import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, expect, it } from "vitest";
import { addMember, setupApp, signUp, type TestClient } from "./helpers";

const root = "/bank-reconciliations";
let ctx: Awaited<ReturnType<typeof setupApp>>;
beforeEach(async () => { ctx = await setupApp(); });
afterEach(() => ctx.close());

async function company() {
  const { client, organizationId } = await signUp(ctx.app);
  const { data }: { data: { id: string; number: string }[] } = await client.ok("GET", "/accounts");
  function account(number: string) { return data.find(a => a.number === number)!.id; }
  return { client, organizationId, bank: account("1010"), savings: account("1020"), equity: account("3000") };
}

async function post(client: TestClient, bank: string, equity: string, date: string, signed: string) {
  const negative = signed.startsWith("-");
  const amount = negative ? signed.slice(1) : signed;
  const entry = await client.ok("POST", "/journal-entries", {
    date, lines: [
      { accountId: bank, [negative ? "credit" : "debit"]: amount },
      { accountId: equity, [negative ? "debit" : "credit"]: amount },
    ],
  });
  const detail = await client.ok("GET", `/journal-entries/${entry.id}`);
  return (detail.lines as { accountId: string; id: string }[]).find(l => l.accountId === bank)!.id;
}

function line(externalId: string, amount: string, date = "2026-03-15") {
  return { externalId, date, description: `Bank reference ${externalId}`, amount };
}
function march(accountId: string, lines: ReturnType<typeof line>[] = [], closingBalance = "0.00") {
  return { accountId, externalId: "MARCH", startDate: "2026-03-01", endDate: "2026-03-31", openingBalance: "0.00", closingBalance, lines };
}
function april(accountId: string, lines: ReturnType<typeof line>[], openingBalance: string, closingBalance: string) {
  return { accountId, externalId: "APRIL", startDate: "2026-04-01", endDate: "2026-04-30", openingBalance, closingBalance, lines };
}
async function importStatement(client: TestClient, input: ReturnType<typeof march>) {
  const res = await client.ok("POST", root + "/import", input);
  return `${root}/${res.id}`;
}
function rejected(result: { status: number }) {
  expect([400, 404, 409, 422]).toContain(result.status);
}

it("concurrent imports have one effect and changed content cannot overwrite the original", async () => {
  const { client, bank } = await company();
  const input = march(bank, [line("A", "10.12"), line("B", "-0.22")], "9.90");
  const result = await Promise.all([client.req("POST", root + "/import", input), client.req("POST", root + "/import", input)]);
  expect(result.map(r => r.status).sort()).toEqual([200, 201]);
  expect(result[0]!.body.id).toBe(result[1]!.body.id);
  expect(result.map(r => r.body.imported).sort()).toEqual([0, 2]);
  const replay = await client.ok("POST", root + "/import", { ...input, lines: [...input.lines].reverse() });
  expect(replay).toMatchObject({ duplicate: true, imported: 0 });
  const changed = { ...input, lines: [line("A", "10.12"), { ...line("B", "-0.22"), description: "Different text" }] };
  rejected(await client.req("POST", root + "/import", changed));
  const id = result[0]!.body.id;
  const detail = await client.ok("GET", `${root}/${id}`);
  expect(detail.lines).toHaveLength(2);
  const history = await client.ok("GET", `/audit-events?entityType=bank_statement&entityId=${id}`);
  expect(history.data.map((e: { action: string }) => e.action)).toEqual(["bank_statement.imported"]);
  expect((await client.ok("GET", "/journal-entries")).total).toBe(0);
});

it("a check clearing next month stays outstanding in the earlier statement", async () => {
  const { client, bank, equity } = await company();
  await post(client, bank, equity, "2026-02-01", "125.00");
  const deposit = await post(client, bank, equity, "2026-03-10", "20.13");
  const check = await post(client, bank, equity, "2026-03-31", "-3.17");
  await post(client, bank, equity, "2026-05-01", "80.00");
  const m = { ...march(bank, [line("D", "20.13")], "145.13"), openingBalance: "125.00" };
  const first = await importStatement(client, m);
  const d = await client.ok("GET", first);
  const match = first + "/lines/" + d.lines[0].id + "/match";
  await client.ok("POST", match, { journalLineId: deposit });
  const cleared = await client.ok("GET", first);
  expect(cleared.summary).toMatchObject({ bookBalance: "141.96", outstandingAmount: "-3.17", adjustedBankBalance: "141.96", difference: "0.00", unmatchedCount: 0, outstandingCount: 1 });
  expect(cleared.candidates.map((c: { id: string }) => c.id)).toEqual([check]);
  await client.ok("POST", first + "/close");
  expect(await client.ok("POST", root + "/import", m)).toMatchObject({ imported: 0, duplicate: true });
  rejected(await client.req("POST", first + "/lines/" + d.lines[0].id + "/unmatch"));
  const second = await importStatement(client, april(bank, [line("C", "-3.17", "2026-04-04")], "145.13", "141.96"));
  const a = await client.ok("GET", second);
  await client.ok("POST", second + "/lines/" + a.lines[0].id + "/match", { journalLineId: check });
  await client.ok("POST", second + "/close");
  expect((await client.ok("GET", second)).summary).toMatchObject({ outstandingCount: 0, difference: "0.00" });
  expect((await client.ok("GET", first)).summary).toEqual(cleared.summary);
  rejected(await client.req("POST", first + "/reopen"));
  await client.ok("POST", second + "/reopen");
  await client.ok("POST", second + "/lines/" + a.lines[0].id + "/unmatch");
  expect((await client.ok("GET", second)).summary.unmatchedCount).toBe(1);
  const audit = await client.ok("GET", "/audit-events?entityType=bank_statement&entityId=" + a.statement.id);
  expect(audit.data.map((e: { action: string }) => e.action)).toEqual([
    "bank_statement.unmatched", "bank_statement.reopened", "bank_statement.closed", "bank_statement.matched", "bank_statement.imported",
  ]);
  expect((await client.ok("GET", "/journal-entries")).total).toBe(4);
});

