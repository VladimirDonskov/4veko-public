import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "../../db/client";
import {
  accounts,
  invoiceLines,
  invoices,
  items,
  organizations,
  parties,
  paymentApplications,
  payments,
  salesOrders,
} from "../../db/schema";
import { audit } from "../../lib/audit";
import type { OrgContext } from "../../lib/context";
import { AppError, conflict, invalid, notFound } from "../../lib/errors";
import { addDays } from "../../lib/dates";
import { cents, dec, lineAmount, sum, taxOn } from "../../lib/money";
import { nextDocumentNumber } from "../../lib/numbering";
import { defaultLocationId, issueStock, linkMovesToEntry, receiveStock } from "../inventory/service";
import { postJournalEntry, reverseJournalEntry, systemAccounts, type PostingLine } from "../ledger/posting";

export type LineInput = {
  itemId: string;
  description?: string | null;
  quantity: string;
  unitPrice?: string;
  discountPct?: string;
};

export type ComputedLine = {
  lineNo: number;
  itemId: string;
  description: string | null;
  quantity: string;
  unitPrice: string;
  discountPct: string;
  amount: string;
  taxable: boolean;
  item: typeof items.$inferSelect;
};

export async function loadCustomer(tx: Tx, organizationId: string, customerId: string) {
  const [customer] = await tx
    .select()
    .from(parties)
    .where(and(eq(parties.organizationId, organizationId), eq(parties.id, customerId), eq(parties.kind, "customer")));
  if (!customer) throw invalid("Customer does not exist.");
  return customer;
}

/** Price, discount and tax every line on the server; client totals are never trusted. */
export async function computeDocument(
  tx: Tx,
  organizationId: string,
  customer: typeof parties.$inferSelect,
  lines: LineInput[],
  taxRateInput?: string,
) {
  if (lines.length === 0) throw invalid("Add at least one line.");
  const ids = [...new Set(lines.map((l) => l.itemId))];
  const itemRows = await tx
    .select()
    .from(items)
    .where(and(eq(items.organizationId, organizationId), inArray(items.id, ids)));
  const byId = new Map(itemRows.map((i) => [i.id, i]));
  const computed: ComputedLine[] = lines.map((l, i) => {
    const item = byId.get(l.itemId);
    if (!item) throw invalid(`Line ${i + 1}: the item does not exist.`);
    if (!item.isActive) throw invalid(`Line ${i + 1}: ${item.sku} is archived.`);
    const unitPrice = cents(l.unitPrice ?? item.salesPrice);
    const discountPct = dec(l.discountPct ?? 0).toFixed(2);
    return {
      lineNo: i + 1,
      itemId: item.id,
      description: l.description ?? item.name,
      quantity: dec(l.quantity).toFixed(4),
      unitPrice,
      discountPct,
      amount: lineAmount(l.quantity, unitPrice, discountPct),
      taxable: item.taxable,
      item,
    };
  });

  let taxRate = "0";
  if (!customer.taxExempt) {
    if (taxRateInput !== undefined) taxRate = taxRateInput;
    else {
      const [org] = await tx
        .select({ rate: organizations.defaultTaxRate })
        .from(organizations)
        .where(eq(organizations.id, organizationId));
      taxRate = org?.rate ?? "0";
    }
  }
  const subtotal = cents(sum(computed.map((l) => l.amount)));
  const taxableSubtotal = sum(computed.filter((l) => l.taxable).map((l) => l.amount));
  const taxTotal = taxOn(taxableSubtotal, taxRate);
  const total = cents(dec(subtotal).plus(taxTotal));
  return { lines: computed, taxRate, subtotal, taxTotal, total };
}

/**
 * Create and post an invoice in one transaction: the invoice, its stock
 * issues at moving-average cost, and one balanced journal entry
 * (Dr AR / Cr revenue / Cr sales tax; Dr COGS / Cr inventory).
 */
