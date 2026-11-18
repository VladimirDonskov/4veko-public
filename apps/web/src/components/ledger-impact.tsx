"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Card, CardHeader, LoadingRows, Money } from "@/components/ui/misc";
import { api } from "@/lib/api";
import { date } from "@/lib/format";

type Entry = {
  id: string;
  number: number;
  date: string;
  memo: string | null;
  lines: { lineNo: number; accountId: string; accountNumber: string; accountName: string; debit: string; credit: string }[];
};

/** Shows the journal entry a document posted, so users see its accounting effect without leaving. */
export function LedgerImpact({ entryId, title = "General Ledger impact" }: { entryId: string; title?: string }) {
  const q = useQuery({ queryKey: ["journal", entryId], queryFn: () => api<Entry>(`/journal-entries/${entryId}`) });
  return (
    <Card>
      <CardHeader
        title={title}
        description={q.data ? `Entry #${q.data.number} · ${date(q.data.date)}` : undefined}
        action={
          <Link href={`/journal/${entryId}`} className="text-xs text-accent hover:underline">
            Open entry
          </Link>
        }
      />
      {!q.data ? (
        <LoadingRows rows={3} />
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted">
              <th className="px-4 py-2 font-medium">Account</th>
              <th className="px-4 py-2 text-right font-medium">Debit</th>
              <th className="px-4 py-2 text-right font-medium">Credit</th>
            </tr>
          </thead>
          <tbody>
            {q.data.lines.map((l) => (
              <tr key={l.lineNo} className="border-b border-border last:border-0">
                <td className="px-4 py-2">
                  <Link href={`/accounts/${l.accountId}`} className="hover:underline">
                    <span className="font-mono text-xs text-muted">{l.accountNumber}</span> {l.accountName}
                  </Link>
                </td>
                <td className="px-4 py-2 text-right">{Number(l.debit) ? <Money value={l.debit} /> : ""}</td>
                <td className="px-4 py-2 text-right">{Number(l.credit) ? <Money value={l.credit} /> : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
