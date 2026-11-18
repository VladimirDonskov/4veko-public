import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Tx } from "../../db/client";
import { invoices, items, parties, salesOrderLines, salesOrders } from "../../db/schema";
import { audit } from "../../lib/audit";
import { requireOrg } from "../../lib/context";
import { conflict, invalid, notFound } from "../../lib/errors";
import { today } from "../../lib/dates";
import { nextDocumentNumber } from "../../lib/numbering";
import {
  isoDate,
  likePattern,
  nonNegativeMoney,
  optionalText,
  percentInput,
  positiveQuantity,
  uuidParam,
} from "../../lib/validation";
import { computeDocument, loadCustomer, postInvoice } from "./service";

const lineSchema = z.object({
  itemId: z.uuid(),
  description: optionalText(500),
  quantity: positiveQuantity,
  unitPrice: nonNegativeMoney.optional(),
  discountPct: percentInput.optional(),
});

const orderBody = z.object({
  customerId: z.uuid(),
  orderDate: isoDate,
  expectedDate: isoDate.nullish(),
  memo: optionalText(1000),
  taxRate: percentInput.optional(),
  lines: z.array(lineSchema).min(1, "Add at least one line.").max(200),
});

const STATUSES = ["draft", "confirmed", "invoiced", "cancelled"] as const;

