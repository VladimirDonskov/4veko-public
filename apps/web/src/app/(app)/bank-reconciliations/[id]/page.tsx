"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, FormError, Select } from "@/components/ui/inputs";
import { Card, CardHeader, EmptyState, ErrorState, LoadingRows, Money, PageHeader, StatusBadge } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import type { Reconciliation, ReconciliationSummary, StatementLine } from "@/lib/bank-reconciliation";
import { date, dateTime, money } from "@/lib/format";
import { useCan } from "@/lib/session";

function Records<T extends { id: string }>({ rows, headings, render, empty, label }: {
  rows: T[]; headings: string[]; render: (row: T) => ReactNode; empty: string; label: string;
}) {
  const [page, setPage] = useState(0);
  const pageSize = 25;
  const lastPage = Math.max(0, Math.ceil(rows.length / pageSize) - 1);
  const active = Math.min(page, lastPage);
  if (!rows.length) return <EmptyState title={empty} />;
  return (
    <>
      <div className="overflow-x-auto">
        <table aria-label={label} className="w-full text-left text-sm">
          <thead><tr className="border-b border-border text-xs text-muted">
            {headings.map((heading) => <th scope="col" className="px-3 py-2 font-medium" key={heading}>{heading}</th>)}
          </tr></thead>
          <tbody>{rows.slice(active * pageSize, (active + 1) * pageSize).map((row) => (
            <tr key={row.id} className="border-b border-border last:border-0 [&>td]:px-3 [&>td]:py-2">{render(row)}</tr>
          ))}</tbody>
        </table>
      </div>
      {lastPage > 0 && <nav aria-label={`${label} pages`} className="flex items-center justify-end gap-3 border-t border-border p-2 text-sm">
        <Button variant="secondary" size="sm" disabled={active === 0} onClick={() => setPage(active - 1)}>Previous</Button>
        {active + 1} of {lastPage + 1}
        <Button variant="secondary" size="sm" disabled={active === lastPage} onClick={() => setPage(active + 1)}>Next</Button>
      </nav>}
    </>
  );
}

type Action = { path: string; label: string; body?: { journalLineId: string } | { expectedJournalLineId: string }; discard?: boolean };

function ApprovalChanges({ data }: { data: Reconciliation }) {
  const { statement, closedSummary, summary } = data;
  if (!closedSummary || !statement.closedAt) return null;
  const labels: Record<keyof ReconciliationSummary, string> = {
    bookBalance: "Ledger balance", outstandingAmount: "Outstanding amount", adjustedBankBalance: "Adjusted bank balance",
    difference: "Reconciliation difference", statementDifference: "Statement arithmetic difference",
    unmatchedCount: "Unmatched transactions", outstandingCount: "Outstanding postings",
  };
  const changed = (Object.keys(labels) as (keyof ReconciliationSummary)[]).filter((key) => closedSummary[key] !== summary[key]);
  if (!changed.length) return null;
  const display = (value: string | number) => typeof value === "number" ? value : money(value);
  return (
    <section aria-label="Changes since close">
      <Card>
        <CardHeader title="Changes since close" description={`Closed ${dateTime(statement.closedAt)}. These figures have changed for the statement period since approval.`} />
        <div className="overflow-x-auto">
          <table aria-label="Comparison with approved figures" className="w-full text-left text-sm">
            <thead className="border-b border-border text-xs text-muted"><tr>
              {["Figure", "At close", "Current"].map((label) => <th key={label} scope="col" className="px-3 py-2">{label}</th>)}
            </tr></thead>
            <tbody>{changed.map((key) => <tr key={key} className="border-b border-border last:border-0">
              <th scope="row" className="px-3 py-2 font-medium">{labels[key]}</th>
              <td className="tabular px-3 py-2">{display(closedSummary[key])}</td><td className="tabular px-3 py-2">{display(summary[key])}</td>
            </tr>)}</tbody>
          </table>
        </div>
        <Link className="inline-block px-3 py-3 text-sm text-accent underline" href={`/accounts/${statement.accountId}?to=${statement.endDate}`}>Review dated ledger entries</Link>
      </Card>
    </section>
  );
}

