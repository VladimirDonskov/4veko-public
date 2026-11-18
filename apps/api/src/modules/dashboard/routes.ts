import { and, desc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import {
  accounts,
  auditEvents,
  bills,
  invoices,
  items,
  journalEntries,
  journalLines,
  organizations,
  parties,
  purchaseOrders,
  salesOrders,
  stockLevels,
  users,
} from "../../db/schema";
import { requireOrg } from "../../lib/context";
import { addDays, fiscalYearStart, monthStart, today } from "../../lib/dates";
import { cents, dec } from "../../lib/money";
import { can } from "../../lib/permissions";
import { accountTotals, apAging, arAging } from "../reports/queries";

export const dashboardRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get("/", { schema: { tags: ["Dashboard"], summary: "Financial and operational KPIs, computed live from the ledger" } }, async (req) => {
    const ctx = requireOrg(req);
    const db = app.db;
    const asOf = today();
    const [org] = await db
      .select({ fy: organizations.fiscalYearStartMonth, name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, ctx.organizationId));
    const fyStart = fiscalYearStart(asOf, org?.fy ?? 1);
    const mStart = monthStart(asOf);

    const sumWhere = (rows: Awaited<ReturnType<typeof accountTotals>>, pick: (r: (typeof rows)[number]) => boolean) =>
      cents(rows.filter(pick).reduce((a, r) => a.plus(r.balance), dec(0)));
    const isSales = (r: { type: string; subtype: string }) => r.type === "revenue" && r.subtype === "sales";

    const [ytd, mtd, toDate] = await Promise.all([
      accountTotals(db, ctx.organizationId, { from: fyStart, to: asOf }),
      accountTotals(db, ctx.organizationId, { from: mStart, to: asOf }),
      accountTotals(db, ctx.organizationId, { to: asOf }),
    ]);
    const netIncomeYtd = ytd.reduce(
      (a, r) => (r.type === "revenue" ? a.plus(r.balance) : r.type === "expense" ? a.minus(r.balance) : a),
      dec(0),
    );

    // Revenue by month for the last six months, including months with no sales.
    const sixMonthsAgo = (() => {
      const [y, m] = asOf.split("-").map(Number) as [number, number];
      const d = new Date(Date.UTC(y, m - 1 - 5, 1));
      return d.toISOString().slice(0, 10);
    })();
    const monthly = await db
      .select({
        month: sql<string>`to_char(date_trunc('month', ${journalEntries.date}), 'YYYY-MM')`,
        revenue: sql<string>`(coalesce(sum(${journalLines.credit}),0) - coalesce(sum(${journalLines.debit}),0))::numeric(18,2)::text`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
      .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
      .where(
        and(
          eq(journalLines.organizationId, ctx.organizationId),
          eq(accounts.type, "revenue"),
          eq(accounts.subtype, "sales"),
          gte(journalEntries.date, sixMonthsAgo),
        ),
      )
      .groupBy(sql`date_trunc('month', ${journalEntries.date})`);
    const months: { month: string; revenue: string }[] = [];
    for (let i = 0; i < 6; i++) {
      const [y, m] = sixMonthsAgo.split("-").map(Number) as [number, number];
      const key = new Date(Date.UTC(y, m - 1 + i, 1)).toISOString().slice(0, 7);
      months.push({ month: key, revenue: monthly.find((r) => r.month === key)?.revenue ?? "0.00" });
    }

    const aging = await arAging(db, ctx.organizationId, asOf);
    const payables = await apAging(db, ctx.organizationId, asOf);
    const [billsDue] = await db
      .select({
        count: sql<number>`count(*)::int`,
        amount: sql<string>`coalesce(sum(${bills.balanceDue}),0)::numeric(18,2)::text`,
      })
      .from(bills)
      .where(
        and(
          eq(bills.organizationId, ctx.organizationId),
          inArray(bills.status, ["open", "partially_paid"]),
          lte(bills.dueDate, addDays(asOf, 7)),
        ),
      );
    const [openPos] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(purchaseOrders)
      .where(and(eq(purchaseOrders.organizationId, ctx.organizationId), inArray(purchaseOrders.status, ["issued", "partially_received"])));
    const [overdue] = await db
      .select({
        count: sql<number>`count(*)::int`,
        amount: sql<string>`coalesce(sum(${invoices.balanceDue}),0)::numeric(18,2)::text`,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.organizationId, ctx.organizationId),
          inArray(invoices.status, ["open", "partially_paid"]),
          lt(invoices.dueDate, asOf),
        ),
      );
    const [openOrders] = await db
      .select({ count: sql<number>`count(*)::int`, amount: sql<string>`coalesce(sum(${salesOrders.total}),0)::numeric(18,2)::text` })
      .from(salesOrders)
      .where(and(eq(salesOrders.organizationId, ctx.organizationId), inArray(salesOrders.status, ["draft", "confirmed"])));

    const topCustomers = await db
      .select({
        customerId: parties.id,
        name: parties.displayName,
        invoiced: sql<string>`sum(${invoices.subtotal})::numeric(18,2)::text`,
      })
      .from(invoices)
      .innerJoin(parties, eq(parties.id, invoices.customerId))
      .where(and(eq(invoices.organizationId, ctx.organizationId), gte(invoices.issueDate, fyStart), sql`${invoices.status} <> 'void'`))
      .groupBy(parties.id, parties.displayName)
      .orderBy(desc(sql`sum(${invoices.subtotal})`))
      .limit(5);

    const lowStock = await db
      .select({
        itemId: items.id,
        sku: items.sku,
        name: items.name,
        reorderPoint: items.reorderPoint,
        qtyOnHand: sql<string>`coalesce(sum(${stockLevels.qtyOnHand}),0)::numeric(18,4)::text`,
      })
      .from(items)
      .leftJoin(stockLevels, and(eq(stockLevels.organizationId, items.organizationId), eq(stockLevels.itemId, items.id)))
      .where(and(eq(items.organizationId, ctx.organizationId), eq(items.type, "inventory"), eq(items.isActive, true), sql`${items.reorderPoint} is not null`))
      .groupBy(items.id)
      .having(sql`coalesce(sum(${stockLevels.qtyOnHand}),0) <= ${items.reorderPoint}`)
      .orderBy(items.name)
      .limit(10);

    const recentActivity = can(ctx.role, "audit.view")
      ? await db
          .select({
            id: auditEvents.id,
            action: auditEvents.action,
            summary: auditEvents.summary,
            entityType: auditEvents.entityType,
            entityId: auditEvents.entityId,
            actorName: users.name,
            createdAt: auditEvents.createdAt,
          })
          .from(auditEvents)
          .leftJoin(users, eq(users.id, auditEvents.actorUserId))
          .where(eq(auditEvents.organizationId, ctx.organizationId))
          .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
          .limit(8)
      : [];

    const hasData = toDate.length > 0;
    return {
      asOf,
      fiscalYearStart: fyStart,
      hasData,
      kpis: {
        revenueMonthToDate: sumWhere(mtd, isSales),
        revenueYearToDate: sumWhere(ytd, isSales),
        netIncomeYearToDate: netIncomeYtd.toFixed(2),
        cashBalance: sumWhere(toDate, (r) => r.type === "asset" && (r.subtype === "bank" || r.subtype === "cash")),
        accountsReceivable: aging.totals.total,
        overdueReceivables: overdue?.amount ?? "0.00",
        overdueInvoiceCount: overdue?.count ?? 0,
        inventoryValue: sumWhere(toDate, (r) => r.subtype === "inventory"),
        openSalesOrders: openOrders?.count ?? 0,
        openSalesOrdersValue: openOrders?.amount ?? "0.00",
        accountsPayable: payables.totals.total,
        billsDueSoonAmount: billsDue?.amount ?? "0.00",
        billsDueSoonCount: billsDue?.count ?? 0,
        openPurchaseOrders: openPos?.count ?? 0,
      },
      revenueByMonth: months,
      arAging: aging.totals,
      topCustomers,
      lowStock,
      recentActivity,
    };
  });
};
