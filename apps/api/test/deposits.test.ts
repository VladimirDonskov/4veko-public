import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { addMember, setupApp, signUp, type TestClient } from "./helpers";

let ctx: Awaited<ReturnType<typeof setupApp>>;
beforeEach(async () => { ctx = await setupApp(); });
afterEach(async () => { await ctx.close(); });

async function company() {
  const { client, organizationId } = await signUp(ctx.app);
  const { data }: { data: { id: string; number: string }[] } = await client.ok("GET", "/accounts");
  const account = (n: string) => data.find(a => a.number === n)!.id;
  const buyer = await client.ok("POST", "/customers", { displayName: "Example buyer" });
  return { client, organizationId, buyer: buyer.id as string, bank: account("1010"), savings: account("1020"), holding: account("1050") };
}
type Company = Awaited<ReturnType<typeof company>>;

function receipt(co: Company, amount: string, date = "2026-03-01", extra = {}) {
  return co.client.ok("POST", "/payments", { customerId: co.buyer, date, amount, method: "check", autoApply: false, ...extra });
}
function batch(co: Company, paymentIds: string[], date = "2026-03-15") {
  return { bankAccountId: co.bank, date, paymentIds, memo: "Morning deposit" };
}
function idem(value = randomUUID() as string) { return { "idempotency-key": value }; }
async function eligible(client: TestClient, asOf = "2026-04-30") {
  const { data }: { data: { id: string }[] } = await client.ok("GET", "/deposits/eligible?asOf=" + asOf);
  return data.map(r => r.id).sort();
}
function rejected(result: { status: number }) { expect([400, 404, 409, 422]).toContain(result.status); }
async function balance(client: TestClient, id: string, date: string) {
  return (await client.ok("GET", `/accounts/${id}?to=${date}`)).closingBalance;
}
async function statement(co: Company, lines: { externalId: string; amount: string }[], opts = {}) {
  const result = await co.client.ok("POST", "/bank-reconciliations/import", {
    accountId: co.bank, externalId: "March", startDate: "2026-03-01", endDate: "2026-03-31",
    openingBalance: "0.00", closingBalance: lines[0]?.amount ?? "0.00",
    lines: lines.map(l => ({ ...l, date: "2026-03-20", description: "Bank deposit" })), ...opts,
  });
  return "/bank-reconciliations/" + result.id;
}

