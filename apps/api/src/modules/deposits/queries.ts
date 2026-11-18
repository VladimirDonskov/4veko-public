import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, notExists, or } from "drizzle-orm";
import type { DbOrTx } from "../../db/client";
import { accounts, auditEvents, bankStatementLines, bankStatements, depositPayments, deposits, journalLines, parties, payments } from "../../db/schema";
import { notFound } from "../../lib/errors";

const receiptFields = {
  id: payments.id, number: payments.number, date: payments.date, amount: payments.amount,
  method: payments.method, reference: payments.reference, customerId: payments.customerId, customerName: parties.displayName,
};

export function eligibleReceipts(db: DbOrTx, org: string, asOf: string, ids?: string[]) {
  // Availability for a new deposit, including any already-committed future claims.
  const conflictingClaim = db.select({ id: depositPayments.depositId }).from(depositPayments)
    .where(and(eq(depositPayments.organizationId, org), eq(depositPayments.paymentId, payments.id),
      or(isNull(depositPayments.releasedOn), gt(depositPayments.releasedOn, asOf))));
  return db.select(receiptFields).from(payments)
    .innerJoin(parties, and(eq(parties.organizationId, org), eq(parties.id, payments.customerId)))
    .innerJoin(accounts, and(eq(accounts.organizationId, org), eq(accounts.id, payments.depositAccountId)))
    .where(and(eq(payments.organizationId, org), eq(accounts.systemKey, "undeposited_funds"),
      isNotNull(payments.journalEntryId), lte(payments.date, asOf), notExists(conflictingClaim),
      ids ? inArray(payments.id, ids) : undefined))
    .orderBy(asc(payments.date), asc(payments.number), asc(payments.id));
}

export function depositHeaders(db: DbOrTx, org: string, id?: string) {
  return db.select({
    id: deposits.id, number: deposits.number, date: deposits.date, total: deposits.amount,
    bankAccountId: deposits.bankAccountId, bankAccountName: accounts.name, bankAccountNumber: accounts.number,
    memo: deposits.memo, status: deposits.status, journalEntryId: deposits.journalEntryId,
    voidJournalEntryId: deposits.voidJournalEntryId, voidDate: deposits.voidDate, voidReason: deposits.voidReason,
  }).from(deposits)
    .innerJoin(accounts, and(eq(accounts.organizationId, org), eq(accounts.id, deposits.bankAccountId)))
    .where(and(eq(deposits.organizationId, org), id ? eq(deposits.id, id) : undefined))
    .orderBy(desc(deposits.date), desc(deposits.createdAt), desc(deposits.id));
}

export async function depositHeader(db: DbOrTx, org: string, id: string) {
  const [header] = await depositHeaders(db, org, id);
  if (!header) throw notFound("Deposit");
  return header;
}

export function depositReceipts(db: DbOrTx, org: string, id: string) {
  return db.select(receiptFields).from(depositPayments)
    .innerJoin(payments, and(eq(payments.organizationId, org), eq(payments.id, depositPayments.paymentId)))
    .innerJoin(parties, and(eq(parties.organizationId, org), eq(parties.id, payments.customerId)))
    .where(and(eq(depositPayments.organizationId, org), eq(depositPayments.depositId, id)))
    .orderBy(asc(payments.date), asc(payments.number), asc(payments.id));
}

export async function matchedStatement(db: DbOrTx, org: string, journalEntryId: string) {
  const [row] = await db.select({ id: bankStatementLines.statementId }).from(bankStatementLines)
    .innerJoin(journalLines, and(eq(journalLines.organizationId, org), eq(journalLines.id, bankStatementLines.journalLineId)))
    .where(and(eq(bankStatementLines.organizationId, org), eq(journalLines.journalEntryId, journalEntryId))).limit(1);
  return row?.id ?? null;
}

/** Closing the first statement approves the opening balance and its earlier bank postings. */
export async function baselineStatement(db: DbOrTx, org: string, header: Awaited<ReturnType<typeof depositHeader>>) {
  if (header.status === "void") return null;
  const [first] = await db.select({ id: bankStatements.id, startDate: bankStatements.startDate, status: bankStatements.status })
    .from(bankStatements).where(and(eq(bankStatements.organizationId, org), eq(bankStatements.accountId, header.bankAccountId)))
    .orderBy(asc(bankStatements.startDate)).limit(1);
  if (first?.status !== "closed" || header.date >= first.startDate) return null;

  // A later backdated entry changes the live books but was absent from the approval.
  // Both mutations lock this bank account before assigning their audit event IDs.
  const postedEvent = db.select({ id: auditEvents.id }).from(auditEvents)
    .where(and(eq(auditEvents.organizationId, org), eq(auditEvents.entityType, "deposit"),
      eq(auditEvents.entityId, header.id), eq(auditEvents.action, "deposit.posted"))).limit(1);
  const [approval] = await db.select({ statementId: auditEvents.entityId }).from(auditEvents)
    .where(and(eq(auditEvents.organizationId, org), eq(auditEvents.entityType, "bank_statement"),
      eq(auditEvents.entityId, first.id), eq(auditEvents.action, "bank_statement.closed"), gt(auditEvents.id, postedEvent))).limit(1);
  return approval?.statementId ?? null;
}
