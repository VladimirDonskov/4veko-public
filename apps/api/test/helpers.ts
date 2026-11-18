import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config";
import { createDb } from "../src/db/client";
import { buildApp } from "../src/server";

export const TEST_URL = process.env.TEST_DATABASE_URL!;
export const PASSWORD = "Correct-Horse-42";

export async function setupApp() {
  const { db, pool } = createDb(TEST_URL);
  const config = loadConfig({ ...process.env, DATABASE_URL: TEST_URL, LOG_LEVEL: "silent" });
  const app = await buildApp({ config, db, logger: false });
  return {
    app,
    db,
    pool,
    async close() {
      await app.close();
      await pool.end();
    },
  };
}

type App = Awaited<ReturnType<typeof setupApp>>["app"];

export type Res<T = any> = { status: number; body: T; headers: Record<string, unknown> };

/** A signed-in API user. Keeps the session cookie between calls. */
export class TestClient {
  cookie = "";
  constructor(private app: App) {}

  async req<T = any>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Res<T>> {
    const res = await this.app.inject({
      method,
      url: `/api/v1${url}`,
      payload: body as any,
      headers: { ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
    });
    const setCookie = res.headers["set-cookie"];
    if (setCookie) this.cookie = String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0]!;
    let parsed: any = null;
    try {
      parsed = res.body ? res.json() : null;
    } catch {
      parsed = res.body;
    }
    return { status: res.statusCode, body: parsed, headers: res.headers as Record<string, unknown> };
  }

  /** Like req, but fails the test on any non-2xx response. */
  async ok<T = any>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, body?: unknown, headers?: Record<string, string>) {
    const res = await this.req<T>(method, url, body, headers);
    if (res.status >= 300) throw new Error(`${method} ${url} -> ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  }
}

export async function signUp(app: App, orgName = `Test Co ${randomUUID().slice(0, 8)}`) {
  const client = new TestClient(app);
  const email = `owner-${randomUUID()}@example.test`;
  const res = await client.req("POST", "/auth/signup", {
    name: "Test Owner",
    email,
    password: PASSWORD,
    organizationName: orgName,
  });
  if (res.status !== 201) throw new Error(`signup failed: ${JSON.stringify(res.body)}`);
  return { client, email, organizationId: res.body.organizationId as string };
}

export async function addMember(app: App, owner: TestClient, role: string) {
  const email = `${role}-${randomUUID()}@example.test`;
  await owner.ok("POST", "/org/members", { email, name: `Test ${role}`, role, temporaryPassword: PASSWORD });
  const client = new TestClient(app);
  await client.ok("POST", "/auth/login", { email, password: PASSWORD });
  return client;
}

/** A small working company: accounts map, one customer, one stocked item with 10 on hand at $6. */
export async function setupCompany(client: TestClient) {
  const accounts = (await client.ok("GET", "/accounts")).data as { id: string; number: string; systemKey: string | null }[];
  const acct = (n: string) => accounts.find((a) => a.number === n)!.id;
  const sys = (k: string) => accounts.find((a) => a.systemKey === k)!.id;
  await client.ok("PATCH", "/org", { defaultTaxRate: "8.25" });
  const customer = await client.ok("POST", "/customers", { displayName: `Customer ${randomUUID().slice(0, 6)}`, termsDays: 30 });
  const widget = await client.ok("POST", "/items", {
    sku: `W-${randomUUID().slice(0, 6)}`,
    name: "Widget",
    type: "inventory",
    salesPrice: "10.00",
    reorderPoint: "2",
  });
  const service = await client.ok("POST", "/items", {
    sku: `S-${randomUUID().slice(0, 6)}`,
    name: "Installation",
    type: "service",
    salesPrice: "50.00",
  });
  await client.ok("POST", "/inventory/adjustments", {
    date: "2026-01-05",
    reason: "opening_balance",
    lines: [{ itemId: widget.id, quantityChange: "10", unitCost: "6.00" }],
  });
  return { acct, sys, customer, widget, service };
}

export async function accountBalance(client: TestClient, accountId: string) {
  const res = await client.ok("GET", `/accounts/${accountId}`);
  return res.closingBalance as string;
}

/** Await a promise that must fail, and return the underlying Postgres message. */
export async function dbError(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    const e = err as { message?: string; cause?: { message?: string } };
    return e.cause?.message ?? e.message ?? String(err);
  }
  throw new Error("Expected the database to reject this statement");
}