it("moves whole receipts once, preserves invoice applications and clears one bank line", async () => {
  const co = await company();
  const item = await co.client.ok("POST", "/items", { sku: "S-DEP", name: "Work", type: "service", salesPrice: "20.00" });
  const invoice = await co.client.ok("POST", "/invoices", {
    customerId: co.buyer, issueDate: "2026-03-01", dueDate: "2026-03-31", taxRate: "0",
    lines: [{ itemId: item.id, quantity: "1", unitPrice: "20.00" }],
  });
  const first = await receipt(co, "28.54", "2026-03-02", { applications: [{ invoiceId: invoice.id, amount: "20.00" }] });
  const nextBuyer = await co.client.ok("POST", "/customers", { displayName: "Second buyer" });
  const second = await receipt(co, "9.01", "2026-03-13", { customerId: nextBuyer.id });
  expect(await eligible(co.client, "2026-03-02")).toEqual([first.id]);
  const original = await co.client.ok("GET", "/payments/" + first.id);
  const deposit = await co.client.ok("POST", "/deposits", batch(co, [first.id, second.id]), idem());
  const detail = await co.client.ok("GET", "/deposits/" + deposit.id);
  expect(detail).toMatchObject({ total: "37.55", status: "posted", bankAccountId: co.bank, date: "2026-03-15" });
  expect(detail.receipts.map((r: { id: string }) => r.id).sort()).toEqual([first.id, second.id].sort());
  expect(await eligible(co.client)).toEqual([]);
  const journal = await co.client.ok("GET", "/journal-entries/" + detail.journalEntryId);
  expect(journal).toMatchObject({ sourceType: "deposit", sourceId: deposit.id });
  expect(journal.lines).toHaveLength(2);
  expect(journal.lines).toEqual(expect.arrayContaining([
    expect.objectContaining({ accountId: co.bank, debit: "37.55", credit: "0.00" }),
    expect.objectContaining({ accountId: co.holding, debit: "0.00", credit: "37.55" }),
  ]));
  expect(await balance(co.client, co.holding, "2026-03-14")).toBe("37.55");
  expect(await balance(co.client, co.holding, "2026-03-15")).toBe("0.00");
  expect(await balance(co.client, co.bank, "2026-03-15")).toBe("37.55");
  const after = await co.client.ok("GET", "/payments/" + first.id);
  expect(after).toMatchObject({ applications: original.applications, unappliedAmount: "8.54", journalEntryId: original.journalEntryId });
  const path = await statement(co, [{ externalId: "DEPOSIT", amount: "37.55" }]);
  const s = await co.client.ok("GET", path);
  expect(s.candidates).toHaveLength(1);
  expect(s.candidates[0]).toMatchObject({ entryId: detail.journalEntryId, amount: "37.55" });
  await co.client.ok("POST", path + "/lines/" + s.lines[0].id + "/match", { journalLineId: s.candidates[0].id });
  await co.client.ok("POST", path + "/close");
  expect((await co.client.ok("GET", path)).closedSummary).toMatchObject({ difference: "0.00", outstandingCount: 0 });
  expect((await co.client.ok("GET", "/deposits/" + deposit.id)).matchedStatementId).toBe(s.statement.id);
  expect((await co.client.req("POST", "/deposits/" + deposit.id + "/void", { date: "2026-04-01", reason: "Entry error" })).status).toBe(409);
  rejected(await co.client.req("POST", "/journal-entries/" + journal.id + "/reverse", { date: "2026-04-01" }));
});

it("identical simultaneous requests post once and changed input conflicts with the original key", async () => {
  const co = await company();
  const a = await receipt(co, "1.97");
  const b = await receipt(co, "2.14");
  const input = batch(co, [a.id, b.id]);
  const key = idem();
  const initial = (await co.client.ok("GET", "/journal-entries")).total;
  const res = await Promise.all([input, { ...input, paymentIds: [b.id, a.id] }].map(body => co.client.req("POST", "/deposits", body, key)));
  expect(res.map(r => r.status).sort()).toEqual([200, 201]);
  expect(res[0]!.body.id).toBe(res[1]!.body.id);
  for (const change of [{ bankAccountId: co.savings }, { memo: "Changed" }, { date: "2026-03-16" }, { paymentIds: [a.id] }]) {
    expect((await co.client.req("POST", "/deposits", { ...input, ...change }, key)).status).toBe(409);
  }
  expect((await co.client.ok("GET", "/journal-entries")).total).toBe(initial + 1);
  expect((await co.client.ok("GET", "/deposits")).data).toHaveLength(1);
  const audit = await co.client.ok("GET", "/audit-events?entityType=deposit&entityId=" + res[0]!.body.id);
  expect(audit.data.map((e: { action: string }) => e.action)).toEqual(["deposit.posted"]);
});

it("overlapping requests to different banks cannot claim the same receipt or consume the loser's receipts", async () => {
  const co = await company();
  const shared = await receipt(co, "4.00");
  const a = await receipt(co, "1.00");
  const b = await receipt(co, "2.00");
  const res = await Promise.all([
    co.client.req("POST", "/deposits", batch(co, [shared.id, a.id]), idem()),
    co.client.req("POST", "/deposits", { ...batch(co, [b.id, shared.id]), bankAccountId: co.savings }, idem()),
  ]);
  expect(res.map(r => r.status).sort()).toEqual([201, 409]);
  expect(await eligible(co.client)).toEqual([res[0]!.status === 201 ? b.id : a.id]);
  expect((await co.client.ok("GET", "/journal-entries")).total).toBe(4);
});