export async function postInvoice(
  tx: Tx,
  ctx: OrgContext,
  args: {
    customerId: string;
    issueDate: string;
    dueDate?: string;
    memo?: string | null;
    taxRate?: string;
    lines: LineInput[];
    salesOrderId?: string | null;
    salesOrderNumber?: string | null;
  },
) {
  const customer = await loadCustomer(tx, ctx.organizationId, args.customerId);
  if (!customer.isActive) throw invalid(`${customer.displayName} is archived.`);
  const doc = await computeDocument(tx, ctx.organizationId, customer, args.lines, args.taxRate);
  if (dec(doc.total).lte(0)) throw invalid("The invoice total must be greater than zero.");
  const dueDate = args.dueDate ?? addDays(args.issueDate, customer.termsDays);
  if (dueDate < args.issueDate) throw invalid("The due date cannot be before the invoice date.");

  const number = await nextDocumentNumber(tx, ctx.organizationId, "invoice");
  const [invoice] = await tx
    .insert(invoices)
    .values({
      organizationId: ctx.organizationId,
      number,
      customerId: customer.id,
      salesOrderId: args.salesOrderId ?? null,
      issueDate: args.issueDate,
      dueDate,
      memo: args.memo ?? null,
      taxRate: doc.taxRate,
      subtotal: doc.subtotal,
      taxTotal: doc.taxTotal,
      total: doc.total,
      amountPaid: "0",
      balanceDue: doc.total,
      createdBy: ctx.userId,
    })
    .returning();
  if (!invoice) throw new Error("Invoice insert returned nothing");

  // Issue stock in item order so concurrent invoices lock rows consistently.
  const locationId = await defaultLocationId(tx, ctx.organizationId);
  const costs = new Map<number, string>();
  for (const line of [...doc.lines].sort((a, b) => a.itemId.localeCompare(b.itemId))) {
    if (line.item.type !== "inventory") continue;
    const cost = await issueStock(tx, {
      organizationId: ctx.organizationId,
      itemId: line.itemId,
      locationId,
      date: args.issueDate,
      quantity: line.quantity,
      sourceType: "invoice",
      sourceId: invoice.id,
      sourceNumber: number,
    });
    costs.set(line.lineNo, cost);
  }

  await tx.insert(invoiceLines).values(
    doc.lines.map((l) => ({
      organizationId: ctx.organizationId,
      invoiceId: invoice.id,
      lineNo: l.lineNo,
      itemId: l.itemId,
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      discountPct: l.discountPct,
      amount: l.amount,
      taxable: l.taxable,
      incomeAccountId: l.item.incomeAccountId,
      costAmount: costs.get(l.lineNo) ?? null,
    })),
  );

  const sys = await systemAccounts(tx, ctx.organizationId, ["accounts_receivable", "sales_tax_payable"]);
  const gl: PostingLine[] = [
    { accountId: sys("accounts_receivable"), debit: doc.total, partyId: customer.id, description: `Invoice ${number}` },
  ];
  const revenue = new Map<string, ReturnType<typeof dec>>();
  const cogs = new Map<string, ReturnType<typeof dec>>();
  const inventory = new Map<string, ReturnType<typeof dec>>();
  for (const l of doc.lines) {
    revenue.set(l.item.incomeAccountId, (revenue.get(l.item.incomeAccountId) ?? dec(0)).plus(l.amount));
    const cost = costs.get(l.lineNo);
    if (cost && l.item.cogsAccountId && l.item.inventoryAccountId) {
      cogs.set(l.item.cogsAccountId, (cogs.get(l.item.cogsAccountId) ?? dec(0)).plus(cost));
      inventory.set(l.item.inventoryAccountId, (inventory.get(l.item.inventoryAccountId) ?? dec(0)).plus(cost));
    }
  }
  for (const [accountId, amount] of revenue) gl.push({ accountId, credit: cents(amount), description: `Sales ${number}` });
  if (!dec(doc.taxTotal).isZero()) {
    gl.push({ accountId: sys("sales_tax_payable"), credit: doc.taxTotal, description: `Sales tax ${number}` });
  }
  for (const [accountId, amount] of cogs) gl.push({ accountId, debit: cents(amount), description: `Cost of sales ${number}` });
  for (const [accountId, amount] of inventory) gl.push({ accountId, credit: cents(amount), description: `Stock shipped ${number}` });

  const entry = await postJournalEntry(tx, {
    organizationId: ctx.organizationId,
    date: args.issueDate,
    memo: `Invoice ${number} to ${customer.displayName}`,
    sourceType: "invoice",
    sourceId: invoice.id,
    sourceNumber: number,
    createdBy: ctx.userId,
    lines: gl,
  });
  await tx.update(invoices).set({ journalEntryId: entry.id }).where(eq(invoices.id, invoice.id));
  await linkMovesToEntry(tx, ctx.organizationId, invoice.id, entry.id);
  await audit(tx, {
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: "invoice.posted",
    entityType: "invoice",
    entityId: invoice.id,
    summary: `Posted invoice ${number} to ${customer.displayName} for $${doc.total}`,
    data: { total: doc.total, salesOrder: args.salesOrderNumber ?? null, journalEntry: entry.number },
    ip: ctx.ip,
  });
  return { ...invoice, journalEntryId: entry.id };
}

