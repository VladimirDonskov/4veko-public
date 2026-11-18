import { and, desc, eq, ilike, inArray, lt, or, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { accounts, invoiceLines, invoices, items, parties, paymentApplications, payments, salesOrders } from "../../db/schema";
import { requireOrg } from "../../lib/context";
import { notFound } from "../../lib/errors";
import { today } from "../../lib/dates";
import {
  isoDate,
  likePattern,
  nonNegativeMoney,
  optionalText,
  percentInput,
  positiveQuantity,
  uuidParam,
} from "../../lib/validation";
import { postInvoice, voidInvoice } from "./service";

export const invoiceRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/",
    {
      schema: {
        tags: ["Invoices"],
        summary: "List invoices",
        querystring: z.object({
          status: z.enum(["open", "partially_paid", "paid", "void", "unpaid", "overdue"]).optional(),
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
      const asOf = today();
      const where = and(
        eq(invoices.organizationId, ctx.organizationId),
        status === "unpaid" || status === "overdue"
          ? inArray(invoices.status, ["open", "partially_paid"])
          : status
            ? eq(invoices.status, status)
            : undefined,
        status === "overdue" ? lt(invoices.dueDate, asOf) : undefined,
        customerId ? eq(invoices.customerId, customerId) : undefined,
        q ? or(ilike(invoices.number, likePattern(q)), ilike(parties.displayName, likePattern(q))) : undefined,
      );
      const rows = await app.db
        .select({
          id: invoices.id,
          number: invoices.number,
          customerId: invoices.customerId,
          customerName: parties.displayName,
          issueDate: invoices.issueDate,
          dueDate: invoices.dueDate,
          status: invoices.status,
          total: invoices.total,
          balanceDue: invoices.balanceDue,
          daysOverdue: sql<number>`case when ${invoices.status} in ('open','partially_paid') then greatest(0, ${asOf}::date - ${invoices.dueDate})::int else 0 end`,
        })
        .from(invoices)
        .innerJoin(parties, eq(parties.id, invoices.customerId))
        .where(where)
        .orderBy(desc(invoices.issueDate), desc(invoices.number))
        .limit(limit)
        .offset(offset);
      const [agg] = await app.db
        .select({
          total: sql<number>`count(*)::int`,
          sumBalance: sql<string>`coalesce(sum(case when ${invoices.status} <> 'void' then ${invoices.balanceDue} else 0 end),0)::numeric(18,2)::text`,
        })
        .from(invoices)
        .innerJoin(parties, eq(parties.id, invoices.customerId))
        .where(where);
      return { data: rows, total: agg?.total ?? 0, totalBalanceDue: agg?.sumBalance ?? "0.00" };
    },
  );

  app.post(
    "/",
    {
      schema: {
        tags: ["Invoices"],
        summary: "Create and post an invoice without a sales order",
        body: z.object({
          customerId: z.uuid(),
          issueDate: isoDate,
          dueDate: isoDate.optional(),
          memo: optionalText(1000),
          taxRate: percentInput.optional(),
          lines: z
            .array(
              z.object({
                itemId: z.uuid(),
                description: optionalText(500),
                quantity: positiveQuantity,
                unitPrice: nonNegativeMoney.optional(),
                discountPct: percentInput.optional(),
              }),
            )
            .min(1)
            .max(200),
        }),
      },
    },
    async (req, reply) => {
      const ctx = requireOrg(req, "invoice.post");
      const invoice = await app.db.transaction((tx) => postInvoice(tx, ctx, req.body));
      return reply.status(201).send(invoice);
    },
  );

  app.get("/:id", { schema: { tags: ["Invoices"], summary: "Get an invoice with lines and payments", params: uuidParam } }, async (req) => {
    const ctx = requireOrg(req);
    const [row] = await app.db
      .select({
        invoice: invoices,
        customerName: parties.displayName,
        customerEmail: parties.email,
        customerAddress: parties.billingAddress,
        salesOrderNumber: salesOrders.number,
      })
      .from(invoices)
      .innerJoin(parties, eq(parties.id, invoices.customerId))
      .leftJoin(salesOrders, eq(salesOrders.id, invoices.salesOrderId))
      .where(and(eq(invoices.organizationId, ctx.organizationId), eq(invoices.id, req.params.id)));
    if (!row) throw notFound("Invoice");
    const lines = await app.db
      .select({
        lineNo: invoiceLines.lineNo,
        itemId: invoiceLines.itemId,
        sku: items.sku,
        description: invoiceLines.description,
        quantity: invoiceLines.quantity,
        unitPrice: invoiceLines.unitPrice,
        discountPct: invoiceLines.discountPct,
        amount: invoiceLines.amount,
        taxable: invoiceLines.taxable,
        incomeAccount: sql<string>`${accounts.number} || ' ' || ${accounts.name}`,
        costAmount: invoiceLines.costAmount,
      })
      .from(invoiceLines)
      .innerJoin(items, eq(items.id, invoiceLines.itemId))
      .innerJoin(accounts, eq(accounts.id, invoiceLines.incomeAccountId))
      .where(eq(invoiceLines.invoiceId, row.invoice.id))
      .orderBy(invoiceLines.lineNo);
    const applied = await app.db
      .select({
        paymentId: payments.id,
        number: payments.number,
        date: payments.date,
        method: payments.method,
        amount: paymentApplications.amount,
      })
      .from(paymentApplications)
      .innerJoin(payments, eq(payments.id, paymentApplications.paymentId))
      .where(eq(paymentApplications.invoiceId, row.invoice.id))
      .orderBy(payments.date);
    return {
      ...row.invoice,
      customerName: row.customerName,
      customerEmail: row.customerEmail,
      customerAddress: row.customerAddress,
      salesOrderNumber: row.salesOrderNumber,
      lines,
      payments: applied,
    };
  });

  app.post(
    "/:id/void",
    {
      schema: {
        tags: ["Invoices"],
        summary: "Void an unpaid invoice (posts a reversing entry and returns stock)",
        params: uuidParam,
        body: z.object({ date: isoDate.optional(), reason: optionalText(500) }).optional(),
      },
    },
    async (req) => {
      const ctx = requireOrg(req, "invoice.void");
      return app.db.transaction((tx) => voidInvoice(tx, ctx, req.params.id, req.body?.date ?? today(), req.body?.reason ?? null));
    },
  );
};
