"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Suspense } from "react";
import { DateControl, ReportActions } from "@/components/report-parts";
import { Card, ErrorState, LoadingRows, Money, PageHeader } from "@/components/ui/misc";
import { api } from "@/lib/api";
import { date, todayIso } from "@/lib/format";
import { useDateFilter } from "@/lib/use-date-filter";

type Row = Record<string, string> & { customerId: string; customerName: string };
type Aging = { asOf: string; buckets: string[]; customers: Row[]; totals: Record<string, string> };
const LABELS: Record<string, string> = { current: "Current", "1-30": "1–30", "31-60": "31–60", "61-90": "61–90", over90: "Over 90" };

export default function ArAgingPage() {
  return <Suspense fallback={<LoadingRows />}><AgingReport /></Suspense>;
}

function AgingReport() {
  const [asOf, setAsOf] = useDateFilter("asOf", todayIso());
  const q = useQuery({
    queryKey: ["reports", "aging", asOf],
    queryFn: () => api<Aging>(`/reports/ar-aging?asOf=${asOf}`),
    enabled: !!asOf,
  });
  const r = q.data;
  const cols = r ? [...r.buckets, "unappliedCredits", "total"] : [];
  const header = (c: string) => LABELS[c] ?? (c === "unappliedCredits" ? "Credits" : "Total");
  return (
    <>
      <PageHeader
        breadcrumb={<Link href="/reports" className="hover:underline">Reports</Link>}
        title="Receivables Aging"
        description={r ? `Open balances by days past due, as of ${date(r.asOf)}. Unapplied payments are shown as credits.` : undefined}
        actions={
          <>
            <DateControl label="As of" value={asOf} onChange={setAsOf} />
            {r && !q.error && (
              <ReportActions
                filename={`ar-aging-${r.asOf}.csv`}
                rows={[
                  ["Customer", ...cols.map((k) => k === "unappliedCredits" ? "Credits (deduct)" : header(k))],
                  ...r.customers.map((c) => [c.customerName, ...cols.map((k) => c[k] ?? "")]),
                  ["Total", ...cols.map((k) => r.totals[k] ?? "")],
                ]}
              />
            )}
          </>
        }
      />
      <Card>
        {!asOf ? (
          <p className="px-4 py-8 text-center text-sm text-muted">Choose a report date.</p>
        ) : q.error ? (
          <ErrorState error={q.error} retry={() => q.refetch()} />
        ) : !r ? (
          <LoadingRows />
        ) : r.customers.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted">No open customer balances on this date.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted">
                  <th className="px-4 py-2 font-medium">Customer</th>
                  {cols.map((c) => (
                    <th key={c} className="px-4 py-2 text-right font-medium">
                      {header(c)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {r.customers.map((c) => (
                  <tr key={c.customerId} className="border-b border-border">
                    <td className="px-4 py-2">
                      <Link href={`/customers/${c.customerId}`} className="hover:underline">
                        {c.customerName}
                      </Link>
                    </td>
                    {cols.map((k) => (
                      <td key={k} className={`px-4 py-2 text-right ${k === "total" ? "font-semibold" : ""}`}>
                        {Number(c[k]) ? <Money value={k === "unappliedCredits" ? `-${c[k]}` : c[k]} /> : <span className="text-muted">—</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-fg/70 font-semibold">
                  <td className="px-4 py-2">Total</td>
                  {cols.map((k) => (
                    <td key={k} className="px-4 py-2 text-right">
                      <Money value={k === "unappliedCredits" && Number(r.totals[k]) ? `-${r.totals[k]}` : r.totals[k]} />
                    </td>
                  ))}
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
