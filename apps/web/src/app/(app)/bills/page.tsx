"use client";

import { useQuery } from "@tanstack/react-query";
import { Plus, Receipt, Wallet } from "lucide-react";
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

type Bill = { id: string; number: string; vendorReference: string; vendorName: string; billDate: string; dueDate: string; status: string; total: string; balanceDue: string; daysOverdue: number };

const TABS = [
  { value: "", label: "All" },
  { value: "unpaid", label: "Unpaid" },
  { value: "overdue", label: "Overdue" },
  { value: "paid", label: "Paid" },
  { value: "void", label: "Void" },
];

function BillsPage() {
  const params = useSearchParams();
  const router = useRouter();
  const status = params.get("status") ?? "";
  const canPost = useCan("bills.post");
  const canPay = useCan("bills.pay");
  const q = useQuery({
    queryKey: ["bills", "list", status],
    queryFn: () => api<{ data: Bill[]; totalBalanceDue: string }>(`/bills?limit=500${status ? `&status=${status}` : ""}`),
  });
  return (
    <>
      <PageHeader
        title="Bills"
        description="What you owe vendors. Entering a bill credits Accounts Payable; paying it debits Payable and credits the bank."
        actions={
          <>
            {canPay && (
              <ButtonLink variant="secondary" href="/bill-payments/new">
                <Wallet /> Pay bills
              </ButtonLink>
            )}
            {canPost && (
              <ButtonLink href="/bills/new">
                <Plus /> Enter bill
              </ButtonLink>
            )}
          </>
        }
      />
      <div className="mb-3 flex flex-wrap items-center gap-1" role="tablist" aria-label="Bill status">
        {TABS.map((t) => (
          <button
            key={t.value}
            role="tab"
            aria-selected={status === t.value}
            onClick={() => router.replace(t.value ? `/bills?status=${t.value}` : "/bills")}
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
            id="bills"
            rows={q.data.data}
            href={(r) => `/bills/${r.id}`}
            initialSort={{ key: "due", dir: "asc" }}
            empty={<EmptyState icon={<Receipt />} title={status ? "No bills in this view" : "No bills yet"} description="Enter a vendor's invoice when it arrives." action={canPost && <ButtonLink href="/bills/new">Enter bill</ButtonLink>} />}
            columns={[
              { key: "number", header: "Number", value: (r) => r.number, cell: (r) => <span className="font-medium">{r.number}</span> },
              { key: "vendor", header: "Vendor", value: (r) => r.vendorName, cell: (r) => r.vendorName },
              { key: "ref", header: "Vendor invoice", value: (r) => r.vendorReference, cell: (r) => <span className="text-muted">{r.vendorReference}</span>, hideBelow: "md" },
              { key: "date", header: "Date", value: (r) => r.billDate, cell: (r) => date(r.billDate), hideBelow: "lg" },
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
                hideBelow: "sm",
              },
              { key: "status", header: "Status", value: (r) => r.status, cell: (r) => <StatusBadge status={r.status} overdue={r.daysOverdue > 0} /> },
              { key: "balance", header: "Balance due", align: "right", value: (r) => Number(r.balanceDue), cell: (r) => (r.status === "void" ? <span className="text-muted">—</span> : <Money value={r.balanceDue} />) },
            ]}
          />
        )}
      </Card>
      <p className="mt-3 text-xs text-muted">
        Totals by age: <Link className="text-accent hover:underline" href="/reports/ap-aging">payables aging report</Link>.
      </p>
    </>
  );
}

export default function Page() {
  return (
    <Suspense>
      <BillsPage />
    </Suspense>
  );
}
