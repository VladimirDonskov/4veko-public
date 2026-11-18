"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { BalanceCheck, DateControl, ReportActions } from "@/components/report-parts";
import { Card, ErrorState, LoadingRows, Money, PageHeader } from "@/components/ui/misc";
import { api } from "@/lib/api";
import { date, todayIso } from "@/lib/format";

type TB = { asOf: string; lines: { accountId: string; number: string; name: string; type: string; debit: string; credit: string }[]; totalDebit: string; totalCredit: string; balanced: boolean };

export default function TrialBalancePage() {
  const [asOf, setAsOf] = useState(todayIso());
  const q = useQuery({ queryKey: ["reports", "tb", asOf], queryFn: () => api<TB>(`/reports/trial-balance?asOf=${asOf}`) });
  const r = q.data;
  return (
    <>
      <PageHeader
        breadcrumb={<Link href="/reports" className="hover:underline">Reports</Link>}
        title="Trial Balance"
        description={r ? `As of ${date(r.asOf)}` : undefined}
        actions={
          <div className="flex flex-wrap items-end gap-2">
            <DateControl label="As of" value={asOf} onChange={setAsOf} />
            {r && (
              <ReportActions
                filename={`trial-balance-${r.asOf}.csv`}
                rows={[["Account", "Debit", "Credit"], ...r.lines.map((l) => [`${l.number} ${l.name}`, l.debit, l.credit]), ["Total", r.totalDebit, r.totalCredit]]}
              />
            )}
          </div>
        }
      />
      <Card className="max-w-3xl">
        {q.error ? (
          <ErrorState error={q.error} />
        ) : !r ? (
          <LoadingRows />
        ) : (
          <div className="pb-4">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted">
                  <th className="px-4 py-2 font-medium">Account</th>
                  <th className="px-4 py-2 text-right font-medium">Debit</th>
                  <th className="px-4 py-2 text-right font-medium">Credit</th>
                </tr>
              </thead>
              <tbody>
                {r.lines.map((l) => (
                  <tr key={l.accountId} className="border-b border-border">
                    <td className="px-4 py-1.5">
                      <Link href={`/accounts/${l.accountId}`} className="hover:underline">
                        <span className="font-mono text-xs text-muted">{l.number}</span> {l.name}
                      </Link>
                    </td>
                    <td className="px-4 py-1.5 text-right">{Number(l.debit) ? <Money value={l.debit} /> : ""}</td>
                    <td className="px-4 py-1.5 text-right">{Number(l.credit) ? <Money value={l.credit} /> : ""}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-fg/70 font-semibold">
                  <td className="px-4 py-2">Total</td>
                  <td className="px-4 py-2 text-right">
                    <Money value={r.totalDebit} />
                  </td>
                  <td className="px-4 py-2 text-right">
                    <Money value={r.totalCredit} />
                  </td>
                </tr>
              </tfoot>
            </table>
            <div className="px-4">
              <BalanceCheck ok={r.balanced}>{r.balanced ? "Debits equal credits." : "Debits and credits do not match."}</BalanceCheck>
            </div>
          </div>
        )}
      </Card>
    </>
  );
}
