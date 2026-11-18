import { and, asc, eq, gte, lt, lte, sql, type SQL } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { accounts, journalEntries, journalLines, parties } from "../../db/schema";
import { audit } from "../../lib/audit";
import { requireOrg } from "../../lib/context";
import { invalid, notFound } from "../../lib/errors";
import { dec } from "../../lib/money";
import { isoDate, optionalText, uuidParam } from "../../lib/validation";
import { ACCOUNT_SUBTYPES, normalBalance, type AccountType } from "./chart-template";

const accountTypes = ["asset", "liability", "equity", "revenue", "expense"] as const;

const accountBody = z.object({
  number: z
    .string()
    .trim()
    .regex(/^[0-9A-Za-z.-]{1,20}$/, "Use letters, digits, dots or dashes (up to 20)."),
  name: z.string().trim().min(1, "Name is required.").max(160),
  type: z.enum(accountTypes),
  subtype: z.string().trim().min(1),
  description: optionalText(1000),
});

function assertSubtype(type: AccountType, subtype: string) {
  if (!(ACCOUNT_SUBTYPES[type] as readonly string[]).includes(subtype)) {
    throw invalid(`"${subtype}" is not a valid detail type for ${type} accounts.`, {
      allowed: ACCOUNT_SUBTYPES[type],
    });
  }
}

/** Signed balance in the account's normal direction (debit-normal: debits в€’ credits). */
export function signedBalanceSql(type: unknown, include?: SQL) {
  const filter = include ? sql`filter (where ${include})` : sql.empty();
  const netDebit = sql`coalesce(sum(${journalLines.debit} - ${journalLines.credit}) ${filter}, 0.00)`;
  return sql<string>`(case when ${type} in ('asset','expense') then ${netDebit} else -${netDebit} end)::text`;
}

const ledgerLineLimit = 5000;

