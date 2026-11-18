import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Tx } from "../../db/client";
import { accounts, items, stockLevels, stockMoves } from "../../db/schema";
import { audit } from "../../lib/audit";
import { requireOrg } from "../../lib/context";
import { invalid, notFound } from "../../lib/errors";
import {
  likePattern,
  listQuery,
  nonNegativeMoney,
  optionalText,
  quantityInput,
  uuidParam,
} from "../../lib/validation";
import { systemAccounts } from "../ledger/posting";

const itemBody = z.object({
  sku: z.string().trim().min(1, "SKU is required.").max(60),
  name: z.string().trim().min(1, "Name is required.").max(200),
  description: optionalText(4000),
  type: z.enum(["inventory", "non_inventory", "service"]),
  unit: z.string().trim().min(1).max(20).optional(),
  salesPrice: nonNegativeMoney.optional(),
  purchaseCost: nonNegativeMoney.optional(),
  taxable: z.boolean().optional(),
  incomeAccountId: z.uuid().optional(),
  cogsAccountId: z.uuid().nullish(),
  inventoryAccountId: z.uuid().nullish(),
  reorderPoint: quantityInput.nullish(),
});

const stockSummary = {
  qtyOnHand: sql<string>`coalesce(sum(${stockLevels.qtyOnHand}), 0)::numeric(18,4)::text`,
  valueOnHand: sql<string>`coalesce(sum(${stockLevels.valueOnHand}), 0)::numeric(18,2)::text`,
};

export const itemRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/",
    {
      schema: {
        tags: ["Items"],
        summary: "List products and services with stock on hand",
        querystring: listQuery.extend({ type: z.enum(["inventory", "non_inventory", "service"]).optional() }),
      },
    },
    async (req) => {
      const ctx = requireOrg(req);
      const { q, limit, offset, includeArchived, type } = req.query;
      const where = and(
        eq(items.organizationId, ctx.organizationId),
        includeArchived ? undefined : eq(items.isActive, true),
        type ? eq(items.type, type) : undefined,
        q ? or(ilike(items.name, likePattern(q)), ilike(items.sku, likePattern(q))) : undefined,
      );
      const rows = await app.db
        .select({
          id: items.id,
          sku: items.sku,
          name: items.name,
          type: items.type,
          unit: items.unit,
          salesPrice: items.salesPrice,
          purchaseCost: items.purchaseCost,
          taxable: items.taxable,
          reorderPoint: items.reorderPoint,
          isActive: items.isActive,
          ...stockSummary,
        })
        .from(items)
        .leftJoin(stockLevels, and(eq(stockLevels.organizationId, items.organizationId), eq(stockLevels.itemId, items.id)))
        .where(where)
        .groupBy(items.id)
        .orderBy(items.name)
        .limit(limit)
        .offset(offset);
      const [{ total } = { total: 0 }] = await app.db
        .select({ total: sql<number>`count(*)::int` })
        .from(items)
        .where(where);
      return { data: rows, total };
    },
  );

  app.post("/", { schema: { tags: ["Items"], summary: "Create a product or service", body: itemBody } }, async (req, reply) => {
    const ctx = requireOrg(req, "masterdata.write");
    const row = await app.db.transaction(async (tx) => {
      const accountsFor = await resolveItemAccounts(tx, ctx.organizationId, req.body.type, req.body);
      const [row] = await tx
        .insert(items)
        .values({
          organizationId: ctx.organizationId,
          sku: req.body.sku,
          name: req.body.name,
          description: req.body.description,
          type: req.body.type,
          unit: req.body.unit ?? "ea",
          salesPrice: req.body.salesPrice ?? "0",
          purchaseCost: req.body.purchaseCost ?? "0",
          taxable: req.body.taxable ?? req.body.type !== "service",
          reorderPoint: req.body.type === "inventory" ? (req.body.reorderPoint ?? null) : null,
          ...accountsFor,
        })
        .returning();
      await audit(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        action: "item.created",
        entityType: "item",
        entityId: row!.id,
        summary: `Created item ${row!.sku} ${row!.name}`,
        ip: ctx.ip,
      });
      return row;
    });
    return reply.status(201).send(row);
  });

  app.get("/:id", { schema: { tags: ["Items"], summary: "Get an item with stock and recent movements", params: uuidParam } }, async (req) => {
    const ctx = requireOrg(req);
    const [row] = await app.db
      .select({ item: items, ...stockSummary })
      .from(items)
      .leftJoin(stockLevels, and(eq(stockLevels.organizationId, items.organizationId), eq(stockLevels.itemId, items.id)))
      .where(and(eq(items.organizationId, ctx.organizationId), eq(items.id, req.params.id)))
      .groupBy(items.id);
    if (!row) throw notFound("Item");
    const moves = await app.db
      .select()
      .from(stockMoves)
      .where(and(eq(stockMoves.organizationId, ctx.organizationId), eq(stockMoves.itemId, req.params.id)))
      .orderBy(desc(stockMoves.date), desc(stockMoves.createdAt))
      .limit(50);
    return { ...row.item, qtyOnHand: row.qtyOnHand, valueOnHand: row.valueOnHand, movements: moves };
  });

  app.patch(
    "/:id",
    {
      schema: {
        tags: ["Items"],
        summary: "Update an item",
        params: uuidParam,
        body: itemBody.partial().extend({ isActive: z.boolean().optional() }),
      },
    },
    async (req) => {
      const ctx = requireOrg(req, "masterdata.write");
      return app.db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(items)
          .where(and(eq(items.organizationId, ctx.organizationId), eq(items.id, req.params.id)))
          .for("update");
        if (!current) throw notFound("Item");
        const nextType = req.body.type ?? current.type;
        if (nextType !== current.type) {
          const [moved] = await tx
            .select({ id: stockMoves.id })
            .from(stockMoves)
            .where(and(eq(stockMoves.organizationId, ctx.organizationId), eq(stockMoves.itemId, current.id)))
            .limit(1);
          if (moved) throw invalid("The item type cannot change after stock has moved.");
        }
        const accountsFor = await resolveItemAccounts(tx, ctx.organizationId, nextType, { ...current, ...req.body });
        const [row] = await tx
          .update(items)
          .set({ ...req.body, ...accountsFor, updatedAt: new Date() })
          .where(eq(items.id, current.id))
          .returning();
        await audit(tx, {
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: "item.updated",
          entityType: "item",
          entityId: current.id,
          summary: `Updated item ${row!.sku}`,
          data: { fields: Object.keys(req.body) },
          ip: ctx.ip,
        });
        return row;
      });
    },
  );

  app.post(
    "/bulk-archive",
    {
      schema: {
        tags: ["Items"],
        summary: "Archive or restore several items",
        body: z.object({ ids: z.array(z.uuid()).min(1).max(500), archived: z.boolean() }),
      },
    },
    async (req) => {
      const ctx = requireOrg(req, "masterdata.write");
      return app.db.transaction(async (tx) => {
        const rows = await tx
          .update(items)
          .set({ isActive: !req.body.archived, updatedAt: new Date() })
          .where(and(eq(items.organizationId, ctx.organizationId), inArray(items.id, req.body.ids)))
          .returning({ id: items.id });
        await audit(tx, {
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: req.body.archived ? "item.archived" : "item.restored",
          entityType: "item",
          summary: `${req.body.archived ? "Archived" : "Restored"} ${rows.length} items`,
          data: { ids: rows.map((r) => r.id) },
          ip: ctx.ip,
        });
        return { updated: rows.length };
      });
    },
  );
};

