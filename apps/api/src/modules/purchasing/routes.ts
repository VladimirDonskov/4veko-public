import { and, desc, eq, gt, ilike, inArray, lt, or, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  accounts,
  billLines,
  billPaymentApplications,
  billPayments,
  bills,
  items,
  parties,
  purchaseOrderLines,
  purchaseOrders,
  purchaseReceipts,
} from "../../db/schema";
import { audit } from "../../lib/audit";
import { requireOrg } from "../../lib/context";
import { today } from "../../lib/dates";
import { conflict, fromDatabaseError, notFound } from "../../lib/errors";
import { nextDocumentNumber } from "../../lib/numbering";
import {
  isoDate,
  likePattern,
  nonNegativeMoney,
  optionalText,
  positiveMoney,
  positiveQuantity,
  uuidParam,
} from "../../lib/validation";
import { computePoLines, loadVendor, lockPurchaseOrder, payBills, postBill, receivePurchaseOrder, voidBill } from "./service";

const poBody = z.object({
  vendorId: z.uuid(),
  orderDate: isoDate,
  expectedDate: isoDate.nullish(),
  memo: optionalText(1000),
  lines: z
    .array(
      z.object({
        itemId: z.uuid(),
        description: optionalText(500),
        quantity: positiveQuantity,
        unitCost: nonNegativeMoney.optional(),
      }),
    )
    .min(1, "Add at least one line.")
    .max(200),
});

const page = {
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
};

