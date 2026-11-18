import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountBalance, setupApp, setupCompany, signUp, type TestClient } from "./helpers";

let ctx: Awaited<ReturnType<typeof setupApp>>;
let owner: TestClient;
let co: Awaited<ReturnType<typeof setupCompany>>;

beforeAll(async () => {
  ctx = await setupApp();
  owner = (await signUp(ctx.app)).client;
  co = await setupCompany(owner);
});
afterAll(() => ctx.close());

async function stockOf(itemId: string) {
  return (await owner.ok("GET", `/items/${itemId}`)) as { qtyOnHand: string; valueOnHand: string };
}

/** The receivables subledger must always equal the AR control account. */
async function expectArReconciles() {
  const aging = await owner.ok("GET", "/reports/ar-aging");
  expect(await accountBalance(owner, co.sys("accounts_receivable"))).toBe(aging.totals.total);
}

/** The inventory control account must always equal the value of stock on hand. */
async function expectInventoryReconciles() {
  const inv = await owner.ok("GET", "/inventory");
  expect(await accountBalance(owner, co.sys("inventory"))).toBe(inv.totalValue);
}

describe("order to cash", () => {
  let orderId: string;
  let invoice: { id: string; number: string; total: string; journalEntryId: string; dueDate: string };

  it("creates a draft sales order with server-side totals", async () => {
    const order = await owner.ok("POST", "/sales-orders", {
      customerId: co.customer.id,
      orderDate: "2026-06-10",
      lines: [
        { itemId: co.widget.id, quantity: "3" },
        { itemId: co.service.id, quantity: "1", discountPct: "10" },
      ],
    });
    orderId = order.id;
    expect(order.status).toBe("draft");
    // 3 × 10.00 taxable = 30.00; service 50.00 − 10% = 45.00 (not taxable); tax 8.25% of 30.00 = 2.48
    expect(order.subtotal).toBe("75.00");
    expect(order.taxTotal).toBe("2.48");
    expect(order.total).toBe("77.48");
  });

  it("invoices the order in one step and posts AR, revenue, tax, COGS and stock together", async () => {
    invoice = await owner.ok("POST", `/sales-orders/${orderId}/invoice`, { issueDate: "2026-06-11" });
    expect(invoice.total).toBe("77.48");
    expect(invoice.dueDate).toBe("2026-07-11");

    const order = await owner.ok("GET", `/sales-orders/${orderId}`);
    expect(order.status).toBe("invoiced");

    const entry = await owner.ok("GET", `/journal-entries/${invoice.journalEntryId}`);
    const byAccount = (id: string) => entry.lines.filter((l: { accountId: string }) => l.accountId === id);
    expect(byAccount(co.sys("accounts_receivable"))[0].debit).toBe("77.48");
    expect(byAccount(co.sys("sales_revenue"))[0].credit).toBe("30.00");
    expect(byAccount(co.sys("service_revenue"))[0].credit).toBe("45.00");
    expect(byAccount(co.sys("sales_tax_payable"))[0].credit).toBe("2.48");
    expect(byAccount(co.sys("cogs"))[0].debit).toBe("18.00");
    expect(byAccount(co.sys("inventory"))[0].credit).toBe("18.00");

    const stock = await stockOf(co.widget.id);
    expect(stock.qtyOnHand).toBe("7.0000");
    expect(stock.valueOnHand).toBe("42.00");
    await expectArReconciles();
    await expectInventoryReconciles();
  });

  it("refuses to invoice the same order twice, including simultaneous clicks", async () => {
    const again = await owner.req("POST", `/sales-orders/${orderId}/invoice`, {});
    expect(again.status).toBe(409);

    const order2 = await owner.ok("POST", "/sales-orders", {
      customerId: co.customer.id,
      orderDate: "2026-06-12",
      lines: [{ itemId: co.service.id, quantity: "1" }],
    });
    const results = await Promise.all(
      Array.from({ length: 4 }, () => owner.req("POST", `/sales-orders/${order2.id}/invoice`, { issueDate: "2026-06-12" })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);
  });

  it("records a partial payment, then the rest, and closes the invoice", async () => {
    const p1 = await owner.ok("POST", "/payments", {
      customerId: co.customer.id,
      date: "2026-06-20",
      amount: "40.00",
      method: "ach",
      applications: [{ invoiceId: invoice.id, amount: "40.00" }],
    });
    expect(p1.unappliedAmount).toBe("0.00");
    let inv = await owner.ok("GET", `/invoices/${invoice.id}`);
    expect(inv.status).toBe("partially_paid");
    expect(inv.balanceDue).toBe("37.48");

    await owner.ok("POST", "/payments", {
      customerId: co.customer.id,
      date: "2026-06-25",
      amount: "37.48",
      method: "check",
      applications: [{ invoiceId: invoice.id, amount: "37.48" }],
    });
    inv = await owner.ok("GET", `/invoices/${invoice.id}`);
    expect(inv.status).toBe("paid");
    expect(inv.balanceDue).toBe("0.00");
    expect(inv.payments).toHaveLength(2);
    expect(await accountBalance(owner, co.sys("undeposited_funds"))).toBe("77.48");
    await expectArReconciles();
  });

  it("will not apply more than an invoice's balance", async () => {
    const inv = await owner.ok("POST", "/invoices", {
      customerId: co.customer.id,
      issueDate: "2026-07-01",
      lines: [{ itemId: co.service.id, quantity: "2" }],
    });
    const res = await owner.req("POST", "/payments", {
      customerId: co.customer.id,
      date: "2026-07-02",
      amount: "150.00",
      method: "ach",
      applications: [{ invoiceId: inv.id, amount: "150.00" }],
    });
    expect(res.status).toBe(422);
    const after = await owner.ok("GET", `/invoices/${inv.id}`);
    expect(after.balanceDue).toBe("100.00");
  });

  it("keeps an overpayment as an unapplied customer credit", async () => {
    const customer = await owner.ok("POST", "/customers", { displayName: "Overpayer LLC" });
    const inv = await owner.ok("POST", "/invoices", {
      customerId: customer.id,
      issueDate: "2026-07-01",
      lines: [{ itemId: co.service.id, quantity: "1" }],
    });
    const p = await owner.ok("POST", "/payments", { customerId: customer.id, date: "2026-07-03", amount: "80.00", method: "card" });
    expect(p.unappliedAmount).toBe("30.00");
    const detail = await owner.ok("GET", `/customers/${customer.id}`);
    expect(detail.balance).toBe("-30.00");
    expect((await owner.ok("GET", `/invoices/${inv.id}`)).status).toBe("paid");
    await expectArReconciles();
  });

  it("treats a retried payment with the same Idempotency-Key as one payment", async () => {
    const customer = await owner.ok("POST", "/customers", { displayName: "Retry Industries" });
    await owner.ok("POST", "/invoices", { customerId: customer.id, issueDate: "2026-07-05", lines: [{ itemId: co.service.id, quantity: "1" }] });
    const body = { customerId: customer.id, date: "2026-07-06", amount: "50.00", method: "ach" };
    const key = { "idempotency-key": "retry-test-key-0001" };
    const results = await Promise.all([1, 2, 3].map(() => owner.req("POST", "/payments", body, key)));
    const ids = new Set(results.map((r) => r.body.id));
    expect(results.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(ids.size).toBe(1);
    const list = await owner.ok("GET", `/payments?customerId=${customer.id}`);
    expect(list.total).toBe(1);
    await expectArReconciles();
  });

  it("replays a keyed payment even when the retries race for the same invoice", async () => {
    const customer = await owner.ok("POST", "/customers", { displayName: "Keyed Race LLC" });
    const inv = await owner.ok("POST", "/invoices", { customerId: customer.id, issueDate: "2026-07-05", lines: [{ itemId: co.service.id, quantity: "1" }] });
    const body = { customerId: customer.id, date: "2026-07-06", amount: "50.00", method: "ach", applications: [{ invoiceId: inv.id, amount: "50.00" }] };
    const results = await Promise.all([1, 2, 3].map(() => owner.req("POST", "/payments", body, { "idempotency-key": "keyed-race-key-0001" })));
    expect(results.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
  });

  it("never over-applies when two payments race for the same invoice", async () => {
    const customer = await owner.ok("POST", "/customers", { displayName: "Race Condition Co" });
    const inv = await owner.ok("POST", "/invoices", { customerId: customer.id, issueDate: "2026-07-07", lines: [{ itemId: co.service.id, quantity: "1" }] });
    const results = await Promise.all(
      [1, 2].map(() =>
        owner.req("POST", "/payments", {
          customerId: customer.id,
          date: "2026-07-08",
          amount: "50.00",
          method: "ach",
          applications: [{ invoiceId: inv.id, amount: "50.00" }],
        }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 422)).toHaveLength(1);
    const after = await owner.ok("GET", `/invoices/${inv.id}`);
    expect(after.amountPaid).toBe("50.00");
  });

  it("blocks an invoice when stock is short and leaves no trace", async () => {
    const before = await stockOf(co.widget.id);
    const invoicesBefore = (await owner.ok("GET", "/invoices")).total;
    const res = await owner.req("POST", "/invoices", {
      customerId: co.customer.id,
      issueDate: "2026-07-10",
      lines: [{ itemId: co.widget.id, quantity: "999" }],
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("insufficient_stock");
    expect((await owner.ok("GET", "/invoices")).total).toBe(invoicesBefore);
    expect(await stockOf(co.widget.id)).toMatchObject({ qtyOnHand: before.qtyOnHand, valueOnHand: before.valueOnHand });
  });

  it("never sells the same last units twice under concurrency", async () => {
    const item = await owner.ok("POST", "/items", { sku: `LAST-${Date.now()}`, name: "Last unit", type: "inventory", salesPrice: "5.00" });
    await owner.ok("POST", "/inventory/adjustments", {
      date: "2026-07-01",
      reason: "received",
      lines: [{ itemId: item.id, quantityChange: "3", unitCost: "2.00" }],
    });
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        owner.req("POST", "/invoices", { customerId: co.customer.id, issueDate: "2026-07-11", lines: [{ itemId: item.id, quantity: "2" }] }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const stock = await stockOf(item.id);
    expect(stock.qtyOnHand).toBe("1.0000");
    expect(stock.valueOnHand).toBe("2.00");
    await expectInventoryReconciles();
  });

  it("voids an unpaid invoice: reversing entry, stock back at original cost, order reopened", async () => {
    const order = await owner.ok("POST", "/sales-orders", {
      customerId: co.customer.id,
      orderDate: "2026-08-01",
      lines: [{ itemId: co.widget.id, quantity: "2" }],
    });
    const inv = await owner.ok("POST", `/sales-orders/${order.id}/invoice`, { issueDate: "2026-08-01" });
    const stockAfterSale = await stockOf(co.widget.id);
    const voided = await owner.ok("POST", `/invoices/${inv.id}/void`, { date: "2026-08-02", reason: "Customer cancelled" });
    expect(voided.status).toBe("void");
    expect(voided.voidJournalEntryId).toBeTruthy();
    const stock = await stockOf(co.widget.id);
    expect(Number(stock.qtyOnHand)).toBe(Number(stockAfterSale.qtyOnHand) + 2);
    expect((await owner.ok("GET", `/sales-orders/${order.id}`)).status).toBe("confirmed");
    // The order can be invoiced again after the void.
    const reinvoiced = await owner.req("POST", `/sales-orders/${order.id}/invoice`, { issueDate: "2026-08-03" });
    expect(reinvoiced.status).toBe(201);
    await expectArReconciles();
    await expectInventoryReconciles();
  });

  it("refuses to void an invoice with payments applied", async () => {
    const res = await owner.req("POST", `/invoices/${invoice.id}/void`, {});
    expect(res.status).toBe(409);
  });

  it("lists inventory adjustments with their value", async () => {
    const list = await owner.ok("GET", "/inventory/adjustments");
    const opening = list.find((a: { reason: string }) => a.reason === "opening_balance");
    expect(opening.valueChange).toBe("60.00");
  });

  it("produces balanced statements and a dashboard that matches the ledger", async () => {
    const tb = await owner.ok("GET", "/reports/trial-balance?asOf=2026-12-31");
    expect(tb.balanced).toBe(true);
    const bs = await owner.ok("GET", "/reports/balance-sheet?asOf=2026-12-31");
    expect(bs.balanced).toBe(true);
    const pl = await owner.ok("GET", "/reports/profit-and-loss?from=2026-01-01&to=2026-12-31");
    expect(Number(pl.grossProfit)).toBeGreaterThan(0);

    const dash = await owner.ok("GET", "/dashboard");
    const aging = await owner.ok("GET", "/reports/ar-aging");
    expect(dash.kpis.accountsReceivable).toBe(aging.totals.total);
    expect(dash.kpis.inventoryValue).toBe((await owner.ok("GET", "/inventory")).totalValue);
    expect(dash.recentActivity.length).toBeGreaterThan(0);
  });

  it("validates input and reports field errors", async () => {
    const res = await owner.req("POST", "/sales-orders", { customerId: "not-a-uuid", orderDate: "06/10/2026", lines: [] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
    const negative = await owner.req("POST", "/sales-orders", {
      customerId: co.customer.id,
      orderDate: "2026-06-10",
      lines: [{ itemId: co.widget.id, quantity: "-1" }],
    });
    expect(negative.status).toBe(400);
  });
});
