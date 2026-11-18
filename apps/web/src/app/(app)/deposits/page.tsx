"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Plus } from "lucide-react";
import { DataTable } from "@/components/data-table";
import { ButtonLink } from "@/components/ui/button";
import { Card, EmptyState, ErrorState, LoadingRows, Money, PageHeader, StatusBadge } from "@/components/ui/misc";
import { api } from "@/lib/api";
import type { Deposit } from "@/lib/deposits";
import { date } from "@/lib/format";
import { useCan } from "@/lib/session";

export default function DepositsPage() {
  const canPost = useCan("bank.reconcile");
  const deposits = useQuery({ queryKey: ["deposits", "list"], queryFn: () => api<{ data: Deposit[] }>("/deposits") });
  return <>
    <PageHeader title="Bank Deposits" description="Group customer receipts into the deposits on your bank statement."
      actions={canPost && <ButtonLink href="/deposits/new"><Plus /> New deposit</ButtonLink>} />
    <Card>
      {deposits.error ? <ErrorState error={deposits.error} retry={() => deposits.refetch()} /> : !deposits.data ? <LoadingRows />
        : deposits.data.data.length === 0 ? <EmptyState title="No deposits yet" description="Payments recorded to Undeposited Funds can be included in a deposit." />
        : <DataTable id="bank-deposits" rows={deposits.data.data} href={(r) => `/deposits/${r.id}`} initialSort={{ key: "date", dir: "desc" }}
          columns={[
            { key: "number", header: "Deposit", value: (r) => r.number, cell: (r) => <Link href={`/deposits/${r.id}`} className="font-medium text-accent underline">{r.number}</Link> },
            { key: "date", header: "Date", value: (r) => r.date, cell: (r) => date(r.date) },
            { key: "bank", header: "Bank account", value: (r) => r.bankAccountNumber + " " + r.bankAccountName, cell: (r) => `${r.bankAccountNumber} ${r.bankAccountName}` },
            { key: "total", header: "Total", align: "right", cell: (r) => <Money value={r.total} /> },
            { key: "status", header: "Status", value: (r) => r.status, cell: (r) => <StatusBadge status={r.status} /> },
          ]} />}
    </Card>
  </>;
}