export const purchaseOrderRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/",
    {
      schema: {
        tags: ["Purchase Orders"],
        summary: "List purchase orders",
        querystring: z.object({
          status: z.enum(["draft", "issued", "partially_received", "received", "closed", "cancelled", "open"]).optional(),
          vendorId: z.uuid().optional(),
          q: z.string().trim().max(200).optional(),
          ...page,
        }),
      },
    },
    async (req) => {
      const ctx = requireOrg(req);
      const { status, vendorId, q, limit, offset } = req.query;
      const where = and(
        eq(purchaseOrders.organizationId, ctx.organizationId),
        status === "open"
          ? inArray(purchaseOrders.status, ["issued", "partially_received"])
          : status
            ? eq(purchaseOrders.status, status)
            : undefined,
        vendorId ? eq(purchaseOrders.vendorId, vendorId) : undefined,
        q ? or(ilike(purchaseOrders.number, likePattern(q)), ilike(parties.displayName, likePattern(q))) : undefined,
      );
      const rows = await app.db
        .select({
          id: purchaseOrders.id,
          number: purchaseOrders.number,
          orderDate: purchaseOrders.orderDate,
          expectedDate: purchaseOrders.expectedDate,
          status: purchaseOrders.status,
          vendorId: purchaseOrders.vendorId,
          vendorName: parties.displayName,
          total: purchaseOrders.total,
        })
        .from(purchaseOrders)
        .innerJoin(parties, eq(parties.id, purchaseOrders.vendorId))
        .where(where)
        .orderBy(desc(purchaseOrders.orderDate), desc(purchaseOrders.number))
        .limit(limit)
        .offset(offset);
      const [{ total } = { total: 0 }] = await app.db
        .select({ total: sql<number>`count(*)::int` })
        .from(purchaseOrders)
        .innerJoin(parties, eq(parties.id, purchaseOrders.vendorId))
        .where(where);
      return { data: rows, total };
    },
  );

  app.post("/", { schema: { tags: ["Purchase Orders"], summary: "Create a draft purchase order", body: poBody } }, async (req, reply) => {
    const ctx = requireOrg(req, "purchasing.write");
    const po = await app.db.transaction(async (tx) => {
      const vendor = await loadVendor(tx, ctx.organizationId, req.body.vendorId);
      if (!vendor.isActive) throw conflict(`${vendor.displayName} is archived.`);
      const doc = await computePoLines(tx, ctx.organizationId, req.body.lines);
      const number = await nextDocumentNumber(tx, ctx.organizationId, "purchaseOrder");
      const [po] = await tx
        .insert(purchaseOrders)
        .values({
          organizationId: ctx.organizationId,
          number,
          vendorId: vendor.id,
          orderDate: req.body.orderDate,
          expectedDate: req.body.expectedDate ?? null,
          memo: req.body.memo,
          total: doc.total,
          createdBy: ctx.userId,
        })
        .returning();
      await tx.insert(purchaseOrderLines).values(doc.lines.map((l) => ({ ...l, organizationId: ctx.organizationId, purchaseOrderId: po!.id })));
      await audit(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        action: "purchase_order.created",
        entityType: "purchase_order",
        entityId: po!.id,
        summary: `Created purchase order ${number} to ${vendor.displayName} for $${doc.total}`,
        ip: ctx.ip,
      });
      return po;
    });
    return reply.status(201).send(po);
  });

  app.get("/:id", { schema: { tags: ["Purchase Orders"], summary: "Get a purchase order with lines, receipts and bills", params: uuidParam } }, async (req) => {
    const ctx = requireOrg(req);
    const [row] = await app.db
      .select({ po: purchaseOrders, vendorName: parties.displayName })
      .from(purchaseOrders)
      .innerJoin(parties, eq(parties.id, purchaseOrders.vendorId))
      .where(and(eq(purchaseOrders.organizationId, ctx.organizationId), eq(purchaseOrders.id, req.params.id)));
    if (!row) throw notFound("Purchase order");
    const lines = await app.db
      .select({
        id: purchaseOrderLines.id,
        lineNo: purchaseOrderLines.lineNo,
        itemId: purchaseOrderLines.itemId,
        sku: items.sku,
        description: purchaseOrderLines.description,
        quantity: purchaseOrderLines.quantity,
        unitCost: purchaseOrderLines.unitCost,
        amount: purchaseOrderLines.amount,
        qtyReceived: purchaseOrderLines.qtyReceived,
        qtyBilled: purchaseOrderLines.qtyBilled,
      })
      .from(purchaseOrderLines)
      .innerJoin(items, eq(items.id, purchaseOrderLines.itemId))
      .where(eq(purchaseOrderLines.purchaseOrderId, row.po.id))
      .orderBy(purchaseOrderLines.lineNo);
    const receipts = await app.db
      .select({ id: purchaseReceipts.id, number: purchaseReceipts.number, date: purchaseReceipts.date, total: purchaseReceipts.total, journalEntryId: purchaseReceipts.journalEntryId })
      .from(purchaseReceipts)
      .where(and(eq(purchaseReceipts.organizationId, ctx.organizationId), eq(purchaseReceipts.purchaseOrderId, row.po.id)))
      .orderBy(purchaseReceipts.date, purchaseReceipts.number);
    // A purchase order always has at least one line.
    const relatedBills = await app.db
      .selectDistinct({ id: bills.id, number: bills.number, vendorReference: bills.vendorReference, status: bills.status, total: bills.total })
      .from(bills)
      .innerJoin(billLines, eq(billLines.billId, bills.id))
      .where(and(eq(bills.organizationId, ctx.organizationId), inArray(billLines.purchaseOrderLineId, lines.map((l) => l.id))));
    return { ...row.po, vendorName: row.vendorName, lines, receipts, bills: relatedBills };
  });

  app.patch(
    "/:id",
    { schema: { tags: ["Purchase Orders"], summary: "Edit a draft purchase order", params: uuidParam, body: poBody } },
    async (req) => {
      const ctx = requireOrg(req, "purchasing.write");
      return app.db.transaction(async (tx) => {
        const po = await lockPurchaseOrder(tx, ctx.organizationId, req.params.id);
        if (po.status !== "draft") throw conflict("Only draft purchase orders can be edited.");
        await loadVendor(tx, ctx.organizationId, req.body.vendorId);
        const doc = await computePoLines(tx, ctx.organizationId, req.body.lines);
        await tx.delete(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, po.id));
        await tx.insert(purchaseOrderLines).values(doc.lines.map((l) => ({ ...l, organizationId: ctx.organizationId, purchaseOrderId: po.id })));
        const [updated] = await tx
          .update(purchaseOrders)
          .set({
            vendorId: req.body.vendorId,
            orderDate: req.body.orderDate,
            expectedDate: req.body.expectedDate ?? null,
            memo: req.body.memo,
            total: doc.total,
            updatedAt: new Date(),
          })
          .where(eq(purchaseOrders.id, po.id))
          .returning();
        await audit(tx, {
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: "purchase_order.updated",
          entityType: "purchase_order",
          entityId: po.id,
          summary: `Edited purchase order ${po.number}`,
          ip: ctx.ip,
        });
        return updated;
      });
    },
  );

  const transitions = {
    issue: { from: ["draft"], to: "issued", verb: "Issued" },
    cancel: { from: ["draft", "issued"], to: "cancelled", verb: "Cancelled" },
    close: { from: ["partially_received"], to: "closed", verb: "Closed" },
  } as const;
  for (const [action, t] of Object.entries(transitions)) {
    app.post(
      `/:id/${action}`,
      {
        schema: {
          tags: ["Purchase Orders"],
          summary:
            action === "close"
              ? "Close a partially received order: no more receipts, the rest is not coming"
              : `${t.verb.replace(/ed$/, "")} a purchase order`,
          params: uuidParam,
        },
      },
      async (req) => {
        const ctx = requireOrg(req, "purchasing.write");
        return app.db.transaction(async (tx) => {
          const po = await lockPurchaseOrder(tx, ctx.organizationId, req.params.id);
          if (!(t.from as readonly string[]).includes(po.status)) {
            throw conflict(`Purchase order ${po.number} is ${po.status.replace("_", " ")} and cannot be ${t.to}.`);
          }
          const [updated] = await tx
            .update(purchaseOrders)
            .set({ status: t.to, updatedAt: new Date() })
            .where(eq(purchaseOrders.id, po.id))
            .returning();
          await audit(tx, {
            organizationId: ctx.organizationId,
            actorUserId: ctx.userId,
            action: `purchase_order.${t.to}`,
            entityType: "purchase_order",
            entityId: po.id,
            summary: `${t.verb} purchase order ${po.number}`,
            ip: ctx.ip,
          });
          return updated;
        });
      },
    );
  }

  app.post(
    "/:id/receive",
    {
      schema: {
        tags: ["Purchase Orders"],
        summary: "Receive stock on a purchase order (omit lines to receive everything outstanding)",
        params: uuidParam,
        body: z
          .object({
            date: isoDate.optional(),
            memo: optionalText(500),
            lines: z.array(z.object({ purchaseOrderLineId: z.uuid(), quantity: positiveQuantity })).max(200).optional(),
          })
          .optional(),
      },
    },
    async (req, reply) => {
      const ctx = requireOrg(req, "purchasing.write");
      const receipt = await app.db.transaction((tx) =>
        receivePurchaseOrder(tx, ctx, req.params.id, { date: req.body?.date ?? today(), memo: req.body?.memo, lines: req.body?.lines }),
      );
      return reply.status(201).send(receipt);
    },
  );
};