it("zero net movement cannot conceal unmatched offsetting lines or a wrong opening balance", async () => {
  const { client, bank, equity } = await company();
  await post(client, bank, equity, "2026-02-01", "1.01");
  const wrong = await importStatement(client, march(bank));
  expect((await client.ok("GET", wrong)).summary.difference).not.toBe("0.00");
  rejected(await client.req("POST", wrong + "/close"));
  await client.ok("DELETE", wrong);
  const corrected = await importStatement(client, { ...march(bank, [line("in", "25.00"), line("out", "-25.00")], "1.01"), openingBalance: "1.01" });
  expect((await client.ok("GET", corrected)).summary).toMatchObject({ difference: "0.00", unmatchedCount: 2 });
  rejected(await client.req("POST", corrected + "/close"));
  expect((await client.ok("GET", "/journal-entries")).total).toBe(1);
});

it("a journal line cannot clear two equal bank transactions, including concurrent assignments", async () => {
  const { client, bank, equity, savings } = await company();
  const accepted = await post(client, bank, equity, "2026-03-10", "5.00");
  const bad = await Promise.all([
    post(client, savings, equity, "2026-03-10", "5.00"),
    post(client, bank, equity, "2026-04-01", "5.00"),
    post(client, bank, equity, "2026-03-10", "-5.00"),
  ]);
  const path = await importStatement(client, march(bank, [line("1", "5.00"), line("2", "5.00")], "10.00"));
  const detail = await client.ok("GET", path);
  const match = (id: string, journalLineId: string) => client.req("POST", path + "/lines/" + id + "/match", { journalLineId });
  for (const invalid of bad) rejected(await match(detail.lines[0].id, invalid));
  const responses = await Promise.all(detail.lines.map((l: { id: string }) => match(l.id, accepted)));
  expect(responses.filter(r => r.status === 200)).toHaveLength(1);
  rejected(responses.find(r => r.status !== 200)!);
  rejected(await client.req("DELETE", path));
  expect((await client.ok("GET", path)).summary.unmatchedCount).toBe(1);
});

it("separates organizations, bank accounts, read access, clearing and reopening", async () => {
  const { client, bank, equity } = await company();
  const other = await company();
  const path = await importStatement(client, march(bank, [line("shared", "7.55")], "7.55"));
  const input = march(other.bank, [line("shared", "7.55")], "7.55");
  await importStatement(other.client, input);
  expect((await other.client.req("GET", path)).status).toBe(404);
  expect((await other.client.req("POST", path + "/close")).status).toBe(404);
  expect((await other.client.req("DELETE", path)).status).toBe(404);
  rejected(await other.client.req("POST", root + "/import", march(bank)));
  const viewer = await addMember(ctx.app, client, "viewer");
  const accountant = await addMember(ctx.app, client, "accountant");
  const d = await viewer.ok("GET", path);
  expect((await viewer.req("POST", root + "/import", march(bank))).status).toBe(403);
  expect((await viewer.req("DELETE", path)).status).toBe(403);
  const foreignLine = await post(other.client, other.bank, other.equity, "2026-03-06", "7.55");
  const match = path + "/lines/" + d.lines[0].id + "/match";
  rejected(await accountant.req("POST", match, { journalLineId: foreignLine }));
  const authorized = await post(client, bank, equity, "2026-03-06", "7.55");
  expect((await viewer.req("POST", match, { journalLineId: authorized })).status).toBe(403);
  await accountant.ok("POST", match, { journalLineId: authorized });
  await accountant.ok("POST", path + "/close");
  expect((await accountant.req("POST", path + "/reopen")).status).toBe(403);
  await client.ok("POST", path + "/reopen");
  const history = await client.ok("GET", "/audit-events?entityType=bank_statement&entityId=" + d.statement.id);
  expect(history.data).toContainEqual(expect.objectContaining({ action: "bank_statement.closed", actorName: "Test accountant" }));
  expect(history.data).toContainEqual(expect.objectContaining({ action: "bank_statement.reopened", actorName: "Test Owner" }));
});

