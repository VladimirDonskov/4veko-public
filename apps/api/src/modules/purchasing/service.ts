import { and, asc, eq, inArray } from "drizzle-orm";
import type { Tx } from "../../db/client";
import {
  accounts,
  billLines,
  billPaymentApplications,
  billPayments,
  bills,
  items,
  parties,
  purchaseOrderLines,
  purchaseOrders,
  purchaseReceiptLines,
  purchaseReceipts,
} from "../../db/schema";
import { audit } from "../../lib/audit";
import type { OrgContext } from "../../lib/context";
import { addDays } from "../../lib/dates";
import { AppError, conflict, invalid, notFound } from "../../lib/errors";
import { cents, dec, qty4, sum } from "../../lib/money";
import { nextDocumentNumber } from "../../lib/numbering";
import { defaultLocationId, linkMovesToEntry, receiveStock } from "../inventory/service";
import { postJournalEntry, reverseJournalEntry, systemAccounts, type PostingLine } from "../ledger/posting";

type PoLineInput = { itemId: string; description?: string | null; quantity: string; unitCost?: string };

export async function loadVendor(tx: Tx, organizationId: string, vendorId: string) {
  const [vendor] = await tx
    .select()
    .from(parties)
    .where(and(eq(parties.organizationId, organizationId), eq(parties.id, vendorId), eq(parties.kind, "vendor")));
  if (!vendor) throw invalid("Vendor does not exist.");
  return vendor;
}

/** Price purchase order lines. Purchase orders are for stocked items; other purchases go on a bill as expense lines. */
export async function computePoLines(tx: Tx, organizationId: string, lines: PoLineInput[]) {
  if (lines.length === 0) throw invalid("Add at least one line.");
  const ids = [...new Set(lines.map((l) => l.itemId))];
  const rows = await tx
    .select()
    .from(items)
    .where(and(eq(items.organizationId, organizationId), inArray(items.id, ids)));
  const byId = new Map(rows.map((i) => [i.id, i]));
  const computed = lines.map((l, i) => {
    const item = byId.get(l.itemId);
    if (!item) throw invalid(`Line ${i + 1}: the item does not exist.`);
    if (item.type !== "inventory") {
      throw invalid(`Line ${i + 1}: ${item.sku} is not a stocked item. Enter other purchases on a bill as expense lines.`);
    }
    if (!item.isActive) throw invalid(`Line ${i + 1}: ${item.sku} is archived.`);
    const unitCost = dec(l.unitCost ?? item.purchaseCost).toDecimalPlaces(4).toFixed(4);
    return {
      lineNo: i + 1,
      itemId: item.id,
      description: l.description ?? item.name,
      quantity: qty4(l.quantity),
      unitCost,
      amount: cents(dec(l.quantity).times(unitCost)),
    };
  });
  return { lines: computed, total: cents(sum(computed.map((l) => l.amount))) };
}

async function lockPo(tx: Tx, organizationId: string, id: string) {
  const [po] = await tx
    .select()
    .from(purchaseOrders)
    .where(and(eq(purchaseOrders.organizationId, organizationId), eq(purchaseOrders.id, id)))
    .for("update");
  if (!po) throw notFound("Purchase order");
  return po;
}

export async function lockPurchaseOrder(tx: Tx, organizationId: string, id: string) {
  return lockPo(tx, organizationId, id);
}

/**
 * Receive stock against a purchase order. Posts Dr Inventory / Cr Received
 * Not Billed at the order cost; the vendor bill later clears the accrual.
 */
