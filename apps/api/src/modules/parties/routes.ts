import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { billPayments, bills, invoices, parties, payments, purchaseOrders } from "../../db/schema";
import { audit } from "../../lib/audit";
import { requireOrg } from "../../lib/context";
import { notFound } from "../../lib/errors";
import { addressSchema, likePattern, listQuery, optionalText, uuidParam } from "../../lib/validation";

const partyBody = z.object({
  displayName: z.string().trim().min(1, "Name is required.").max(160),
  companyName: optionalText(160),
  email: z
    .union([z.email("Enter a valid email address."), z.literal("")])
    .nullish()
    .transform((v) => v || null),
  phone: optionalText(40),
  billingAddress: addressSchema,
  termsDays: z.number().int().min(0).max(365).optional(),
  taxExempt: z.boolean().optional(),
  notes: optionalText(4000),
});

/**
 * Open receivable balance per customer: open invoice balances less unapplied
 * payments. Written with explicit aliases: Drizzle renders columns inside
 * sql`` unqualified, which would silently bind to the subquery's own table.
 */
export function customerBalanceSql(organizationId: string) {
  return sql<string>`(
    coalesce((select sum(i.balance_due) from invoices i
      where i.organization_id = ${organizationId} and i.customer_id = "parties"."id"
      and i.status in ('open', 'partially_paid')), 0)
    - coalesce((select sum(p.unapplied_amount) from payments p
      where p.organization_id = ${organizationId} and p.customer_id = "parties"."id"), 0)
  )::numeric(18,2)::text`;
}

/** Open payable balance per vendor: unpaid bill balances. */
export function vendorBalanceSql(organizationId: string) {
  return sql<string>`coalesce((select sum(b.balance_due) from bills b
    where b.organization_id = ${organizationId} and b.vendor_id = "parties"."id"
    and b.status in ('open', 'partially_paid')), 0)::numeric(18,2)::text`;
}

const balanceSql = (kind: "customer" | "vendor", organizationId: string) =>
  kind === "customer" ? customerBalanceSql(organizationId) : vendorBalanceSql(organizationId);