it("rejects incompatible or unposted-date receipts atomically and accepts an explicit holding-account receipt", async () => {
  const co = await company();
  const held = await receipt(co, "5.00", "2026-03-01", { depositAccountId: co.holding });
  const direct = await receipt(co, "5.00", "2026-03-01", { depositAccountId: co.bank });
  const later = await receipt(co, "2.00", "2026-04-02");
  const input = batch(co, [held.id]);
  rejected(await co.client.req("POST", "/deposits", input));
  for (const invalid of [
    { paymentIds: [] }, { paymentIds: [held.id, held.id] }, { paymentIds: [held.id, direct.id] },
    { paymentIds: [held.id, later.id] }, { paymentIds: [randomUUID()] }, { bankAccountId: co.holding },
  ]) rejected(await co.client.req("POST", "/deposits", { ...input, ...invalid }, idem()));
  await co.client.ok("PATCH", "/accounts/" + co.savings, { isActive: false });
  rejected(await co.client.req("POST", "/deposits", { ...input, bankAccountId: co.savings }, idem()));
  expect((await co.client.ok("GET", "/deposits")).data).toHaveLength(0);
  expect(await eligible(co.client, "2026-03-31")).toEqual([held.id]);
  expect(await eligible(co.client)).toEqual([held.id, later.id].sort());
});

it("reverses on the correction date, preserves the receipt trail and prevents historical double counting", async () => {
  const co = await company();
  const a = await receipt(co, "13.33");
  const key = idem();
  const input = batch(co, [a.id]);
  const dep = await co.client.ok("POST", "/deposits", input, key);
  const path = "/deposits/" + dep.id;
  rejected(await co.client.req("POST", path + "/void", { date: "2026-03-14", reason: "Too early" }));
  const correction = { date: "2026-04-02", reason: "Wrong bank account" };
  const responses = await Promise.all([1, 2].map(() => co.client.req("POST", path + "/void", correction)));
  expect(responses.every(r => r.status === 200)).toBe(true);
  expect((await co.client.req("POST", path + "/void", { ...correction, date: "2026-04-03" })).status).toBe(409);
  const voided = await co.client.ok("GET", path);
  expect(voided).toMatchObject({ status: "void", voidDate: correction.date, receipts: [expect.objectContaining({ id: a.id })] });
  const reverse = await co.client.ok("GET", "/journal-entries/" + voided.voidJournalEntryId);
  expect(reverse).toMatchObject({ sourceType: "deposit_void", reversalOfId: dep.journalEntryId, sourceId: dep.id });
  expect(await balance(co.client, co.bank, "2026-04-01")).toBe("13.33");
  expect(await balance(co.client, co.bank, "2026-04-02")).toBe("0.00");
  expect(await balance(co.client, co.holding, "2026-04-02")).toBe("13.33");
  expect((await co.client.ok("POST", "/deposits", input, key)).id).toBe(dep.id);
  expect(await eligible(co.client, "2026-04-01")).toEqual([]);
  expect(await eligible(co.client, "2026-04-02")).toEqual([a.id]);
  rejected(await co.client.req("POST", "/deposits", batch(co, [a.id], "2026-04-01"), idem()));
  const newDeposit = await co.client.ok("POST", "/deposits", { ...batch(co, [a.id], correction.date), bankAccountId: co.savings }, idem());
  expect(newDeposit.id).not.toBe(dep.id);
  const audit = await co.client.ok("GET", "/audit-events?entityType=deposit&entityId=" + dep.id);
  expect(audit.data.map((e: { action: string }) => e.action)).toEqual(["deposit.voided", "deposit.posted"]);
});

it("enforces closed books on the deposit and the correction and rolls back partial changes", async () => {
  const co = await company();
  const p = await receipt(co, "8.99");
  await co.client.ok("PATCH", "/org", { booksClosedThrough: "2026-03-15" });
  const refused = await co.client.req("POST", "/deposits", batch(co, [p.id]), idem());
  expect(refused.body.error.code).toBe("period_closed");
  expect(await eligible(co.client)).toEqual([p.id]);
  const dep = await co.client.ok("POST", "/deposits", batch(co, [p.id], "2026-03-16"), idem());
  await co.client.ok("PATCH", "/org", { booksClosedThrough: "2026-03-31" });
  const reverse = await co.client.req("POST", "/deposits/" + dep.id + "/void", { date: "2026-03-30", reason: "Correction" });
  expect(reverse.body.error.code).toBe("period_closed");
  expect((await co.client.ok("GET", "/deposits/" + dep.id)).status).toBe("posted");
  expect(await eligible(co.client)).toEqual([]);
});

