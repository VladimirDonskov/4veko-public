import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "../../db/client";
import { accounts, bankStatementLines, bankStatements, deposits, journalEntries, journalLines } from "../../db/schema";
import { audit } from "../../lib/audit";
import type { OrgContext } from "../../lib/context";
import { conflict, invalid, notFound } from "../../lib/errors";
import { cents, dec, MONEY_RE, sum } from "../../lib/money";
import { isoDate } from "../../lib/validation";
import { depositForPosting, lockStatement, statementDetail, statementLines, statementPeriod, type Statement } from "./queries";

const reference = z.string().trim().min(1).max(120).refine((v) => !v.includes("\0"), "Invalid reference.");
const balance = z.string().trim().regex(/^-?\d{1,22}(\.\d{1,2})?$/, "Enter a signed dollar balance with up to two decimal places.").transform(cents);
export const importBody = z.object({
  accountId: z.uuid(), externalId: reference, startDate: isoDate, endDate: isoDate,
  openingBalance: balance, closingBalance: balance,
  lines: z.array(z.object({
    externalId: reference, date: isoDate,
    description: z.string().trim().max(500).refine((v) => !v.includes("\0"), "Invalid description."),
    amount: z.string().trim().regex(MONEY_RE, "Enter a signed dollar amount with up to two decimal places.")
      .transform(cents).refine((v) => !dec(v).isZero(), "Statement amounts must be nonzero."),
  })).max(1000),
});
type ImportBody = z.output<typeof importBody>;

function record(tx: Tx, ctx: OrgContext, id: string, action: string, summary: string, data: Record<string, unknown>) {
  return audit(tx, {
    organizationId: ctx.organizationId, actorUserId: ctx.userId, ip: ctx.ip,
    entityType: "bank_statement", entityId: id, action: `bank_statement.${action}`, summary, data,
  });
}

export async function importStatement(tx: Tx, ctx: OrgContext, input: ImportBody) {
  const org = ctx.organizationId;
  const [account] = await tx.select().from(accounts)
    .where(and(eq(accounts.organizationId, org), eq(accounts.id, input.accountId))).for("update");
  if (!account) throw notFound("Bank account");
  const accountScope = and(eq(bankStatements.organizationId, org), eq(bankStatements.accountId, account.id));
  const [priorImport] = await tx.select().from(bankStatements)
    .where(and(accountScope, eq(bankStatements.externalId, input.externalId)));
  const byReference = new Map(input.lines.map((line) => [line.externalId, line]));
  if (byReference.size !== input.lines.length) throw invalid("Each imported bank transaction needs a unique reference.");
  if (priorImport) {
    const stored = await statementLines(tx, org, priorImport.id);
    const sameRows = stored.length === input.lines.length && stored.every((line) => {
      const other = byReference.get(line.externalId);
      return other && line.date === other.date && line.description === other.description && line.amount === other.amount;
    });
    if (!sameRows || priorImport.startDate !== input.startDate || priorImport.endDate !== input.endDate
      || priorImport.openingBalance !== input.openingBalance || priorImport.closingBalance !== input.closingBalance) {
      throw conflict("That statement reference already exists with different amounts, dates or transactions.");
    }
    return { id: priorImport.id, imported: 0, duplicate: true };
  }
  if (account.type !== "asset" || account.subtype !== "bank" || !account.isActive) {
    throw invalid("Choose an active bank account.");
  }
  if (input.startDate > input.endDate || input.lines.some((line) => line.date < input.startDate || line.date > input.endDate)) {
    throw invalid("The start must be on or before the end, and all bank transaction dates must fall within the statement.");
  }
  if (!dec(input.openingBalance).plus(sum(input.lines.map((line) => line.amount))).eq(input.closingBalance)) {
    throw invalid("The opening balance plus all bank transactions must equal the closing balance.");
  }
  const [previous] = await tx.select({
    nextStart: sql<string>`(${bankStatements.endDate} + 1)::text`,
    closingBalance: bankStatements.closingBalance,
  }).from(bankStatements).where(accountScope).orderBy(desc(bankStatements.endDate)).limit(1);
  if (previous && (previous.nextStart !== input.startDate || previous.closingBalance !== input.openingBalance)) {
    throw conflict(`The next statement must start on ${previous.nextStart} with an opening balance of ${previous.closingBalance}.`);
  }
  const { lines, ...header } = input;
  const [created] = await tx.insert(bankStatements).values({ ...header, organizationId: org })
    .returning({ id: bankStatements.id });
  const id = created!.id;
  if (lines.length) await tx.insert(bankStatementLines).values(lines.map((line) => ({
    ...line, statementId: id, organizationId: org, accountId: account.id,
  })));
  await record(tx, ctx, id, "imported", `Imported bank statement ${input.externalId}`, { ...header, lineCount: lines.length });
  return { id, imported: lines.length, duplicate: false };
}

