import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { createDb } from "../src/db/client";
import { platformRoles, signPlatformToken } from "../src/modules/platform/routes";
import { buildApp } from "../src/server";
import { addMember, signUp, TEST_URL, TestClient } from "./helpers";

const SECRET = "gateway-test-secret-0123456789-abcdef";

type Seen = { method: string; url: string; authorization: string; contentType: string; body: string };

/** A stand-in for the Java platform that records requests and answers from a script. */
async function fakePlatform(answer: (req: IncomingMessage, body: string) => { status: number; type?: string; body?: string }) {
  const seen: Seen[] = [];
  const server: Server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    seen.push({ method: req.method!, url: req.url!, authorization: String(req.headers.authorization), contentType: String(req.headers["content-type"]), body });
    const a = answer(req, body);
    res.writeHead(a.status, { "content-type": a.type ?? "application/json" });
    res.end(a.body ?? "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function appWith(env: Record<string, string | undefined>) {
  const { db, pool } = createDb(TEST_URL);
  const config = loadConfig({ ...process.env, DATABASE_URL: TEST_URL, LOG_LEVEL: "silent", ...env });
  const app = await buildApp({ config, db, logger: false });
  return { app, close: async () => (await app.close(), await pool.end()) };
}

function claims(token: string) {
  const [h, p, s] = token.split(".");
  expect(createHmac("sha256", SECRET).update(`${h}.${p}`).digest("base64url")).toBe(s);
  return JSON.parse(Buffer.from(p!, "base64url").toString());
}

describe("platform tokens", () => {
  it("are HS256 JWTs with the member's organization and platform roles, valid for five minutes", () => {
    const token = signPlatformToken(SECRET, { sub: "ann@example.test", org: "org-1", roles: ["clerk"] }, 300, 1_800_000_000_000);
    expect(JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString())).toEqual({ alg: "HS256", typ: "JWT" });
    expect(claims(token)).toEqual({ sub: "ann@example.test", org: "org-1", roles: ["clerk"], iat: 1_800_000_000, exp: 1_800_000_300 });
  });

  it("map member roles to platform roles", () => {
    expect(platformRoles("owner")).toEqual(["admin"]);
    expect(platformRoles("admin")).toEqual(["admin"]);
    expect(platformRoles("accountant")).toEqual(["clerk"]);
    expect(platformRoles("sales")).toEqual(["clerk"]);
    expect(platformRoles("viewer")).toEqual(["viewer"]);
  });
});

describe("platform gateway", () => {
  let platform: Awaited<ReturnType<typeof fakePlatform>>;
  let ctx: Awaited<ReturnType<typeof appWith>>;
  let owner: TestClient;
  let email: string;
  let organizationId: string;

  beforeAll(async () => {
    platform = await fakePlatform((req, body) => {
      if (req.url!.includes("/rejected")) {
        return {
          status: 422,
          type: "application/problem+json",
          body: JSON.stringify({ type: "about:blank", title: "Unprocessable Content", status: 422, detail: "Quantity must be greater than zero.", code: "VKS4100", kind: "rejected", line: 53, col: 13 }),
        };
      }
      if (req.method === "DELETE") return { status: 204 };
      return { status: req.method === "POST" ? 201 : 200, body: JSON.stringify({ echoed: body ? JSON.parse(body) : null, amount: "12.50" }) };
    });
    ctx = await appWith({ VKS_PLATFORM_URL: platform.url, VKS_JWT_SECRET: SECRET });
    ({ client: owner, email, organizationId } = await signUp(ctx.app));
  });
  afterAll(async () => {
    await ctx.close();
    await platform.close();
  });

  it("forwards with a signed token for the member and passes answers through unchanged", async () => {
    const res = await owner.req("GET", "/platform/apps/inventory/catalogs/Products?q=motor&limit=5");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ echoed: null, amount: "12.50" });
    const seen = platform.seen.at(-1)!;
    expect(seen.method).toBe("GET");
    expect(seen.url).toBe("/api/v1/apps/inventory/catalogs/Products?q=motor&limit=5");
    expect(claims(seen.authorization.replace("Bearer ", ""))).toMatchObject({ sub: email, org: organizationId, roles: ["admin"] });
  });

  it("forwards bodies and statuses", async () => {
    const created = await owner.req("POST", "/platform/apps/inventory/catalogs/Products", { fields: { code: "P-1", price: "1.50" } });
    expect(created.status).toBe(201);
    expect(created.body.echoed).toEqual({ fields: { code: "P-1", price: "1.50" } });
    expect(platform.seen.at(-1)!.contentType).toBe("application/json");
    expect((await owner.req("DELETE", "/platform/apps/inventory/catalogs/Products/x")).status).toBe(204);
  });

  it("turns platform problems into this API's error envelope", async () => {
    const res = await owner.req("POST", "/platform/apps/inventory/rejected", {});
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: { code: "VKS4100", message: "Quantity must be greater than zero.", details: { kind: "rejected", line: 53, col: 13 } } });
  });

  it("uses each member's own role", async () => {
    const viewer = await addMember(ctx.app, owner, "viewer");
    await viewer.ok("GET", "/platform/apps");
    expect(claims(platform.seen.at(-1)!.authorization.replace("Bearer ", "")).roles).toEqual(["viewer"]);
    const accountant = await addMember(ctx.app, owner, "accountant");
    await accountant.ok("GET", "/platform/apps");
    expect(claims(platform.seen.at(-1)!.authorization.replace("Bearer ", "")).roles).toEqual(["clerk"]);
  });

  it("forwards only application paths and requires a session", async () => {
    const before = platform.seen.length;
    expect((await owner.req("GET", "/platform/actuator/env")).status).toBe(404);
    expect((await owner.req("GET", "/platform/apps/x%2F..%2F..%2Fhealth")).status).toBe(404);
    expect((await new TestClient(ctx.app).req("GET", "/platform/apps")).status).toBe(401);
    expect(platform.seen.length).toBe(before);
  });
});

describe("platform gateway without a platform", () => {
  it("answers 503 when no secret is configured or the platform is down", async () => {
    const unconfigured = await appWith({ VKS_JWT_SECRET: undefined });
    const a = (await signUp(unconfigured.app)).client;
    const res = await a.req("GET", "/platform/apps");
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("platform_unavailable");
    await unconfigured.close();

    const down = await appWith({ VKS_PLATFORM_URL: "http://127.0.0.1:9", VKS_JWT_SECRET: SECRET });
    const b = (await signUp(down.app)).client;
    expect((await b.req("GET", "/platform/apps")).status).toBe(503);
    await down.close();
  });
});
