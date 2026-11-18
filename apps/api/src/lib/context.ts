import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db/client";
import { memberships, sessions } from "../db/schema";
import { forbidden, unauthorized } from "./errors";
import { can, type Permission, type Role } from "./permissions";

export const SESSION_COOKIE = "veko_session";
export const SESSION_DAYS = 30;

export type AuthContext = {
  sessionId: string;
  userId: string;
  organizationId: string | null;
  role: Role | null;
};

/** Context for a member acting inside an organization. */
export type OrgContext = {
  sessionId: string;
  userId: string;
  organizationId: string;
  role: Role;
  ip: string;
};

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function newSessionToken() {
  return randomBytes(32).toString("base64url");
}

export async function createSession(db: Db, userId: string, organizationId: string | null) {
  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await db.insert(sessions).values({ tokenHash: hashToken(token), userId, organizationId, expiresAt });
  return { token, expiresAt };
}

export function setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date, secure: boolean) {
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure,
    expires: expiresAt,
  });
}

export async function resolveSession(db: Db, token: string | undefined): Promise<AuthContext | null> {
  if (!token) return null;
  const [row] = await db
    .select({
      sessionId: sessions.id,
      userId: sessions.userId,
      organizationId: sessions.organizationId,
      role: memberships.role,
    })
    .from(sessions)
    .leftJoin(
      memberships,
      and(eq(memberships.userId, sessions.userId), eq(memberships.organizationId, sessions.organizationId)),
    )
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())));
  if (!row) return null;
  // A session pointing at an organization the user has left loses that organization.
  return {
    sessionId: row.sessionId,
    userId: row.userId,
    organizationId: row.role ? row.organizationId : null,
    role: row.role ?? null,
  };
}

export function requireUser(req: FastifyRequest) {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

export function requireOrg(req: FastifyRequest, permission?: Permission): OrgContext {
  const auth = requireUser(req);
  if (!auth.organizationId || !auth.role) throw forbidden("Select an organization first.");
  if (permission && !can(auth.role, permission)) {
    throw forbidden(`Your role (${auth.role}) cannot perform this action.`);
  }
  return {
    sessionId: auth.sessionId,
    userId: auth.userId,
    organizationId: auth.organizationId,
    role: auth.role,
    ip: req.ip,
  };
}
