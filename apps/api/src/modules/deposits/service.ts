import { randomUUID } from "node:crypto";
import { and, asc, eq, or } from "drizzle-orm";
import type { Tx } from "../../db/client";
import { accounts, depositPayments, deposits } from "../../db/schema";
import { audit } from "../../lib/audit";
import type { OrgContext } from "../../lib/context";
import { conflict, invalid, notFound } from "../../lib/errors";
import { cents, MONEY_RE, sum } from "../../lib/money";
import { nextDocumentNumber } from "../../lib/numbering";
import { postJournalEntry, reverseJournalEntry } from "../ledger/posting";
import { baselineStatement, depositHeader, eligibleReceipts, matchedStatement } from "./queries";

// All deposits use the organization's one Undeposited Funds account. Locking it
// serializes competing claims and same-key requests even across destination banks.
// The bank lock also orders cancellations against a statement match. NO KEY UPDATE
// remains compatible with ordinary postings taking account foreign-key locks.
async function lockAccounts(tx: Tx, org: string, bankAccountId: string) {
  const rows = await tx.select().from(accounts).where(and(eq(accounts.organizationId, org),
    or(eq(accounts.id, bankAccountId), eq(accounts.systemKey, "undeposited_funds"))))
    .orderBy(asc(accounts.id)).for("no key update");
  const source = rows.find(a => a.systemKey === "undeposited_funds");
  if (!source) throw invalid("The organization has no Undeposited Funds account.");
  return { source, bank: rows.find(a => a.id === bankAccountId) };
}

type NewDeposit = { date: string; bankAccountId: string; paymentIds: string[]; memo?: string | null };

export async function postDeposit(tx: Tx, ctx: OrgContext, input: NewDeposit, key: string) {
  const org = ctx.organizationId;
  const selected = new Set(input.paymentIds);
  if (selected.size !== input.paymentIds.length) throw invalid("Select each receipt only once.");
  const { bank, source } = await lockAccounts(tx, org, input.bankAccountId);
  const [existing] = await tx.select().from(deposits)
    .where(and(eq(deposits.organizationId, org), eq(deposits.idempotencyKey, key)));
  if (existing) {
    const members = await tx.select({ id: depositPayments.paymentId }).from(depositPayments)
      .where(and(eq(depositPayments.organizationId, org), eq(depositPayments.depositId, existing.id)));
    if (existing.date !== input.date || existing.bankAccountId !== input.bankAccountId || existing.memo !== (input.memo ?? null)
      || members.length !== selected.size || !members.every(r => selected.has(r.id))) {
      throw conflict("This idempotency key was used for a different deposit.");
    }
    return { header: await depositHeader(tx, org, existing.id), replayed: true };
  }
  if (!bank) throw notFound("Bank account");
  if (bank.id === source.id || bank.type !== "asset" || bank.subtype !== "bank" || !bank.isActive) {
    throw invalid("Select an active bank account for the deposit.");
  }
  const receipts = await eligibleReceipts(tx, org, input.date, input.paymentIds);
  if (receipts.length !== selected.size) throw conflict("One or more receipts are unavailable on this deposit date. Refresh the receipt list.");
  const total = cents(sum(receipts.map(r => r.amount)));
  if (!MONEY_RE.test(total)) throw invalid("The deposit total exceeds the maximum amount for a single journal posting.");

  const id = randomUUID();
  const number = await nextDocumentNumber(tx, org, "deposit");
  const entry = await postJournalEntry(tx, {
    organizationId: org, date: input.date, sourceId: id, sourceNumber: number, sourceType: "deposit",
    memo: input.memo ?? `Deposit ${number}`, createdBy: ctx.userId,
    lines: [{ accountId: bank.id, debit: total }, { accountId: source.id, credit: total }],
  });
  await tx.insert(deposits).values({
    id, organizationId: org, number, date: input.date, bankAccountId: bank.id, amount: total, memo: input.memo,
    journalEntryId: entry.id, idempotencyKey: key, createdBy: ctx.userId,
  });
  await tx.insert(depositPayments).values(receipts.map(r => ({ organizationId: org, depositId: id, paymentId: r.id })));
  await audit(tx, {
    organizationId: org, actorUserId: ctx.userId, ip: ctx.ip, action: "deposit.posted", entityType: "deposit", entityId: id,
    summary: `Posted deposit ${number} of $${total}`,
    data: { bankAccountId: bank.id, date: input.date, journalEntryId: entry.id, total, receiptCount: receipts.length },
  });
  return { header: await depositHeader(tx, org, id), replayed: false };
}

export async function voidDeposit(tx: Tx, ctx: OrgContext, id: string, date: string, reason: string) {
  const org = ctx.organizationId;
  const [known] = await tx.select({ bankAccountId: deposits.bankAccountId }).from(deposits)
    .where(and(eq(deposits.organizationId, org), eq(deposits.id, id)));
  if (!known) throw notFound("Deposit");
  await lockAccounts(tx, org, known.bankAccountId);
  const header = await depositHeader(tx, org, id);
  if (header.status === "void") {
    if (header.voidDate === date && header.voidReason === reason) return header;
    throw conflict("The deposit has already been voided with a different date or reason.");
  }
  if (await matchedStatement(tx, org, header.journalEntryId)) {
    throw conflict("Remove the bank statement match before voiding this deposit.");
  }
  if (await baselineStatement(tx, org, header)) {
    throw conflict("This deposit is included in the approved opening balance. Reopen the first bank statement before voiding it.");
  }
  const reversal = await reverseJournalEntry(tx, {
    organizationId: org, entryId: header.journalEntryId, sourceId: id, sourceNumber: header.number, sourceType: "deposit_void",
    date, memo: reason, createdBy: ctx.userId,
  });
  await tx.update(deposits).set({ status: "void", voidDate: date, voidReason: reason, voidJournalEntryId: reversal.id })
    .where(and(eq(deposits.organizationId, org), eq(deposits.id, id)));
  await tx.update(depositPayments).set({ releasedOn: date })
    .where(and(eq(depositPayments.organizationId, org), eq(depositPayments.depositId, id)));
  await audit(tx, {
    organizationId: org, actorUserId: ctx.userId, ip: ctx.ip, action: "deposit.voided", entityType: "deposit", entityId: id,
    summary: `Voided deposit ${header.number}`, data: { reason, date, journalEntryId: header.journalEntryId, voidJournalEntryId: reversal.id },
  });
  return depositHeader(tx, org, id);
}