it("rejects invalid imports atomically and permits empty statements on a continuous balance chain", async () => {
  const { client, bank, equity } = await company();
  const invalid = [
    march(equity), march(bank, [line("bad-date", "1.00", "2026-04-01")], "1.00"),
    march(bank, [line("duplicate", "1.00"), line("duplicate", "-1.00")]),
    march(bank, [line("wrong-total", "2.00")], "1.00"),
    march(bank, [line("rounding", "0.001")]), march(bank, [line("zero", "0.00")]),
  ];
  for (const input of invalid) rejected(await client.req("POST", root + "/import", input));
  expect((await client.ok("GET", root)).data).toHaveLength(0);
  const first = await importStatement(client, march(bank));
  const next = april(bank, [], "0.00", "0.00");
  rejected(await client.req("POST", root + "/import", { ...next, startDate: "2026-03-31" }));
  rejected(await client.req("POST", root + "/import", { ...next, startDate: "2026-04-02" }));
  rejected(await client.req("POST", root + "/import", { ...next, openingBalance: "1.00", closingBalance: "1.00" }));
  const second = await importStatement(client, next);
  rejected(await client.req("DELETE", first));
  rejected(await client.req("POST", second + "/close"));
  await client.ok("POST", first + "/close");
  await client.ok("POST", second + "/close");
  rejected(await client.req("DELETE", second));
});

it("clears cash journals from customer and vendor payments without altering either document", async () => {
  const { client, bank } = await company();
  const accounts: { data: { id: string; number: string }[] } = await client.ok("GET", "/accounts");
  const expense = accounts.data.find(account => account.number === "6300")!.id;
  const customer = await client.ok("POST", "/customers", { displayName: "Example buyer" });
  const vendor = await client.ok("POST", "/vendors", { displayName: "Example supplier" });
  const receipt = await client.ok("POST", "/payments", {
    customerId: customer.id, date: "2026-03-12", method: "ach", depositAccountId: bank,
    amount: "125.89", applications: [],
  });
  const bill = await client.ok("POST", "/bills", {
    vendorId: vendor.id, vendorReference: "EX-1", billDate: "2026-03-05", dueDate: "2026-03-30",
    expenseLines: [{ accountId: expense, amount: "20.20" }],
  });
  const payment = await client.ok("POST", "/bill-payments", {
    vendorId: vendor.id, date: "2026-03-12", method: "ach", applications: [{ billId: bill.id, amount: "20.20" }],
  });
  const before = await client.ok("GET", "/journal-entries");
  const path = await importStatement(client, march(bank, [line("incoming", "125.89"), line("outgoing", "-20.20")], "105.69"));
  const d = await client.ok("GET", path);
  expect(d.candidates).toHaveLength(2);
  for (const row of d.lines) {
    const ledgerLine = d.candidates.find((c: { amount: string }) => c.amount === row.amount);
    await client.ok("POST", path + "/lines/" + row.id + "/match", { journalLineId: ledgerLine.id });
  }
  await client.ok("POST", path + "/close");
  expect((await client.ok("GET", path)).summary).toMatchObject({ difference: "0.00", bookBalance: "105.69", outstandingCount: 0 });
  expect((await client.ok("GET", "/journal-entries")).total).toBe(before.total);
  expect((await client.ok("GET", "/payments/" + receipt.id)).amount).toBe("125.89");
  expect((await client.ok("GET", "/bill-payments/" + payment.id)).amount).toBe("20.20");
});

it("retains every cent at balances above JavaScript's safe integer range", async () => {
  const { client, bank, equity } = await company();
  await post(client, bank, equity, "2026-02-10", "8999999999999999.99");
  await post(client, bank, equity, "2026-02-11", "8999999999999999.99");
  const cash = await post(client, bank, equity, "2026-03-01", "-0.01");
  const path = await importStatement(client, {
    ...march(bank, [line("cent", "-0.01")], "17999999999999999.97"), openingBalance: "17999999999999999.98",
  });
  const d = await client.ok("GET", path);
  await client.ok("POST", path + "/lines/" + d.lines[0].id + "/match", { journalLineId: cash });
  await client.ok("POST", path + "/close");
  expect((await client.ok("GET", path)).summary).toMatchObject({
    difference: "0.00", bookBalance: "17999999999999999.97", adjustedBankBalance: "17999999999999999.97",
  });
});

