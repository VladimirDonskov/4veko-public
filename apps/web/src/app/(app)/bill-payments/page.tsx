"use client";

import { useQuery } from "@tanstack/react-query";
import { Plus, Wallet } from "lucide-react";
import { DataTable } from "@/components/data-table";
import { ButtonLink } from "@/components/ui/button";
import { Card, EmptyState, ErrorState, LoadingRows, Money, PageHeader } from "@/components/ui/misc";
import { api } from "@/lib/api";
import { date } from "@/lib/format";
import { useCan } from "@/lib/session";

type Payment = { id: string; number: string; date: string; vendorName: string; amount: string; method: string; reference: string | null };

export default function BillPaymentsPage() {
  const canPay = useCan("bills.pay");
  const q = useQuery({ queryKey: ["bill-payments", "list"], queryFn: () => api<{ data: Payment[] }>("/bill-payments?limit=500") });
  return (
    <>
      <PageHeader
        title="Bill Payments"
        description="Money paid to vendors."
        actions={
          canPay && (
            <ButtonLink href="/bill-payments/new">
              <Plus /> Pay bills
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
            id="bill-payments"
            rows={q.data.data}
            href={(r) => `/bill-payments/${r.id}`}
            initialSort={{ key: "date", dir: "desc" }}
            empty={<EmptyState icon={<Wallet />} title="No bill payments yet" action={canPay && <ButtonLink href="/bill-payments/new">Pay bills</ButtonLink>} />}
            columns={[
              { key: "number", header: "Number", value: (r) => r.number, cell: (r) => <span className="font-medium">{r.number}</span> },
              { key: "date", header: "Date", value: (r) => r.date, cell: (r) => date(r.date) },
              { key: "vendor", header: "Vendor", value: (r) => r.vendorName, cell: (r) => r.vendorName },
              { key: "method", header: "Method", value: (r) => r.method, cell: (r) => r.method.toUpperCase(), hideBelow: "md" },
              { key: "reference", header: "Reference", value: (r) => r.reference, cell: (r) => <span className="text-muted">{r.reference ?? "—"}</span>, hideBelow: "lg" },
              { key: "amount", header: "Amount", align: "right", value: (r) => Number(r.amount), cell: (r) => <Money value={r.amount} /> },
            ]}
          />
        )}
      </Card>
    </>
  );
}
