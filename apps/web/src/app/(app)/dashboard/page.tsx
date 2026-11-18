"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Circle, Plus } from "lucide-react";
import Link from "next/link";
import { BarChart } from "@/components/bar-chart";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardHeader, ErrorState, Money, PageHeader, Skeleton } from "@/components/ui/misc";
import { api } from "@/lib/api";
import { dateTime, monthLabel, quantity } from "@/lib/format";
import { useMe } from "@/lib/session";

type Dashboard = {
  asOf: string;
  hasData: boolean;
  kpis: Record<string, string> & { overdueInvoiceCount: number; openSalesOrders: number; billsDueSoonCount: number; openPurchaseOrders: number };
  revenueByMonth: { month: string; revenue: string }[];
  arAging: Record<string, string>;
  topCustomers: { customerId: string; name: string; invoiced: string }[];
  lowStock: { itemId: string; sku: string; name: string; qtyOnHand: string; reorderPoint: string }[];
  recentActivity: { id: number; summary: string; actorName: string | null; createdAt: string }[];
};

function Stat({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: "danger" }) {
  return (
    <Card className="p-4">
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tracking-tight tabular ${tone === "danger" ? "text-danger" : ""}`}>{value}</p>
      {sub && <p className="mt-1 text-xs text-muted">{sub}</p>}
    </Card>
  );
}

const AGING_LABELS: Record<string, string> = { current: "Current", "1-30": "1–30 days", "31-60": "31–60 days", "61-90": "61–90 days", over90: "Over 90 days" };

export default function DashboardPage() {
  const me = useMe();
  const q = useQuery({ queryKey: ["dashboard"], queryFn: () => api<Dashboard>("/dashboard") });

  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const d = q.data;

  return (
    <>
      <PageHeader
        title={me.data?.organization?.name ?? "Dashboard"}
        description={`Live from your General Ledger as of ${d ? new Date(`${d.asOf}T00:00:00`).toLocaleDateString("en-US", { dateStyle: "medium" }) : "today"}. Every number links to the records behind it.`}
        actions={
          <>
            <ButtonLink href="/payments/new" variant="secondary">
              Record payment
            </ButtonLink>
            <ButtonLink href="/sales-orders/new">
              <Plus /> New sales order
            </ButtonLink>
          </>
        }
      />
      {!d ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {!d.hasData && <Onboarding />}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Revenue this month" value={<Money value={d.kpis.revenueMonthToDate} />} sub={<>Year to date <Money value={d.kpis.revenueYearToDate} /></>} />
            <Stat label="Net income, year to date" value={<Money value={d.kpis.netIncomeYearToDate} />} sub={<Link className="text-accent hover:underline" href="/reports/profit-and-loss">Profit and Loss</Link>} />
            <Stat label="Cash and bank" value={<Money value={d.kpis.cashBalance} />} sub="Bank and undeposited funds" />
            <Stat label="Inventory value" value={<Money value={d.kpis.inventoryValue} />} sub={<Link className="text-accent hover:underline" href="/inventory">Stock on hand</Link>} />
            <Stat label="Accounts receivable" value={<Money value={d.kpis.accountsReceivable} />} sub={<Link className="text-accent hover:underline" href="/reports/ar-aging">Aging report</Link>} />
            <Stat
              label="Overdue receivables"
              value={<Money value={d.kpis.overdueReceivables} />}
              tone={Number(d.kpis.overdueReceivables) > 0 ? "danger" : undefined}
              sub={
                <Link className="text-accent hover:underline" href="/invoices?status=overdue">
                  {d.kpis.overdueInvoiceCount} overdue invoice{d.kpis.overdueInvoiceCount === 1 ? "" : "s"}
                </Link>
              }
            />
            <Stat label="Open sales orders" value={d.kpis.openSalesOrders} sub={<>Worth <Money value={d.kpis.openSalesOrdersValue} /></>} />
            <Stat
              label="Accounts payable"
              value={<Money value={d.kpis.accountsPayable} />}
              sub={
                <Link className="text-accent hover:underline" href="/bills?status=unpaid">
                  {d.kpis.billsDueSoonCount} bill{d.kpis.billsDueSoonCount === 1 ? "" : "s"} due within 7 days
                </Link>
              }
            />
          </div>

          <div className="grid gap-6 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader title="Sales revenue by month" description="Last six months, from posted invoices" />
              <div className="p-4">
                <BarChart
                  label="Sales revenue by month, last six months"
                  data={d.revenueByMonth.map((m) => ({ key: m.month, label: monthLabel(m.month), value: Number(m.revenue) }))}
                />
              </div>
            </Card>
            <Card>
              <CardHeader title="Receivables aging" action={<Link href="/reports/ar-aging" className="text-xs text-accent hover:underline">Details</Link>} />
              <ul className="divide-y divide-border">
                {Object.entries(AGING_LABELS).map(([k, label]) => (
                  <li key={k} className="flex items-center justify-between px-4 py-2.5 text-sm">
                    <span className="flex items-center gap-2">
                      {k !== "current" && Number(d.arAging[k]) > 0 && <AlertTriangle className="size-3.5 text-warning" aria-label="Past due" />}
                      {label}
                    </span>
                    <Money value={d.arAging[k]} />
                  </li>
                ))}
                {Number(d.arAging.unappliedCredits) > 0 && (
                  <li className="flex items-center justify-between px-4 py-2.5 text-sm">
                    <span>Unapplied customer credits</span>
                    <Money value={`-${d.arAging.unappliedCredits}`} />
                  </li>
                )}
                <li className="flex items-center justify-between px-4 py-2.5 text-sm font-semibold">
                  <span>Total</span>
                  <Money value={d.arAging.total} />
                </li>
              </ul>
            </Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-3">
            <Card>
              <CardHeader title="Top customers" description="Invoiced this fiscal year, before tax" />
              {d.topCustomers.length === 0 ? (
                <p className="px-4 py-6 text-sm text-muted">No invoices yet this year.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {d.topCustomers.map((c) => (
                    <li key={c.customerId} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                      <Link href={`/customers/${c.customerId}`} className="truncate hover:underline">
                        {c.name}
                      </Link>
                      <Money value={c.invoiced} />
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card>
              <CardHeader title="Low stock" description="At or below the reorder point" />
              {d.lowStock.length === 0 ? (
                <p className="flex items-center gap-2 px-4 py-6 text-sm text-muted">
                  <CheckCircle2 className="size-4 text-success" aria-hidden /> Everything is above its reorder point.
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {d.lowStock.map((i) => (
                    <li key={i.itemId} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                      <Link href={`/items/${i.itemId}`} className="min-w-0 truncate hover:underline">
                        <span className="font-mono text-xs text-muted">{i.sku}</span> {i.name}
                      </Link>
                      <span className="whitespace-nowrap tabular text-warning">
                        {quantity(i.qtyOnHand)} / {quantity(i.reorderPoint)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card>
              <CardHeader title="Recent activity" action={d.recentActivity.length > 0 && <Link href="/audit" className="text-xs text-accent hover:underline">Audit log</Link>} />
              {d.recentActivity.length === 0 ? (
                <p className="px-4 py-6 text-sm text-muted">Activity appears here for owners, admins and accountants.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {d.recentActivity.map((a) => (
                    <li key={a.id} className="px-4 py-2.5 text-sm">
                      <p className="truncate">{a.summary}</p>
                      <p className="text-xs text-muted">
                        {a.actorName ?? "System"} · {dateTime(a.createdAt)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>
      )}
    </>
  );
}

function Onboarding() {
  const steps = [
    { label: "Add your first customer", href: "/customers?new=1" },
    { label: "Add products and services", href: "/items?new=1" },
    { label: "Enter opening stock", href: "/inventory?adjust=1" },
    { label: "Create a sales order and invoice it", href: "/sales-orders/new" },
    { label: "Invite your accountant", href: "/settings" },
  ];
  return (
    <Card className="p-5">
      <h2 className="font-semibold">Get set up in a few minutes</h2>
      <p className="mt-1 text-sm text-muted">Your chart of accounts and main warehouse are ready. These steps get your first invoice out.</p>
      <ol className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {steps.map((s) => (
          <li key={s.href}>
            <Link href={s.href} className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:border-accent hover:bg-accent-soft">
              <Circle className="size-4 text-muted" aria-hidden /> {s.label}
            </Link>
          </li>
        ))}
      </ol>
    </Card>
  );
}
