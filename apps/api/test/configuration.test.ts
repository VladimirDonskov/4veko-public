import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SAMPLE_CONFIGURATION } from "../src/modules/config/sample";
import { accountBalance, addMember, setupApp, setupCompany, signUp, type TestClient } from "./helpers";

let ctx: Awaited<ReturnType<typeof setupApp>>;
let owner: TestClient;
let co: Awaited<ReturnType<typeof setupCompany>>;

beforeAll(async () => {
  ctx = await setupApp();
  owner = (await signUp(ctx.app)).client;
  co = await setupCompany(owner);
});
afterAll(() => ctx.close());

async function expectBooksReconcile() {
  expect((await owner.ok("GET", "/reports/trial-balance?asOf=2027-12-31")).balanced).toBe(true);
  const inv = await owner.ok("GET", "/inventory");
  expect(await accountBalance(owner, co.sys("inventory"))).toBe(inv.totalValue);
  const aging = await owner.ok("GET", "/reports/ar-aging");
  expect(await accountBalance(owner, co.sys("accounts_receivable"))).toBe(aging.totals.total);
}

describe("configurations", () => {
  it("starts empty and refuses code that does not compile, with line numbers", async () => {
    expect((await owner.ok("GET", "/config")).version).toBe(0);
    const bad = await owner.req("PUT", "/config", { source: "catalog Thing\n  field name: Txt\nend\ndocument X\n  on post\n    nothing()\n  end\nend" });
    expect(bad.status).toBe(422);
    const diags = bad.body.error.details.diagnostics;
    expect(diags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ line: 2, message: expect.stringMatching(/Unknown type "Txt"/) }),
        expect.objectContaining({ line: 6, message: expect.stringMatching(/Unknown name "nothing"/) }),
      ]),
    );
    const check = await owner.ok("POST", "/config/check", { source: "function f(\nend" });
    expect(check.ok).toBe(false);
  });

  it("saves versions and describes the objects", async () => {
    const v1 = await owner.ok("PUT", "/config", { source: SAMPLE_CONFIGURATION, comment: "Rental sample" });
    expect(v1.version).toBe(1);
    expect(v1.metadata.documents.map((d: { name: string }) => d.name)).toEqual(["Rental", "EquipmentReturn", "CounterSale"]);
    expect(v1.metadata.registers.find((r: { name: string }) => r.name === "EquipmentOut").nonnegative).toBe(true);
    const versions = await owner.ok("GET", "/config/versions");
    expect(versions[0]).toMatchObject({ version: 1, comment: "Rental sample" });
  });

  it("only owners and admins can change the configuration", async () => {
    const accountant = await addMember(ctx.app, owner, "accountant");
    expect((await accountant.req("PUT", "/config", { source: SAMPLE_CONFIGURATION })).status).toBe(403);
    expect((await accountant.req("GET", "/config")).status).toBe(200);
  });
});

