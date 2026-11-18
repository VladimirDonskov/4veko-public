"use client";

import { useQuery } from "@tanstack/react-query";
import { Upload } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { DataTable } from "@/components/data-table";
import { Button } from "@/components/ui/button";
import { Card, EmptyState, ErrorState, LoadingRows, Money, PageHeader, StatusBadge } from "@/components/ui/misc";
import { api } from "@/lib/api";
import type { BankStatement } from "@/lib/bank-reconciliation";
import { date } from "@/lib/format";
import { useCan } from "@/lib/session";
import { ImportStatement } from "./import-statement";

export default function BankReconciliationsPage() {
  const canEdit = useCan("bank.reconcile");
  const [importing, setImporting] = useState(false);
  const statements = useQuery({
    queryKey: ["bank-reconciliations"],
    queryFn: () => api<{ data: BankStatement[] }>("/bank-reconciliations"),
  });
  return (
    <>
      <PageHeader title="Bank Reconciliation" description="Compare each bank statement with posted transactions in its ledger account."
        actions={canEdit && <Button onClick={() => setImporting(true)}><Upload /> Import statement</Button>} />
      <Card>
        {statements.error ? <ErrorState error={statements.error} retry={() => statements.refetch()} />
          : !statements.data ? <LoadingRows />
          : statements.data.data.length === 0 ? <EmptyState title="No bank statements yet" />
          : <DataTable id="bank-statements" rows={statements.data.data} initialSort={{ key: "endDate", dir: "desc" }}
              href={(s) => `/bank-reconciliations/${s.id}`}
              columns={[
                { key: "externalId", header: "Statement", value: (s) => s.externalId,
                  cell: (s) => <Link className="font-medium text-accent underline" href={`/bank-reconciliations/${s.id}`}>{s.externalId}</Link> },
                { key: "account", header: "Account", value: (s) => `${s.accountNumber} ${s.accountName}`, cell: (s) => `${s.accountNumber} ${s.accountName}` },
                { key: "endDate", header: "Period ending", value: (s) => s.endDate, cell: (s) => date(s.endDate) },
                { key: "closingBalance", header: "Statement balance", align: "right", cell: (s) => <Money value={s.closingBalance} /> },
                { key: "status", header: "Status", value: (s) => s.status, cell: (s) => <StatusBadge status={s.status} /> },
              ]} />}
      </Card>
      {canEdit && importing && <ImportStatement onDismiss={() => setImporting(false)} />}
    </>
  );
}
