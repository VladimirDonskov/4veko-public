import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountBalance, addMember, setupApp, setupCompany, signUp, type TestClient } from "./helpers";

let ctx: Awaited<ReturnType<typeof setupApp>>;
let owner: TestClient;
let co: Awaited<ReturnType<typeof setupCompany>>;
let vendor: { id: string };

beforeAll(async () => {
  ctx = await setupApp();
  owner = (await signUp(ctx.app)).client;
  co = await setupCompany(owner);
  vendor = await owner.ok("POST", "/vendors", { displayName: "Acme Wholesale", termsDays: 30 });
});
afterAll(() => ctx.close());

/** Accounts Payable control account = open bill balances (AP aging total). */
async function expectApReconciles() {
  const aging = await owner.ok("GET", "/reports/ap-aging");
  expect(await accountBalance(owner, co.sys("accounts_payable"))).toBe(aging.totals.total);
}

/** Received Not Billed = Σ (received − billed) × order cost over every order line. */
async function expectAccrualReconciles(lines: { quantity: string; qtyReceived: string; qtyBilled: string; unitCost: string }[][]) {
  const expected = lines
    .flat()
    .reduce((a, l) => a + Math.round((Number(l.qtyReceived) - Number(l.qtyBilled)) * Number(l.unitCost) * 100), 0);
  expect(await accountBalance(owner, co.sys("received_not_billed"))).toBe((expected / 100).toFixed(2));
}

async function expectInventoryReconciles() {
  const inv = await owner.ok("GET", "/inventory");
  expect(await accountBalance(owner, co.sys("inventory"))).toBe(inv.totalValue);
}

async function newIssuedPo(quantity: string, unitCost: string, vendorId = vendor.id) {
  const po = await owner.ok("POST", "/purchase-orders", {
    vendorId,
    orderDate: "2026-05-01",
    lines: [{ itemId: co.widget.id, quantity, unitCost }],
  });
  await owner.ok("POST", `/purchase-orders/${po.id}/issue`);
  return (await owner.ok("GET", `/purchase-orders/${po.id}`)) as {
    id: string;
    number: string;
    status: string;
    lines: { id: string; quantity: string; qtyReceived: string; qtyBilled: string; unitCost: string }[];
  };
}

