"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FormError, Input, Select } from "@/components/ui/inputs";
import { Card, PageHeader } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { api, ApiError } from "@/lib/api";
import { format2, parse } from "@/lib/decimal";
import { money, todayIso } from "@/lib/format";

type Account = { id: string; number: string; name: string };
type Line = { accountId: string; debit: string; credit: string; description: string };
const blank = (): Line => ({ accountId: "", debit: "", credit: "", description: "" });

export default function NewJournalEntryPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: () => api<{ data: Account[] }>("/accounts") });
  const [entryDate, setEntryDate] = useState(todayIso());
  const [memo, setMemo] = useState("");
  const [lines, setLines] = useState<Line[]>([blank(), blank()]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const totalDebit = lines.reduce((a, l) => a + (parse(l.debit) ?? 0n), 0n);
  const totalCredit = lines.reduce((a, l) => a + (parse(l.credit) ?? 0n), 0n);
  const difference = totalDebit - totalCredit;

  function set(i: number, patch: Partial<Line>) {
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (difference !== 0n) return setError("Debits and credits must be equal before you can post.");
    setSaving(true);
    try {
      const entry = await api<{ id: string; number: number }>("/journal-entries", {
        method: "POST",
        body: {
          date: entryDate,
          memo: memo || null,
          lines: lines.filter((l) => l.accountId && (l.debit || l.credit)).map((l) => ({ accountId: l.accountId, debit: l.debit || undefined, credit: l.credit || undefined, description: l.description || null })),
        },
      });
      qc.invalidateQueries();
      toast.success(`Journal entry #${entry.number} posted.`);
      router.push(`/journal/${entry.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not post the entry.");
      setSaving(false);
    }
  }

  return (
    <>
      <PageHeader breadcrumb={<Link href="/journal" className="hover:underline">Journal Entries</Link>} title="New journal entry" description="Posted entries cannot be edited. To correct one, reverse it." />
      <form onSubmit={submit} className="flex flex-col gap-6">
        <FormError message={error} />
        <Card className="grid gap-4 p-4 sm:grid-cols-3">
          <Field label="Date" required>
            {(p) => <Input {...p} type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} />}
          </Field>
          <Field label="Memo" className="sm:col-span-2">
            {(p) => <Input {...p} value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="What is this entry for?" />}
          </Field>
        </Card>
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted">
                  <th className="w-[38%] px-3 py-2 font-medium">Account</th>
                  <th className="px-3 py-2 font-medium">Description</th>
                  <th className="w-32 px-3 py-2 text-right font-medium">Debit</th>
                  <th className="w-32 px-3 py-2 text-right font-medium">Credit</th>
                  <th className="w-10" />
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i} className="border-b border-border last:border-0">
                    <td className="px-3 py-2">
                      <Select value={l.accountId} onChange={(e) => set(i, { accountId: e.target.value })} aria-label={`Line ${i + 1} account`}>
                        <option value="">Choose an account…</option>
                        {accounts.data?.data.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.number} {a.name}
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td className="px-3 py-2">
                      <Input value={l.description} onChange={(e) => set(i, { description: e.target.value })} aria-label={`Line ${i + 1} description`} />
                    </td>
                    <td className="px-3 py-2">
                      <Input value={l.debit} onChange={(e) => set(i, { debit: e.target.value, credit: e.target.value ? "" : l.credit })} inputMode="decimal" className="text-right" aria-label={`Line ${i + 1} debit`} />
                    </td>
                    <td className="px-3 py-2">
                      <Input value={l.credit} onChange={(e) => set(i, { credit: e.target.value, debit: e.target.value ? "" : l.debit })} inputMode="decimal" className="text-right" aria-label={`Line ${i + 1} credit`} />
                    </td>
                    <td className="px-1">
                      <Button variant="ghost" size="icon" aria-label={`Remove line ${i + 1}`} onClick={() => setLines((ls) => (ls.length > 2 ? ls.filter((_, j) => j !== i) : ls))}>
                        <Trash2 />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-border font-semibold">
                  <td className="px-3 py-2" colSpan={2}>
                    <Button variant="secondary" size="sm" onClick={() => setLines((ls) => [...ls, blank()])}>
                      <Plus /> Add line
                    </Button>
                  </td>
                  <td className="px-3 py-2 text-right tabular">{money(format2(totalDebit))}</td>
                  <td className="px-3 py-2 text-right tabular">{money(format2(totalCredit))}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
          <div className={`border-t border-border px-4 py-2 text-right text-sm ${difference === 0n ? "text-success" : "text-danger"}`} role="status">
            {difference === 0n ? (totalDebit > 0n ? "Balanced" : "Enter amounts") : `Out of balance by ${money(format2(difference < 0n ? -difference : difference))}`}
          </div>
        </Card>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => router.back()}>
            Cancel
          </Button>
          <Button type="submit" loading={saving} disabled={difference !== 0n || totalDebit === 0n}>
            Post entry
          </Button>
        </div>
      </form>
    </>
  );
}
