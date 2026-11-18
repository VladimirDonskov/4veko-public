import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cents, dec } from "../src/lib/money";
import { addMember, setupApp, setupCompany, signUp, TestClient } from "./helpers";

let ctx: Awaited<ReturnType<typeof setupApp>>;
let owner: TestClient;
let other: TestClient;
let co: Awaited<ReturnType<typeof setupCompany>>;

beforeAll(async () => {
  ctx = await setupApp();
  owner = (await signUp(ctx.app)).client;
  other = (await signUp(ctx.app)).client;
  co = await setupCompany(owner);
  const customerId = co.customer.id;
  const vendorId = (await owner.ok("POST", "/vendors", { displayName: "Workshop Supplies" })).id;

  async function invoice(issueDate: string, dueDate: string, amount: string) {
    return owner.ok("POST", "/invoices", {
      customerId, issueDate, dueDate, taxRate: "0",
      lines: [{ itemId: co.service.id, quantity: "1", unitPrice: amount }],
    });
  }
  async function bill(billDate: string, dueDate: string, amount: string) {
    return owner.ok("POST", "/bills", {
      vendorId, vendorReference: "WS-" + billDate, billDate, dueDate,
      expenseLines: [{ accountId: co.acct("6300"), amount }],
    });
  }

  const firstInvoice = await invoice("2024-01-10", "2024-01-31", "100.37");
  const firstBill = await bill("2024-01-10", "2024-01-31", "100.37");
  const futureInvoice = await invoice("2024-03-01", "2024-03-31", "15.00");
  const futureBill = await bill("2024-03-01", "2024-03-31", "15.00");
  const voidInvoice = await invoice("2024-01-11", "2024-01-31", "50.00");
  const voidBill = await bill("2024-01-11", "2024-01-31", "50.00");
  await owner.ok("POST", `/invoices/${voidInvoice.id}/void`, { date: "2024-02-02" });
  await owner.ok("POST", `/bills/${voidBill.id}/void`, { date: "2024-02-02" });
  // One payment may cover current and future documents. Before the latter
  // takes effect its share is an advance, even when it is already allocated.
  await owner.ok("POST", "/payments", {
    customerId, date: "2024-01-31", method: "ach", amount: "38.11",
    applications: [{ invoiceId: firstInvoice.id, amount: "20.11" }, { invoiceId: futureInvoice.id, amount: "15.00" }],
  });
  await owner.ok("POST", "/bill-payments", {
    vendorId, date: "2024-01-31", method: "ach",
    applications: [{ billId: firstBill.id, amount: "20.11" }, { billId: futureBill.id, amount: "15.00" }],
  });
  await owner.ok("POST", "/payments", {
    customerId, date: "2024-05-02", method: "ach", amount: "80.26",
    applications: [{ invoiceId: firstInvoice.id, amount: "80.26" }],
  });
  await owner.ok("POST", "/bill-payments", {
    vendorId, date: "2024-05-02", method: "ach", applications: [{ billId: firstBill.id, amount: "80.26" }],
  });
});
afterAll(() => ctx.close());

describe.each(["ar", "ap"] as const)("%s aging at an accounting cutoff", (side) => {
  const isAr = side === "ar";
  const path = `/reports/${side}-aging`;
  it.each([
    // Cutoff       Due bucket  Outstanding  Advance or residual credit
    ["2024-01-09", "current", "0.00", "0.00"],
    ["2024-01-10", "current", "100.37", "0.00"],
    ["2024-01-31", "current", "130.26", isAr ? "18.00" : "15.00"],
    ["2024-02-01", "1-30",   "130.26", isAr ? "18.00" : "15.00"],
    ["2024-02-02", "1-30",    "80.26", isAr ? "18.00" : "15.00"],
    ["2024-03-01", "1-30",    "80.26", isAr ? "3.00" : "0.00"],
    ["2024-03-02", "31-60",   "80.26", isAr ? "3.00" : "0.00"],
    ["2024-04-01", "61-90",   "80.26", isAr ? "3.00" : "0.00"],
    ["2024-05-01", "over90",  "80.26", isAr ? "3.00" : "0.00"],
    ["2024-05-02", "over90",   "0.00", isAr ? "3.00" : "0.00"],
  ])("reconciles documents and payments to the ledger on %s", async (date, bucket, outstanding, credit) => {
    const report = await owner.ok("GET", `${path}?asOf=${date}`);
    const trial = await owner.ok("GET", `/reports/trial-balance?asOf=${date}`);
    const accountId = co.sys(isAr ? "accounts_receivable" : "accounts_payable");
    const control = trial.lines.find((r: { accountId: string }) => r.accountId === accountId);
    const net = control ? dec(control.debit).minus(control.credit) : dec(0);
    const expected = cents(dec(outstanding).minus(credit));
    const byBucket: Record<string, string> = { current: "0.00", "1-30": "0.00", "31-60": "0.00", "61-90": "0.00", over90: "0.00" };
    byBucket[bucket] = outstanding;
    if (isAr) byBucket.unappliedCredits = credit;
    else byBucket.current = cents(dec(byBucket.current).minus(credit));
    expect(report.asOf).toBe(date);
    expect(report.totals).toEqual({ ...byBucket, total: expected });
    expect(report.totals.total).toBe(cents(isAr ? net : net.negated()));
    const rows = isAr ? report.customers : report.vendors;
    if (outstanding === "0.00" && credit === "0.00") expect(rows).toEqual([]);
    else expect(rows).toEqual([expect.objectContaining({ ...byBucket, total: expected })]);
  });

  it("returns no historical rows from another organization", async () => {
    const report = await other.ok("GET", path + "?asOf=2024-02-01");
    expect(isAr ? report.customers : report.vendors).toEqual([]);
    expect(report.totals.total).toBe("0.00");
  });

  it("rejects invalid calendar dates and accepts leap days", async () => {
    for (const date of ["2023-02-29", "2024-04-31", "0000-01-01"]) {
      expect((await owner.req("GET", `${path}?asOf=${date}`)).status).toBe(400);
    }
    expect((await owner.req("GET", path + "?asOf=2024-02-29")).status).toBe(200);
  });
});

