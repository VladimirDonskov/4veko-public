import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { users } from "../../db/schema";
import { requireOrg } from "../../lib/context";
import { AppError, notFound } from "../../lib/errors";
import type { Role } from "../../lib/permissions";

/**
 * Gateway to the Java VekoScript platform. The browser keeps using its first-party session
 * cookie; for each request this API signs a five-minute token for the signed-in member and
 * forwards the call. Tokens never reach the browser. Identity stays here until sign-in moves
 * to the Java platform (docs/vekoscript/adr/0002-java-platform-scope.md).
 */

/** Platform roles for each member role. Capabilities per platform role live in the platform's configuration. */
export function platformRoles(role: Role): string[] {
  switch (role) {
    case "owner":
    case "admin":
      return ["admin"];
    case "accountant":
    case "sales":
      return ["clerk"];
    default:
      return ["viewer"];
  }
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

/** An HS256 JWT with sub, org and roles, valid for `seconds`. */
export function signPlatformToken(secret: string, claims: { sub: string; org: string; roles: string[] }, seconds = 300, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ ...claims, iat, exp: iat + seconds }));
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

/** Only application paths are forwarded: apps, apps/name, apps/name/catalogs/Type/id/... */
const FORWARDED = /^apps(\/[A-Za-z0-9_-]+)*$/;

type Problem = { status?: number; detail?: string; code?: string; title?: string; [k: string]: unknown };

export const platformRoutes: FastifyPluginAsyncZod = async (app) => {
  app.all("/*", { schema: { hide: true } }, async (req, reply) => {
    const ctx = requireOrg(req);
    const path = (req.params as { "*": string })["*"] ?? "";
    if (!FORWARDED.test(path)) throw notFound("This platform resource");
    const secret = app.config.VKS_JWT_SECRET;
    if (!secret) throw new AppError(503, "platform_unavailable", "The VekoScript platform is not configured on this server (VKS_JWT_SECRET).");

    const [user] = await app.db.select({ email: users.email }).from(users).where(eq(users.id, ctx.userId));
    const token = signPlatformToken(secret, { sub: user?.email ?? ctx.userId, org: ctx.organizationId, roles: platformRoles(ctx.role) });
    const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    const hasBody = req.method !== "GET" && req.method !== "HEAD" && req.body !== undefined;

    let res: Response;
    try {
      res = await fetch(`${app.config.VKS_PLATFORM_URL}/api/v1/${path}${query}`, {
        method: req.method,
        headers: { authorization: `Bearer ${token}`, ...(hasBody ? { "content-type": "application/json" } : {}) },
        body: hasBody ? JSON.stringify(req.body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      req.log.warn({ err }, "VekoScript platform unreachable");
      throw new AppError(503, "platform_unavailable", "The VekoScript platform is not reachable. Please try again.");
    }

    const text = await res.text();
    if (res.status === 204 || !text) return reply.status(res.status).send();
    if (res.ok) return reply.status(res.status).type("application/json").send(text);

    // Platform problems (RFC 9457) become this API's error envelope; the platform's code,
    // kind, position, diagnostics and plan travel in details.
    let problem: Problem = {};
    try {
      problem = JSON.parse(text) as Problem;
    } catch {
      problem = { detail: `The VekoScript platform answered ${res.status}.` };
    }
    const { status: _status, detail, code, title: _title, type: _type, ...details } = problem;
    return reply.status(res.status).send({ error: { code: code ?? "platform_error", message: detail ?? "The VekoScript platform refused the request.", details } });
  });
};
