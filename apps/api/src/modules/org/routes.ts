import { and, eq, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Tx } from "../../db/client";
import { memberships, organizations, sessions, users } from "../../db/schema";
import { audit } from "../../lib/audit";
import { requireOrg } from "../../lib/context";
import { conflict, forbidden, invalid, notFound } from "../../lib/errors";
import { hashPassword } from "../../lib/passwords";
import { ROLES } from "../../lib/permissions";
import { addressSchema, isoDate, optionalText, percentInput, uuidParam } from "../../lib/validation";

export const orgRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get("/", { schema: { tags: ["Organization"], summary: "Current organization settings" } }, async (req) => {
    const ctx = requireOrg(req);
    const [org] = await app.db.select().from(organizations).where(eq(organizations.id, ctx.organizationId));
    if (!org) throw notFound("Organization");
    return org;
  });

  app.patch(
    "/",
    {
      schema: {
        tags: ["Organization"],
        summary: "Update organization settings, including the books-closed date",
        body: z.object({
          name: z.string().trim().min(1).max(160).optional(),
          legalName: optionalText(200).optional(),
          phone: optionalText(40).optional(),
          email: optionalText(254).optional(),
          address: addressSchema,
          fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
          defaultTaxRate: percentInput.optional(),
          booksClosedThrough: isoDate.nullable().optional(),
        }),
      },
    },
    async (req) => {
      const ctx = requireOrg(req, "org.manage");
      return app.db.transaction(async (tx) => {
        const [before] = await tx.select().from(organizations).where(eq(organizations.id, ctx.organizationId)).for("no key update");
        if (!before) throw notFound("Organization");
        const body = req.body;
        const [org] = await tx
          .update(organizations)
          .set({
            ...(body.name !== undefined && { name: body.name }),
            ...(body.legalName !== undefined && { legalName: body.legalName }),
            ...(body.phone !== undefined && { phone: body.phone }),
            ...(body.email !== undefined && { email: body.email }),
            ...(body.address !== undefined && { address: body.address }),
            ...(body.fiscalYearStartMonth !== undefined && { fiscalYearStartMonth: body.fiscalYearStartMonth }),
            ...(body.defaultTaxRate !== undefined && { defaultTaxRate: body.defaultTaxRate }),
            ...(body.booksClosedThrough !== undefined && { booksClosedThrough: body.booksClosedThrough }),
            updatedAt: new Date(),
          })
          .where(eq(organizations.id, ctx.organizationId))
          .returning();
        if (body.booksClosedThrough !== undefined && body.booksClosedThrough !== before.booksClosedThrough) {
          const cutoff = body.booksClosedThrough;
          const closing = cutoff !== null && (before.booksClosedThrough === null || cutoff > before.booksClosedThrough);
          let summary = `Reopened the books (previously closed through ${before.booksClosedThrough})`;
          if (closing) summary = `Closed the books through ${cutoff}`;
          else if (cutoff) summary = `Reopened dates after ${cutoff} through ${before.booksClosedThrough}`;
          await audit(tx, {
            organizationId: ctx.organizationId,
            actorUserId: ctx.userId,
            action: closing ? "books.closed" : "books.reopened",
            entityType: "organization",
            entityId: ctx.organizationId,
            summary,
            data: { from: before.booksClosedThrough, to: body.booksClosedThrough },
            ip: ctx.ip,
          });
        } else {
          await audit(tx, {
            organizationId: ctx.organizationId,
            actorUserId: ctx.userId,
            action: "organization.updated",
            entityType: "organization",
            entityId: ctx.organizationId,
            summary: "Updated organization settings",
            data: { fields: Object.keys(body) },
            ip: ctx.ip,
          });
        }
        return org;
      });
    },
  );

  app.get("/members", { schema: { tags: ["Organization"], summary: "List members and roles" } }, async (req) => {
    const ctx = requireOrg(req);
    return app.db
      .select({
        id: memberships.id,
        userId: users.id,
        name: users.name,
        email: users.email,
        role: memberships.role,
        createdAt: memberships.createdAt,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.organizationId, ctx.organizationId))
      .orderBy(users.name);
  });

  app.post(
    "/members",
    {
      schema: {
        tags: ["Organization"],
        summary: "Add a member. Creates the user account if the email is new.",
        body: z.object({
          email: z.email().trim().toLowerCase(),
          name: z.string().trim().min(1).max(120),
          role: z.enum(ROLES),
          temporaryPassword: z.string().min(10).max(200).optional(),
        }),
      },
    },
    async (req, reply) => {
      const ctx = requireOrg(req, "members.manage");
      if (req.body.role === "owner" && ctx.role !== "owner") throw forbidden("Only an owner can add another owner.");
      const result = await app.db.transaction(async (tx) => {
        let [user] = await tx
          .select()
          .from(users)
          .where(sql`lower(${users.email}) = ${req.body.email}`);
        if (!user) {
          if (!req.body.temporaryPassword) {
            throw invalid("This person has no 4VEKO account yet. Set a temporary password for them.");
          }
          [user] = await tx
            .insert(users)
            .values({
              email: req.body.email,
              name: req.body.name,
              passwordHash: await hashPassword(req.body.temporaryPassword),
            })
            .returning();
        }
        if (!user) throw new Error("User insert returned nothing");
        const [m] = await tx
          .insert(memberships)
          .values({ organizationId: ctx.organizationId, userId: user.id, role: req.body.role })
          .returning();
        await audit(tx, {
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: "member.added",
          entityType: "membership",
          entityId: m!.id,
          summary: `Added ${user.email} as ${req.body.role}`,
          ip: ctx.ip,
        });
        return { id: m!.id, userId: user.id, email: user.email, name: user.name, role: m!.role };
      });
      return reply.status(201).send(result);
    },
  );

  app.patch(
    "/members/:id",
    {
      schema: {
        tags: ["Organization"],
        summary: "Change a member's role",
        params: uuidParam,
        body: z.object({ role: z.enum(ROLES) }),
      },
    },
    async (req) => {
      const ctx = requireOrg(req, "members.manage");
      return app.db.transaction(async (tx) => {
        const m = await lockMembership(tx, ctx.organizationId, req.params.id);
        if ((m.role === "owner" || req.body.role === "owner") && ctx.role !== "owner") {
          throw forbidden("Only an owner can change owner roles.");
        }
        if (m.role === "owner" && req.body.role !== "owner") await assertAnotherOwner(tx, ctx.organizationId);
        const [updated] = await tx
          .update(memberships)
          .set({ role: req.body.role })
          .where(eq(memberships.id, m.id))
          .returning();
        await audit(tx, {
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: "member.role_changed",
          entityType: "membership",
          entityId: m.id,
          summary: `Changed role from ${m.role} to ${req.body.role}`,
          data: { userId: m.userId, from: m.role, to: req.body.role },
          ip: ctx.ip,
        });
        return updated;
      });
    },
  );

  app.delete(
    "/members/:id",
    { schema: { tags: ["Organization"], summary: "Remove a member", params: uuidParam } },
    async (req) => {
      const ctx = requireOrg(req, "members.manage");
      await app.db.transaction(async (tx) => {
        const m = await lockMembership(tx, ctx.organizationId, req.params.id);
        if (m.role === "owner") {
          if (ctx.role !== "owner") throw forbidden("Only an owner can remove an owner.");
          await assertAnotherOwner(tx, ctx.organizationId);
        }
        await tx.delete(memberships).where(eq(memberships.id, m.id));
        // Revoke their sessions in this organization immediately.
        await tx
          .delete(sessions)
          .where(and(eq(sessions.userId, m.userId), eq(sessions.organizationId, ctx.organizationId)));
        await audit(tx, {
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: "member.removed",
          entityType: "membership",
          entityId: m.id,
          summary: `Removed a ${m.role} from the organization`,
          data: { userId: m.userId },
          ip: ctx.ip,
        });
      });
      return { ok: true };
    },
  );
};

async function lockMembership(tx: Tx, orgId: string, id: string) {
  const [m] = await tx
    .select()
    .from(memberships)
    .where(and(eq(memberships.organizationId, orgId), eq(memberships.id, id)))
    .for("update");
  if (!m) throw notFound("Member");
  return m;
}

async function assertAnotherOwner(tx: Tx, orgId: string) {
  const owners = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.organizationId, orgId), eq(memberships.role, "owner")))
    .for("update");
  if (owners.length <= 1) throw conflict("An organization must keep at least one owner.");
}
