"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { DateControl, ReportActions, ReportSection, ReportTotal, sectionRows, type Section } from "@/components/report-parts";
import { Card, ErrorState, LoadingRows, PageHeader } from "@/components/ui/misc";
import { api } from "@/lib/api";
import { date, todayIso } from "@/lib/format";

type PL = { from: string; to: string; income: Section; cogs: Section; grossProfit: string; expenses: Section; operatingIncome: string; otherIncome: Section; otherExpenses: Section; netIncome: string };

export default function ProfitAndLossPage() {
  const [from, setFrom] = useState(`${todayIso().slice(0, 4)}-01-01`);
  const [to, setTo] = useState(todayIso());
  const q = useQuery({ queryKey: ["reports", "pl", from, to], queryFn: () => api<PL>(`/reports/profit-and-loss?from=${from}&to=${to}`) });
  const r = q.data;
  return (
    <>
      <PageHeader
        breadcrumb={<Link href="/reports" className="hover:underline">Reports</Link>}
        title="Profit and Loss"
        description={r ? `${date(r.from)} – ${date(r.to)}` : undefined}
        actions={
          <div className="flex flex-wrap items-end gap-2">
            <DateControl label="From" value={from} onChange={setFrom} />
            <DateControl label="To" value={to} onChange={setTo} />
            {r && (
              <ReportActions
                filename={`profit-and-loss-${r.from}-to-${r.to}.csv`}
                rows={[
                  ["Profit and Loss", `${r.from} to ${r.to}`],
                  ...sectionRows(r.income),
                  ...sectionRows(r.cogs),
                  ["Gross profit", r.grossProfit],
                  ...sectionRows(r.expenses),
                  ["Operating income", r.operatingIncome],
                  ...sectionRows(r.otherIncome),
                  ...sectionRows(r.otherExpenses),
                  ["Net income", r.netIncome],
                ]}
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
          <table className="w-full text-sm">
            <tbody>
              <ReportSection section={r.income} />
              <ReportSection section={r.cogs} />
              <ReportTotal label="Gross profit" value={r.grossProfit} />
              <ReportSection section={r.expenses} />
              <ReportTotal label="Operating income" value={r.operatingIncome} />
              {r.otherIncome.accounts.length > 0 && <ReportSection section={r.otherIncome} />}
              {r.otherExpenses.accounts.length > 0 && <ReportSection section={r.otherExpenses} />}
              <ReportTotal label="Net income" value={r.netIncome} strong />
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