export const billRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/",
    {
      schema: {
        tags: ["Bills"],
        summary: "List vendor bills",
        querystring: z.object({
          status: z.enum(["open", "partially_paid", "paid", "void", "unpaid", "overdue"]).optional(),
          vendorId: z.uuid().optional(),
          q: z.string().trim().max(200).optional(),
          ...page,
        }),
      },
    },
    async (req) => {
      const ctx = requireOrg(req);
      const { status, vendorId, q, limit, offset } = req.query;
      const asOf = today();
      const where = and(
        eq(bills.organizationId, ctx.organizationId),
        status === "unpaid" || status === "overdue" ? inArray(bills.status, ["open", "partially_paid"]) : status ? eq(bills.status, status) : undefined,
        status === "overdue" ? lt(bills.dueDate, asOf) : undefined,
        vendorId ? eq(bills.vendorId, vendorId) : undefined,
        q
          ? or(ilike(bills.number, likePattern(q)), ilike(bills.vendorReference, likePattern(q)), ilike(parties.displayName, likePattern(q)))
          : undefined,
      );
      const rows = await app.db
        .select({
          id: bills.id,
          number: bills.number,
          vendorReference: bills.vendorReference,
          vendorId: bills.vendorId,
          vendorName: parties.displayName,
          billDate: bills.billDate,
          dueDate: bills.dueDate,
          status: bills.status,
          total: bills.total,
          balanceDue: bills.balanceDue,
          daysOverdue: sql<number>`case when ${bills.status} in ('open','partially_paid') then greatest(0, ${asOf}::date - ${bills.dueDate})::int else 0 end`,
        })
        .from(bills)
        .innerJoin(parties, eq(parties.id, bills.vendorId))
        .where(where)
        .orderBy(desc(bills.billDate), desc(bills.number))
        .limit(limit)
        .offset(offset);
      const [agg] = await app.db
        .select({
          total: sql<number>`count(*)::int`,
          sumBalance: sql<string>`coalesce(sum(case when ${bills.status} <> 'void' then ${bills.balanceDue} else 0 end),0)::numeric(18,2)::text`,
        })
        .from(bills)
        .innerJoin(parties, eq(parties.id, bills.vendorId))
        .where(where);
      return { data: rows, total: agg?.total ?? 0, totalBalanceDue: agg?.sumBalance ?? "0.00" };
    },
  );

  app.get(
    "/billable-lines",
    {
      schema: {
        tags: ["Bills"],
        summary: "Purchase order lines received but not yet billed, for one vendor",
        querystring: z.object({ vendorId: z.uuid() }),
      },
    },
    async (req) => {
      const ctx = requireOrg(req);
      return app.db
        .select({
          purchaseOrderLineId: purchaseOrderLines.id,
          purchaseOrderId: purchaseOrders.id,
          purchaseOrderNumber: purchaseOrders.number,
          lineNo: purchaseOrderLines.lineNo,
          itemId: items.id,
          sku: items.sku,
          description: purchaseOrderLines.description,
          unitCost: purchaseOrderLines.unitCost,
          billableQuantity: sql<string>`(${purchaseOrderLines.qtyReceived} - ${purchaseOrderLines.qtyBilled})::numeric(18,4)::text`,
        })
        .from(purchaseOrderLines)
        .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderLines.purchaseOrderId))
        .innerJoin(items, eq(items.id, purchaseOrderLines.itemId))
        .where(
          and(
            eq(purchaseOrderLines.organizationId, ctx.organizationId),
            eq(purchaseOrders.vendorId, req.query.vendorId),
            gt(purchaseOrderLines.qtyReceived, purchaseOrderLines.qtyBilled),
          ),
        )
        .orderBy(purchaseOrders.number, purchaseOrderLines.lineNo);
    },
  );

  app.post(
    "/",
    {
      schema: {
        tags: ["Bills"],
        summary: "Enter a vendor bill (received purchase order lines and/or expense lines)",
        body: z.object({
          vendorId: z.uuid(),
          vendorReference: z.string().trim().min(1, "Enter the vendor's invoice number.").max(60),
          billDate: isoDate,
          dueDate: isoDate.optional(),
          memo: optionalText(1000),
          poLines: z
            .array(
              z.object({
                purchaseOrderLineId: z.uuid(),
                quantity: positiveQuantity,
                unitCost: nonNegativeMoney.optional(),
                description: optionalText(500),
              }),
            )
            .max(200)
            .optional(),
          expenseLines: z
            .array(z.object({ accountId: z.uuid(), amount: positiveMoney, description: optionalText(500) }))
            .max(200)
            .optional(),
        }),
      },
    },
    async (req, reply) => {
      const ctx = requireOrg(req, "bills.post");
      const bill = await app.db.transaction((tx) => postBill(tx, ctx, req.body));
      return reply.status(201).send(bill);
    },
  );

  app.get("/:id", { schema: { tags: ["Bills"], summary: "Get a bill with lines and payments", params: uuidParam } }, async (req) => {
    const ctx = requireOrg(req);
    const [row] = await app.db
      .select({ bill: bills, vendorName: parties.displayName, purchaseOrderNumber: purchaseOrders.number })
      .from(bills)
      .innerJoin(parties, eq(parties.id, bills.vendorId))
      .leftJoin(purchaseOrders, eq(purchaseOrders.id, bills.purchaseOrderId))
      .where(and(eq(bills.organizationId, ctx.organizationId), eq(bills.id, req.params.id)));
    if (!row) throw notFound("Bill");
    const lines = await app.db
      .select({
        lineNo: billLines.lineNo,
        purchaseOrderLineId: billLines.purchaseOrderLineId,
        sku: items.sku,
        quantity: billLines.quantity,
        unitCost: billLines.unitCost,
        accountId: billLines.accountId,
        account: sql<string | null>`case when ${accounts.id} is null then null else ${accounts.number} || ' ' || ${accounts.name} end`,
        description: billLines.description,
        amount: billLines.amount,
      })
      .from(billLines)
      .leftJoin(items, eq(items.id, billLines.itemId))
      .leftJoin(accounts, eq(accounts.id, billLines.accountId))
      .where(eq(billLines.billId, row.bill.id))
      .orderBy(billLines.lineNo);
    const paid = await app.db
      .select({ paymentId: billPayments.id, number: billPayments.number, date: billPayments.date, method: billPayments.method, amount: billPaymentApplications.amount })
      .from(billPaymentApplications)
      .innerJoin(billPayments, eq(billPayments.id, billPaymentApplications.billPaymentId))
      .where(eq(billPaymentApplications.billId, row.bill.id))
      .orderBy(billPayments.date);
    return { ...row.bill, vendorName: row.vendorName, purchaseOrderNumber: row.purchaseOrderNumber, lines, payments: paid };
  });

  app.post(
    "/:id/void",
    {
      schema: {
        tags: ["Bills"],
        summary: "Void an unpaid bill (reversing entry; order lines become billable again)",
        params: uuidParam,
        body: z.object({ date: isoDate.optional(), reason: optionalText(500) }).optional(),
      },
    },
    async (req) => {
      const ctx = requireOrg(req, "bills.post");
      return app.db.transaction((tx) => voidBill(tx, ctx, req.params.id, req.body?.date ?? today(), req.body?.reason ?? null));
    },
  );
};