describe("documents written in Veko", () => {
  let drill: { id: string };
  let saw: { id: string };
  let rental: { id: string; number: string; journalEntryId: string };

  it("creates catalog items with required fields enforced", async () => {
    const missing = await owner.req("POST", "/x/Equipment", { data: { name: "Hammer drill" } });
    expect(missing.status).toBe(422);
    expect(missing.body.error.message).toMatch(/dailyRate is required/);
    drill = await owner.ok("POST", "/x/Equipment", { data: { name: "Hammer drill", serial: "HD-01", dailyRate: "35.00" } });
    saw = await owner.ok("POST", "/x/Equipment", { data: { name: "Tile saw", dailyRate: "48.50" } });
    const list = await owner.ok("GET", "/x/Equipment");
    expect(list.data.map((r: { label: string }) => r.label).sort()).toEqual(["Hammer drill", "Tile saw"]);
  });

  it("runs on write: defaults, computed amounts and totals", async () => {
    const created = await owner.ok("POST", "/x/Rental", {
      date: "2026-09-01",
      data: { customer: co.customer.id },
      tables: { lines: [{ equipment: drill.id, days: "3" }, { equipment: saw.id, days: "2", rate: "45" }] },
    });
    expect(created.number).toBe("Rental-1001");
    expect(created.posted).toBe(false);
    expect(created.tables.lines[0]).toMatchObject({ rate: "35.00", amount: "105.00" });
    expect(created.tables.lines[1]).toMatchObject({ rate: "45.00", amount: "90.00" });
    expect(created.data.total).toBe("195.00");
    expect(created.labels[drill.id]).toBe("Hammer drill");
    rental = created;
  });

  it("refuses a document when on write fails", async () => {
    const res = await owner.req("POST", "/x/Rental", { data: { customer: co.customer.id }, tables: { lines: [] } });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: "rule_failed", message: "Add at least one piece of equipment." });
    const list = await owner.ok("GET", "/x/Rental");
    expect(list.data).toHaveLength(1);
  });

  it("posts: one balanced journal entry, register movements, messages", async () => {
    const posted = await owner.ok("POST", `/x/Rental/${rental.id}/post`);
    expect(posted.posted).toBe(true);
    expect(posted.messages).toEqual(["Rental Rental-1001 posted for 195"]);
    const entry = await owner.ok("GET", `/journal-entries/${posted.journalEntryId}`);
    expect(entry.sourceType).toBe("config_document");
    expect(entry.lines.find((l: { accountId: string }) => l.accountId === co.sys("undeposited_funds")).debit).toBe("195.00");
    expect(entry.lines.find((l: { accountId: string }) => l.accountId === co.sys("service_revenue")).credit).toBe("195.00");
    const out = await owner.ok("GET", "/registers/EquipmentOut/balances");
    expect(out.balances).toHaveLength(2);
    expect(out.balances.every((b: { resources: { units: string } }) => b.resources.units === "1")).toBe(true);
    expect(out.labels[drill.id]).toBe("Hammer drill");
    rental = posted;
    await expectBooksReconcile();
  });

  it("reposts after an edit: the old entry is reversed and registers rewritten", async () => {
    const edited = await owner.ok("PUT", `/x/Rental/${rental.id}`, {
      tables: { lines: [{ equipment: drill.id, days: "4" }] },
      post: true,
    });
    expect(edited.data.total).toBe("140.00");
    expect(edited.journalEntryId).not.toBe(rental.journalEntryId);
    const old = await owner.ok("GET", `/journal-entries/${rental.journalEntryId}`);
    expect(old.reversedById).toBeTruthy();
    const out = await owner.ok("GET", "/registers/EquipmentOut/balances");
    expect(out.balances).toHaveLength(1);
    const revenue = await owner.ok("GET", "/registers/RentalRevenue/balances");
    expect(revenue.balances[0].resources.amount).toBe("140");
    rental = edited;
    await expectBooksReconcile();
  });

  it("enforces nonnegative registers across documents", async () => {
    const back = await owner.ok("POST", "/x/EquipmentReturn", { data: { rental: rental.id }, post: true });
    expect(back.posted).toBe(true);
    expect((await owner.ok("GET", "/registers/EquipmentOut/balances")).balances).toHaveLength(0);
    const twice = await owner.req("POST", "/x/EquipmentReturn", { data: { rental: rental.id }, post: true });
    expect(twice.status).toBe(422);
    expect(twice.body.error.code).toBe("negative_balance");
    // The failed document was rolled back entirely.
    expect((await owner.ok("GET", "/x/EquipmentReturn")).data).toHaveLength(1);
    // Unposting the rental would leave the returned equipment negative.
    const unpost = await owner.req("POST", `/x/Rental/${rental.id}/unpost`);
    expect(unpost.status).toBe(422);
  });

  it("refuses rule violations in on write that reference other documents", async () => {
    const draft = await owner.ok("POST", "/x/Rental", { data: { customer: co.customer.id }, tables: { lines: [{ equipment: saw.id, days: "1" }] } });
    const res = await owner.req("POST", "/x/EquipmentReturn", { data: { rental: draft.id } });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toBe("Only posted rentals can be returned.");
  });

  it("moves stock through the kernel at average cost, with the inventory side posted by the platform", async () => {
    const before = await owner.ok("GET", `/items/${co.widget.id}`);
    const sale = await owner.ok("POST", "/x/CounterSale", {
      date: "2026-09-05",
      data: { customer: co.customer.id },
      tables: { lines: [{ item: co.widget.id, qty: "2" }] },
      post: true,
    });
    expect(sale.tables.lines[0].price).toBe("10.00");
    const after = await owner.ok("GET", `/items/${co.widget.id}`);
    expect(Number(after.qtyOnHand)).toBe(Number(before.qtyOnHand) - 2);
    const entry = await owner.ok("GET", `/journal-entries/${sale.journalEntryId}`);
    expect(entry.lines.find((l: { accountId: string }) => l.accountId === co.sys("cogs")).debit).toBe("12.00");
    expect(entry.lines.find((l: { accountId: string }) => l.accountId === co.sys("inventory")).credit).toBe("12.00");
    await expectBooksReconcile();

    // Unposting puts the stock back exactly and reverses the entry.
    await owner.ok("POST", `/x/CounterSale/${sale.id}/unpost`);
    const restored = await owner.ok("GET", `/items/${co.widget.id}`);
    expect(restored.qtyOnHand).toBe(before.qtyOnHand);
    expect(restored.valueOnHand).toBe(before.valueOnHand);
    await expectBooksReconcile();
  });

  it("rolls back stock when posting fails", async () => {
    const before = await owner.ok("GET", `/items/${co.widget.id}`);
    const res = await owner.req("POST", "/x/CounterSale", {
      data: { customer: co.customer.id },
      tables: { lines: [{ item: co.widget.id, qty: "1" }, { item: co.widget.id, qty: "9999" }] },
      post: true,
    });
    expect(res.status).toBe(422);
    const after = await owner.ok("GET", `/items/${co.widget.id}`);
    expect(after.qtyOnHand).toBe(before.qtyOnHand);
  });

  it("does not let code post to control accounts", async () => {
    const source = `${SAMPLE_CONFIGURATION}
document Sneaky
  field customer: Customer required
  on post
    ledger.post(debit: accounts.receivable, credit: accounts.sales, amount: 10, party: customer)
  end
end`;
    await owner.ok("PUT", "/config", { source });
    const res = await owner.req("POST", "/x/Sneaky", { data: { customer: co.customer.id }, post: true });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/control account/);
    await expectBooksReconcile();
  });

  it("stops runaway code and reports the line", async () => {
    const source = `${SAMPLE_CONFIGURATION}
document Loop
  field note: Text
  on write
    let i = 0
    while true
      i = i + 1
    end
  end
end`;
    await owner.ok("PUT", "/config", { source });
    const res = await owner.req("POST", "/x/Loop", { data: { note: "x" } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("code_error");
    expect(res.body.error.message).toMatch(/ran too long|longer than/);
  });

  it("respects the books-closed date", async () => {
    await owner.ok("PATCH", "/org", { booksClosedThrough: "2026-06-30" });
    const res = await owner.req("POST", "/x/Rental", {
      date: "2026-06-15",
      data: { customer: co.customer.id },
      tables: { lines: [{ equipment: saw.id, days: "1" }] },
      post: true,
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("period_closed");
    await owner.ok("PATCH", "/org", { booksClosedThrough: null });
  });

  it("keeps organizations apart", async () => {
    const other = (await signUp(ctx.app)).client;
    expect((await other.req("GET", `/x/Rental/${rental.id}`)).status).toBe(404);
    await other.ok("PUT", "/config", { source: SAMPLE_CONFIGURATION });
    expect((await other.ok("GET", "/x/Rental")).data).toHaveLength(0);
    const foreignRef = await other.req("POST", "/x/EquipmentReturn", { data: { rental: rental.id } });
    expect(foreignRef.status).toBe(422);
    expect((await other.ok("GET", "/registers/EquipmentOut/balances")).balances).toHaveLength(0);
  });

  it("lets viewers read but not write or post", async () => {
    const viewer = await addMember(ctx.app, owner, "viewer");
    expect((await viewer.req("GET", "/x/Rental")).status).toBe(200);
    expect((await viewer.req("POST", "/x/Equipment", { data: { name: "X", dailyRate: "1" } })).status).toBe(403);
    expect((await viewer.req("POST", `/x/Rental/${rental.id}/unpost`)).status).toBe(403);
  });
});
