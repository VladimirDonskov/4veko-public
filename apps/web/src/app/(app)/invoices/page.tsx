"use client";

import { useQuery } from "@tanstack/react-query";
import { FileText, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { DataTable } from "@/components/data-table";
import { ButtonLink } from "@/components/ui/button";
import { Card, EmptyState, ErrorState, LoadingRows, Money, PageHeader, StatusBadge } from "@/components/ui/misc";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { date } from "@/lib/format";
import { useCan } from "@/lib/session";

type Invoice = { id: string; number: string; customerName: string; issueDate: string; dueDate: string; status: string; total: string; balanceDue: string; daysOverdue: number };

const TABS = [
  { value: "", label: "All" },
  { value: "unpaid", label: "Unpaid" },
  { value: "overdue", label: "Overdue" },
  { value: "paid", label: "Paid" },
  { value: "void", label: "Void" },
];

function InvoicesPage() {
  const params = useSearchParams();
  const router = useRouter();
  const status = params.get("status") ?? "";
  const canPost = useCan("invoice.post");
  const q = useQuery({
    queryKey: ["invoices", "list", status],
    queryFn: () => api<{ data: Invoice[]; totalBalanceDue: string }>(`/invoices?limit=500${status ? `&status=${status}` : ""}`),
  });
  return (
    <>
      <PageHeader
        title="Invoices"
        description="Posted invoices update receivables, revenue, sales tax and stock at the same moment."
        actions={
          canPost && (
            <ButtonLink href="/invoices/new">
              <Plus /> New invoice
            </ButtonLink>
          )
        }
      />
      <div className="mb-3 flex flex-wrap items-center gap-1" role="tablist" aria-label="Invoice status">
        {TABS.map((t) => (
          <button
            key={t.value}
            role="tab"
            aria-selected={status === t.value}
            onClick={() => router.replace(t.value ? `/invoices?status=${t.value}` : "/invoices")}
            className={cn("rounded-md px-3 py-1.5 text-sm", status === t.value ? "bg-accent-soft font-medium text-accent" : "text-muted hover:bg-surface-2")}
          >
            {t.label}
          </button>
        ))}
        {q.data && (
          <span className="ml-auto text-sm text-muted">
            Balance due: <Money value={q.data.totalBalanceDue} strong className="text-fg" />
          </span>
        )}
      </div>
      <Card>
        {q.error ? (
          <ErrorState error={q.error} retry={() => q.refetch()} />
        ) : !q.data ? (
          <LoadingRows />
        ) : (
          <DataTable
            id="invoices"
            rows={q.data.data}
            href={(r) => `/invoices/${r.id}`}
            initialSort={{ key: "issued", dir: "desc" }}
            empty={
              <EmptyState
                icon={<FileText />}
                title={status ? "No invoices in this view" : "No invoices yet"}
                description="Invoice a sales order, or create an invoice directly."
                action={canPost && <ButtonLink href="/invoices/new">New invoice</ButtonLink>}
              />
            }
            columns={[
              { key: "number", header: "Number", value: (r) => r.number, cell: (r) => <span className="font-medium">{r.number}</span> },
              { key: "customer", header: "Customer", value: (r) => r.customerName, cell: (r) => r.customerName },
              { key: "issued", header: "Date", value: (r) => r.issueDate, cell: (r) => date(r.issueDate), hideBelow: "sm" },
              {
                key: "due",
                header: "Due",
                value: (r) => r.dueDate,
                cell: (r) => (
                  <span className={r.daysOverdue > 0 ? "text-danger" : ""}>
                    {date(r.dueDate)}
                    {r.daysOverdue > 0 && <span className="block text-xs">{r.daysOverdue} days late</span>}
                  </span>
                ),
                hideBelow: "md",
              },
              { key: "status", header: "Status", value: (r) => r.status, cell: (r) => <StatusBadge status={r.status} overdue={r.daysOverdue > 0} /> },
              { key: "total", header: "Total", align: "right", value: (r) => Number(r.total), cell: (r) => <Money value={r.total} />, hideBelow: "sm" },
              { key: "balance", header: "Balance due", align: "right", value: (r) => Number(r.balanceDue), cell: (r) => (r.status === "void" ? <span className="text-muted">—</span> : <Money value={r.balanceDue} />) },
            ]}
          />
        )}
      </Card>
      <p className="mt-3 text-xs text-muted">
        Need the totals by age? See the <Link className="text-accent hover:underline" href="/reports/ar-aging">receivables aging report</Link>.
      </p>
    </>
  );
}

export default function Page() {
  return (
    <Suspense>
      <InvoicesPage />
    </Suspense>
  );
}
