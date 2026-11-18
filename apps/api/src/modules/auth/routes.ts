import { and, eq, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { memberships, organizations, sessions, users } from "../../db/schema";
import { audit } from "../../lib/audit";
import { createSession, requireUser, SESSION_COOKIE, setSessionCookie } from "../../lib/context";
import { AppError, forbidden } from "../../lib/errors";
import { hashPassword, verifyPassword } from "../../lib/passwords";
import { permissionsFor } from "../../lib/permissions";
import { createOrganization } from "../org/service";

const email = z.email("Enter a valid email address.").trim().toLowerCase().max(254);
const password = z.string().min(10, "Use at least 10 characters.").max(200);

// Verifying against a fixed hash when the email is unknown keeps response
// times similar, so the login form does not reveal which emails exist.
let dummyHash: string | null = null;
async function getDummyHash() {
  dummyHash ??= await hashPassword("not-a-real-password-placeholder");
  return dummyHash;
}

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  const authLimit = { rateLimit: { max: 10, timeWindow: "1 minute" } };

  app.post(
    "/signup",
    {
      config: authLimit,
      schema: {
        tags: ["Auth"],
        summary: "Create an account and a new organization",
        body: z.object({
          name: z.string().trim().min(1).max(120),
          email,
          password,
          organizationName: z.string().trim().min(1).max(160),
          fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
        }),
      },
    },
    async (req, reply) => {
      const { name, email: mail, password: pw, organizationName, fiscalYearStartMonth } = req.body;
      const passwordHash = await hashPassword(pw);
      const { user, org } = await app.db.transaction(async (tx) => {
        const [user] = await tx.insert(users).values({ email: mail, name, passwordHash }).returning();
        if (!user) throw new Error("User insert returned nothing");
        const org = await createOrganization(tx, user.id, { name: organizationName, fiscalYearStartMonth });
        return { user, org };
      });
      const session = await createSession(app.db, user.id, org.id);
      setSessionCookie(reply, session.token, session.expiresAt, app.config.COOKIE_SECURE);
      return reply.status(201).send({ user: { id: user.id, email: user.email, name: user.name }, organizationId: org.id });
    },
  );

  app.post(
    "/login",
    {
      config: authLimit,
      schema: {
        tags: ["Auth"],
        summary: "Sign in with email and password",
        body: z.object({ email, password: z.string().min(1).max(200) }),
      },
    },
    async (req, reply) => {
      const [user] = await app.db
        .select()
        .from(users)
        .where(sql`lower(${users.email}) = ${req.body.email}`);
      const ok = user ? await verifyPassword(user.passwordHash, req.body.password) : await verifyPassword(await getDummyHash(), "x");
      if (!user || !ok) throw new AppError(401, "invalid_credentials", "Email or password is incorrect.");

      const [firstMembership] = await app.db
        .select({ organizationId: memberships.organizationId })
        .from(memberships)
        .where(eq(memberships.userId, user.id))
        .orderBy(memberships.createdAt)
        .limit(1);
      const session = await createSession(app.db, user.id, firstMembership?.organizationId ?? null);
      if (firstMembership) {
        await audit(app.db, {
          organizationId: firstMembership.organizationId,
          actorUserId: user.id,
          action: "user.signed_in",
          entityType: "user",
          entityId: user.id,
          summary: `${user.name} signed in`,
          ip: req.ip,
        });
      }
      setSessionCookie(reply, session.token, session.expiresAt, app.config.COOKIE_SECURE);
      return { user: { id: user.id, email: user.email, name: user.name } };
    },
  );

  app.post("/logout", { schema: { tags: ["Auth"], summary: "Sign out this session" } }, async (req, reply) => {
    if (req.auth) await app.db.delete(sessions).where(eq(sessions.id, req.auth.sessionId));
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/me", { schema: { tags: ["Auth"], summary: "Current user, organization and permissions" } }, async (req) => {
    const auth = requireUser(req);
    const [user] = await app.db
      .select({ id: users.id, email: users.email, name: users.name })
      .from(users)
      .where(eq(users.id, auth.userId));
    const orgs = await app.db
      .select({ id: organizations.id, name: organizations.name, role: memberships.role })
      .from(memberships)
      .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
      .where(eq(memberships.userId, auth.userId))
      .orderBy(organizations.name);
    const current = orgs.find((o) => o.id === auth.organizationId) ?? null;
    return {
      user,
      organization: current,
      role: auth.role,
      permissions: auth.role ? permissionsFor(auth.role) : [],
      organizations: orgs,
    };
  });

  app.post(
    "/switch-organization",
    {
      schema: {
        tags: ["Auth"],
        summary: "Make another of your organizations current",
        body: z.object({ organizationId: z.uuid() }),
      },
    },
    async (req) => {
      const auth = requireUser(req);
      const [m] = await app.db
        .select()
        .from(memberships)
        .where(and(eq(memberships.userId, auth.userId), eq(memberships.organizationId, req.body.organizationId)));
      if (!m) throw forbidden("You are not a member of that organization.");
      await app.db
        .update(sessions)
        .set({ organizationId: req.body.organizationId })
        .where(eq(sessions.id, auth.sessionId));
      return { ok: true };
    },
  );
};