/** Void an unpaid invoice: reversing entry, stock returned at original cost, order reopened. */
export async function voidInvoice(tx: Tx, ctx: OrgContext, invoiceId: string, date: string, reason: string | null) {
  const [invoice] = await tx
    .select()
    .from(invoices)
    .where(and(eq(invoices.organizationId, ctx.organizationId), eq(invoices.id, invoiceId)))
    .for("update");
  if (!invoice) throw notFound("Invoice");
  if (invoice.status === "void") throw conflict(`Invoice ${invoice.number} is already void.`);
  if (!dec(invoice.amountPaid).isZero()) {
    throw conflict(`Invoice ${invoice.number} has payments applied and cannot be voided.`);
  }
  if (date < invoice.issueDate) throw invalid("The void date cannot be earlier than the invoice date.");
  if (!invoice.journalEntryId) throw new AppError(500, "missing_entry", "Invoice has no journal entry.");

  const reversal = await reverseJournalEntry(tx, {
    organizationId: ctx.organizationId,
    entryId: invoice.journalEntryId,
    date,
    memo: `Void invoice ${invoice.number}${reason ? `: ${reason}` : ""}`,
    createdBy: ctx.userId,
    sourceType: "invoice_void",
    sourceId: invoice.id,
    sourceNumber: invoice.number,
  });

  const lines = await tx
    .select({ lineNo: invoiceLines.lineNo, itemId: invoiceLines.itemId, quantity: invoiceLines.quantity, costAmount: invoiceLines.costAmount })
    .from(invoiceLines)
    .where(eq(invoiceLines.invoiceId, invoice.id))
    .orderBy(asc(invoiceLines.itemId));
  const locationId = await defaultLocationId(tx, ctx.organizationId);
  for (const l of lines) {
    if (l.costAmount === null) continue;
    await receiveStock(tx, {
      organizationId: ctx.organizationId,
      itemId: l.itemId,
      locationId,
      date,
      quantity: l.quantity,
      value: l.costAmount,
      sourceType: "invoice_void",
      sourceId: invoice.id,
      sourceNumber: invoice.number,
    });
  }
  await linkMovesToEntry(tx, ctx.organizationId, invoice.id, reversal.id);

  const [updated] = await tx
    .update(invoices)
    .set({ status: "void", voidJournalEntryId: reversal.id, voidedAt: new Date() })
    .where(eq(invoices.id, invoice.id))
    .returning();
  if (invoice.salesOrderId) {
    await tx
      .update(salesOrders)
      .set({ status: "confirmed", updatedAt: new Date() })
      .where(and(eq(salesOrders.organizationId, ctx.organizationId), eq(salesOrders.id, invoice.salesOrderId)));
  }
  await audit(tx, {
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: "invoice.voided",
    entityType: "invoice",
    entityId: invoice.id,
    summary: `Voided invoice ${invoice.number}${reason ? ` (${reason})` : ""}`,
    data: { reversalEntry: reversal.number },
    ip: ctx.ip,
  });
  return updated;
}

export type PaymentInput = {
  customerId: string;
  date: string;
  amount: string;
  method: (typeof payments.$inferInsert)["method"];
  reference?: string | null;
  depositAccountId?: string;
  memo?: string | null;
  applications?: { invoiceId: string; amount: string }[];
  autoApply?: boolean;
  idempotencyKey?: string | null;
};

/** Record a customer payment, apply it to invoices and post Dr cash / Cr AR. */
async function findPaymentByKey(tx: Tx, organizationId: string, key: string | null | undefined) {
  if (!key) return null;
  const [existing] = await tx
    .select()
    .from(payments)
    .where(and(eq(payments.organizationId, organizationId), eq(payments.idempotencyKey, key)));
  return existing ?? null;
}

