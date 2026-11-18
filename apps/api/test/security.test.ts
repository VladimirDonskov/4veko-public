import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, PASSWORD, setupApp, setupCompany, signUp, TestClient } from "./helpers";

let ctx: Awaited<ReturnType<typeof setupApp>>;
let ownerA: TestClient;
let ownerB: TestClient;
let coA: Awaited<ReturnType<typeof setupCompany>>;

beforeAll(async () => {
  ctx = await setupApp();
  ownerA = (await signUp(ctx.app, "Alpha Corp")).client;
  ownerB = (await signUp(ctx.app, "Bravo Corp")).client;
  coA = await setupCompany(ownerA);
});
afterAll(() => ctx.close());

describe("tenant isolation", () => {
  it("another organization cannot read, list or search our records", async () => {
    expect((await ownerB.req("GET", `/customers/${coA.customer.id}`)).status).toBe(404);
    expect((await ownerB.req("GET", `/items/${coA.widget.id}`)).status).toBe(404);
    const list = await ownerB.ok("GET", "/customers");
    expect(list.data.find((c: { id: string }) => c.id === coA.customer.id)).toBeUndefined();
    const search = await ownerB.ok("GET", `/search?q=${encodeURIComponent(coA.customer.displayName)}`);
    expect(search.results).toHaveLength(0);
  });

  it("another organization cannot use our records in its documents", async () => {
    const bItems = await ownerB.ok("POST", "/items", { sku: "B-1", name: "B item", type: "service", salesPrice: "1.00" });
    const crossCustomer = await ownerB.req("POST", "/sales-orders", {
      customerId: coA.customer.id,
      orderDate: "2026-06-01",
      lines: [{ itemId: bItems.id, quantity: "1" }],
    });
    expect(crossCustomer.status).toBe(422);
    const bCustomer = await ownerB.ok("POST", "/customers", { displayName: "B customer" });
    const crossItem = await ownerB.req("POST", "/invoices", {
      customerId: bCustomer.id,
      issueDate: "2026-06-01",
      lines: [{ itemId: coA.widget.id, quantity: "1" }],
    });
    expect(crossItem.status).toBe(422);
    const crossAccount = await ownerB.req("POST", "/journal-entries", {
      date: "2026-06-01",
      lines: [
        { accountId: coA.acct("1010"), debit: "1.00" },
        { accountId: coA.acct("3000"), credit: "1.00" },
      ],
    });
    expect(crossAccount.status).toBe(422);
  });

  it("another organization cannot change our records", async () => {
    const res = await ownerB.req("PATCH", `/customers/${coA.customer.id}`, { displayName: "Hijacked" });
    expect(res.status).toBe(404);
    const archive = await ownerB.ok("POST", "/customers/bulk-archive", { ids: [coA.customer.id], archived: true });
    expect(archive.updated).toBe(0);
    expect((await ownerA.ok("GET", `/customers/${coA.customer.id}`)).displayName).not.toBe("Hijacked");
  });
});