describe("procure to pay", () => {
  let po: Awaited<ReturnType<typeof newIssuedPo>>;
  let billId: string;

  it("creates a purchase order with server-side totals and edits it while draft", async () => {
    const draft = await owner.ok("POST", "/purchase-orders", {
      vendorId: vendor.id,
      orderDate: "2026-05-01",
      lines: [{ itemId: co.widget.id, quantity: "10", unitCost: "4.00" }],
    });
    expect(draft.status).toBe("draft");
    expect(draft.total).toBe("40.00");
    const edited = await owner.ok("PATCH", `/purchase-orders/${draft.id}`, {
      vendorId: vendor.id,
      orderDate: "2026-05-01",
      lines: [{ itemId: co.widget.id, quantity: "12", unitCost: "4.00" }],
    });
    expect(edited.total).toBe("48.00");
    await owner.ok("POST", `/purchase-orders/${draft.id}/issue`);
    expect((await owner.req("PATCH", `/purchase-orders/${draft.id}`, { vendorId: vendor.id, orderDate: "2026-05-01", lines: [{ itemId: co.widget.id, quantity: "1" }] })).status).toBe(409);
    await owner.ok("POST", `/purchase-orders/${draft.id}/cancel`);
  });

  it("rejects non-stocked items on a purchase order", async () => {
    const res = await owner.req("POST", "/purchase-orders", {
      vendorId: vendor.id,
      orderDate: "2026-05-01",
      lines: [{ itemId: co.service.id, quantity: "1", unitCost: "5" }],
    });
    expect(res.status).toBe(422);
  });

  it("receives part of an order: stock in at order cost, Dr Inventory / Cr Received Not Billed", async () => {
    po = await newIssuedPo("10", "4.00");
    const stockBefore = (await owner.ok("GET", `/items/${co.widget.id}`)).qtyOnHand;
    const receipt = await owner.ok("POST", `/purchase-orders/${po.id}/receive`, {
      date: "2026-05-05",
      lines: [{ purchaseOrderLineId: po.lines[0]!.id, quantity: "6" }],
    });
    expect(receipt.total).toBe("24.00");
    const entry = await owner.ok("GET", `/journal-entries/${receipt.journalEntryId}`);
    const line = (id: string) => entry.lines.find((l: { accountId: string }) => l.accountId === id);
    expect(line(co.sys("inventory")).debit).toBe("24.00");
    expect(line(co.sys("received_not_billed")).credit).toBe("24.00");
    expect(Number((await owner.ok("GET", `/items/${co.widget.id}`)).qtyOnHand)).toBe(Number(stockBefore) + 6);
    po = await owner.ok("GET", `/purchase-orders/${po.id}`);
    expect(po.status).toBe("partially_received");
    await expectInventoryReconciles();
    await expectAccrualReconciles([po.lines]);
  });

  it("never receives more than was ordered", async () => {
    const res = await owner.req("POST", `/purchase-orders/${po.id}/receive`, {
      date: "2026-05-06",
      lines: [{ purchaseOrderLineId: po.lines[0]!.id, quantity: "5" }],
    });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/only 4 left/);
  });

  it("refuses to bill goods that have not been received (three-way match)", async () => {
    const res = await owner.req("POST", "/bills", {
      vendorId: vendor.id,
      vendorReference: "ACME-INV-100",
      billDate: "2026-05-07",
      poLines: [{ purchaseOrderLineId: po.lines[0]!.id, quantity: "7" }],
    });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/only 6 received and not yet billed/);
  });

  it("bills received goods at a higher price: accrual cleared, variance booked, AP credited", async () => {
    const bill = await owner.ok("POST", "/bills", {
      vendorId: vendor.id,
      vendorReference: "ACME-INV-100",
      billDate: "2026-05-07",
      poLines: [{ purchaseOrderLineId: po.lines[0]!.id, quantity: "6", unitCost: "4.50" }],
    });
    billId = bill.id;
    expect(bill.total).toBe("27.00");
    expect(bill.dueDate).toBe("2026-06-06");
    const entry = await owner.ok("GET", `/journal-entries/${bill.journalEntryId}`);
    const line = (id: string) => entry.lines.find((l: { accountId: string }) => l.accountId === id);
    expect(line(co.sys("received_not_billed")).debit).toBe("24.00");
    expect(line(co.sys("purchase_price_variance")).debit).toBe("3.00");
    expect(line(co.sys("accounts_payable")).credit).toBe("27.00");
    po = await owner.ok("GET", `/purchase-orders/${po.id}`);
    expect(po.lines[0]!.qtyBilled).toBe("6.0000");
    await expectApReconciles();
    await expectAccrualReconciles([po.lines]);
  });

  it("refuses the same vendor invoice number twice", async () => {
    const res = await owner.req("POST", "/bills", {
      vendorId: vendor.id,
      vendorReference: "acme-inv-100",
      billDate: "2026-05-08",
      expenseLines: [{ accountId: co.acct("6300"), amount: "10.00" }],
    });
    expect(res.status).toBe(409);
  });

  it("receives the rest, and receiving twice at once cannot over-receive", async () => {
    const results = await Promise.all([1, 2, 3].map(() => owner.req("POST", `/purchase-orders/${po.id}/receive`, { date: "2026-05-09" })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
    po = await owner.ok("GET", `/purchase-orders/${po.id}`);
    expect(po.status).toBe("received");
    expect(po.lines[0]!.qtyReceived).toBe("10.0000");
    await expectInventoryReconciles();
    await expectAccrualReconciles([po.lines]);
  });

  it("lists exactly what is billable for a vendor", async () => {
    const billable = await owner.ok("GET", `/bills/billable-lines?vendorId=${vendor.id}`);
    expect(billable).toHaveLength(1);
    expect(billable[0].billableQuantity).toBe("4.0000");
  });

  it("enters an expense bill and blocks bank or receivable accounts as expense lines", async () => {
    const bill = await owner.ok("POST", "/bills", {
      vendorId: vendor.id,
      vendorReference: "ACME-RENT-05",
      billDate: "2026-05-01",
      expenseLines: [
        { accountId: co.acct("6500"), amount: "1200.00", description: "May rent" },
        { accountId: co.acct("6900"), amount: "85.40", description: "Utilities" },
      ],
    });
    expect(bill.total).toBe("1285.40");
    const bad = await owner.req("POST", "/bills", {
      vendorId: vendor.id,
      vendorReference: "ACME-BAD-1",
      billDate: "2026-05-01",
      expenseLines: [{ accountId: co.acct("1010"), amount: "5.00" }],
    });
    expect(bad.status).toBe(422);
    await expectApReconciles();
  });

  it("pays bills partially then fully, and never over-pays", async () => {
    const over = await owner.req("POST", "/bill-payments", {
      vendorId: vendor.id,
      date: "2026-05-20",
      method: "ach",
      applications: [{ billId, amount: "27.01" }],
    });
    expect(over.status).toBe(422);
    const cashBefore = await accountBalance(owner, co.acct("1010"));
    await owner.ok("POST", "/bill-payments", { vendorId: vendor.id, date: "2026-05-20", method: "ach", applications: [{ billId, amount: "10.00" }] });
    expect((await owner.ok("GET", `/bills/${billId}`)).status).toBe("partially_paid");
    await owner.ok("POST", "/bill-payments", { vendorId: vendor.id, date: "2026-05-21", method: "check", reference: "1001", applications: [{ billId, amount: "17.00" }] });
    const bill = await owner.ok("GET", `/bills/${billId}`);
    expect(bill.status).toBe("paid");
    expect(bill.payments).toHaveLength(2);
    expect(Number(await accountBalance(owner, co.acct("1010")))).toBeCloseTo(Number(cashBefore) - 27, 2);
    await expectApReconciles();
  });

  it("treats a retried bill payment with the same key as one payment, and racing payments cannot double-pay", async () => {
    const bill = await owner.ok("POST", "/bills", {
      vendorId: vendor.id,
      vendorReference: "ACME-RACE-1",
      billDate: "2026-05-10",
      expenseLines: [{ accountId: co.acct("6300"), amount: "50.00" }],
    });
    const body = { vendorId: vendor.id, date: "2026-05-22", method: "ach", applications: [{ billId: bill.id, amount: "50.00" }] };
    const keyed = await Promise.all([1, 2, 3].map(() => owner.req("POST", "/bill-payments", body, { "idempotency-key": "bill-pay-retry-0001" })));
    expect(new Set(keyed.map((r) => r.body.id)).size).toBe(1);

    const bill2 = await owner.ok("POST", "/bills", {
      vendorId: vendor.id,
      vendorReference: "ACME-RACE-2",
      billDate: "2026-05-10",
      expenseLines: [{ accountId: co.acct("6300"), amount: "60.00" }],
    });
    const raced = await Promise.all(
      [1, 2].map(() => owner.req("POST", "/bill-payments", { ...body, applications: [{ billId: bill2.id, amount: "60.00" }] })),
    );
    expect(raced.filter((r) => r.status === 201)).toHaveLength(1);
    expect(raced.filter((r) => r.status === 422)).toHaveLength(1);
    await expectApReconciles();
  });

  it("voids an unpaid bill and makes its order lines billable again; refuses to void a paid one", async () => {
    const bill = await owner.ok("POST", "/bills", {
      vendorId: vendor.id,
      vendorReference: "ACME-INV-101",
      billDate: "2026-05-12",
      poLines: [{ purchaseOrderLineId: po.lines[0]!.id, quantity: "4" }],
    });
    expect((await owner.ok("GET", `/bills/billable-lines?vendorId=${vendor.id}`)).length).toBe(0);
    const voided = await owner.ok("POST", `/bills/${bill.id}/void`, { date: "2026-05-13", reason: "Entered against the wrong vendor" });
    expect(voided.status).toBe("void");
    const billable = await owner.ok("GET", `/bills/billable-lines?vendorId=${vendor.id}`);
    expect(billable[0].billableQuantity).toBe("4.0000");
    // The voided reference can be entered again correctly.
    await owner.ok("POST", "/bills", {
      vendorId: vendor.id,
      vendorReference: "ACME-INV-101",
      billDate: "2026-05-14",
      poLines: [{ purchaseOrderLineId: po.lines[0]!.id, quantity: "4" }],
    });
    expect((await owner.req("POST", `/bills/${billId}/void`, {})).status).toBe(409);
    po = await owner.ok("GET", `/purchase-orders/${po.id}`);
    await expectApReconciles();
    await expectAccrualReconciles([po.lines]);
  });

  it("closes a partially received order so nothing more can arrive on it", async () => {
    const short = await newIssuedPo("5", "3.00");
    await owner.ok("POST", `/purchase-orders/${short.id}/receive`, { date: "2026-05-15", lines: [{ purchaseOrderLineId: short.lines[0]!.id, quantity: "2" }] });
    await owner.ok("POST", `/purchase-orders/${short.id}/close`);
    expect((await owner.req("POST", `/purchase-orders/${short.id}/receive`, { date: "2026-05-16" })).status).toBe(409);
    expect((await owner.req("POST", `/purchase-orders/${short.id}/cancel`)).status).toBe(409);
  });

  it("shows vendor balances and keeps every control account and statement in balance", async () => {
    const detail = await owner.ok("GET", `/vendors/${vendor.id}`);
    const aging = await owner.ok("GET", "/reports/ap-aging");
    expect(detail.balance).toBe(aging.vendors.find((v: { vendorId: string }) => v.vendorId === vendor.id).total);
    expect(detail.bills.length).toBeGreaterThan(0);
    expect(detail.purchaseOrders.length).toBeGreaterThan(0);
    const dash = await owner.ok("GET", "/dashboard");
    expect(dash.kpis.accountsPayable).toBe(aging.totals.total);
    expect((await owner.ok("GET", "/reports/trial-balance?asOf=2026-12-31")).balanced).toBe(true);
    expect((await owner.ok("GET", "/reports/balance-sheet?asOf=2026-12-31")).balanced).toBe(true);
    await expectInventoryReconciles();
    const search = await owner.ok("GET", "/search?q=ACME-INV");
    expect(search.results.some((r: { type: string }) => r.type === "bill")).toBe(true);
  });
});

