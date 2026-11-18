import { and, asc, desc, eq, gte, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { DbOrTx, Tx } from "../../db/client";
import { accounts, auditEvents, bankStatementLines, bankStatements, deposits, journalEntries, journalLines } from "../../db/schema";
import { notFound } from "../../lib/errors";
import { cents, dec, sum } from "../../lib/money";

const headerColumns = {
  id: bankStatements.id, accountId: bankStatements.accountId, externalId: bankStatements.externalId,
  accountName: accounts.name, accountNumber: accounts.number,
  startDate: bankStatements.startDate, endDate: bankStatements.endDate,
  openingBalance: bankStatements.openingBalance, closingBalance: bankStatements.closingBalance,
  status: bankStatements.status, closedAt: bankStatements.closedAt,
};

export function statements(db: DbOrTx, org: string, id?: string) {
  return db.select(headerColumns).from(bankStatements)
    .innerJoin(accounts, and(eq(accounts.organizationId, org), eq(accounts.id, bankStatements.accountId)))
    .where(and(eq(bankStatements.organizationId, org), id ? eq(bankStatements.id, id) : undefined))
    .orderBy(desc(bankStatements.endDate), asc(accounts.number));
}

export async function getStatement(db: DbOrTx, org: string, id: string) {
  const [statement] = await statements(db, org, id);
  if (!statement) throw notFound("Bank statement");
  return statement;
}
export type Statement = Awaited<ReturnType<typeof getStatement>>;

/** Every statement mutation takes the same account lock before reading mutable state.
 * The cash journal's account FK also orders posting against a reconciliation close. */
export async function lockStatement(tx: Tx, org: string, id: string) {
  const [account] = await tx.select({ id: accounts.id }).from(accounts)
    .innerJoin(bankStatements, and(eq(bankStatements.organizationId, org), eq(bankStatements.accountId, accounts.id)))
    .where(and(eq(accounts.organizationId, org), eq(bankStatements.id, id)))
    .for("update", { of: accounts });
  if (!account) throw notFound("Bank statement");
  return getStatement(tx, org, id);
}

export async function statementPeriod(db: DbOrTx, org: string, statement: Statement) {
  const [period] = await db.select({
    firstDate: sql<string>`min(${bankStatements.startDate})::text`,
    isLatest: sql<boolean>`max(${bankStatements.endDate}) = ${statement.endDate}::date`,
    earlierOpen: sql<boolean>`bool_or(${bankStatements.endDate} < ${statement.startDate}::date and ${bankStatements.status} = 'open')`,
    laterClosed: sql<boolean>`bool_or(${bankStatements.startDate} > ${statement.endDate}::date and ${bankStatements.status} = 'closed')`,
  }).from(bankStatements)
    .where(and(eq(bankStatements.organizationId, org), eq(bankStatements.accountId, statement.accountId)));
  return period!;
}

export function statementLines(db: DbOrTx, org: string, id: string) {
  return db.select({
    id: bankStatementLines.id, externalId: bankStatementLines.externalId, date: bankStatementLines.date,
    description: bankStatementLines.description, amount: bankStatementLines.amount,
    journalLineId: bankStatementLines.journalLineId, entryId: journalEntries.id, entryNumber: journalEntries.number, lineNo: journalLines.lineNo,
  }).from(bankStatementLines)
    .leftJoin(journalLines, and(eq(journalLines.organizationId, org), eq(journalLines.id, bankStatementLines.journalLineId)))
    .leftJoin(journalEntries, and(eq(journalEntries.organizationId, org), eq(journalEntries.id, journalLines.journalEntryId)))
    .where(and(eq(bankStatementLines.organizationId, org), eq(bankStatementLines.statementId, id)))
    .orderBy(asc(bankStatementLines.date), asc(bankStatementLines.externalId));
}

export function depositForPosting(org: string) {
  return and(eq(deposits.organizationId, org), eq(deposits.id, journalEntries.sourceId),
    inArray(journalEntries.sourceType, ["deposit", "deposit_void"]));
}

export async function statementDetail(tx: Tx, org: string, statement: Statement) {
  const period = await statementPeriod(tx, org, statement);
  const lines = await statementLines(tx, org, statement.id);
  const throughEnd = and(eq(journalLines.organizationId, org), eq(journalLines.accountId, statement.accountId),
    lte(journalEntries.date, statement.endDate));
  const entryScope = and(eq(journalEntries.organizationId, org), eq(journalEntries.id, journalLines.journalEntryId));
  const [balance] = await tx.select({
    value: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0.00)::text`,
  }).from(journalLines).innerJoin(journalEntries, entryScope).where(throughEnd);
  // Historical outstanding items include postings cleared on a later statement.
  // Before the first imported period, the opening statement balance is the cleared baseline.
  const candidates = await tx.select({
    id: journalLines.id, entryId: journalEntries.id, entryNumber: journalEntries.number, date: journalEntries.date, lineNo: journalLines.lineNo,
    description: sql<string>`coalesce(${journalLines.description}, ${journalEntries.memo}, ${journalEntries.sourceNumber}, '')`,
    amount: sql<string>`(${journalLines.debit} - ${journalLines.credit})::text`,
    matchedLater: sql<boolean>`${bankStatementLines.journalLineId} is not null`,
    depositVoidedOn: deposits.voidDate,
  }).from(journalLines).innerJoin(journalEntries, entryScope)
    .leftJoin(deposits, depositForPosting(org))
    .leftJoin(bankStatementLines, and(eq(bankStatementLines.organizationId, org), eq(bankStatementLines.journalLineId, journalLines.id)))
    .leftJoin(bankStatements, and(eq(bankStatements.organizationId, org), eq(bankStatements.id, bankStatementLines.statementId)))
    .where(and(throughEnd, gte(journalEntries.date, period.firstDate),
      or(isNull(deposits.voidDate), gt(deposits.voidDate, statement.endDate)),
      or(isNull(bankStatementLines.journalLineId), gt(bankStatements.endDate, statement.endDate))))
    .orderBy(asc(journalEntries.date), asc(journalEntries.number), asc(journalLines.lineNo));

  const bookBalance = balance!.value;
  const outstanding = sum(candidates.map((row) => row.amount));
  const adjusted = dec(statement.closingBalance).plus(outstanding);
  const difference = dec(bookBalance).minus(adjusted);
  const statementDifference = dec(statement.closingBalance).minus(statement.openingBalance).minus(sum(lines.map((row) => row.amount)));
  const unmatchedCount = lines.filter((line) => !line.journalLineId).length;
  const summary = {
    bookBalance, outstandingAmount: cents(outstanding), adjustedBankBalance: cents(adjusted),
    difference: cents(difference), statementDifference: cents(statementDifference),
    unmatchedCount, outstandingCount: candidates.length,
  };
  const [lastClose] = statement.status === "closed" ? await tx.select({
    summary: sql<typeof summary>`${auditEvents.data}->'summary'`,
  }).from(auditEvents).where(and(
    eq(auditEvents.organizationId, org), eq(auditEvents.entityType, "bank_statement"),
    eq(auditEvents.entityId, statement.id), eq(auditEvents.action, "bank_statement.closed"),
  )).orderBy(desc(auditEvents.id)).limit(1) : [];
  return {
    statement, lines, candidates, summary, closedSummary: lastClose?.summary ?? null, isLatest: period.isLatest,
    canClose: statement.status === "open" && !period.earlierOpen && unmatchedCount === 0 && difference.isZero() && statementDifference.isZero(),
    canReopen: statement.status === "closed" && !period.laterClosed,
    canDiscard: statement.status === "open" && period.isLatest && unmatchedCount === lines.length,
  };
}