it("enforces roles and organization boundaries for headers, receipt IDs, destinations and corrections", async () => {
  const co = await company();
  const other = await company();
  const p = await receipt(co, "6.43");
  const foreign = await receipt(other, "5.00");
  const viewer = await addMember(ctx.app, co.client, "viewer");
  const accountant = await addMember(ctx.app, co.client, "accountant");
  const input = batch(co, [p.id]);
  expect((await viewer.req("POST", "/deposits", input, idem())).status).toBe(403);
  rejected(await accountant.req("POST", "/deposits", { ...input, paymentIds: [p.id, foreign.id] }, idem()));
  rejected(await accountant.req("POST", "/deposits", { ...input, bankAccountId: other.bank }, idem()));
  const dep = await accountant.ok("POST", "/deposits", input, idem("same-tenant-independent"));
  await other.client.ok("POST", "/deposits", batch(other, [foreign.id]), idem("same-tenant-independent"));
  expect((await viewer.ok("GET", "/deposits/" + dep.id)).id).toBe(dep.id);
  expect((await other.client.req("GET", "/deposits/" + dep.id)).status).toBe(404);
  const fix = { date: "2026-04-01", reason: "Duplicate entry" };
  expect((await viewer.req("POST", "/deposits/" + dep.id + "/void", fix)).status).toBe(403);
  expect((await other.client.req("POST", "/deposits/" + dep.id + "/void", fix)).status).toBe(404);
  expect((await other.client.ok("GET", "/deposits")).data.map((r: { id: string }) => r.id)).not.toContain(dep.id);
});

it("checks a grouped total against the journal's precision and retains valid large cents exactly", async () => {
  const co = await company();
  const a = await receipt(co, "9999999999999999.98");
  const b = await receipt(co, "0.02");
  const c = await receipt(co, "0.01");
  rejected(await co.client.req("POST", "/deposits", batch(co, [a.id, b.id]), idem()));
  expect(await eligible(co.client)).toEqual([a.id, b.id, c.id].sort());
  const dep = await co.client.ok("POST", "/deposits", batch(co, [a.id, c.id]), idem());
  expect(dep.total).toBe("9999999999999999.99");
  expect(await balance(co.client, co.bank, "2026-03-31")).toBe("9999999999999999.99");
});

it("keeps a voided deposit outstanding before its reversal, then removes the cancelling pair", async () => {
  const co = await company();
  const p = await receipt(co, "17.23");
  const dep = await co.client.ok("POST", "/deposits", batch(co, [p.id]), idem());
  const march = await statement(co, []);
  await co.client.ok("POST", march + "/close");
  await co.client.ok("POST", "/deposits/" + dep.id + "/void", { date: "2026-04-02", reason: "Duplicate deposit slip" });
  const historical = await co.client.ok("GET", march);
  expect(historical.summary).toMatchObject({ outstandingCount: 1, outstandingAmount: "17.23", bookBalance: "17.23", difference: "0.00" });
  expect(historical.closedSummary).toEqual(historical.summary);
  const april = await statement(co, [], { externalId: "April", startDate: "2026-04-01", endDate: "2026-04-30" });
  const current = await co.client.ok("GET", april);
  expect(current.summary).toMatchObject({ outstandingCount: 0, bookBalance: "0.00", difference: "0.00" });
  expect(current.candidates).toEqual([]);
  await co.client.ok("POST", april + "/close");
});

