import { and, desc, eq, gte, ilike, lte, or, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { accounts, journalEntries, journalLines, parties, users } from "../../db/schema";
import { audit } from "../../lib/audit";
import { requireOrg } from "../../lib/context";
import { invalid, notFound } from "../../lib/errors";
import { isoDate, likePattern, moneyInput, optionalText, uuidParam } from "../../lib/validation";
import { postJournalEntry, reverseJournalEntry } from "./posting";

const manualLine = z.object({
  accountId: z.uuid(),
  debit: moneyInput.optional(),
  credit: moneyInput.optional(),
  description: optionalText(500),
  partyId: z.uuid().nullish(),
});

export const journalRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/",
    {
      schema: {
        tags: ["General Ledger"],
        summary: "List journal entries",
        querystring: z.object({
          from: isoDate.optional(),
          to: isoDate.optional(),
          q: z.string().trim().max(200).optional(),
          sourceType: z
            .enum(["manual", "invoice", "invoice_void", "payment", "inventory_adjustment", "reversal"])
            .optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
          offset: z.coerce.number().int().min(0).default(0),
        }),
      },
    },
    async (req) => {
      const ctx = requireOrg(req);
      const { from, to, q, sourceType, limit, offset } = req.query;
      const where = and(
        eq(journalEntries.organizationId, ctx.organizationId),
        from ? gte(journalEntries.date, from) : undefined,
        to ? lte(journalEntries.date, to) : undefined,
        sourceType ? eq(journalEntries.sourceType, sourceType) : undefined,
        q
          ? or(
              ilike(journalEntries.memo, likePattern(q)),
              ilike(journalEntries.sourceNumber, likePattern(q)),
              /^\d+$/.test(q) ? eq(journalEntries.number, Number(q)) : undefined,
            )
          : undefined,
      );
      const rows = await app.db
        .select({
          id: journalEntries.id,
          number: journalEntries.number,
          date: journalEntries.date,
          memo: journalEntries.memo,
          sourceType: journalEntries.sourceType,
          sourceId: journalEntries.sourceId,
          sourceNumber: journalEntries.sourceNumber,
          reversalOfId: journalEntries.reversalOfId,
          reversedById: journalEntries.reversedById,
          total: sql<string>`(select coalesce(sum(jl.debit),0)::numeric(18,2)::text from journal_lines jl where jl.journal_entry_id = "journal_entries"."id")`,
          createdAt: journalEntries.createdAt,
        })
        .from(journalEntries)
        .where(where)
        .orderBy(desc(journalEntries.date), desc(journalEntries.number))
        .limit(limit)
        .offset(offset);
      const [{ total } = { total: 0 }] = await app.db
        .select({ total: sql<number>`count(*)::int` })
        .from(journalEntries)
        .where(where);
      return { data: rows, total };
    },
  );

  app.post(
    "/",
    {
      schema: {
        tags: ["General Ledger"],
        summary: "Post a manual journal entry",
        body: z.object({
          date: isoDate,
          memo: optionalText(500),
          lines: z.array(manualLine).min(2, "Add at least two lines.").max(200),
        }),
      },
    },
    async (req, reply) => {
      const ctx = requireOrg(req, "journal.post");
      for (const [i, l] of req.body.lines.entries()) {
        if (!l.debit && !l.credit) throw invalid(`Line ${i + 1} needs a debit or a credit amount.`);
      }
      const entry = await app.db.transaction(async (tx) => {
        const entry = await postJournalEntry(tx, {
          organizationId: ctx.organizationId,
          date: req.body.date,
          memo: req.body.memo,
          sourceType: "manual",
          createdBy: ctx.userId,
          lines: req.body.lines,
        });
        await audit(tx, {
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: "journal.posted",
          entityType: "journal_entry",
          entityId: entry.id,
          summary: `Posted manual journal entry #${entry.number}`,
          ip: ctx.ip,
        });
        return entry;
      });
      return reply.status(201).send(entry);
    },
  );

  app.get(
    "/:id",
    { schema: { tags: ["General Ledger"], summary: "Get a journal entry with lines", params: uuidParam } },
    async (req) => {
      const ctx = requireOrg(req);
      const [entry] = await app.db
        .select({ entry: journalEntries, createdByName: users.name })
        .from(journalEntries)
        .leftJoin(users, eq(users.id, journalEntries.createdBy))
        .where(and(eq(journalEntries.organizationId, ctx.organizationId), eq(journalEntries.id, req.params.id)));
      if (!entry) throw notFound("Journal entry");
      const lines = await app.db
        .select({
          id: journalLines.id,
          lineNo: journalLines.lineNo,
          accountId: accounts.id,
          accountNumber: accounts.number,
          accountName: accounts.name,
          description: journalLines.description,
          debit: journalLines.debit,
          credit: journalLines.credit,
          partyId: journalLines.partyId,
          partyName: parties.displayName,
        })
        .from(journalLines)
        .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
        .leftJoin(parties, eq(parties.id, journalLines.partyId))
        .where(eq(journalLines.journalEntryId, entry.entry.id))
        .orderBy(journalLines.lineNo);
      return { ...entry.entry, createdByName: entry.createdByName, lines };
    },
  );

  app.post(
    "/:id/reverse",
    {
      schema: {
        tags: ["General Ledger"],
        summary: "Reverse a manual journal entry",
        params: uuidParam,
        body: z.object({ date: isoDate, memo: optionalText(500) }),
      },
    },
    async (req, reply) => {
      const ctx = requireOrg(req, "journal.post");
      const reversal = await app.db.transaction(async (tx) => {
        const [original] = await tx
          .select({ sourceType: journalEntries.sourceType, number: journalEntries.number })
          .from(journalEntries)
          .where(and(eq(journalEntries.organizationId, ctx.organizationId), eq(journalEntries.id, req.params.id)));
        if (!original) throw notFound("Journal entry");
        if (original.sourceType !== "manual" && original.sourceType !== "reversal") {
          throw invalid("This entry was created by a document. Void or correct the source document instead.");
        }
        const reversal = await reverseJournalEntry(tx, {
          organizationId: ctx.organizationId,
          entryId: req.params.id,
          date: req.body.date,
          memo: req.body.memo,
          createdBy: ctx.userId,
        });
        await audit(tx, {
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: "journal.reversed",
          entityType: "journal_entry",
          entityId: req.params.id,
          summary: `Reversed journal entry #${original.number} with #${reversal.number}`,
          data: { reversalId: reversal.id },
          ip: ctx.ip,
        });
        return reversal;
      });
      return reply.status(201).send(reversal);
    },
  );
};