function requireOpen(statement: Statement) {
  if (statement.status !== "open") throw conflict("Reopen this bank statement before changing it.");
}

export async function changeMatch(tx: Tx, ctx: OrgContext, id: string, lineId: string, journalLineId: string | null, expected?: string) {
  const org = ctx.organizationId;
  const statement = await lockStatement(tx, org, id);
  requireOpen(statement);
  const scope = and(eq(bankStatementLines.organizationId, org), eq(bankStatementLines.statementId, id), eq(bankStatementLines.id, lineId));
  const [line] = await tx.select().from(bankStatementLines).where(scope);
  if (!line) throw notFound("Bank transaction");
  if (line.journalLineId === journalLineId) return { id };
  if (expected && line.journalLineId !== expected) throw conflict("The match changed. Refresh the statement and try again.");
  if (journalLineId) {
    if (line.journalLineId) throw conflict("Remove the existing match before selecting another posting.");
    const [posting] = await tx.select({
      date: journalEntries.date, amount: sql<string>`(${journalLines.debit} - ${journalLines.credit})::text`,
      depositVoidedOn: deposits.voidDate,
    }).from(journalLines)
      .innerJoin(journalEntries, and(eq(journalEntries.organizationId, org), eq(journalEntries.id, journalLines.journalEntryId)))
      .leftJoin(deposits, depositForPosting(org))
      .where(and(eq(journalLines.organizationId, org), eq(journalLines.accountId, statement.accountId), eq(journalLines.id, journalLineId)));
    if (!posting) throw notFound("Bank account posting");
    if (posting.depositVoidedOn) throw conflict("A cancelled deposit and its reversal cannot be matched to bank activity.");
    const period = await statementPeriod(tx, org, statement);
    if (posting.date < period.firstDate || posting.date > statement.endDate) throw invalid("The posting falls outside the dates eligible for this statement.");
    if (!dec(posting.amount).eq(line.amount)) throw invalid("The posting amount and sign must equal the bank transaction.");
    const [existing] = await tx.select({ id: bankStatementLines.id }).from(bankStatementLines)
      .where(and(eq(bankStatementLines.organizationId, org), eq(bankStatementLines.journalLineId, journalLineId)));
    if (existing) throw conflict("This posting has already been matched to a bank transaction.");
  }
  await tx.update(bankStatementLines).set({ journalLineId }).where(scope);
  await record(tx, ctx, id, journalLineId ? "matched" : "unmatched",
    `${journalLineId ? "Matched" : "Unmatched"} bank transaction ${line.externalId}`,
    { lineId, journalLineId: journalLineId ?? line.journalLineId });
  return { id };
}

export async function setClosed(tx: Tx, ctx: OrgContext, id: string, close: boolean) {
  const org = ctx.organizationId;
  const statement = await lockStatement(tx, org, id);
  const status = close ? "closed" : "open";
  if (statement.status === status) return { id };
  const detail = await statementDetail(tx, org, statement);
  if (close && !detail.canClose) {
    throw conflict("Match every bank transaction, resolve differences and close earlier statements first.", detail.summary);
  }
  if (!close && !detail.canReopen) throw conflict("Reopen later closed statements first.");
  await tx.update(bankStatements).set({ status, closedAt: close ? new Date() : null })
    .where(and(eq(bankStatements.organizationId, org), eq(bankStatements.id, id)));
  await record(tx, ctx, id, close ? "closed" : "reopened", `${close ? "Closed" : "Reopened"} bank statement ${statement.externalId}`,
    { accountId: statement.accountId, externalId: statement.externalId, summary: detail.summary });
  return { id };
}

export async function discard(tx: Tx, ctx: OrgContext, id: string) {
  const org = ctx.organizationId;
  const statement = await lockStatement(tx, org, id);
  requireOpen(statement);
  const period = await statementPeriod(tx, org, statement);
  if (!period.isLatest) throw conflict("Only the most recent statement may be discarded.");
  const lines = await statementLines(tx, org, id);
  if (lines.some((line) => line.journalLineId)) throw conflict("Unmatch all bank transactions before discarding the statement.");
  await tx.delete(bankStatementLines).where(and(eq(bankStatementLines.organizationId, org), eq(bankStatementLines.statementId, id)));
  await tx.delete(bankStatements).where(and(eq(bankStatements.organizationId, org), eq(bankStatements.id, id)));
  await record(tx, ctx, id, "discarded", `Discarded bank statement ${statement.externalId}`, {
    accountId: statement.accountId, externalId: statement.externalId, startDate: statement.startDate,
    endDate: statement.endDate, openingBalance: statement.openingBalance, closingBalance: statement.closingBalance, lineCount: lines.length,
  });
  return { id };
}
