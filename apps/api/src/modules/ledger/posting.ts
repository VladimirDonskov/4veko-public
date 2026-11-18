import { and, eq, inArray } from "drizzle-orm";
import type { Tx } from "../../db/client";
import { accounts, journalEntries, journalLines, organizations } from "../../db/schema";
import { AppError, invalid, notFound } from "../../lib/errors";
import { cents, dec, sum } from "../../lib/money";
import { nextNumber } from "../../lib/numbering";
import type { SystemKey } from "../accounts/chart-template";

export type PostingLine = {
  accountId: string;
  debit?: string;
  credit?: string;
  description?: string | null;
  partyId?: string | null;
};

export type PostingInput = {
  organizationId: string;
  date: string;
  memo?: string | null;
  sourceType: (typeof journalEntries.$inferInsert)["sourceType"];
  sourceId?: string | null;
  sourceNumber?: string | null;
  reversalOfId?: string | null;
  createdBy: string | null;
  lines: PostingLine[];
};

/**
 * The single entry point for writing to the General Ledger. Every module
 * calls this inside its own transaction. Rules are checked here for clear
 * error messages and again by database triggers (balance, period lock,
 * immutability) as the last line of defence.
 */
export async function postJournalEntry(tx: Tx, input: PostingInput) {
  // Merge zero lines away and normalise amounts to cents.
  const lines = input.lines
    .map((l) => ({
      ...l,
      debit: cents(l.debit ?? 0),
      credit: cents(l.credit ?? 0),
    }))
    .filter((l) => !(dec(l.debit).isZero() && dec(l.credit).isZero()));

  if (lines.length < 2) throw invalid("A journal entry needs at least two lines with amounts.");
  for (const l of lines) {
    if (dec(l.debit).isNegative() || dec(l.credit).isNegative()) {
      throw invalid("Debit and credit amounts cannot be negative.");
    }
    if (!dec(l.debit).isZero() && !dec(l.credit).isZero()) {
      throw invalid("A journal line can have a debit or a credit, not both.");
    }
  }
  const totalDebit = sum(lines.map((l) => l.debit));
  const totalCredit = sum(lines.map((l) => l.credit));
  if (!totalDebit.equals(totalCredit)) {
    throw new AppError(
      422,
      "unbalanced_entry",
      `Debits (${totalDebit.toFixed(2)}) must equal credits (${totalCredit.toFixed(2)}).`,
    );
  }

  const [org] = await tx
    .select({ booksClosedThrough: organizations.booksClosedThrough })
    .from(organizations)
    .where(eq(organizations.id, input.organizationId));
  if (!org) throw notFound("Organization");
  if (org.booksClosedThrough && input.date <= org.booksClosedThrough) {
    throw new AppError(
      422,
      "period_closed",
      `The books are closed through ${org.booksClosedThrough}. Choose a later date or reopen the period.`,
    );
  }

  const accountIds = [...new Set(lines.map((l) => l.accountId))];
  const found = await tx
    .select({ id: accounts.id, isActive: accounts.isActive, name: accounts.name })
    .from(accounts)
    .where(and(eq(accounts.organizationId, input.organizationId), inArray(accounts.id, accountIds)));
  if (found.length !== accountIds.length) throw invalid("One or more accounts do not exist in this organization.");
  const inactive = found.find((a) => !a.isActive);
  if (inactive) throw invalid(`Account "${inactive.name}" is archived and cannot receive postings.`);

  const number = await nextNumber(tx, input.organizationId, "journal");
  const [entry] = await tx
    .insert(journalEntries)
    .values({
      organizationId: input.organizationId,
      number,
      date: input.date,
      memo: input.memo ?? null,
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
      sourceNumber: input.sourceNumber ?? null,
      reversalOfId: input.reversalOfId ?? null,
      createdBy: input.createdBy,
    })
    .returning();
  if (!entry) throw new Error("Journal entry insert returned nothing");

  await tx.insert(journalLines).values(
    lines.map((l, i) => ({
      organizationId: input.organizationId,
      journalEntryId: entry.id,
      lineNo: i + 1,
      accountId: l.accountId,
      description: l.description ?? null,
      debit: l.debit,
      credit: l.credit,
      partyId: l.partyId ?? null,
    })),
  );
  return entry;
}

/** Post the mirror image of an entry and link the two. */
export async function reverseJournalEntry(
  tx: Tx,
  args: {
    organizationId: string;
    entryId: string;
    date: string;
    memo?: string | null;
    createdBy: string | null;
    sourceType?: PostingInput["sourceType"];
    sourceId?: string | null;
    sourceNumber?: string | null;
  },
) {
  const [original] = await tx
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.organizationId, args.organizationId), eq(journalEntries.id, args.entryId)))
    .for("update");
  if (!original) throw notFound("Journal entry");
  if (original.reversedById) throw new AppError(409, "already_reversed", `Entry #${original.number} is already reversed.`);
  if (original.reversalOfId) throw new AppError(409, "is_reversal", "A reversing entry cannot itself be reversed.");
  if (args.date < original.date) throw invalid("The reversal date cannot be earlier than the original entry date.");

  const lines = await tx
    .select()
    .from(journalLines)
    .where(eq(journalLines.journalEntryId, original.id))
    .orderBy(journalLines.lineNo);

  const reversal = await postJournalEntry(tx, {
    organizationId: args.organizationId,
    date: args.date,
    memo: args.memo ?? `Reversal of entry #${original.number}${original.memo ? `: ${original.memo}` : ""}`,
    sourceType: args.sourceType ?? "reversal",
    sourceId: args.sourceId ?? original.sourceId,
    sourceNumber: args.sourceNumber ?? original.sourceNumber,
    reversalOfId: original.id,
    createdBy: args.createdBy,
    lines: lines.map((l) => ({
      accountId: l.accountId,
      debit: l.credit,
      credit: l.debit,
      description: l.description,
      partyId: l.partyId,
    })),
  });

  await tx.update(journalEntries).set({ reversedById: reversal.id }).where(eq(journalEntries.id, original.id));
  return reversal;
}

/** Resolve system accounts (AR, inventory, sales tax...) for an organization. */
export async function systemAccounts(tx: Tx, organizationId: string, keys: SystemKey[]) {
  const rows = await tx
    .select({ id: accounts.id, systemKey: accounts.systemKey })
    .from(accounts)
    .where(and(eq(accounts.organizationId, organizationId), inArray(accounts.systemKey, keys)));
  const map = new Map(rows.map((r) => [r.systemKey as SystemKey, r.id]));
  for (const key of keys) {
    if (!map.has(key)) throw new AppError(500, "missing_system_account", `System account "${key}" is missing.`);
  }
  return (key: SystemKey) => map.get(key)!;
}
