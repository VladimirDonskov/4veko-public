"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { use } from "react";
import { Input } from "@/components/ui/inputs";
import { Card, ErrorState, LoadingRows, Money, PageHeader } from "@/components/ui/misc";
import { api } from "@/lib/api";
import { sourceHref } from "@/components/nav";
import { date, humanize } from "@/lib/format";
import { useDateFilter } from "@/lib/use-date-filter";

type Ledger = {
  account: { id: string; number: string; name: string; type: string; subtype: string; normalBalance: string; description: string | null };
  openingBalance: string;
  closingBalance: string;
  truncated: boolean;
  lines: { id: string; entryId: string; entryNumber: number; date: string; memo: string | null; sourceType: string; sourceId: string | null; sourceNumber: string | null; description: string | null; debit: string; credit: string; balance: string; partyName: string | null }[];
};


export default function AccountLedgerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [from, setFrom] = useDateFilter("from", "");
  const [to, setTo] = useDateFilter("to", "");
  const q = useQuery({
    queryKey: ["accounts", id, from, to],
    queryFn: () => api<Ledger>(`/accounts/${id}?${new URLSearchParams({ ...(from && { from }), ...(to && { to }) })}`),
  });
  const account = q.data?.account;

  return (
    <>
      <PageHeader
        breadcrumb={<Link href="/accounts" className="hover:underline">Chart of Accounts</Link>}
        title={account ? `${account.number} ${account.name}` : "Account Ledger"}
        description={account && `${humanize(account.type)} · ${humanize(account.subtype)} · normal ${account.normalBalance} balance`}
        actions={
          <div className="flex items-end gap-2">
            <label className="text-xs text-muted">
              From
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="mt-1" />
            </label>
            <label className="text-xs text-muted">
              To
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="mt-1" />
            </label>
          </div>
        }
      />
      {q.error ? <ErrorState error={q.error} retry={() => q.refetch()} /> :
        q.data ? <LedgerTable ledger={q.data} showOpening={!!from} /> : <LoadingRows />}
    </>
  );
}

function LedgerTable({ ledger, showOpening }: { ledger: Ledger; showOpening: boolean }) {
  const { lines } = ledger;
  return (
    <Card>
      {ledger.truncated && (
        <p className="border-b border-border px-4 py-3 text-sm text-muted">
          Showing the first {lines.length.toLocaleString("en-US")} postings. The closing balance includes every posting through the end of the selected period.
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted">
              <th className="px-4 py-2 font-medium">Date</th>
              <th className="px-4 py-2 font-medium">Entry</th>
              <th className="px-4 py-2 font-medium">Description</th>
              <th className="px-4 py-2 text-right font-medium">Debit</th>
              <th className="px-4 py-2 text-right font-medium">Credit</th>
              <th className="px-4 py-2 text-right font-medium">Balance</th>
            </tr>
          </thead>
          <tbody>
            {showOpening && (
              <tr className="border-b border-border bg-surface">
                <td className="px-4 py-2" colSpan={5}>
                  Opening balance
                </td>
                <td className="px-4 py-2 text-right">
                  <Money value={ledger.openingBalance} />
                </td>
              </tr>
            )}
            {lines.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-muted">
                  No postings in this period.
                </td>
              </tr>
            )}
            {lines.map((l) => (
              <tr key={l.id} className="border-b border-border last:border-0">
                <td className="whitespace-nowrap px-4 py-2">{date(l.date)}</td>
                <td className="whitespace-nowrap px-4 py-2">
                  <Link className="text-accent hover:underline" href={`/journal/${l.entryId}`}>
                    #{l.entryNumber}
                  </Link>
                </td>
                <td className="px-4 py-2">
                  <div>{l.description ?? l.memo}</div>
                  <div className="text-xs text-muted">
                    {sourceHref(l.sourceType, l.sourceId, l.sourceNumber) ? (
                      <Link className="hover:underline" href={sourceHref(l.sourceType, l.sourceId, l.sourceNumber)!}>
                        {l.sourceNumber}
                      </Link>
                    ) : (
                      humanize(l.sourceType)
                    )}
                    {l.partyName && ` · ${l.partyName}`}
                  </div>
                </td>
                <td className="px-4 py-2 text-right">{Number(l.debit) ? <Money value={l.debit} /> : ""}</td>
                <td className="px-4 py-2 text-right">{Number(l.credit) ? <Money value={l.credit} /> : ""}</td>
                <td className="px-4 py-2 text-right">
                  <Money value={l.balance} />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-border font-semibold">
              <td className="px-4 py-2" colSpan={5}>
                Closing balance
              </td>
              <td className="px-4 py-2 text-right">
                <Money value={ledger.closingBalance} />
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </Card>
  );
}