export const accountRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/",
    {
      schema: {
        tags: ["Chart of Accounts"],
        summary: "Chart of Accounts with balances",
        querystring: z.object({
          asOf: isoDate.optional(),
          includeArchived: z
            .enum(["true", "false"])
            .optional()
            .transform((v) => v === "true"),
        }),
      },
    },
    async (req) => {
      const ctx = requireOrg(req);
      const { asOf, includeArchived } = req.query;
      const rows = await app.db
        .select({
          id: accounts.id,
          number: accounts.number,
          name: accounts.name,
          type: accounts.type,
          subtype: accounts.subtype,
          description: accounts.description,
          systemKey: accounts.systemKey,
          isActive: accounts.isActive,
          balance: signedBalanceSql(accounts.type, asOf ? lte(journalEntries.date, asOf) : undefined),
        })
        .from(accounts)
        .leftJoin(
          journalLines,
          and(eq(journalLines.organizationId, accounts.organizationId), eq(journalLines.accountId, accounts.id)),
        )
        .leftJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
        .where(
          and(
            eq(accounts.organizationId, ctx.organizationId),
            includeArchived ? undefined : eq(accounts.isActive, true),
          ),
        )
        .groupBy(accounts.id)
        .orderBy(accounts.number);
      return { data: rows.map((r) => ({ ...r, normalBalance: normalBalance(r.type) })), subtypes: ACCOUNT_SUBTYPES };
    },
  );

  app.post(
    "/",
    { schema: { tags: ["Chart of Accounts"], summary: "Create an account", body: accountBody } },
    async (req, reply) => {
      const ctx = requireOrg(req, "accounts.write");
      assertSubtype(req.body.type, req.body.subtype);
      const row = await app.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(accounts)
          .values({ ...req.body, organizationId: ctx.organizationId })
          .returning();
        await audit(tx, {
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: "account.created",
          entityType: "account",
          entityId: row!.id,
          summary: `Created account ${row!.number} ${row!.name}`,
          ip: ctx.ip,
        });
        return row;
      });
      return reply.status(201).send(row);
    },
  );

  app.get(
    "/:id",
    {
      schema: {
        tags: ["Chart of Accounts"],
        summary: "Account ledger with running balance",
        params: uuidParam,
        querystring: z.object({ from: isoDate.optional(), to: isoDate.optional() }),
      },
    },
    async (req) => {
      const ctx = requireOrg(req);
      const { from, to } = req.query;
      if (from && to && from > to) throw invalid("The start date must be on or before the end date.");
      return app.db.transaction(async (tx) => {
        const [account] = await tx
          .select()
          .from(accounts)
          .where(and(eq(accounts.organizationId, ctx.organizationId), eq(accounts.id, req.params.id)));
        if (!account) throw notFound("Account");
        const direction = normalBalance(account.type);
        const accountScope = and(
          eq(journalLines.organizationId, ctx.organizationId), eq(journalLines.accountId, account.id),
          to ? lte(journalEntries.date, to) : undefined,
        );
        const [balances] = await tx
          .select({
            openingBalance: from ? signedBalanceSql(account.type, lt(journalEntries.date, from)) : sql<string>`'0.00'`,
            closingBalance: signedBalanceSql(account.type),
          })
          .from(journalLines)
          .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
          .where(accountScope);

        const lines = await tx
          .select({
            id: journalLines.id,
            entryId: journalEntries.id,
            entryNumber: journalEntries.number,
            date: journalEntries.date,
            memo: journalEntries.memo,
            sourceType: journalEntries.sourceType,
            sourceId: journalEntries.sourceId,
            sourceNumber: journalEntries.sourceNumber,
            description: journalLines.description,
            debit: journalLines.debit,
            credit: journalLines.credit,
            partyName: parties.displayName,
          })
          .from(journalLines)
          .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
          .leftJoin(parties, eq(parties.id, journalLines.partyId))
          .where(and(accountScope, from ? gte(journalEntries.date, from) : undefined))
          .orderBy(asc(journalEntries.date), asc(journalEntries.number), asc(journalLines.lineNo))
          .limit(ledgerLineLimit + 1);

        let running = dec(balances!.openingBalance);
        const withBalance = lines.slice(0, ledgerLineLimit).map((l) => {
          const change = direction === "debit" ? dec(l.debit).minus(l.credit) : dec(l.credit).minus(l.debit);
          running = running.plus(change);
          return { ...l, balance: running.toFixed(2) };
        });
        return {
          account: { ...account, normalBalance: direction },
          openingBalance: balances!.openingBalance,
          closingBalance: balances!.closingBalance,
          truncated: lines.length > ledgerLineLimit,
          lines: withBalance,
        };
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
    },
  );

  app.patch(
    "/:id",
    {
      schema: {
        tags: ["Chart of Accounts"],
        summary: "Update or archive an account",
        params: uuidParam,
        body: accountBody.partial().extend({ isActive: z.boolean().optional() }),
      },
    },
    async (req) => {
      const ctx = requireOrg(req, "accounts.write");
      return app.db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(accounts)
          .where(and(eq(accounts.organizationId, ctx.organizationId), eq(accounts.id, req.params.id)))
          .for("update");
        if (!current) throw notFound("Account");
        const nextType = req.body.type ?? current.type;
        const nextSubtype = req.body.subtype ?? current.subtype;
        if (nextType !== current.type) {
          if (current.systemKey) throw invalid("The type of a system account cannot change.");
          const [posted] = await tx
            .select({ id: journalLines.id })
            .from(journalLines)
            .where(and(eq(journalLines.organizationId, ctx.organizationId), eq(journalLines.accountId, current.id)))
            .limit(1);
          if (posted) throw invalid("The account type cannot change after the account has postings.");
        }
        assertSubtype(nextType, nextSubtype);
        if (req.body.isActive === false && current.systemKey) {
          throw invalid("System accounts are used by 4VEKO automatically and cannot be archived.");
        }
        const [row] = await tx
          .update(accounts)
          .set({ ...req.body, updatedAt: new Date() })
          .where(eq(accounts.id, current.id))
          .returning();
        await audit(tx, {
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: req.body.isActive === false ? "account.archived" : "account.updated",
          entityType: "account",
          entityId: current.id,
          summary: `Updated account ${row!.number} ${row!.name}`,
          data: { fields: Object.keys(req.body) },
          ip: ctx.ip,
        });
        return row;
      });
    },
  );
};
