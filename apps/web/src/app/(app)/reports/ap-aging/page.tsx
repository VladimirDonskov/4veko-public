"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Suspense } from "react";
import { DateControl, ReportActions } from "@/components/report-parts";
import { Card, ErrorState, LoadingRows, Money, PageHeader } from "@/components/ui/misc";
import { api } from "@/lib/api";
import { date, todayIso } from "@/lib/format";
import { useDateFilter } from "@/lib/use-date-filter";

type Row = Record<string, string> & { vendorId: string; vendorName: string };
type Aging = { asOf: string; buckets: string[]; vendors: Row[]; totals: Record<string, string> };
const LABELS: Record<string, string> = { current: "Current", "1-30": "1–30", "31-60": "31–60", "61-90": "61–90", over90: "Over 90", total: "Total" };

export default function ApAgingPage() {
  return <Suspense fallback={<LoadingRows />}><AgingReport /></Suspense>;
}

function AgingReport() {
  const [asOf, setAsOf] = useDateFilter("asOf", todayIso());
  const q = useQuery({
    queryKey: ["reports", "ap-aging", asOf],
    queryFn: () => api<Aging>(`/reports/ap-aging?asOf=${asOf}`),
    enabled: !!asOf,
  });
  const r = q.data;
  const cols = r ? [...r.buckets, "total"] : [];
  return (
    <>
      <PageHeader
        breadcrumb={<Link href="/reports" className="hover:underline">Reports</Link>}
        title="Payables Aging"
        description={r ? `Unpaid bills by days past due, as of ${date(r.asOf)}.` : undefined}
        actions={
          <>
            <DateControl label="As of" value={asOf} onChange={setAsOf} />
            {r && !q.error && (
              <ReportActions
                filename={`ap-aging-${r.asOf}.csv`}
                rows={[["Vendor", ...cols.map((c) => LABELS[c] ?? c)], ...r.vendors.map((v) => [v.vendorName, ...cols.map((c) => v[c] ?? "")]), ["Total", ...cols.map((c) => r.totals[c] ?? "")]]}
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
        ) : r.vendors.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted">No open vendor balances on this date.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted">
                  <th className="px-4 py-2 font-medium">Vendor</th>
                  {cols.map((c) => (
                    <th key={c} className="px-4 py-2 text-right font-medium">
                      {LABELS[c]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {r.vendors.map((v) => (
                  <tr key={v.vendorId} className="border-b border-border">
                    <td className="px-4 py-2">
                      <Link href={`/vendors/${v.vendorId}`} className="hover:underline">
                        {v.vendorName}
                      </Link>
                    </td>
                    {cols.map((c) => (
                      <td key={c} className={`px-4 py-2 text-right ${c === "total" ? "font-semibold" : ""}`}>
                        {Number(v[c]) ? <Money value={v[c]} /> : <span className="text-muted">—</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-fg/70 font-semibold">
                  <td className="px-4 py-2">Total</td>
                  {cols.map((c) => (
                    <td key={c} className="px-4 py-2 text-right">
                      <Money value={r.totals[c]} />
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