export default function StatementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const base = `/bank-reconciliations/${id}`;
  const canEdit = useCan("bank.reconcile");
  const canReopen = useCan("bank.reopen");
  const queries = useQueryClient();
  const router = useRouter();
  const toast = useToast();
  const [matching, setMatching] = useState<StatementLine | null>(null);
  const [postingId, setPostingId] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const detail = useQuery({ queryKey: ["bank-reconciliations", id], queryFn: () => api<Reconciliation>(base) });
  const change = useMutation({
    mutationFn: (action: Action) => api(base + action.path, { method: action.discard ? "DELETE" : "POST", body: action.body }),
    onSuccess: async (_, action) => {
      toast.success(action.label);
      setMatching(null);
      setConfirmDiscard(false);
      if (action.discard) {
        await queries.invalidateQueries({ queryKey: ["bank-reconciliations"], exact: true });
        router.replace("/bank-reconciliations");
      } else await queries.invalidateQueries({ queryKey: ["bank-reconciliations"] });
    },
    onError: () => { void detail.refetch(); },
  });
  if (detail.error) return <ErrorState error={detail.error} retry={() => detail.refetch()} />;
  if (!detail.data) return <LoadingRows />;
  const { statement, summary, lines, candidates } = detail.data;
  const open = statement.status === "open";
  const choices = matching ? candidates.filter((row) => !row.matchedLater && !row.depositVoidedOn && row.amount === matching.amount) : [];
  const ledgerLink = (entryId: string, number: number, lineNo: number | null) => (
    <Link className="inline-block py-1 text-accent underline" href={`/journal/${entryId}`}>Entry #{number}{lineNo !== null && `, line ${lineNo}`}</Link>
  );
  const error = change.error?.message;
  const closeHint = summary.unmatchedCount > 0 ? `Match ${summary.unmatchedCount} remaining statement line(s) before closing.`
    : summary.difference !== "0.00" || summary.statementDifference !== "0.00" ? "Resolve the balance difference before closing."
    : !detail.data.canClose ? "Close preceding statements first." : null;

  return (
    <>
      <PageHeader title={statement.externalId}
        breadcrumb={<Link className="hover:underline" href="/bank-reconciliations">Bank Reconciliation</Link>}
        description={<>{statement.accountNumber} {statement.accountName} · {date(statement.startDate)} – {date(statement.endDate)}</>}
        actions={<>
          <StatusBadge status={statement.status} />
          {canEdit && detail.data.canDiscard && <Button variant="secondary" disabled={change.isPending}
            onClick={() => { change.reset(); setConfirmDiscard(true); }}>Discard import</Button>}
          {open && canEdit && <Button disabled={!detail.data.canClose || change.isPending}
            onClick={() => change.mutate({ path: "/close", label: "Statement closed." })}>Close statement</Button>}
          {!open && canReopen && <Button variant="secondary" disabled={!detail.data.canReopen || change.isPending}
            onClick={() => change.mutate({ path: "/reopen", label: "Statement reopened." })}>Reopen statement</Button>}
        </>}
      />
      <div className="space-y-5">
        {!matching && !confirmDiscard && <FormError message={error} />}
        <ApprovalChanges data={detail.data} />
        <Card>
          <CardHeader title="Balance reconciliation" description={`The adjusted bank balance includes outstanding ledger postings through ${date(statement.endDate)}.`} />
          <dl className="grid grid-cols-2 gap-4 p-4 text-sm lg:grid-cols-5">
            {[
              ["Opening bank balance", statement.openingBalance], ["Closing bank balance", statement.closingBalance],
              ["Outstanding postings", summary.outstandingAmount], ["Adjusted bank balance", summary.adjustedBankBalance],
              ["Ledger balance", summary.bookBalance],
            ].map(([label, value]) => <div key={label}><dt className="text-xs text-muted">{label}</dt><dd className="mt-1"><Money value={value} /></dd></div>)}
          </dl>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3 text-sm">
            <strong>Ledger less adjusted bank balance</strong><Money strong value={summary.difference} />
          </div>
          {open && closeHint && <p className="px-4 pb-3 text-sm text-muted">{closeHint}</p>}
          {!open && canReopen && !detail.data.canReopen && <p className="px-4 pb-3 text-sm text-muted">Reopen later closed statements first.</p>}
        </Card>
        <Card>
          <CardHeader title="Statement transactions" description={`${lines.length - summary.unmatchedCount} of ${lines.length} matched`} />
          <Records rows={lines} label="Statement transactions" headings={["Bank transaction", "Date", "Amount", "Ledger match"]} empty="No transactions on this statement."
            render={(row) => <>
              <td><div className="font-medium">{row.externalId}</div><div className="max-w-md break-words text-muted">{row.description}</div></td>
              <td className="whitespace-nowrap">{date(row.date)}</td><td><Money value={row.amount} /></td>
              <td><div className="flex flex-wrap items-center gap-2">
                {row.entryId && row.entryNumber !== null ? ledgerLink(row.entryId, row.entryNumber, row.lineNo) : <span className="text-muted">Unmatched</span>}
                {open && canEdit && (row.journalLineId
                  ? <Button size="sm" variant="secondary" disabled={change.isPending}
                      onClick={() => change.mutate({ path: `/lines/${row.id}/unmatch`, body: { expectedJournalLineId: row.journalLineId! }, label: "Ledger match removed." })}>Unmatch</Button>
                  : <Button size="sm" variant="secondary" disabled={change.isPending}
                      onClick={() => { change.reset(); setMatching(row); setPostingId(""); }}>Match</Button>)}
              </div></td>
            </>} />
        </Card>
        <Card>
          <CardHeader title="Outstanding ledger postings" description={`${summary.outstandingCount} postings adjust the bank balance at the statement end date.`} />
          <Records rows={candidates} label="Outstanding ledger postings" headings={["Journal entry", "Date", "Description", "Amount"]} empty="No outstanding ledger postings."
            render={(row) => <>
              <td>{ledgerLink(row.entryId, row.entryNumber, row.lineNo)}{row.matchedLater && <p className="text-xs text-muted">Cleared on a later statement</p>}
                {row.depositVoidedOn && <p className="text-xs text-muted">Deposit voided on {date(row.depositVoidedOn)}</p>}</td>
              <td className="whitespace-nowrap">{date(row.date)}</td><td className="max-w-md break-words">{row.description}</td><td><Money value={row.amount} /></td>
            </>} />
        </Card>
      </div>
      {matching && <Dialog open onOpenChange={(value) => { if (!value && !change.isPending) setMatching(null); }} title="Match ledger posting"
        description={`${matching.externalId} · ${date(matching.date)} · ${money(matching.amount)}`}>
        <form className="space-y-4" onSubmit={(event) => {
          event.preventDefault();
          if (choices.some((row) => row.id === postingId)) change.mutate({ path: `/lines/${matching.id}/match`, body: { journalLineId: postingId }, label: "Statement transaction matched." });
        }}>
          <FormError message={error} />
          {choices.length === 0 ? <p className="text-sm">No available ledger posting matches this amount. Check the account, amount and posting date.</p>
            : <Field label="Ledger posting" required hint="Available postings have the same signed amount as this bank transaction.">
              {(props) => <Select {...props} value={postingId} onChange={(event) => setPostingId(event.target.value)}>
                <option value="">Choose a posting…</option>
                {choices.map((row) => <option key={row.id} value={row.id}>#{row.entryNumber}, line {row.lineNo} · {date(row.date)} · {row.description || money(row.amount)}</option>)}
              </Select>}
            </Field>}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" disabled={change.isPending} onClick={() => setMatching(null)}>Cancel</Button>
            <Button type="submit" loading={change.isPending} disabled={!choices.some((row) => row.id === postingId)}>Confirm match</Button>
          </div>
        </form>
      </Dialog>}
      {confirmDiscard && <Dialog open onOpenChange={(value) => { if (!value && !change.isPending) setConfirmDiscard(false); }} title="Discard statement import?"
        description={`Remove ${statement.externalId} and its imported lines. The posted ledger entries are kept. You can import a corrected statement afterward.`}
        footer={<>
          <Button variant="secondary" disabled={change.isPending} onClick={() => setConfirmDiscard(false)}>Cancel</Button>
          <Button variant="danger" loading={change.isPending} onClick={() => change.mutate({ path: "", discard: true, label: "Statement import discarded." })}>Discard statement</Button>
        </>}>
        <FormError message={error} />
      </Dialog>}
    </>
  );
}
