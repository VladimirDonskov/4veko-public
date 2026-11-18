"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { BalanceCheck, DateControl, ReportActions, ReportSection, ReportTotal, sectionRows, type Section } from "@/components/report-parts";
import { Card, ErrorState, LoadingRows, PageHeader } from "@/components/ui/misc";
import { api } from "@/lib/api";
import { date, money, todayIso } from "@/lib/format";

type BS = { asOf: string; assets: Section; liabilities: Section; equity: Section; totalLiabilitiesAndEquity: string; balanced: boolean };

export default function BalanceSheetPage() {
  const [asOf, setAsOf] = useState(todayIso());
  const q = useQuery({ queryKey: ["reports", "bs", asOf], queryFn: () => api<BS>(`/reports/balance-sheet?asOf=${asOf}`) });
  const r = q.data;
  return (
    <>
      <PageHeader
        breadcrumb={<Link href="/reports" className="hover:underline">Reports</Link>}
        title="Balance Sheet"
        description={r ? `As of ${date(r.asOf)}` : undefined}
        actions={
          <div className="flex flex-wrap items-end gap-2">
            <DateControl label="As of" value={asOf} onChange={setAsOf} />
            {r && (
              <ReportActions
                filename={`balance-sheet-${r.asOf}.csv`}
                rows={[["Balance Sheet", r.asOf], ...sectionRows(r.assets), ...sectionRows(r.liabilities), ...sectionRows(r.equity), ["Total liabilities and equity", r.totalLiabilitiesAndEquity]]}
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
              <tbody>
                <ReportSection section={r.assets} />
                <ReportSection section={r.liabilities} />
                <ReportSection section={r.equity} />
                <ReportTotal label="Total liabilities and equity" value={r.totalLiabilitiesAndEquity} strong />
              </tbody>
            </table>
            <div className="px-4">
              <BalanceCheck ok={r.balanced}>
                {r.balanced
                  ? "Assets equal liabilities plus equity."
                  : `Out of balance: assets ${money(r.assets.total)} vs liabilities and equity ${money(r.totalLiabilitiesAndEquity)}.`}
              </BalanceCheck>
            </div>
          </div>
        )}
      </Card>
    </>
  );
}
