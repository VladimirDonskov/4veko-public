import { and, eq, ilike, or } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { accounts, bills, invoices, items, parties, payments, purchaseOrders, salesOrders } from "../../db/schema";
import { requireOrg } from "../../lib/context";
import { likePattern } from "../../lib/validation";

export const searchRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/",
    {
      schema: {
        tags: ["Search"],
        summary: "Search customers, vendors, items, documents and accounts",
        querystring: z.object({ q: z.string().trim().min(1).max(100) }),
      },
    },
    async (req) => {
      const ctx = requireOrg(req);
      const p = likePattern(req.query.q);
      const org = ctx.organizationId;
      const [partyRows, itemRows, invoiceRows, orderRows, paymentRows, accountRows, poRows, billRows] = await Promise.all([
        app.db
          .select({ id: parties.id, kind: parties.kind, title: parties.displayName, subtitle: parties.email })
          .from(parties)
          .where(and(eq(parties.organizationId, org), or(ilike(parties.displayName, p), ilike(parties.email, p), ilike(parties.companyName, p))))
          .limit(6),
        app.db
          .select({ id: items.id, title: items.name, subtitle: items.sku })
          .from(items)
          .where(and(eq(items.organizationId, org), or(ilike(items.name, p), ilike(items.sku, p))))
          .limit(6),
        app.db
          .select({ id: invoices.id, title: invoices.number, subtitle: parties.displayName, status: invoices.status })
          .from(invoices)
          .innerJoin(parties, eq(parties.id, invoices.customerId))
          .where(and(eq(invoices.organizationId, org), or(ilike(invoices.number, p), ilike(parties.displayName, p))))
          .limit(6),
        app.db
          .select({ id: salesOrders.id, title: salesOrders.number, subtitle: parties.displayName, status: salesOrders.status })
          .from(salesOrders)
          .innerJoin(parties, eq(parties.id, salesOrders.customerId))
          .where(and(eq(salesOrders.organizationId, org), or(ilike(salesOrders.number, p), ilike(parties.displayName, p))))
          .limit(6),
        app.db
          .select({ id: payments.id, title: payments.number, subtitle: parties.displayName })
          .from(payments)
          .innerJoin(parties, eq(parties.id, payments.customerId))
          .where(and(eq(payments.organizationId, org), or(ilike(payments.number, p), ilike(payments.reference, p))))
          .limit(4),
        app.db
          .select({ id: accounts.id, title: accounts.name, subtitle: accounts.number })
          .from(accounts)
          .where(and(eq(accounts.organizationId, org), or(ilike(accounts.name, p), ilike(accounts.number, p))))
          .limit(4),
        app.db
          .select({ id: purchaseOrders.id, title: purchaseOrders.number, subtitle: parties.displayName, status: purchaseOrders.status })
          .from(purchaseOrders)
          .innerJoin(parties, eq(parties.id, purchaseOrders.vendorId))
          .where(and(eq(purchaseOrders.organizationId, org), or(ilike(purchaseOrders.number, p), ilike(parties.displayName, p))))
          .limit(5),
        app.db
          .select({ id: bills.id, title: bills.number, subtitle: parties.displayName, ref: bills.vendorReference, status: bills.status })
          .from(bills)
          .innerJoin(parties, eq(parties.id, bills.vendorId))
          .where(and(eq(bills.organizationId, org), or(ilike(bills.number, p), ilike(bills.vendorReference, p), ilike(parties.displayName, p))))
          .limit(5),
      ]);
      return {
        results: [
          ...partyRows.map((r) => ({ type: r.kind, id: r.id, title: r.title, subtitle: r.subtitle })),
          ...itemRows.map((r) => ({ type: "item", ...r })),
          ...invoiceRows.map((r) => ({ type: "invoice", id: r.id, title: r.title, subtitle: `${r.subtitle} · ${r.status}` })),
          ...orderRows.map((r) => ({ type: "sales_order", id: r.id, title: r.title, subtitle: `${r.subtitle} · ${r.status}` })),
          ...paymentRows.map((r) => ({ type: "payment", ...r })),
          ...accountRows.map((r) => ({ type: "account", ...r })),
          ...poRows.map((r) => ({ type: "purchase_order", id: r.id, title: r.title, subtitle: `${r.subtitle} · ${r.status.replace("_", " ")}` })),
          ...billRows.map((r) => ({ type: "bill", id: r.id, title: `${r.title} (${r.ref})`, subtitle: `${r.subtitle} · ${r.status.replace("_", " ")}` })),
        ],
      };
    },
  );
};
