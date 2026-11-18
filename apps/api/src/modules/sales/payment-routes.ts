import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { accounts, depositPayments, deposits, invoices, parties, paymentApplications, payments } from "../../db/schema";
import { requireOrg } from "../../lib/context";
import { fromDatabaseError, notFound } from "../../lib/errors";
import { isoDate, likePattern, optionalText, positiveMoney, uuidParam } from "../../lib/validation";
import { recordPayment } from "./service";

export const paymentRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/",
    {
      schema: {
        tags: ["Payments"],
        summary: "List customer payments",
        querystring: z.object({
          customerId: z.uuid().optional(),
          q: z.string().trim().max(200).optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
          offset: z.coerce.number().int().min(0).default(0),
        }),
      },
    },
    async (req) => {
      const ctx = requireOrg(req);
      const { customerId, q, limit, offset } = req.query;
      const where = and(
        eq(payments.organizationId, ctx.organizationId),
        customerId ? eq(payments.customerId, customerId) : undefined,
        q
          ? or(
              ilike(payments.number, likePattern(q)),
              ilike(payments.reference, likePattern(q)),
              ilike(parties.displayName, likePattern(q)),
            )
          : undefined,
      );
      const rows = await app.db
        .select({
          id: payments.id,
          number: payments.number,
          date: payments.date,
          customerId: payments.customerId,
          customerName: parties.displayName,
          amount: payments.amount,
          unappliedAmount: payments.unappliedAmount,
          method: payments.method,
          reference: payments.reference,
        })
        .from(payments)
        .innerJoin(parties, eq(parties.id, payments.customerId))
        .where(where)
        .orderBy(desc(payments.date), desc(payments.number))
        .limit(limit)
        .offset(offset);
      const [{ total } = { total: 0 }] = await app.db
        .select({ total: sql<number>`count(*)::int` })
        .from(payments)
        .innerJoin(parties, eq(parties.id, payments.customerId))
        .where(where);
      return { data: rows, total };
    },
  );

  app.post(
    "/",
    {
      schema: {
        tags: ["Payments"],
        summary:
          "Record a customer payment. Send an Idempotency-Key header to make retries safe; " +
          "omit applications to apply the payment to the oldest open invoices.",
        headers: z.object({ "idempotency-key": z.string().trim().min(8).max(100).optional() }),
        body: z.object({
          customerId: z.uuid(),
          date: isoDate,
          amount: positiveMoney,
          method: z.enum(["check", "ach", "wire", "card", "cash", "other"]),
          reference: optionalText(100),
          depositAccountId: z.uuid().optional(),
          memo: optionalText(500),
          autoApply: z.boolean().optional(),
          applications: z.array(z.object({ invoiceId: z.uuid(), amount: positiveMoney })).max(500).optional(),
        }),
      },
    },
    async (req, reply) => {
      const ctx = requireOrg(req, "payments.write");
      const idempotencyKey = req.headers["idempotency-key"] ?? null;
      try {
        const result = await app.db.transaction((tx) => recordPayment(tx, ctx, { ...req.body, idempotencyKey }));
        return reply.status(result.replayed ? 200 : 201).header("Idempotent-Replayed", String(result.replayed)).send(result.payment);
      } catch (err) {
        // Two concurrent requests with the same key: the loser returns the winner's payment.
        const dbErr = fromDatabaseError(err);
        if (idempotencyKey && dbErr?.details?.constraint === "pmt_org_idem_uq") {
          const [existing] = await app.db
            .select()
            .from(payments)
            .where(and(eq(payments.organizationId, ctx.organizationId), eq(payments.idempotencyKey, idempotencyKey)));
          if (existing) return reply.status(200).header("Idempotent-Replayed", "true").send(existing);
        }
        throw err;
      }
    },
  );

  app.get("/:id", { schema: { tags: ["Payments"], summary: "Get a payment and where it was applied", params: uuidParam } }, async (req) => {
    const ctx = requireOrg(req);
    const [row] = await app.db
      .select({
        payment: payments,
        customerName: parties.displayName,
        depositAccount: sql<string>`${accounts.number} || ' ' || ${accounts.name}`,
      })
      .from(payments)
      .innerJoin(parties, eq(parties.id, payments.customerId))
      .innerJoin(accounts, eq(accounts.id, payments.depositAccountId))
      .where(and(eq(payments.organizationId, ctx.organizationId), eq(payments.id, req.params.id)));
    if (!row) throw notFound("Payment");
    const applications = await app.db
      .select({
        invoiceId: invoices.id,
        number: invoices.number,
        issueDate: invoices.issueDate,
        total: invoices.total,
        amount: paymentApplications.amount,
      })
      .from(paymentApplications)
      .innerJoin(invoices, eq(invoices.id, paymentApplications.invoiceId))
      .where(eq(paymentApplications.paymentId, row.payment.id))
      .orderBy(invoices.number);
    const depositHistory = await app.db.select({
      id: deposits.id, number: deposits.number, date: deposits.date, status: deposits.status, voidDate: deposits.voidDate,
    }).from(depositPayments)
      .innerJoin(deposits, and(eq(deposits.organizationId, ctx.organizationId), eq(deposits.id, depositPayments.depositId)))
      .where(and(eq(depositPayments.organizationId, ctx.organizationId), eq(depositPayments.paymentId, row.payment.id)))
      .orderBy(desc(deposits.createdAt), desc(deposits.id));
    return { ...row.payment, customerName: row.customerName, depositAccount: row.depositAccount, applications, deposits: depositHistory };
  });
};
