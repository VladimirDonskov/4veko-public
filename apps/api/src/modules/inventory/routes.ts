import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  accounts,
  inventoryAdjustmentLines,
  inventoryAdjustments,
  items,
  locations,
  stockLevels,
  stockMoves,
} from "../../db/schema";
import { audit } from "../../lib/audit";
import { requireOrg } from "../../lib/context";
import { invalid, notFound } from "../../lib/errors";
import { cents, dec } from "../../lib/money";
import { nextDocumentNumber } from "../../lib/numbering";
import { isoDate, nonNegativeMoney, optionalText, quantityInput, uuidParam } from "../../lib/validation";
import { postJournalEntry, systemAccounts, type PostingLine } from "../ledger/posting";
import { defaultLocationId, issueStock, linkMovesToEntry, receiveStock } from "./service";

const REASONS = ["opening_balance", "received", "count_correction", "damaged", "other"] as const;

export const inventoryRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/",
    { schema: { tags: ["Inventory"], summary: "Stock on hand and value for stocked items" } },
    async (req) => {
      const ctx = requireOrg(req);
      const rows = await app.db
        .select({
          itemId: items.id,
          sku: items.sku,
          name: items.name,
          unit: items.unit,
          reorderPoint: items.reorderPoint,
          isActive: items.isActive,
          qtyOnHand: sql<string>`coalesce(sum(${stockLevels.qtyOnHand}),0)::numeric(18,4)::text`,
          valueOnHand: sql<string>`coalesce(sum(${stockLevels.valueOnHand}),0)::numeric(18,2)::text`,
        })
        .from(items)
        .leftJoin(stockLevels, and(eq(stockLevels.organizationId, items.organizationId), eq(stockLevels.itemId, items.id)))
        .where(and(eq(items.organizationId, ctx.organizationId), eq(items.type, "inventory")))
        .groupBy(items.id)
        .orderBy(items.name);
      const data = rows.map((r) => {
        const qty = dec(r.qtyOnHand);
        return {
          ...r,
          averageCost: qty.isZero() ? "0.00" : dec(r.valueOnHand).dividedBy(qty).toFixed(4),
          lowStock: r.reorderPoint !== null && qty.lte(r.reorderPoint),
        };
      });
      const totalValue = cents(data.reduce((acc, r) => acc.plus(r.valueOnHand), dec(0)));
      return { data, totalValue };
    },
  );

  app.get("/locations", { schema: { tags: ["Inventory"], summary: "Warehouses" } }, async (req) => {
    const ctx = requireOrg(req);
    return app.db.select().from(locations).where(eq(locations.organizationId, ctx.organizationId)).orderBy(locations.code);
  });

  app.get(
    "/movements",
    {
      schema: {
        tags: ["Inventory"],
        summary: "Stock movement history",
        querystring: z.object({
          itemId: z.uuid().optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        }),
      },
    },
    async (req) => {
      const ctx = requireOrg(req);
      return app.db
        .select({
          id: stockMoves.id,
          date: stockMoves.date,
          itemId: stockMoves.itemId,
          sku: items.sku,
          itemName: items.name,
          quantity: stockMoves.quantity,
          valueChange: stockMoves.valueChange,
          sourceType: stockMoves.sourceType,
          sourceId: stockMoves.sourceId,
          sourceNumber: stockMoves.sourceNumber,
          journalEntryId: stockMoves.journalEntryId,
        })
        .from(stockMoves)
        .innerJoin(items, eq(items.id, stockMoves.itemId))
        .where(
          and(
            eq(stockMoves.organizationId, ctx.organizationId),
            req.query.itemId ? eq(stockMoves.itemId, req.query.itemId) : undefined,
          ),
        )
        .orderBy(desc(stockMoves.date), desc(stockMoves.createdAt))
        .limit(req.query.limit);
    },
  );

  app.get("/adjustments", { schema: { tags: ["Inventory"], summary: "List inventory adjustments" } }, async (req) => {
    const ctx = requireOrg(req);
    return app.db
      .select({
        id: inventoryAdjustments.id,
        number: inventoryAdjustments.number,
        date: inventoryAdjustments.date,
        reason: inventoryAdjustments.reason,
        memo: inventoryAdjustments.memo,
        journalEntryId: inventoryAdjustments.journalEntryId,
        valueChange: sql<string>`(select coalesce(sum(l.value_change),0)::numeric(18,2)::text from inventory_adjustment_lines l where l.adjustment_id = "inventory_adjustments"."id")`,
      })
      .from(inventoryAdjustments)
      .where(eq(inventoryAdjustments.organizationId, ctx.organizationId))
      .orderBy(desc(inventoryAdjustments.date), desc(inventoryAdjustments.number))
      .limit(200);
  });

  app.get(
    "/adjustments/:id",
    { schema: { tags: ["Inventory"], summary: "Get an inventory adjustment", params: uuidParam } },
    async (req) => {
      const ctx = requireOrg(req);
      const [adj] = await app.db
        .select()
        .from(inventoryAdjustments)
        .where(and(eq(inventoryAdjustments.organizationId, ctx.organizationId), eq(inventoryAdjustments.id, req.params.id)));
      if (!adj) throw notFound("Inventory adjustment");
      const lines = await app.db
        .select({
          lineNo: inventoryAdjustmentLines.lineNo,
          itemId: items.id,
          sku: items.sku,
          name: items.name,
          quantityChange: inventoryAdjustmentLines.quantityChange,
          unitCost: inventoryAdjustmentLines.unitCost,
          valueChange: inventoryAdjustmentLines.valueChange,
        })
        .from(inventoryAdjustmentLines)
        .innerJoin(items, eq(items.id, inventoryAdjustmentLines.itemId))
        .where(eq(inventoryAdjustmentLines.adjustmentId, adj.id))
        .orderBy(asc(inventoryAdjustmentLines.lineNo));
      return { ...adj, lines };
    },
  );

  app.post(
    "/adjustments",
    {
      schema: {
        tags: ["Inventory"],
        summary: "Adjust stock: receive opening or new stock, or write stock down",
        body: z.object({
          date: isoDate,
          reason: z.enum(REASONS),
          memo: optionalText(500),
          locationId: z.uuid().optional(),
          offsetAccountId: z.uuid().optional(),
          lines: z
            .array(
              z.object({
                itemId: z.uuid(),
                quantityChange: quantityInput.refine((v) => Number(v) !== 0, "Quantity change cannot be zero."),
                unitCost: nonNegativeMoney.optional(),
              }),
            )
            .min(1)
            .max(200),
        }),
      },
    },
    async (req, reply) => {
      const ctx = requireOrg(req, "inventory.adjust");
      const body = req.body;
      const result = await app.db.transaction(async (tx) => {
        const locationId = body.locationId ?? (await defaultLocationId(tx, ctx.organizationId));
        const sys = await systemAccounts(tx, ctx.organizationId, ["opening_balance_equity", "inventory_shrinkage"]);
        const offsetAccountId =
          body.offsetAccountId ??
          (body.reason === "opening_balance" ? sys("opening_balance_equity") : sys("inventory_shrinkage"));
        const [offset] = await tx
          .select({ id: accounts.id, type: accounts.type, subtype: accounts.subtype })
          .from(accounts)
          .where(and(eq(accounts.organizationId, ctx.organizationId), eq(accounts.id, offsetAccountId)));
        if (!offset) throw invalid("The offset account does not exist.");
        if (offset.subtype === "inventory") throw invalid("The offset account cannot be an inventory account.");

        const itemIds = [...new Set(body.lines.map((l) => l.itemId))];
        const itemRows = await tx
          .select()
          .from(items)
          .where(and(eq(items.organizationId, ctx.organizationId), inArray(items.id, itemIds)));
        const byId = new Map(itemRows.map((i) => [i.id, i]));
        for (const l of body.lines) {
          const item = byId.get(l.itemId);
          if (!item) throw invalid("One or more items do not exist.");
          if (item.type !== "inventory") throw invalid(`${item.sku} is not a stocked item.`);
          if (dec(l.quantityChange).gt(0) && l.unitCost === undefined) {
            throw invalid(`Enter a unit cost for the stock added to ${item.sku}.`);
          }
        }

        const number = await nextDocumentNumber(tx, ctx.organizationId, "adjustment");
        const [adj] = await tx
          .insert(inventoryAdjustments)
          .values({
            organizationId: ctx.organizationId,
            number,
            date: body.date,
            locationId,
            offsetAccountId,
            reason: body.reason,
            memo: body.memo,
            createdBy: ctx.userId,
          })
          .returning();
        if (!adj) throw new Error("Adjustment insert returned nothing");

        const glLines: PostingLine[] = [];
        // Lock stock rows in a stable order to avoid deadlocks between concurrent documents.
        const ordered = body.lines.map((l, i) => ({ ...l, lineNo: i + 1 })).sort((a, b) => a.itemId.localeCompare(b.itemId));
        const lineValues = new Map<number, string>();
        for (const l of ordered) {
          const item = byId.get(l.itemId)!;
          const source = {
            organizationId: ctx.organizationId,
            itemId: item.id,
            locationId,
            date: body.date,
            sourceType: "inventory_adjustment",
            sourceId: adj.id,
            sourceNumber: number,
          };
          const change = dec(l.quantityChange);
          if (change.gt(0)) {
            const value = await receiveStock(tx, { ...source, quantity: change.toFixed(), value: cents(change.times(l.unitCost!)) });
            lineValues.set(l.lineNo, value);
            glLines.push({ accountId: item.inventoryAccountId!, debit: value, description: `${item.sku} +${change.toFixed()}` });
            glLines.push({ accountId: offsetAccountId, credit: value, description: `${item.sku} ${body.reason}` });
          } else {
            const cost = await issueStock(tx, { ...source, quantity: change.negated().toFixed() });
            lineValues.set(l.lineNo, cents(dec(cost).negated()));
            glLines.push({ accountId: offsetAccountId, debit: cost, description: `${item.sku} ${body.reason}` });
            glLines.push({ accountId: item.inventoryAccountId!, credit: cost, description: `${item.sku} ${change.toFixed()}` });
          }
        }
        await tx.insert(inventoryAdjustmentLines).values(
          body.lines.map((l, i) => ({
            organizationId: ctx.organizationId,
            adjustmentId: adj.id,
            lineNo: i + 1,
            itemId: l.itemId,
            quantityChange: l.quantityChange,
            unitCost: l.unitCost ?? null,
            valueChange: lineValues.get(i + 1)!,
          })),
        );

        let journalEntryId: string | null = null;
        // A zero-value adjustment (e.g. free stock) moves quantity without a GL entry.
        if (glLines.some((g) => !dec(g.debit ?? g.credit ?? 0).isZero())) {
          const entry = await postJournalEntry(tx, {
            organizationId: ctx.organizationId,
            date: body.date,
            memo: `Inventory adjustment ${number}${body.memo ? `: ${body.memo}` : ""}`,
            sourceType: "inventory_adjustment",
            sourceId: adj.id,
            sourceNumber: number,
            createdBy: ctx.userId,
            lines: glLines,
          });
          journalEntryId = entry.id;
          await tx.update(inventoryAdjustments).set({ journalEntryId }).where(eq(inventoryAdjustments.id, adj.id));
          await linkMovesToEntry(tx, ctx.organizationId, adj.id, entry.id);
        }
        await audit(tx, {
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: "inventory.adjusted",
          entityType: "inventory_adjustment",
          entityId: adj.id,
          summary: `Posted inventory adjustment ${number} (${body.reason})`,
          data: { lines: body.lines.length },
          ip: ctx.ip,
        });
        return { ...adj, journalEntryId };
      });
      return reply.status(201).send(result);
    },
  );
};
