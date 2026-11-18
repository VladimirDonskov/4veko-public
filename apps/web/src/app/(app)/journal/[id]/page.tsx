"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Undo2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, FormError, Input } from "@/components/ui/inputs";
import { Badge, Card, DescriptionList, ErrorState, LoadingRows, Money, PageHeader } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { sourceHref } from "@/components/nav";
import { api, ApiError } from "@/lib/api";
import { format2, parse } from "@/lib/decimal";
import { date, dateTime, humanize, todayIso } from "@/lib/format";
import { useCan } from "@/lib/session";

type Entry = {
  id: string;
  number: number;
  date: string;
  memo: string | null;
  sourceType: string;
  sourceId: string | null;
  sourceNumber: string | null;
  reversalOfId: string | null;
  reversedById: string | null;
  createdByName: string | null;
  createdAt: string;
  lines: { lineNo: number; accountId: string; accountNumber: string; accountName: string; description: string | null; debit: string; credit: string; partyName: string | null }[];
};


export default function JournalEntryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const canPost = useCan("journal.post");
  const [reversing, setReversing] = useState(false);
  const [revDate, setRevDate] = useState(todayIso());
  const q = useQuery({ queryKey: ["journal", id], queryFn: () => api<Entry>(`/journal-entries/${id}`) });
  const reverse = useMutation({
    mutationFn: () => api<{ id: string; number: number }>(`/journal-entries/${id}/reverse`, { method: "POST", body: { date: revDate } }),
    onSuccess: (r) => {
      qc.invalidateQueries();
      toast.success(`Reversed with entry #${r.number}.`);
      router.push(`/journal/${r.id}`);
    },
  });
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  if (!q.data) return <LoadingRows />;
  const e = q.data;
  const totalD = format2(e.lines.reduce((sum, line) => sum + (parse(line.debit) ?? 0n), 0n));
  const totalC = format2(e.lines.reduce((sum, line) => sum + (parse(line.credit) ?? 0n), 0n));
  const reversible = (e.sourceType === "manual" || e.sourceType === "reversal") && !e.reversedById && !e.reversalOfId;

  return (
    <>
      <PageHeader
        breadcrumb={<Link href="/journal" className="hover:underline">Journal Entries</Link>}
        title={
          <span className="flex items-center gap-3">
            Journal entry #{e.number}
            {e.reversedById && <Badge tone="warning">Reversed</Badge>}
            {e.reversalOfId && <Badge>Reversal</Badge>}
          </span>
        }
        description={e.memo ?? undefined}
        actions={
          canPost &&
          reversible && (
            <Button variant="secondary" onClick={() => setReversing(true)}>
              <Undo2 /> Reverse
            </Button>
          )
        }
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted">
                  <th className="px-4 py-2 font-medium">Account</th>
                  <th className="hidden px-4 py-2 font-medium md:table-cell">Description</th>
                  <th className="px-4 py-2 text-right font-medium">Debit</th>
                  <th className="px-4 py-2 text-right font-medium">Credit</th>
                </tr>
              </thead>
              <tbody>
                {e.lines.map((l) => (
                  <tr key={l.lineNo} className="border-b border-border">
                    <td className="px-4 py-2">
                      <Link className="hover:underline" href={`/accounts/${l.accountId}`}>
                        <span className="font-mono text-xs text-muted">{l.accountNumber}</span> {l.accountName}
                      </Link>
                      {l.partyName && <div className="text-xs text-muted">{l.partyName}</div>}
                    </td>
                    <td className="hidden px-4 py-2 text-muted md:table-cell">{l.description}</td>
                    <td className="px-4 py-2 text-right">{Number(l.debit) ? <Money value={l.debit} /> : ""}</td>
                    <td className="px-4 py-2 text-right">{Number(l.credit) ? <Money value={l.credit} /> : ""}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="font-semibold">
                  <td className="px-4 py-2">Total</td>
                  <td className="hidden md:table-cell" />
                  <td className="px-4 py-2 text-right">
                    <Money value={totalD} />
                  </td>
                  <td className="px-4 py-2 text-right">
                    <Money value={totalC} />
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </Card>
        <Card className="p-4">
          <DescriptionList
            items={[
              { label: "Date", value: date(e.date) },
              {
                label: "Source",
                value:
                  sourceHref(e.sourceType, e.sourceId, e.sourceNumber) ? (
                    <Link className="text-accent hover:underline" href={sourceHref(e.sourceType, e.sourceId, e.sourceNumber)!}>
                      {humanize(e.sourceType)} {e.sourceNumber}
                    </Link>
                  ) : (
                    `${humanize(e.sourceType)} ${e.sourceNumber ?? ""}`
                  ),
              },
              { label: "Posted by", value: e.createdByName },
              { label: "Posted at", value: dateTime(e.createdAt) },
              { label: "Reversal of", value: e.reversalOfId ? <Link className="text-accent hover:underline" href={`/journal/${e.reversalOfId}`}>Original entry</Link> : null },
              { label: "Reversed by", value: e.reversedById ? <Link className="text-accent hover:underline" href={`/journal/${e.reversedById}`}>Reversing entry</Link> : null },
            ]}
          />
        </Card>
      </div>
      <Dialog
        open={reversing}
        onOpenChange={setReversing}
        title={`Reverse entry #${e.number}?`}
        description="4VEKO posts a new entry with every debit and credit swapped and links the two. The original stays in the ledger."
        footer={
          <>
            <Button variant="secondary" onClick={() => setReversing(false)}>
              Cancel
            </Button>
            <Button onClick={() => reverse.mutate()} loading={reverse.isPending}>
              Post reversal
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <FormError message={reverse.error instanceof ApiError ? reverse.error.message : null} />
          <Field label="Reversal date">{(p) => <Input {...p} type="date" value={revDate} onChange={(ev) => setRevDate(ev.target.value)} />}</Field>
        </div>
      </Dialog>
    </>
  );
}