export const billPaymentRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/",
    {
      schema: {
        tags: ["Bill Payments"],
        summary: "List payments to vendors",
        querystring: z.object({ vendorId: z.uuid().optional(), ...page }),
      },
    },
    async (req) => {
      const ctx = requireOrg(req);
      const where = and(
        eq(billPayments.organizationId, ctx.organizationId),
        req.query.vendorId ? eq(billPayments.vendorId, req.query.vendorId) : undefined,
      );
      const rows = await app.db
        .select({
          id: billPayments.id,
          number: billPayments.number,
          date: billPayments.date,
          vendorId: billPayments.vendorId,
          vendorName: parties.displayName,
          amount: billPayments.amount,
          method: billPayments.method,
          reference: billPayments.reference,
        })
        .from(billPayments)
        .innerJoin(parties, eq(parties.id, billPayments.vendorId))
        .where(where)
        .orderBy(desc(billPayments.date), desc(billPayments.number))
        .limit(req.query.limit)
        .offset(req.query.offset);
      const [{ total } = { total: 0 }] = await app.db
        .select({ total: sql<number>`count(*)::int` })
        .from(billPayments)
        .where(where);
      return { data: rows, total };
    },
  );

  app.post(
    "/",
    {
      schema: {
        tags: ["Bill Payments"],
        summary: "Pay vendor bills from a bank account. Send an Idempotency-Key header to make retries safe.",
        headers: z.object({ "idempotency-key": z.string().trim().min(8).max(100).optional() }),
        body: z.object({
          vendorId: z.uuid(),
          date: isoDate,
          method: z.enum(["check", "ach", "wire", "card", "cash", "other"]),
          reference: optionalText(100),
          payFromAccountId: z.uuid().optional(),
          memo: optionalText(500),
          applications: z.array(z.object({ billId: z.uuid(), amount: positiveMoney })).min(1, "Choose at least one bill.").max(500),
        }),
      },
    },
    async (req, reply) => {
      const ctx = requireOrg(req, "bills.pay");
      const idempotencyKey = req.headers["idempotency-key"] ?? null;
      try {
        const result = await app.db.transaction((tx) => payBills(tx, ctx, { ...req.body, idempotencyKey }));
        return reply.status(result.replayed ? 200 : 201).header("Idempotent-Replayed", String(result.replayed)).send(result.payment);
      } catch (err) {
        const dbErr = fromDatabaseError(err);
        if (idempotencyKey && dbErr?.details?.constraint === "bp_org_idem_uq") {
          const [existing] = await app.db
            .select()
            .from(billPayments)
            .where(and(eq(billPayments.organizationId, ctx.organizationId), eq(billPayments.idempotencyKey, idempotencyKey)));
          if (existing) return reply.status(200).header("Idempotent-Replayed", "true").send(existing);
        }
        throw err;
      }
    },
  );

  app.get("/:id", { schema: { tags: ["Bill Payments"], summary: "Get a bill payment", params: uuidParam } }, async (req) => {
    const ctx = requireOrg(req);
    const [row] = await app.db
      .select({
        payment: billPayments,
        vendorName: parties.displayName,
        payFromAccount: sql<string>`${accounts.number} || ' ' || ${accounts.name}`,
      })
      .from(billPayments)
      .innerJoin(parties, eq(parties.id, billPayments.vendorId))
      .innerJoin(accounts, eq(accounts.id, billPayments.payFromAccountId))
      .where(and(eq(billPayments.organizationId, ctx.organizationId), eq(billPayments.id, req.params.id)));
    if (!row) throw notFound("Bill payment");
    const applications = await app.db
      .select({ billId: bills.id, number: bills.number, vendorReference: bills.vendorReference, total: bills.total, amount: billPaymentApplications.amount })
      .from(billPaymentApplications)
      .innerJoin(bills, eq(bills.id, billPaymentApplications.billId))
      .where(eq(billPaymentApplications.billPaymentId, row.payment.id))
      .orderBy(bills.number);
    return { ...row.payment, vendorName: row.vendorName, payFromAccount: row.payFromAccount, applications };
  });
};
