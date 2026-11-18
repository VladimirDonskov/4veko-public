"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Suspense } from "react";
import { DateControl, ReportActions } from "@/components/report-parts";
import { Card, ErrorState, LoadingRows, Money, PageHeader } from "@/components/ui/misc";
import { api } from "@/lib/api";
import { date, money, todayIso } from "@/lib/format";
import { useDateFilter } from "@/lib/use-date-filter";

type Control = {
  key: "accounts_receivable" | "accounts_payable";
  accountId: string;
  number: string;
  name: string;
  ledgerBalance: string;
  subledgerBalance: string;
  difference: string;
};
type Reconciliation = { asOf: string; rows: Control[] };

export default function Page() {
  return <Suspense fallback={<LoadingRows />}><ReconciliationReport /></Suspense>;
}

function ReconciliationReport() {
  const [asOf, setAsOf] = useDateFilter("asOf", todayIso());
  const q = useQuery({
    queryKey: ["reports", "control-reconciliation", asOf],
    queryFn: () => api<Reconciliation>(`/reports/control-reconciliation?asOf=${asOf}`),
    enabled: !!asOf,
  });
  const report = q.data;
  return (
    <>
      <PageHeader
        breadcrumb={<Link href="/reports" className="hover:underline">Reports</Link>}
        title="Control Account Reconciliation"
        description={report && `As of ${date(report.asOf)}. Difference is the ledger balance less the aging balance.`}
        actions={
          <>
            <DateControl label="As of" value={asOf} onChange={setAsOf} />
            {report && !q.error && (
              <ReportActions filename={`control-reconciliation-${report.asOf}.csv`} rows={[
                ["Account number", "Account", "Ledger balance", "Aging balance", "Difference"],
                ...report.rows.map((r) => [r.number, r.name, r.ledgerBalance, r.subledgerBalance, r.difference]),
              ]} />
            )}
          </>
        }
      />
      <Card>
        {!asOf ? (
          <p className="px-4 py-8 text-center text-sm text-muted">Choose a report date.</p>
        ) : q.error ? (
          <ErrorState error={q.error} retry={() => q.refetch()} />
        ) : !report ? (
          <LoadingRows />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[600px] text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-muted">
                  <th scope="col" className="px-4 py-2 text-left">Control account</th>
                  {["Ledger balance", "Aging balance", "Difference", "Status"].map((label) => (
                    <th scope="col" key={label} className="px-4 py-2 text-right">{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.rows.map((row) => {
                  const matches = row.difference === "0.00";
                  const aging = row.key === "accounts_receivable" ? "ar-aging" : "ap-aging";
                  return (
                    <tr key={row.key} className="border-b border-border last:border-0">
                      <th scope="row" className="px-4 py-3 text-left font-medium">
                        <Link className="text-accent underline" href={`/accounts/${row.accountId}?to=${report.asOf}`}>{row.number} {row.name}</Link>
                      </th>
                      <td className="px-4 py-3 text-right"><Money value={row.ledgerBalance} /></td>
                      <td className="px-4 py-3 text-right">
                        <Link
                          className="inline-block py-1 underline"
                          href={`/reports/${aging}?asOf=${report.asOf}`}
                          aria-label={`${row.name} aging balance ${money(row.subledgerBalance)}`}
                        >
                          <Money value={row.subledgerBalance} />
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-right"><Money value={row.difference} /></td>
                      <td className={`px-4 py-3 text-right ${matches ? "text-success" : "text-warning"}`}>{matches ? "Matches" : "Review"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