export async function receivePurchaseOrder(
  tx: Tx,
  ctx: OrgContext,
  poId: string,
  args: { date: string; memo?: string | null; lines?: { purchaseOrderLineId: string; quantity: string }[] },
) {
  const po = await lockPo(tx, ctx.organizationId, poId);
  if (po.status !== "issued" && po.status !== "partially_received") {
    throw conflict(`Purchase order ${po.number} is ${po.status.replace("_", " ")}; only issued orders can be received.`);
  }
  if (args.date < po.orderDate) throw invalid("The receipt date cannot be before the order date.");
  const poLines = await tx
    .select()
    .from(purchaseOrderLines)
    .where(eq(purchaseOrderLines.purchaseOrderId, po.id))
    .orderBy(asc(purchaseOrderLines.id))
    .for("update");
  const byId = new Map(poLines.map((l) => [l.id, l]));

  // Default: receive everything still outstanding.
  const requested =
    args.lines && args.lines.length > 0
      ? args.lines
      : poLines
          .map((l) => ({ purchaseOrderLineId: l.id, quantity: dec(l.quantity).minus(l.qtyReceived).toFixed() }))
          .filter((l) => dec(l.quantity).gt(0));
  if (requested.length === 0) throw conflict(`Everything on ${po.number} has already been received.`);
  const seen = new Set<string>();
  for (const r of requested) {
    const line = byId.get(r.purchaseOrderLineId);
    if (!line) throw invalid("A receipt line does not belong to this purchase order.");
    if (seen.has(line.id)) throw invalid("Each order line can appear only once in a receipt.");
    seen.add(line.id);
    const outstanding = dec(line.quantity).minus(line.qtyReceived);
    if (dec(r.quantity).lte(0)) throw invalid("Received quantities must be greater than zero.");
    if (dec(r.quantity).gt(outstanding)) {
      throw invalid(`Line ${line.lineNo}: only ${outstanding.toFixed()} left to receive.`, { lineId: line.id });
    }
  }

  const itemRows = await tx
    .select()
    .from(items)
    .where(and(eq(items.organizationId, ctx.organizationId), inArray(items.id, [...new Set(poLines.map((l) => l.itemId))])));
  const itemById = new Map(itemRows.map((i) => [i.id, i]));
  const locationId = await defaultLocationId(tx, ctx.organizationId);
  const number = await nextDocumentNumber(tx, ctx.organizationId, "receipt");
  const receiptLines = requested.map((r, i) => {
    const line = byId.get(r.purchaseOrderLineId)!;
    return {
      lineNo: i + 1,
      line,
      quantity: qty4(r.quantity),
      amount: cents(dec(r.quantity).times(line.unitCost)),
    };
  });
  const total = cents(sum(receiptLines.map((l) => l.amount)));
  const [receipt] = await tx
    .insert(purchaseReceipts)
    .values({
      organizationId: ctx.organizationId,
      number,
      purchaseOrderId: po.id,
      date: args.date,
      locationId,
      memo: args.memo ?? null,
      total,
      createdBy: ctx.userId,
    })
    .returning();
  if (!receipt) throw new Error("Receipt insert returned nothing");

  const inventoryDebits = new Map<string, ReturnType<typeof dec>>();
  for (const r of [...receiptLines].sort((a, b) => a.line.itemId.localeCompare(b.line.itemId))) {
    const item = itemById.get(r.line.itemId)!;
    await receiveStock(tx, {
      organizationId: ctx.organizationId,
      itemId: item.id,
      locationId,
      date: args.date,
      quantity: r.quantity,
      value: r.amount,
      sourceType: "purchase_receipt",
      sourceId: receipt.id,
      sourceNumber: number,
    });
    inventoryDebits.set(item.inventoryAccountId!, (inventoryDebits.get(item.inventoryAccountId!) ?? dec(0)).plus(r.amount));
    await tx
      .update(purchaseOrderLines)
      .set({ qtyReceived: qty4(dec(r.line.qtyReceived).plus(r.quantity)) })
      .where(eq(purchaseOrderLines.id, r.line.id));
  }
  await tx.insert(purchaseReceiptLines).values(
    receiptLines.map((r) => ({
      organizationId: ctx.organizationId,
      receiptId: receipt.id,
      lineNo: r.lineNo,
      purchaseOrderLineId: r.line.id,
      itemId: r.line.itemId,
      quantity: r.quantity,
      unitCost: r.line.unitCost,
      amount: r.amount,
    })),
  );

  let journalEntryId: string | null = null;
  if (dec(total).gt(0)) {
    const sys = await systemAccounts(tx, ctx.organizationId, ["received_not_billed"]);
    const vendor = await loadVendor(tx, ctx.organizationId, po.vendorId);
    const gl: PostingLine[] = [...inventoryDebits].map(([accountId, amount]) => ({
      accountId,
      debit: cents(amount),
      description: `Received ${number} on ${po.number}`,
    }));
    gl.push({ accountId: sys("received_not_billed"), credit: total, partyId: vendor.id, description: `Received ${number} on ${po.number}` });
    const entry = await postJournalEntry(tx, {
      organizationId: ctx.organizationId,
      date: args.date,
      memo: `Receipt ${number} from ${vendor.displayName} (${po.number})`,
      sourceType: "purchase_receipt",
      sourceId: receipt.id,
      sourceNumber: number,
      createdBy: ctx.userId,
      lines: gl,
    });
    journalEntryId = entry.id;
    await tx.update(purchaseReceipts).set({ journalEntryId }).where(eq(purchaseReceipts.id, receipt.id));
    await linkMovesToEntry(tx, ctx.organizationId, receipt.id, entry.id);
  }

  const after = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, po.id));
  const fully = after.every((l) => dec(l.qtyReceived).equals(l.quantity));
  await tx
    .update(purchaseOrders)
    .set({ status: fully ? "received" : "partially_received", updatedAt: new Date() })
    .where(eq(purchaseOrders.id, po.id));
  await audit(tx, {
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: "purchase_order.received",
    entityType: "purchase_receipt",
    entityId: receipt.id,
    summary: `Received ${number} on ${po.number} ($${total})`,
    data: { purchaseOrder: po.number, lines: receiptLines.length },
    ip: ctx.ip,
  });
  return { ...receipt, journalEntryId };
}