describe("control account reconciliation", () => {
  const path = "/reports/control-reconciliation";
  it("keeps aggregate turnover and balances wider than one journal line", async () => {
    const { client } = await signUp(ctx.app);
    const { data } = await client.ok("GET", "/accounts");
    const id = (key: string) => data.find((a: { systemKey: string }) => a.systemKey === key).id;
    const postings = [];
    for (let i = 0; i < 2; i++) {
      postings.push(await client.ok("POST", "/journal-entries", {
        date: "2024-07-01", lines: [
          { accountId: id("accounts_receivable"), debit: "9000000000000000.01" },
          { accountId: id("opening_balance_equity"), credit: "9000000000000000.01" },
        ],
      }));
    }
    const atClose = await client.ok("GET", path + "?asOf=2024-07-01");
    expect(atClose.rows[0].difference).toBe("18000000000000000.02");
    for (const entry of postings) {
      await client.ok("POST", `/journal-entries/${entry.id}/reverse`, { date: "2024-07-02" });
    }
    const afterReversal = await client.ok("GET", path + "?asOf=2024-07-02");
    expect(afterReversal.rows[0].difference).toBe("0.00");
  });
  it("exposes signed manual differences until the effective reversal and keeps aging independent", async () => {
    const entry = await owner.ok("POST", "/journal-entries", {
      date: "2024-05-04", memo: "Opening differences",
      lines: [
        { accountId: co.sys("accounts_receivable"), debit: "3.17" },
        { accountId: co.sys("accounts_payable"), debit: "2.41" },
        { accountId: co.sys("cash_operating"), credit: "5.58" },
      ],
    });
    await owner.ok("POST", `/journal-entries/${entry.id}/reverse`, { date: "2024-05-06" });

    for (const [date, arLedger, arSub, arDiff, apLedger, apSub, apDiff] of [
      ["2024-01-09", "0.00", "0.00", "0.00", "0.00", "0.00", "0.00"],
      ["2024-01-31", "112.26", "112.26", "0.00", "115.26", "115.26", "0.00"],
      ["2024-05-03", "-3.00", "-3.00", "0.00", "0.00", "0.00", "0.00"],
      ["2024-05-04", "0.17", "-3.00", "3.17", "-2.41", "0.00", "-2.41"],
      ["2024-05-06", "-3.00", "-3.00", "0.00", "0.00", "0.00", "0.00"],
    ]) {
      expect(await owner.ok("GET", `${path}?asOf=${date}`)).toEqual({
        asOf: date,
        rows: [
          { key: "accounts_receivable", accountId: co.sys("accounts_receivable"), number: "1200", name: "Accounts Receivable", ledgerBalance: arLedger, subledgerBalance: arSub, difference: arDiff },
          { key: "accounts_payable", accountId: co.sys("accounts_payable"), number: "2000", name: "Accounts Payable", ledgerBalance: apLedger, subledgerBalance: apSub, difference: apDiff },
        ],
      });
    }
  });

  it("includes both zero-activity accounts for a separate tenant's viewer and requires sign-in", async () => {
    const viewer = await addMember(ctx.app, other, "viewer");
    const report = await viewer.ok("GET", path + "?asOf=2024-05-04");
    expect(report.rows).toHaveLength(2);
    for (const row of report.rows) {
      expect(row.accountId).not.toBe(co.sys(row.key));
      expect([row.ledgerBalance, row.subledgerBalance, row.difference]).toEqual(["0.00", "0.00", "0.00"]);
    }
    expect((await new TestClient(ctx.app).req("GET", path)).status).toBe(401);
    expect((await viewer.req("GET", path + "?asOf=2023-02-29")).status).toBe(400);
  });

  it("shows a consistent ledger and subledger while invoices are being posted", async () => {
    const client = (await signUp(ctx.app)).client;
    const company = await setupCompany(client);
    const cutoff = path + "?asOf=2024-06-01";
    async function postInvoices() {
      for (let n = 0; n < 8; n++) {
        await client.ok("POST", "/invoices", {
          customerId: company.customer.id, issueDate: "2024-06-01", taxRate: "0",
          lines: [{ itemId: company.service.id, quantity: "1", unitPrice: "10.13" }],
        });
      }
    }
    async function readReports() {
      for (let n = 0; n < 12; n++) {
        const report = await client.ok("GET", cutoff);
        expect(report.rows.map((r: { difference: string }) => r.difference)).toEqual(["0.00", "0.00"]);
      }
    }
    await Promise.all([postInvoices(), readReports()]);
    expect((await client.ok("GET", cutoff)).rows[0]).toMatchObject({
      ledgerBalance: "81.04", subledgerBalance: "81.04", difference: "0.00",
    });
  });
});