export const partyRoutes: FastifyPluginAsyncZod = async (app) => {
  for (const kind of ["customer", "vendor"] as const) {
    const base = kind === "customer" ? "/customers" : "/vendors";
    const label = kind === "customer" ? "Customer" : "Vendor";
    const tag = kind === "customer" ? "Customers" : "Vendors";

    app.get(base, { schema: { tags: [tag], summary: `List ${tag.toLowerCase()}`, querystring: listQuery } }, async (req) => {
      const ctx = requireOrg(req);
      const { q, limit, offset, includeArchived } = req.query;
      const where = and(
        eq(parties.organizationId, ctx.organizationId),
        eq(parties.kind, kind),
        includeArchived ? undefined : eq(parties.isActive, true),
        q
          ? or(
              ilike(parties.displayName, likePattern(q)),
              ilike(parties.companyName, likePattern(q)),
              ilike(parties.email, likePattern(q)),
            )
          : undefined,
      );
      const rows = await app.db
        .select({
          id: parties.id,
          displayName: parties.displayName,
          companyName: parties.companyName,
          email: parties.email,
          phone: parties.phone,
          termsDays: parties.termsDays,
          taxExempt: parties.taxExempt,
          isActive: parties.isActive,
          createdAt: parties.createdAt,
          balance: balanceSql(kind, ctx.organizationId),
        })
        .from(parties)
        .where(where)
        .orderBy(parties.displayName)
        .limit(limit)
        .offset(offset);
      const [{ total } = { total: 0 }] = await app.db
        .select({ total: sql<number>`count(*)::int` })
        .from(parties)
        .where(where);
      return { data: rows, total };
    });

    app.post(base, { schema: { tags: [tag], summary: `Create a ${kind}`, body: partyBody } }, async (req, reply) => {
      const ctx = requireOrg(req, "masterdata.write");
      const row = await app.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(parties)
          .values({ ...req.body, organizationId: ctx.organizationId, kind, billingAddress: req.body.billingAddress ?? null })
          .returning();
        await audit(tx, {
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: `${kind}.created`,
          entityType: kind,
          entityId: row!.id,
          summary: `Created ${kind} ${row!.displayName}`,
          ip: ctx.ip,
        });
        return row;
      });
      return reply.status(201).send(row);
    });

    app.get(`${base}/:id`, { schema: { tags: [tag], summary: `Get a ${kind} with balance and activity`, params: uuidParam } }, async (req) => {
      const ctx = requireOrg(req);
      const [row] = await app.db
        .select({
          party: parties,
          balance: balanceSql(kind, ctx.organizationId),
        })
        .from(parties)
        .where(and(eq(parties.organizationId, ctx.organizationId), eq(parties.kind, kind), eq(parties.id, req.params.id)));
      if (!row) throw notFound(label);
      if (kind === "vendor") {
        const vendorBills = await app.db
          .select({
            id: bills.id,
            number: bills.number,
            vendorReference: bills.vendorReference,
            billDate: bills.billDate,
            dueDate: bills.dueDate,
            status: bills.status,
            total: bills.total,
            balanceDue: bills.balanceDue,
          })
          .from(bills)
          .where(and(eq(bills.organizationId, ctx.organizationId), eq(bills.vendorId, req.params.id)))
          .orderBy(desc(bills.billDate), desc(bills.number))
          .limit(50);
        const vendorPayments = await app.db
          .select({ id: billPayments.id, number: billPayments.number, date: billPayments.date, amount: billPayments.amount, method: billPayments.method })
          .from(billPayments)
          .where(and(eq(billPayments.organizationId, ctx.organizationId), eq(billPayments.vendorId, req.params.id)))
          .orderBy(desc(billPayments.date), desc(billPayments.number))
          .limit(50);
        const orders = await app.db
          .select({ id: purchaseOrders.id, number: purchaseOrders.number, orderDate: purchaseOrders.orderDate, status: purchaseOrders.status, total: purchaseOrders.total })
          .from(purchaseOrders)
          .where(and(eq(purchaseOrders.organizationId, ctx.organizationId), eq(purchaseOrders.vendorId, req.params.id)))
          .orderBy(desc(purchaseOrders.orderDate), desc(purchaseOrders.number))
          .limit(50);
        return { ...row.party, balance: row.balance, bills: vendorBills, billPayments: vendorPayments, purchaseOrders: orders };
      }
      const recentInvoices = await app.db
        .select({
          id: invoices.id,
          number: invoices.number,
          issueDate: invoices.issueDate,
          dueDate: invoices.dueDate,
          status: invoices.status,
          total: invoices.total,
          balanceDue: invoices.balanceDue,
        })
        .from(invoices)
        .where(and(eq(invoices.organizationId, ctx.organizationId), eq(invoices.customerId, req.params.id)))
        .orderBy(desc(invoices.issueDate), desc(invoices.number))
        .limit(50);
      const recentPayments = await app.db
        .select({
          id: payments.id,
          number: payments.number,
          date: payments.date,
          amount: payments.amount,
          unappliedAmount: payments.unappliedAmount,
          method: payments.method,
        })
        .from(payments)
        .where(and(eq(payments.organizationId, ctx.organizationId), eq(payments.customerId, req.params.id)))
        .orderBy(desc(payments.date), desc(payments.number))
        .limit(50);
      return { ...row.party, balance: row.balance, invoices: recentInvoices, payments: recentPayments };
    });

    app.patch(
      `${base}/:id`,
      {
        schema: {
          tags: [tag],
          summary: `Update a ${kind}`,
          params: uuidParam,
          body: partyBody.partial().extend({ isActive: z.boolean().optional() }),
        },
      },
      async (req) => {
        const ctx = requireOrg(req, "masterdata.write");
        return app.db.transaction(async (tx) => {
          const [row] = await tx
            .update(parties)
            .set({ ...req.body, updatedAt: new Date() })
            .where(and(eq(parties.organizationId, ctx.organizationId), eq(parties.kind, kind), eq(parties.id, req.params.id)))
            .returning();
          if (!row) throw notFound(label);
          await audit(tx, {
            organizationId: ctx.organizationId,
            actorUserId: ctx.userId,
            action: `${kind}.updated`,
            entityType: kind,
            entityId: row.id,
            summary: `Updated ${kind} ${row.displayName}`,
            data: { fields: Object.keys(req.body) },
            ip: ctx.ip,
          });
          return row;
        });
      },
    );

    app.post(
      `${base}/bulk-archive`,
      {
        schema: {
          tags: [tag],
          summary: `Archive or restore several ${tag.toLowerCase()} at once`,
          body: z.object({ ids: z.array(z.uuid()).min(1).max(500), archived: z.boolean() }),
        },
      },
      async (req) => {
        const ctx = requireOrg(req, "masterdata.write");
        return app.db.transaction(async (tx) => {
          const rows = await tx
            .update(parties)
            .set({ isActive: !req.body.archived, updatedAt: new Date() })
            .where(
              and(eq(parties.organizationId, ctx.organizationId), eq(parties.kind, kind), inArray(parties.id, req.body.ids)),
            )
            .returning({ id: parties.id });
          await audit(tx, {
            organizationId: ctx.organizationId,
            actorUserId: ctx.userId,
            action: req.body.archived ? `${kind}.archived` : `${kind}.restored`,
            entityType: kind,
            summary: `${req.body.archived ? "Archived" : "Restored"} ${rows.length} ${tag.toLowerCase()}`,
            data: { ids: rows.map((r) => r.id) },
            ip: ctx.ip,
          });
          return { updated: rows.length };
        });
      },
    );
  }
};