export type BillInput = {
  vendorId: string;
  vendorReference: string;
  billDate: string;
  dueDate?: string;
  memo?: string | null;
  poLines?: { purchaseOrderLineId: string; quantity: string; unitCost?: string; description?: string | null }[];
  expenseLines?: { accountId: string; amount: string; description?: string | null }[];
};

const EXPENSE_LINE_BLOCKED_SUBTYPES = new Set(["accounts_receivable", "accounts_payable", "inventory", "bank", "cash"]);

/**
 * Enter a vendor bill. Purchase order lines can only be billed up to the
 * quantity received (three-way match); the order cost clears Received Not
 * Billed and any difference goes to Purchase Price Variance. Expense lines
 * debit the chosen account. Credits Accounts Payable for the total.
 */
export async function postBill(tx: Tx, ctx: OrgContext, input: BillInput) {
  const vendor = await loadVendor(tx, ctx.organizationId, input.vendorId);
  if (!vendor.isActive) throw invalid(`${vendor.displayName} is archived.`);
  const poInputs = input.poLines ?? [];
  const expenseInputs = input.expenseLines ?? [];
  if (poInputs.length + expenseInputs.length === 0) throw invalid("Add at least one line.");

  // Lock the purchase orders, then their lines, in a stable order (same order as receiving).
  const poLineIds = [...new Set(poInputs.map((l) => l.purchaseOrderLineId))];
  if (poLineIds.length !== poInputs.length) throw invalid("Each order line can appear only once on a bill.");
  let poLineRows: (typeof purchaseOrderLines.$inferSelect)[] = [];
  const poById = new Map<string, typeof purchaseOrders.$inferSelect>();
  if (poLineIds.length > 0) {
    const peek = await tx
      .select({ purchaseOrderId: purchaseOrderLines.purchaseOrderId })
      .from(purchaseOrderLines)
      .where(and(eq(purchaseOrderLines.organizationId, ctx.organizationId), inArray(purchaseOrderLines.id, poLineIds)));
    if (peek.length !== poLineIds.length) throw invalid("One or more purchase order lines do not exist.");
    for (const poId of [...new Set(peek.map((p) => p.purchaseOrderId))].sort()) {
      const po = await lockPo(tx, ctx.organizationId, poId);
      if (po.vendorId !== vendor.id) throw invalid(`${po.number} belongs to another vendor.`);
      if (po.status === "cancelled" || po.status === "draft") throw invalid(`${po.number} is ${po.status}; nothing on it can be billed.`);
      poById.set(po.id, po);
    }
    poLineRows = await tx
      .select()
      .from(purchaseOrderLines)
      .where(inArray(purchaseOrderLines.id, poLineIds))
      .orderBy(asc(purchaseOrderLines.id))
      .for("update");
  }
  const poLineById = new Map(poLineRows.map((l) => [l.id, l]));
  const itemRows = poLineRows.length
    ? await tx
        .select()
        .from(items)
        .where(and(eq(items.organizationId, ctx.organizationId), inArray(items.id, [...new Set(poLineRows.map((l) => l.itemId))])))
    : [];
  const itemById = new Map(itemRows.map((i) => [i.id, i]));

  const poBillLines = poInputs.map((l) => {
    const line = poLineById.get(l.purchaseOrderLineId)!;
    const billable = dec(line.qtyReceived).minus(line.qtyBilled);
    if (dec(l.quantity).lte(0)) throw invalid("Billed quantities must be greater than zero.");
    if (dec(l.quantity).gt(billable)) {
      const po = poById.get(line.purchaseOrderId)!;
      throw invalid(
        `${po.number} line ${line.lineNo}: only ${billable.toFixed()} received and not yet billed. Receive the goods before billing them.`,
        { lineId: line.id, billable: billable.toFixed(4) },
      );
    }
    const unitCost = dec(l.unitCost ?? line.unitCost).toDecimalPlaces(4).toFixed(4);
    const amount = cents(dec(l.quantity).times(unitCost));
    const accrued = cents(dec(l.quantity).times(line.unitCost));
    return { input: l, line, item: itemById.get(line.itemId)!, quantity: qty4(l.quantity), unitCost, amount, accrued };
  });

  const expenseAccountIds = [...new Set(expenseInputs.map((l) => l.accountId))];
  const expenseAccounts = expenseAccountIds.length
    ? await tx
        .select()
        .from(accounts)
        .where(and(eq(accounts.organizationId, ctx.organizationId), inArray(accounts.id, expenseAccountIds)))
    : [];
  const accountById = new Map(expenseAccounts.map((a) => [a.id, a]));
  for (const [i, l] of expenseInputs.entries()) {
    const account = accountById.get(l.accountId);
    if (!account) throw invalid(`Expense line ${i + 1}: the account does not exist.`);
    if (!account.isActive) throw invalid(`Expense line ${i + 1}: ${account.name} is archived.`);
    if (!["expense", "asset"].includes(account.type) || EXPENSE_LINE_BLOCKED_SUBTYPES.has(account.subtype) || account.systemKey) {
      throw invalid(`Expense line ${i + 1}: choose an expense or asset account such as Rent or Equipment, not ${account.name}.`);
    }
    if (dec(l.amount).lte(0)) throw invalid(`Expense line ${i + 1}: the amount must be greater than zero.`);
  }

  const total = cents(sum([...poBillLines.map((l) => l.amount), ...expenseInputs.map((l) => l.amount)]));
  if (dec(total).lte(0)) throw invalid("The bill total must be greater than zero.");
  const dueDate = input.dueDate ?? addDays(input.billDate, vendor.termsDays);
  if (dueDate < input.billDate) throw invalid("The due date cannot be before the bill date.");
  const poIds = [...poById.keys()];

  const number = await nextDocumentNumber(tx, ctx.organizationId, "bill");
  const [bill] = await tx
    .insert(bills)
    .values({
      organizationId: ctx.organizationId,
      number,
      vendorId: vendor.id,
      vendorReference: input.vendorReference,
      purchaseOrderId: poIds.length === 1 ? poIds[0]! : null,
      billDate: input.billDate,
      dueDate,
      memo: input.memo ?? null,
      total,
      amountPaid: "0",
      balanceDue: total,
      createdBy: ctx.userId,
    })
    .returning();
  if (!bill) throw new Error("Bill insert returned nothing");

  let lineNo = 0;
  await tx.insert(billLines).values([
    ...poBillLines.map((l) => ({
      organizationId: ctx.organizationId,
      billId: bill.id,
      lineNo: ++lineNo,
      purchaseOrderLineId: l.line.id,
      itemId: l.line.itemId,
      quantity: l.quantity,
      unitCost: l.unitCost,
      description: l.input.description ?? l.line.description ?? l.item.name,
      amount: l.amount,
    })),
    ...expenseInputs.map((l) => ({
      organizationId: ctx.organizationId,
      billId: bill.id,
      lineNo: ++lineNo,
      accountId: l.accountId,
      description: l.description ?? null,
      amount: cents(l.amount),
    })),
  ]);
  for (const l of poBillLines) {
    await tx
      .update(purchaseOrderLines)
      .set({ qtyBilled: qty4(dec(l.line.qtyBilled).plus(l.quantity)) })
      .where(eq(purchaseOrderLines.id, l.line.id));
  }

  const sys = await systemAccounts(tx, ctx.organizationId, ["accounts_payable", "received_not_billed", "purchase_price_variance"]);
  const gl: PostingLine[] = [];
  const accrued = sum(poBillLines.map((l) => l.accrued));
  const variance = sum(poBillLines.map((l) => dec(l.amount).minus(l.accrued)));
  if (accrued.gt(0)) gl.push({ accountId: sys("received_not_billed"), debit: cents(accrued), partyId: vendor.id, description: `Bill ${number}` });
  if (variance.gt(0)) gl.push({ accountId: sys("purchase_price_variance"), debit: cents(variance), description: `Price variance ${number}` });
  if (variance.lt(0)) gl.push({ accountId: sys("purchase_price_variance"), credit: cents(variance.negated()), description: `Price variance ${number}` });
  const byAccount = new Map<string, ReturnType<typeof dec>>();
  for (const l of expenseInputs) byAccount.set(l.accountId, (byAccount.get(l.accountId) ?? dec(0)).plus(l.amount));
  for (const [accountId, amount] of byAccount) gl.push({ accountId, debit: cents(amount), description: `Bill ${number}` });
  gl.push({ accountId: sys("accounts_payable"), credit: total, partyId: vendor.id, description: `Bill ${number} (${input.vendorReference})` });

  const entry = await postJournalEntry(tx, {
    organizationId: ctx.organizationId,
    date: input.billDate,
    memo: `Bill ${number} from ${vendor.displayName}, ref ${input.vendorReference}`,
    sourceType: "bill",
    sourceId: bill.id,
    sourceNumber: number,
    createdBy: ctx.userId,
    lines: gl,
  });
  await tx.update(bills).set({ journalEntryId: entry.id }).where(eq(bills.id, bill.id));
  await audit(tx, {
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: "bill.posted",
    entityType: "bill",
    entityId: bill.id,
    summary: `Entered bill ${number} from ${vendor.displayName} (ref ${input.vendorReference}) for $${total}`,
    data: { total, variance: variance.toFixed(2), journalEntry: entry.number },
    ip: ctx.ip,
  });
  return { ...bill, journalEntryId: entry.id };
}