describe("purchasing permissions and isolation", () => {
  it("only owners, admins and accountants buy and pay", async () => {
    const sales = await addMember(ctx.app, owner, "sales");
    const viewer = await addMember(ctx.app, owner, "viewer");
    const accountant = await addMember(ctx.app, owner, "accountant");
    const body = { vendorId: vendor.id, orderDate: "2026-06-01", lines: [{ itemId: co.widget.id, quantity: "1", unitCost: "1" }] };
    expect((await sales.req("POST", "/purchase-orders", body)).status).toBe(403);
    expect((await viewer.req("POST", "/purchase-orders", body)).status).toBe(403);
    expect((await sales.req("POST", "/bill-payments", { vendorId: vendor.id, date: "2026-06-01", method: "ach", applications: [{ billId: vendor.id, amount: "1" }] })).status).toBe(403);
    expect((await sales.req("GET", "/purchase-orders")).status).toBe(200);
    expect((await accountant.req("POST", "/purchase-orders", body)).status).toBe(201);
  });

  it("another organization cannot receive, bill or read our purchasing documents", async () => {
    const other = (await signUp(ctx.app)).client;
    const po = await newIssuedPo("2", "1.00");
    expect((await other.req("GET", `/purchase-orders/${po.id}`)).status).toBe(404);
    expect((await other.req("POST", `/purchase-orders/${po.id}/receive`, {})).status).toBe(404);
    await owner.ok("POST", `/purchase-orders/${po.id}/receive`, { date: "2026-06-02" });
    const otherVendor = await other.ok("POST", "/vendors", { displayName: "Their vendor" });
    const crossBill = await other.req("POST", "/bills", {
      vendorId: otherVendor.id,
      vendorReference: "X-1",
      billDate: "2026-06-03",
      poLines: [{ purchaseOrderLineId: po.lines[0]!.id, quantity: "1" }],
    });
    expect(crossBill.status).toBe(422);
    expect((await other.ok("GET", `/bills/billable-lines?vendorId=${vendor.id}`)).length).toBe(0);
    expect((await other.ok("GET", "/reports/ap-aging")).vendors).toHaveLength(0);
  });

  it("a bill cannot use another vendor's purchase order", async () => {
    const otherVendor = await owner.ok("POST", "/vendors", { displayName: "Different Supplier" });
    const po = await newIssuedPo("2", "1.00");
    await owner.ok("POST", `/purchase-orders/${po.id}/receive`, { date: "2026-06-02" });
    const res = await owner.req("POST", "/bills", {
      vendorId: otherVendor.id,
      vendorReference: "DS-1",
      billDate: "2026-06-03",
      poLines: [{ purchaseOrderLineId: po.lines[0]!.id, quantity: "1" }],
    });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/another vendor/);
  });
});