it("keeps the figures approved at close when a newly posted entry carries an earlier date", async () => {
  const { client, bank, equity } = await company();
  const path = await importStatement(client, march(bank));
  await client.ok("POST", path + "/close");
  const approved = await client.ok("GET", path);
  expect(approved.closedSummary).toMatchObject({ bookBalance: "0.00", outstandingCount: 0, difference: "0.00" });
  await post(client, bank, equity, "2026-03-20", "-3.29");
  const revised = await client.ok("GET", path);
  expect(revised.statement.status).toBe("closed");
  expect(revised.closedSummary).toEqual(approved.closedSummary);
  expect(revised.summary).toMatchObject({ bookBalance: "-3.29", outstandingAmount: "-3.29", outstandingCount: 1 });
  await client.ok("POST", path + "/reopen");
  expect((await client.ok("GET", path)).closedSummary).toBeNull();
  await client.ok("POST", path + "/close");
  expect((await client.ok("GET", path)).closedSummary).toMatchObject({ bookBalance: "-3.29", outstandingCount: 1 });
});

it("a stale unmatch cannot remove a newer assignment", async () => {
  const { client, bank, equity } = await company();
  const first = await post(client, bank, equity, "2026-03-01", "7.00");
  const next = await post(client, bank, equity, "2026-03-02", "7.00");
  const path = await importStatement(client, march(bank, [line("ref", "7.00")], "7.00"));
  const d = await client.ok("GET", path);
  const row = path + "/lines/" + d.lines[0].id;
  await client.ok("POST", row + "/match", { journalLineId: first });
  await client.ok("POST", row + "/unmatch", { expectedJournalLineId: first });
  await client.ok("POST", row + "/match", { journalLineId: next });
  expect((await client.req("POST", row + "/unmatch", { expectedJournalLineId: first })).status).toBe(409);
  expect((await client.ok("GET", path)).lines[0].journalLineId).toBe(next);
});

it("rejects a bank transaction reused by a different statement, without consuming the new header", async () => {
  const { client, bank, savings } = await company();
  await importStatement(client, march(bank, [line("ref", "8.00")], "8.00"));
  const duplicated = april(bank, [line("ref", "2.00", "2026-04-20")], "8.00", "10.00");
  rejected(await client.req("POST", root + "/import", duplicated));
  expect((await client.ok("GET", root)).data).toHaveLength(1);
  await importStatement(client, { ...duplicated, lines: [line("other", "2.00", "2026-04-20")] });
  await importStatement(client, march(savings, [line("ref", "8.00")], "8.00"));
  expect((await client.ok("GET", root)).data).toHaveLength(3);
});

it("a close waits for an uncommitted cash posting and captures it in the approved balance", async () => {
  const { client, organizationId, bank, equity } = await company();
  const path = await importStatement(client, march(bank));
  const posting = await ctx.pool.connect();
  try {
    await posting.query("begin");
    const entry = await posting.query<{ id: string }>(
      "insert into journal_entries (organization_id, number, date, source_type) values ($1, 1, '2026-03-15', 'manual') returning id",
      [organizationId],
    );
    await posting.query(`
      insert into journal_lines (organization_id, journal_entry_id, line_no, account_id, debit, credit)
      values ($1,$2,1,$3,7.00,0), ($1,$2,2,$4,0,7.00)
    `, [organizationId, entry.rows[0]!.id, bank, equity]);
    const close = client.req("POST", path + "/close");
    let waiting = false;
    const deadline = Date.now() + 3000;
    while (!waiting && Date.now() < deadline) {
      const state = await posting.query<{ waits: boolean }>(`
        select exists(select 1 from pg_locks where not granted and pg_backend_pid() = any(pg_blocking_pids(pid))) as waits
      `);
      waiting = state.rows[0]!.waits;
      if (!waiting) await delay(10);
    }
    await posting.query("commit");
    expect((await close).status).toBe(200);
    expect(waiting).toBe(true);
    expect((await client.ok("GET", path)).closedSummary).toMatchObject({ bookBalance: "7.00", outstandingAmount: "7.00" });
  } finally {
    await posting.query("rollback");
    posting.release();
  }
});

it("imports the supported 1,000 lines atomically and rejects an oversized statement", async () => {
  const { client, bank } = await company();
  const rows = Array.from({ length: 1000 }, (_, i) => ({
    ...line("ref-" + i, "0.01"), description: "€".repeat(500),
  }));
  const input = march(bank, rows, "10.00");
  const path = await importStatement(client, input);
  expect((await client.ok("GET", path)).lines).toHaveLength(1000);
  expect(await client.ok("POST", root + "/import", input)).toMatchObject({ imported: 0, duplicate: true });
  rejected(await client.req("POST", root + "/import", { ...input, closingBalance: "10.01", lines: [...rows, line("extra", "0.01")] }));
});