/** Void an unpaid bill: reversing entry, and its order lines become billable again. */
export async function voidBill(tx: Tx, ctx: OrgContext, billId: string, date: string, reason: string | null) {
  const [bill] = await tx
    .select()
    .from(bills)
    .where(and(eq(bills.organizationId, ctx.organizationId), eq(bills.id, billId)))
    .for("update");
  if (!bill) throw notFound("Bill");
  if (bill.status === "void") throw conflict(`Bill ${bill.number} is already void.`);
  if (!dec(bill.amountPaid).isZero()) throw conflict(`Bill ${bill.number} has payments and cannot be voided.`);
  if (date < bill.billDate) throw invalid("The void date cannot be earlier than the bill date.");
  if (!bill.journalEntryId) throw new AppError(500, "missing_entry", "Bill has no journal entry.");

  const lines = await tx.select().from(billLines).where(eq(billLines.billId, bill.id));
  const poLineIds = lines.filter((l) => l.purchaseOrderLineId).map((l) => l.purchaseOrderLineId!);
  if (poLineIds.length > 0) {
    const poIds = await tx
      .selectDistinct({ id: purchaseOrderLines.purchaseOrderId })
      .from(purchaseOrderLines)
      .where(inArray(purchaseOrderLines.id, poLineIds));
    for (const p of poIds.map((x) => x.id).sort()) await lockPo(tx, ctx.organizationId, p);
    const locked = await tx
      .select()
      .from(purchaseOrderLines)
      .where(inArray(purchaseOrderLines.id, poLineIds))
      .orderBy(asc(purchaseOrderLines.id))
      .for("update");
    for (const pol of locked) {
      const billed = lines.filter((l) => l.purchaseOrderLineId === pol.id).reduce((a, l) => a.plus(l.quantity!), dec(0));
      await tx
        .update(purchaseOrderLines)
        .set({ qtyBilled: qty4(dec(pol.qtyBilled).minus(billed)) })
        .where(eq(purchaseOrderLines.id, pol.id));
    }
  }
  const reversal = await reverseJournalEntry(tx, {
    organizationId: ctx.organizationId,
    entryId: bill.journalEntryId,
    date,
    memo: `Void bill ${bill.number}${reason ? `: ${reason}` : ""}`,
    createdBy: ctx.userId,
    sourceType: "bill_void",
    sourceId: bill.id,
    sourceNumber: bill.number,
  });
  const [updated] = await tx
    .update(bills)
    .set({ status: "void", voidJournalEntryId: reversal.id, voidedAt: new Date() })
    .where(eq(bills.id, bill.id))
    .returning();
  await audit(tx, {
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: "bill.voided",
    entityType: "bill",
    entityId: bill.id,
    summary: `Voided bill ${bill.number}${reason ? ` (${reason})` : ""}`,
    data: { reversalEntry: reversal.number },
    ip: ctx.ip,
  });
  return updated;
}

