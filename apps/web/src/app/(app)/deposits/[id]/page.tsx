"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { use, useState } from "react";
import { LedgerImpact } from "@/components/ledger-impact";
import { Button, ButtonLink } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, FormError, Input } from "@/components/ui/inputs";
import { Card, CardHeader, DescriptionList, ErrorState, LoadingRows, Money, PageHeader, StatusBadge } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import type { DepositDetail } from "@/lib/deposits";
import { date, todayIso } from "@/lib/format";
import { useCan } from "@/lib/session";
import { ReceiptTable } from "../receipt-table";

export default function DepositPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const canPost = useCan("bank.reconcile");
  const queries = useQueryClient();
  const toast = useToast();
  const [voiding, setVoiding] = useState(false);
  const [voidDate, setVoidDate] = useState("");
  const [reason, setReason] = useState("");
  const detail = useQuery({ queryKey: ["deposits", "detail", id], queryFn: () => api<DepositDetail>(`/deposits/${id}`) });
  const reverse = useMutation({
    mutationFn: () => api(`/deposits/${id}/void`, { method: "POST", body: { date: voidDate, reason: reason.trim() } }),
    onSuccess: async () => {
      await queries.invalidateQueries();
      setVoiding(false);
      toast.success("Deposit voided.");
    },
    onError: () => { void detail.refetch(); },
  });
  if (detail.error) return <ErrorState error={detail.error} retry={() => detail.refetch()} />;
  if (!detail.data) return <LoadingRows />;
  const d = detail.data;
  const statementLink = d.matchedStatementId ? `/bank-reconciliations/${d.matchedStatementId}` : null;
  const openingLink = d.baselineStatementId ? `/bank-reconciliations/${d.baselineStatementId}` : null;
  return <>
    <PageHeader title={`Deposit ${d.number}`} breadcrumb={<Link href="/deposits" className="hover:underline">Bank Deposits</Link>}
      description={`${date(d.date)} · ${d.bankAccountNumber} ${d.bankAccountName}`}
      actions={<>
        <StatusBadge status={d.status} />
        {d.status === "posted" && <ButtonLink variant="secondary" href={statementLink ?? openingLink ?? "/bank-reconciliations"}>
          {statementLink ? "View matched statement" : openingLink ? "View opening statement" : "Bank reconciliation"}
        </ButtonLink>}
        {canPost && d.status === "posted" && !statementLink && !openingLink && <Button variant="secondary" onClick={() => {
          reverse.reset();
          setVoidDate(todayIso() < d.date ? d.date : todayIso());
          setReason("");
          setVoiding(true);
        }}>Void deposit</Button>}
      </>} />
    <div className="space-y-5">
      <Card className="space-y-3 p-4">
        <DescriptionList items={[
          { label: "Deposit total", value: <Money value={d.total} strong /> },
          { label: "Receipts", value: d.receipts.length },
          ...(d.voidDate ? [{ label: "Reversal date", value: date(d.voidDate) }, { label: "Reason", value: d.voidReason }] : []),
        ]} />
        {d.memo && <p className="break-words text-sm text-muted">{d.memo}</p>}
        {canPost && statementLink && <p className="text-sm text-muted">Remove the bank statement match before voiding this deposit.</p>}
        {d.status === "posted" && openingLink && !statementLink && <p className="text-sm text-muted">
          This deposit is included in the approved opening balance. An owner or administrator can reopen the opening statement before correcting the deposit.
        </p>}
      </Card>
      <Card><CardHeader title="Included receipts" /><ReceiptTable receipts={d.receipts} /></Card>
      <LedgerImpact entryId={d.journalEntryId} />
      {d.voidJournalEntryId && <LedgerImpact entryId={d.voidJournalEntryId} title="Reversing journal entry" />}
    </div>
    {voiding && <Dialog open title="Void bank deposit" description="Post a reversing journal entry and release these receipts for a corrected deposit from the reversal date."
      onOpenChange={(open) => { if (!open && !reverse.isPending) setVoiding(false); }}>
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (reason.trim()) reverse.mutate(); }}>
        <FormError message={reverse.error?.message} />
        <Field label="Reversal date" required>{(p) => <Input {...p} type="date" min={d.date} value={voidDate} onChange={(e) => setVoidDate(e.target.value)} />}</Field>
        <Field label="Reason for void" required>{(p) => <Input {...p} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" disabled={reverse.isPending} onClick={() => setVoiding(false)}>Cancel</Button>
          <Button type="submit" variant="danger" loading={reverse.isPending} disabled={!voidDate || !reason.trim()}>Confirm void</Button>
        </div>
      </form>
    </Dialog>}
  </>;
}
