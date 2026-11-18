"use client";

import { useQuery } from "@tanstack/react-query";
import { CreditCard, Plus } from "lucide-react";
import { DataTable } from "@/components/data-table";
import { ButtonLink } from "@/components/ui/button";
import { Card, EmptyState, ErrorState, LoadingRows, Money, PageHeader } from "@/components/ui/misc";
import { api } from "@/lib/api";
import { date } from "@/lib/format";
import { useCan } from "@/lib/session";

type Payment = { id: string; number: string; date: string; customerName: string; amount: string; unappliedAmount: string; method: string; reference: string | null };

export default function PaymentsPage() {
  const canWrite = useCan("payments.write");
  const q = useQuery({ queryKey: ["payments", "list"], queryFn: () => api<{ data: Payment[] }>("/payments?limit=500") });
  return (
    <>
      <PageHeader
        title="Payments"
        description="Money received from customers."
        actions={
          canWrite && (
            <ButtonLink href="/payments/new">
              <Plus /> Record payment
            </ButtonLink>
          )
        }
      />
      <Card>
        {q.error ? (
          <ErrorState error={q.error} retry={() => q.refetch()} />
        ) : !q.data ? (
          <LoadingRows />
        ) : (
          <DataTable
            id="payments"
            rows={q.data.data}
            href={(r) => `/payments/${r.id}`}
            initialSort={{ key: "date", dir: "desc" }}
            empty={<EmptyState icon={<CreditCard />} title="No payments yet" action={canWrite && <ButtonLink href="/payments/new">Record payment</ButtonLink>} />}
            columns={[
              { key: "number", header: "Number", value: (r) => r.number, cell: (r) => <span className="font-medium">{r.number}</span> },
              { key: "date", header: "Date", value: (r) => r.date, cell: (r) => date(r.date) },
              { key: "customer", header: "Customer", value: (r) => r.customerName, cell: (r) => r.customerName },
              { key: "method", header: "Method", value: (r) => r.method, cell: (r) => r.method.toUpperCase(), hideBelow: "md" },
              { key: "reference", header: "Reference", value: (r) => r.reference, cell: (r) => <span className="text-muted">{r.reference ?? "—"}</span>, hideBelow: "lg" },
              { key: "unapplied", header: "Unapplied", align: "right", value: (r) => Number(r.unappliedAmount), cell: (r) => (Number(r.unappliedAmount) ? <Money value={r.unappliedAmount} /> : <span className="text-muted">—</span>), hideBelow: "md" },
              { key: "amount", header: "Amount", align: "right", value: (r) => Number(r.amount), cell: (r) => <Money value={r.amount} /> },
            ]}
          />
        )}
      </Card>
    </>
  );
}