export type BillPaymentInput = {
  vendorId: string;
  date: string;
  method: (typeof billPayments.$inferInsert)["method"];
  reference?: string | null;
  payFromAccountId?: string;
  memo?: string | null;
  applications: { billId: string; amount: string }[];
  idempotencyKey?: string | null;
};

/** Pay one or more of a vendor's bills from a bank account: Dr Accounts Payable / Cr bank. */
async function findBillPaymentByKey(tx: Tx, organizationId: string, key: string | null | undefined) {
  if (!key) return null;
  const [existing] = await tx
    .select()
    .from(billPayments)
    .where(and(eq(billPayments.organizationId, organizationId), eq(billPayments.idempotencyKey, key)));
  return existing ?? null;
}

export async function payBills(tx: Tx, ctx: OrgContext, input: BillPaymentInput) {
  const existing = await findBillPaymentByKey(tx, ctx.organizationId, input.idempotencyKey);
  if (existing) return { payment: existing, replayed: true };
  const vendor = await loadVendor(tx, ctx.organizationId, input.vendorId);
  if (input.applications.length === 0) throw invalid("Choose at least one bill to pay.");
  const ids = input.applications.map((a) => a.billId);
  if (new Set(ids).size !== ids.length) throw invalid("Each bill can appear only once in a payment.");

  const sys = await systemAccounts(tx, ctx.organizationId, ["accounts_payable", "cash_operating"]);
  const payFromAccountId = input.payFromAccountId ?? sys("cash_operating");
  const [payFrom] = await tx
    .select()
    .from(accounts)
    .where(and(eq(accounts.organizationId, ctx.organizationId), eq(accounts.id, payFromAccountId)));
  if (!payFrom || payFrom.type !== "asset" || payFrom.subtype !== "bank" || !payFrom.isActive) {
    throw invalid("Pay from an active bank account.");
  }

  const locked = await tx
    .select()
    .from(bills)
    .where(and(eq(bills.organizationId, ctx.organizationId), inArray(bills.id, ids)))
    .orderBy(asc(bills.id))
    .for("update");
  // A concurrent retry with the same key may have committed while we waited for the locks.
  const replay = await findBillPaymentByKey(tx, ctx.organizationId, input.idempotencyKey);
  if (replay) return { payment: replay, replayed: true };
  const byId = new Map(locked.map((b) => [b.id, b]));
  for (const a of input.applications) {
    const bill = byId.get(a.billId);
    if (!bill || bill.vendorId !== vendor.id) throw invalid("Payments can only be applied to this vendor's bills.");
    if (bill.status !== "open" && bill.status !== "partially_paid") throw invalid(`Bill ${bill.number} is ${bill.status.replace("_", " ")}.`);
    if (dec(a.amount).lte(0)) throw invalid("Payment amounts must be greater than zero.");
    if (dec(a.amount).gt(bill.balanceDue)) throw invalid(`Bill ${bill.number} has only $${bill.balanceDue} left to pay.`);
  }
  const amount = cents(sum(input.applications.map((a) => a.amount)));

  const number = await nextDocumentNumber(tx, ctx.organizationId, "billPayment");
  const [payment] = await tx
    .insert(billPayments)
    .values({
      organizationId: ctx.organizationId,
      number,
      vendorId: vendor.id,
      date: input.date,
      amount,
      method: input.method,
      reference: input.reference ?? null,
      payFromAccountId,
      memo: input.memo ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      createdBy: ctx.userId,
    })
    .returning();
  if (!payment) throw new Error("Bill payment insert returned nothing");
  for (const a of input.applications) {
    const bill = byId.get(a.billId)!;
    const paid = dec(bill.amountPaid).plus(a.amount);
    const balance = dec(bill.total).minus(paid);
    await tx.insert(billPaymentApplications).values({
      organizationId: ctx.organizationId,
      billPaymentId: payment.id,
      billId: bill.id,
      amount: cents(a.amount),
    });
    await tx
      .update(bills)
      .set({ amountPaid: cents(paid), balanceDue: cents(balance), status: balance.isZero() ? "paid" : "partially_paid" })
      .where(eq(bills.id, bill.id));
  }
  const entry = await postJournalEntry(tx, {
    organizationId: ctx.organizationId,
    date: input.date,
    memo: `Bill payment ${number} to ${vendor.displayName}`,
    sourceType: "bill_payment",
    sourceId: payment.id,
    sourceNumber: number,
    createdBy: ctx.userId,
    lines: [
      { accountId: sys("accounts_payable"), debit: amount, partyId: vendor.id, description: `Bill payment ${number}` },
      { accountId: payFromAccountId, credit: amount, description: `Bill payment ${number}` },
    ],
  });
  await tx.update(billPayments).set({ journalEntryId: entry.id }).where(eq(billPayments.id, payment.id));
  await audit(tx, {
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: "bill_payment.recorded",
    entityType: "bill_payment",
    entityId: payment.id,
    summary: `Paid $${amount} to ${vendor.displayName} (${number})`,
    data: { bills: input.applications.length, journalEntry: entry.number },
    ip: ctx.ip,
  });
  return { payment: { ...payment, journalEntryId: entry.id }, replayed: false };
}