export async function recordPayment(tx: Tx, ctx: OrgContext, input: PaymentInput) {
  const existing = await findPaymentByKey(tx, ctx.organizationId, input.idempotencyKey);
  if (existing) return { payment: existing, replayed: true };
  const customer = await loadCustomer(tx, ctx.organizationId, input.customerId);
  const sys = await systemAccounts(tx, ctx.organizationId, ["accounts_receivable", "undeposited_funds"]);
  const depositAccountId = input.depositAccountId ?? sys("undeposited_funds");
  const [deposit] = await tx
    .select({ type: accounts.type, subtype: accounts.subtype, isActive: accounts.isActive })
    .from(accounts)
    .where(and(eq(accounts.organizationId, ctx.organizationId), eq(accounts.id, depositAccountId)));
  if (!deposit || deposit.type !== "asset" || !["bank", "cash"].includes(deposit.subtype)) {
    throw invalid("Deposit to a bank or cash account.");
  }

  const amount = dec(input.amount);
  if (amount.lte(0)) throw invalid("Payment amount must be greater than zero.");

  // Lock the customer's open invoices (in id order) before deciding what to apply.
  const open = await tx
    .select()
    .from(invoices)
    .where(
      and(
        eq(invoices.organizationId, ctx.organizationId),
        eq(invoices.customerId, customer.id),
        inArray(invoices.status, ["open", "partially_paid"]),
      ),
    )
    .orderBy(asc(invoices.id))
    .for("update");
  // A concurrent retry with the same key may have committed while we waited for the locks.
  const replay = await findPaymentByKey(tx, ctx.organizationId, input.idempotencyKey);
  if (replay) return { payment: replay, replayed: true };
  const openById = new Map(open.map((i) => [i.id, i]));

  let applications: { invoiceId: string; amount: string }[] = [];
  if (input.applications && input.applications.length > 0) {
    const seen = new Set<string>();
    for (const a of input.applications) {
      if (seen.has(a.invoiceId)) throw invalid("Each invoice can appear only once in a payment.");
      seen.add(a.invoiceId);
      const inv = openById.get(a.invoiceId);
      if (!inv) throw invalid("Payments can only be applied to this customer's open invoices.");
      if (dec(a.amount).lte(0)) throw invalid("Applied amounts must be greater than zero.");
      if (dec(a.amount).gt(inv.balanceDue)) {
        throw invalid(`Invoice ${inv.number} has only $${inv.balanceDue} left to pay.`);
      }
    }
    applications = input.applications.map((a) => ({ invoiceId: a.invoiceId, amount: cents(a.amount) }));
  } else if (input.autoApply !== false) {
    // Oldest due first.
    let remaining = amount;
    for (const inv of [...open].sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.number.localeCompare(b.number))) {
      if (remaining.lte(0)) break;
      const take = remaining.gte(inv.balanceDue) ? dec(inv.balanceDue) : remaining;
      applications.push({ invoiceId: inv.id, amount: cents(take) });
      remaining = remaining.minus(take);
    }
  }
  const applied = sum(applications.map((a) => a.amount));
  if (applied.gt(amount)) throw invalid(`Applied amounts ($${applied.toFixed(2)}) exceed the payment ($${amount.toFixed(2)}).`);

  const number = await nextDocumentNumber(tx, ctx.organizationId, "payment");
  const [payment] = await tx
    .insert(payments)
    .values({
      organizationId: ctx.organizationId,
      number,
      customerId: customer.id,
      date: input.date,
      amount: cents(amount),
      unappliedAmount: cents(amount.minus(applied)),
      method: input.method,
      reference: input.reference ?? null,
      depositAccountId,
      memo: input.memo ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      createdBy: ctx.userId,
    })
    .returning();
  if (!payment) throw new Error("Payment insert returned nothing");

  for (const a of applications) {
    const inv = openById.get(a.invoiceId)!;
    const paid = dec(inv.amountPaid).plus(a.amount);
    const balance = dec(inv.total).minus(paid);
    await tx.insert(paymentApplications).values({
      organizationId: ctx.organizationId,
      paymentId: payment.id,
      invoiceId: inv.id,
      amount: a.amount,
    });
    await tx
      .update(invoices)
      .set({ amountPaid: cents(paid), balanceDue: cents(balance), status: balance.isZero() ? "paid" : "partially_paid" })
      .where(eq(invoices.id, inv.id));
  }

  const entry = await postJournalEntry(tx, {
    organizationId: ctx.organizationId,
    date: input.date,
    memo: `Payment ${number} from ${customer.displayName}`,
    sourceType: "payment",
    sourceId: payment.id,
    sourceNumber: number,
    createdBy: ctx.userId,
    lines: [
      { accountId: depositAccountId, debit: cents(amount), description: `Payment ${number}` },
      { accountId: sys("accounts_receivable"), credit: cents(amount), partyId: customer.id, description: `Payment ${number}` },
    ],
  });
  await tx.update(payments).set({ journalEntryId: entry.id }).where(eq(payments.id, payment.id));
  await audit(tx, {
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: "payment.recorded",
    entityType: "payment",
    entityId: payment.id,
    summary: `Recorded payment ${number} of $${cents(amount)} from ${customer.displayName}`,
    data: { applied: applied.toFixed(2), invoices: applications.length, journalEntry: entry.number },
    ip: ctx.ip,
  });
  return { payment: { ...payment, journalEntryId: entry.id }, replayed: false };
}