export const salesOrderRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/",
    {
      schema: {
        tags: ["Sales Orders"],
        summary: "List sales orders",
        querystring: z.object({
          status: z.enum(STATUSES).optional(),
          customerId: z.uuid().optional(),
          q: z.string().trim().max(200).optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
          offset: z.coerce.number().int().min(0).default(0),
        }),
      },
    },
    async (req) => {
      const ctx = requireOrg(req);
      const { status, customerId, q, limit, offset } = req.query;
      const where = and(
        eq(salesOrders.organizationId, ctx.organizationId),
        status ? eq(salesOrders.status, status) : undefined,
        customerId ? eq(salesOrders.customerId, customerId) : undefined,
        q ? or(ilike(salesOrders.number, likePattern(q)), ilike(parties.displayName, likePattern(q))) : undefined,
      );
      const rows = await app.db
        .select({
          id: salesOrders.id,
          number: salesOrders.number,
          orderDate: salesOrders.orderDate,
          expectedDate: salesOrders.expectedDate,
          status: salesOrders.status,
          customerId: salesOrders.customerId,
          customerName: parties.displayName,
          total: salesOrders.total,
          createdAt: salesOrders.createdAt,
        })
        .from(salesOrders)
        .innerJoin(parties, eq(parties.id, salesOrders.customerId))
        .where(where)
        .orderBy(desc(salesOrders.orderDate), desc(salesOrders.createdAt))
        .limit(limit)
        .offset(offset);
      const [{ total } = { total: 0 }] = await app.db
        .select({ total: sql<number>`count(*)::int` })
        .from(salesOrders)
        .innerJoin(parties, eq(parties.id, salesOrders.customerId))
        .where(where);
      return { data: rows, total };
    },
  );

  app.post("/", { schema: { tags: ["Sales Orders"], summary: "Create a draft sales order", body: orderBody } }, async (req, reply) => {
    const ctx = requireOrg(req, "sales.write");
    const order = await app.db.transaction(async (tx) => {
      const customer = await loadCustomer(tx, ctx.organizationId, req.body.customerId);
      if (!customer.isActive) throw invalid(`${customer.displayName} is archived.`);
      const doc = await computeDocument(tx, ctx.organizationId, customer, req.body.lines, req.body.taxRate);
      const number = await nextDocumentNumber(tx, ctx.organizationId, "salesOrder");
      const [order] = await tx
        .insert(salesOrders)
        .values({
          organizationId: ctx.organizationId,
          number,
          customerId: customer.id,
          orderDate: req.body.orderDate,
          expectedDate: req.body.expectedDate ?? null,
          memo: req.body.memo,
          taxRate: doc.taxRate,
          subtotal: doc.subtotal,
          taxTotal: doc.taxTotal,
          total: doc.total,
          createdBy: ctx.userId,
        })
        .returning();
      await tx.insert(salesOrderLines).values(
        doc.lines.map((l) => ({
          organizationId: ctx.organizationId,
          salesOrderId: order!.id,
          lineNo: l.lineNo,
          itemId: l.itemId,
          description: l.description,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          discountPct: l.discountPct,
          amount: l.amount,
          taxable: l.taxable,
        })),
      );
      await audit(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        action: "sales_order.created",
        entityType: "sales_order",
        entityId: order!.id,
        summary: `Created sales order ${number} for ${customer.displayName}`,
        data: { total: doc.total },
        ip: ctx.ip,
      });
      return order;
    });
    return reply.status(201).send(order);
  });

  app.get("/:id", { schema: { tags: ["Sales Orders"], summary: "Get a sales order", params: uuidParam } }, async (req) => {
    const ctx = requireOrg(req);
    const [row] = await app.db
      .select({ order: salesOrders, customerName: parties.displayName, customerEmail: parties.email })
      .from(salesOrders)
      .innerJoin(parties, eq(parties.id, salesOrders.customerId))
      .where(and(eq(salesOrders.organizationId, ctx.organizationId), eq(salesOrders.id, req.params.id)));
    if (!row) throw notFound("Sales order");
    const lines = await app.db
      .select({
        id: salesOrderLines.id,
        lineNo: salesOrderLines.lineNo,
        itemId: salesOrderLines.itemId,
        sku: items.sku,
        itemName: items.name,
        itemType: items.type,
        description: salesOrderLines.description,
        quantity: salesOrderLines.quantity,
        unitPrice: salesOrderLines.unitPrice,
        discountPct: salesOrderLines.discountPct,
        amount: salesOrderLines.amount,
        taxable: salesOrderLines.taxable,
      })
      .from(salesOrderLines)
      .innerJoin(items, eq(items.id, salesOrderLines.itemId))
      .where(eq(salesOrderLines.salesOrderId, row.order.id))
      .orderBy(salesOrderLines.lineNo);
    const relatedInvoices = await app.db
      .select({ id: invoices.id, number: invoices.number, status: invoices.status, total: invoices.total })
      .from(invoices)
      .where(and(eq(invoices.organizationId, ctx.organizationId), eq(invoices.salesOrderId, row.order.id)))
      .orderBy(desc(invoices.createdAt));
    return { ...row.order, customerName: row.customerName, customerEmail: row.customerEmail, lines, invoices: relatedInvoices };
  });

  app.patch(
    "/:id",
    { schema: { tags: ["Sales Orders"], summary: "Edit a draft sales order", params: uuidParam, body: orderBody } },
    async (req) => {
      const ctx = requireOrg(req, "sales.write");
      return app.db.transaction(async (tx) => {
        const order = await lockOrder(tx, ctx.organizationId, req.params.id);
        if (order.status !== "draft") throw conflict("Only draft orders can be edited.");
        const customer = await loadCustomer(tx, ctx.organizationId, req.body.customerId);
        const doc = await computeDocument(tx, ctx.organizationId, customer, req.body.lines, req.body.taxRate);
        await tx.delete(salesOrderLines).where(eq(salesOrderLines.salesOrderId, order.id));
        await tx.insert(salesOrderLines).values(
          doc.lines.map((l) => ({
            organizationId: ctx.organizationId,
            salesOrderId: order.id,
            lineNo: l.lineNo,
            itemId: l.itemId,
            description: l.description,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            discountPct: l.discountPct,
            amount: l.amount,
            taxable: l.taxable,
          })),
        );
        const [updated] = await tx
          .update(salesOrders)
          .set({
            customerId: customer.id,
            orderDate: req.body.orderDate,
            expectedDate: req.body.expectedDate ?? null,
            memo: req.body.memo,
            taxRate: doc.taxRate,
            subtotal: doc.subtotal,
            taxTotal: doc.taxTotal,
            total: doc.total,
            updatedAt: new Date(),
          })
          .where(eq(salesOrders.id, order.id))
          .returning();
        await audit(tx, {
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: "sales_order.updated",
          entityType: "sales_order",
          entityId: order.id,
          summary: `Edited sales order ${order.number}`,
          ip: ctx.ip,
        });
        return updated;
      });
    },
  );

  for (const action of ["confirm", "cancel"] as const) {
    app.post(
      `/:id/${action}`,
      { schema: { tags: ["Sales Orders"], summary: `${action === "confirm" ? "Confirm" : "Cancel"} a sales order`, params: uuidParam } },
      async (req) => {
        const ctx = requireOrg(req, "sales.write");
        return app.db.transaction(async (tx) => {
          const order = await lockOrder(tx, ctx.organizationId, req.params.id);
          if (action === "confirm" && order.status !== "draft") throw conflict(`Order ${order.number} is ${order.status}.`);
          if (action === "cancel" && !["draft", "confirmed"].includes(order.status)) {
            throw conflict(`Order ${order.number} is ${order.status} and cannot be cancelled.`);
          }
          const status = action === "confirm" ? "confirmed" : "cancelled";
          const [updated] = await tx
            .update(salesOrders)
            .set({ status, updatedAt: new Date() })
            .where(eq(salesOrders.id, order.id))
            .returning();
          await audit(tx, {
            organizationId: ctx.organizationId,
            actorUserId: ctx.userId,
            action: `sales_order.${status}`,
            entityType: "sales_order",
            entityId: order.id,
            summary: `${action === "confirm" ? "Confirmed" : "Cancelled"} sales order ${order.number}`,
            ip: ctx.ip,
          });
          return updated;
        });
      },
    );
  }

  app.post(
    "/:id/invoice",
    {
      schema: {
        tags: ["Sales Orders"],
        summary: "Invoice a sales order (confirms a draft first). Posts AR, revenue, tax, COGS and stock.",
        params: uuidParam,
        body: z.object({ issueDate: isoDate.optional(), dueDate: isoDate.optional(), memo: optionalText(1000) }).optional(),
      },
    },
    async (req, reply) => {
      const ctx = requireOrg(req, "invoice.post");
      const invoice = await app.db.transaction(async (tx) => {
        // The row lock serialises double clicks; the second request sees "invoiced".
        const order = await lockOrder(tx, ctx.organizationId, req.params.id);
        if (order.status === "invoiced") {
          const [existing] = await tx
            .select({ id: invoices.id, number: invoices.number })
            .from(invoices)
            .where(and(eq(invoices.organizationId, ctx.organizationId), eq(invoices.salesOrderId, order.id), sql`${invoices.status} <> 'void'`));
          throw conflict(`Sales order ${order.number} is already invoiced${existing ? ` (${existing.number})` : ""}.`, {
            invoiceId: existing?.id,
          });
        }
        if (order.status === "cancelled") throw conflict(`Sales order ${order.number} is cancelled.`);
        const lines = await tx
          .select()
          .from(salesOrderLines)
          .where(eq(salesOrderLines.salesOrderId, order.id))
          .orderBy(salesOrderLines.lineNo);
        const invoice = await postInvoice(tx, ctx, {
          customerId: order.customerId,
          issueDate: req.body?.issueDate ?? today(),
          dueDate: req.body?.dueDate,
          memo: req.body?.memo ?? order.memo,
          taxRate: order.taxRate,
          salesOrderId: order.id,
          salesOrderNumber: order.number,
          lines: lines.map((l) => ({
            itemId: l.itemId,
            description: l.description,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            discountPct: l.discountPct,
          })),
        });
        await tx.update(salesOrders).set({ status: "invoiced", updatedAt: new Date() }).where(eq(salesOrders.id, order.id));
        return invoice;
      });
      return reply.status(201).send(invoice);
    },
  );
};

async function lockOrder(tx: Tx, organizationId: string, id: string) {
  const [order] = await tx
    .select()
    .from(salesOrders)
    .where(and(eq(salesOrders.organizationId, organizationId), eq(salesOrders.id, id)))
    .for("update");
  if (!order) throw notFound("Sales order");
  return order;
}