describe("roles and permissions", () => {
  it("a viewer can read but not change anything", async () => {
    const viewer = await addMember(ctx.app, ownerA, "viewer");
    expect((await viewer.req("GET", "/customers")).status).toBe(200);
    expect((await viewer.req("GET", "/reports/trial-balance")).status).toBe(200);
    expect((await viewer.req("POST", "/customers", { displayName: "Nope" })).status).toBe(403);
    expect((await viewer.req("POST", "/invoices", { customerId: coA.customer.id, issueDate: "2026-06-01", lines: [{ itemId: coA.service.id, quantity: "1" }] })).status).toBe(403);
    expect((await viewer.req("GET", "/audit-events")).status).toBe(403);
  });

  it("sales can sell but cannot post journal entries, void invoices or record payments", async () => {
    const sales = await addMember(ctx.app, ownerA, "sales");
    const inv = await sales.req("POST", "/invoices", { customerId: coA.customer.id, issueDate: "2026-06-01", lines: [{ itemId: coA.service.id, quantity: "1" }] });
    expect(inv.status).toBe(201);
    expect((await sales.req("POST", `/invoices/${inv.body.id}/void`, {})).status).toBe(403);
    expect((await sales.req("POST", "/payments", { customerId: coA.customer.id, date: "2026-06-02", amount: "1.00", method: "ach" })).status).toBe(403);
    expect(
      (await sales.req("POST", "/journal-entries", { date: "2026-06-01", lines: [{ accountId: coA.acct("6300"), debit: "1" }, { accountId: coA.acct("1010"), credit: "1" }] })).status,
    ).toBe(403);
    expect((await sales.req("PATCH", "/org", { booksClosedThrough: "2026-12-31" })).status).toBe(403);
  });

  it("an accountant cannot manage members", async () => {
    const accountant = await addMember(ctx.app, ownerA, "accountant");
    expect((await accountant.req("POST", "/org/members", { email: "x@example.test", name: "X", role: "viewer", temporaryPassword: PASSWORD })).status).toBe(403);
  });

  it("an organization always keeps an owner", async () => {
    const members = await ownerA.ok("GET", "/org/members");
    const owner = members.find((m: { role: string }) => m.role === "owner");
    const res = await ownerA.req("PATCH", `/org/members/${owner.id}`, { role: "admin" });
    expect(res.status).toBe(409);
  });

  it("removing a member ends their session immediately", async () => {
    const accountant = await addMember(ctx.app, ownerA, "accountant");
    const me = await accountant.ok("GET", "/auth/me");
    const members = await ownerA.ok("GET", "/org/members");
    const m = members.find((x: { userId: string }) => x.userId === me.user.id);
    await ownerA.ok("DELETE", `/org/members/${m.id}`);
    expect((await accountant.req("GET", "/customers")).status).toBe(401);
  });
});

describe("authentication", () => {
  it("requires a session", async () => {
    const anon = new TestClient(ctx.app);
    expect((await anon.req("GET", "/customers")).status).toBe(401);
    expect((await anon.req("GET", "/dashboard")).status).toBe(401);
  });

  it("rejects wrong passwords without revealing whether the email exists", async () => {
    const anon = new TestClient(ctx.app);
    const wrong = await anon.req("POST", "/auth/login", { email: "nobody@example.test", password: "whatever-123" });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.message).toBe("Email or password is incorrect.");
  });

  it("does not allow duplicate accounts", async () => {
    const anon = new TestClient(ctx.app);
    const email = `dup-${Date.now()}@example.test`;
    await anon.ok("POST", "/auth/signup", { name: "A", email, password: PASSWORD, organizationName: "Dup 1" });
    const again = await new TestClient(ctx.app).req("POST", "/auth/signup", { name: "A", email: email.toUpperCase(), password: PASSWORD, organizationName: "Dup 2" });
    expect(again.status).toBe(409);
  });

  it("signs out and the old cookie stops working", async () => {
    const { client } = await signUp(ctx.app);
    const cookie = client.cookie;
    await client.ok("POST", "/auth/logout");
    const reused = new TestClient(ctx.app);
    reused.cookie = cookie;
    expect((await reused.req("GET", "/auth/me")).status).toBe(401);
  });

  it("stores only a hash of the session token and never the password", async () => {
    const { client } = await signUp(ctx.app);
    const token = decodeURIComponent(client.cookie.split("=")[1]!);
    const rows = await ctx.pool.query("select token_hash from sessions where token_hash = $1", [token]);
    expect(rows.rowCount).toBe(0);
    const users = await ctx.pool.query("select password_hash from users where password_hash like 'scrypt$%' limit 1");
    expect(users.rowCount).toBe(1);
  });

  it("rejects state-changing requests from other origins", async () => {
    const res = await ownerA.req("POST", "/customers", { displayName: "CSRF" }, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
  });
});