/** Fill in default accounts by item type and check each account has the right type. */
async function resolveItemAccounts(
  tx: Tx,
  organizationId: string,
  type: "inventory" | "non_inventory" | "service",
  input: { incomeAccountId?: string | null; cogsAccountId?: string | null; inventoryAccountId?: string | null },
) {
  const sys = await systemAccounts(tx, organizationId, ["sales_revenue", "service_revenue", "cogs", "inventory"]);
  const incomeAccountId = input.incomeAccountId ?? (type === "service" ? sys("service_revenue") : sys("sales_revenue"));
  const cogsAccountId = type === "inventory" ? (input.cogsAccountId ?? sys("cogs")) : null;
  const inventoryAccountId = type === "inventory" ? (input.inventoryAccountId ?? sys("inventory")) : null;

  const wanted = [
    { id: incomeAccountId, type: "revenue", label: "Income account" },
    { id: cogsAccountId, type: "expense", label: "Cost of goods sold account" },
    { id: inventoryAccountId, type: "asset", label: "Inventory account" },
  ].filter((w): w is { id: string; type: string; label: string } => !!w.id);
  const rows = await tx
    .select({ id: accounts.id, type: accounts.type })
    .from(accounts)
    .where(and(eq(accounts.organizationId, organizationId), inArray(accounts.id, wanted.map((w) => w.id))));
  for (const w of wanted) {
    const found = rows.find((r) => r.id === w.id);
    if (!found) throw invalid(`${w.label} does not exist.`);
    if (found.type !== w.type) throw invalid(`${w.label} must be a ${w.type} account.`);
  }
  return { incomeAccountId, cogsAccountId, inventoryAccountId };
}