it("serializes a competing match and cancellation and never clears a cancelled deposit", async () => {
  const co = await company();
  const p = await receipt(co, "8.31");
  const dep = await co.client.ok("POST", "/deposits", batch(co, [p.id]), idem());
  const path = await statement(co, [{ externalId: "cash", amount: "8.31" }]);
  const d = await co.client.ok("GET", path);
  const match = path + "/lines/" + d.lines[0].id + "/match";
  const target = { journalLineId: d.candidates[0].id };
  const fix = { date: "2026-03-21", reason: "Cancelled before banking" };
  const depositPath = "/deposits/" + dep.id;
  const [clear, cancel] = await Promise.all([
    co.client.req("POST", match, target), co.client.req("POST", depositPath + "/void", fix),
  ]);
  expect([clear.status, cancel.status].filter(s => s === 200)).toHaveLength(1);
  rejected(clear.status === 200 ? cancel : clear);
  if (clear.status === 200) {
    expect((await co.client.ok("GET", depositPath)).status).toBe("posted");
    await co.client.ok("POST", path + "/lines/" + d.lines[0].id + "/unmatch", { expectedJournalLineId: target.journalLineId });
    await co.client.ok("POST", depositPath + "/void", fix);
  }
  rejected(await co.client.req("POST", match, target));
  const pending = await co.client.ok("GET", path);
  expect(pending.lines[0].journalLineId).toBeNull();
  expect(pending.candidates).toEqual([]);
  expect(await eligible(co.client)).toEqual([p.id]);
});

it("protects deposits included in an approved opening and permits correction after reopening", async () => {
  const co = await company();
  const p = await receipt(co, "4.37", "2026-02-01");
  const dep = await co.client.ok("POST", "/deposits", batch(co, [p.id], "2026-02-26"), idem());
  const path = "/deposits/" + dep.id;
  const first = await statement(co, [], { openingBalance: "4.37", closingBalance: "4.37" });
  expect((await co.client.ok("GET", path)).baselineStatementId).toBeNull();
  await co.client.ok("POST", first + "/close");
  const approved = await co.client.ok("GET", path);
  expect(approved.matchedStatementId).toBeNull();
  expect(first).toBe("/bank-reconciliations/" + approved.baselineStatementId);
  const fix = { date: "2026-03-01", reason: "Incorrect deposit recorded in February" };
  expect((await co.client.req("POST", path + "/void", fix)).status).toBe(409);
  await co.client.ok("POST", first + "/reopen");
  expect((await co.client.ok("GET", path)).baselineStatementId).toBeNull();
  await co.client.ok("POST", path + "/void", fix);
  expect((await co.client.ok("GET", first)).canClose).toBe(false);
});

it("a deposit backdated after approval is absent from that approved opening", async () => {
  const co = await company();
  const p = await receipt(co, "7.77", "2026-02-01");
  const first = await statement(co, []);
  await co.client.ok("POST", first + "/close");
  const dep = await co.client.ok("POST", "/deposits", batch(co, [p.id], "2026-02-25"), idem());
  const path = "/deposits/" + dep.id;
  expect((await co.client.ok("GET", path)).baselineStatementId).toBeNull();
  await co.client.ok("POST", path + "/void", { date: "2026-02-26", reason: "Correction of late entry" });
  const reconciled = await co.client.ok("GET", first);
  expect(reconciled.statement.status).toBe("closed");
  expect(reconciled.summary).toEqual(reconciled.closedSummary);
});

it("accepts the full 500-receipt batch and leaves the next receipt available", async () => {
  const co = await company();
  const paymentIds: string[] = [];
  for (let n = 0; n < 50; n++) {
    const group = await Promise.all(Array.from({ length: 10 }, () => receipt(co, "0.01")));
    paymentIds.push(...group.map(p => p.id));
  }
  const spare = await receipt(co, "0.02");
  expect((await co.client.req("POST", "/deposits", batch(co, [...paymentIds, spare.id]), idem())).status).toBe(400);
  const deposit = await co.client.ok("POST", "/deposits", batch(co, paymentIds), idem());
  const detail = await co.client.ok("GET", "/deposits/" + deposit.id);
  expect(detail.total).toBe("5.00");
  expect(detail.receipts).toHaveLength(500);
  expect(await eligible(co.client)).toEqual([spare.id]);
});
