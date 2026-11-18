"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, ButtonLink } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, FormError, Input, Select } from "@/components/ui/inputs";
import { Card, CardHeader, EmptyState, ErrorState, LoadingRows, Money, PageHeader } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { api, ApiError, newIdempotencyKey } from "@/lib/api";
import { format2, parse } from "@/lib/decimal";
import type { Deposit, DepositReceipt } from "@/lib/deposits";
import { date, money, todayIso } from "@/lib/format";
import { useMe } from "@/lib/session";
import { ReceiptTable } from "../receipt-table";

type Account = { id: string; number: string; name: string; type: string; subtype: string; isActive: boolean };
type Review = { bank: Account; date: string; memo: string; receipts: DepositReceipt[]; total: string };

export default function NewDeposit() {
  const router = useRouter();
  const queries = useQueryClient();
  const toast = useToast();
  const session = useMe();
  const canPost = session.data?.permissions.includes("bank.reconcile") ?? false;
  const [bankId, setBankId] = useState("");
  const [depositDate, setDate] = useState(todayIso);
  const [memo, setMemo] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [review, setReview] = useState<Review | null>(null);
  const [key] = useState(newIdempotencyKey);
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: () => api<{ data: Account[] }>("/accounts"), enabled: canPost });
  const eligible = useQuery({
    queryKey: ["deposits", "eligible", depositDate],
    queryFn: () => api<{ data: DepositReceipt[] }>(`/deposits/eligible?asOf=${encodeURIComponent(depositDate)}`),
    enabled: canPost && !!depositDate,
  });
  const banks = accounts.data?.data.filter((a) => a.isActive && a.type === "asset" && a.subtype === "bank") ?? [];
  const bank = banks.find((a) => a.id === bankId);
  const chosen = eligible.data?.data.filter((r) => selected.has(r.id)) ?? [];
  const total = format2(chosen.reduce((n, r) => n + (parse(r.amount) ?? 0n), 0n));
  const post = useMutation({
    mutationFn: (draft: Review) => api<Deposit>("/deposits", {
      method: "POST", headers: { "idempotency-key": key },
      body: { bankAccountId: draft.bank.id, date: draft.date, memo: draft.memo || undefined, paymentIds: draft.receipts.map((r) => r.id) },
    }),
    onSuccess: (document) => {
      void queries.invalidateQueries();
      toast.success(`Deposit ${document.number} posted.`);
      router.replace(`/deposits/${document.id}`);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
        setReview(null);
        void eligible.refetch();
      }
    },
  });
  if (session.isPending) return <LoadingRows />;
  if (session.error) return <ErrorState error={session.error} retry={() => session.refetch()} />;
  if (!canPost) return <EmptyState title="Bank posting permission is required" action={<ButtonLink href="/deposits" variant="secondary">View deposits</ButtonLink>} />;
  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }
  return <>
    <PageHeader title="New bank deposit" breadcrumb={<Link href="/deposits" className="hover:underline">Bank Deposits</Link>} />
    <div className="space-y-5">
      <FormError message={!review ? post.error?.message : null} />
      <Card className="p-4">
        {accounts.error && <ErrorState error={accounts.error} retry={() => accounts.refetch()} />}
        <form id="deposit-details" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" onSubmit={(event) => {
          event.preventDefault();
          if (bank && chosen.length > 0 && chosen.length <= 500 && !eligible.isFetching && !eligible.error) {
            post.reset();
            setReview({ bank, date: depositDate, memo: memo.trim(), receipts: chosen, total });
          }
        }}>
          <Field label="Deposit to" required>{(p) => <Select {...p} value={bankId} onChange={(e) => setBankId(e.target.value)}>
            <option value="">{accounts.isPending ? "Loading accounts…" : banks.length ? "Choose a bank account…" : "No active bank accounts"}</option>
            {banks.map((a) => <option key={a.id} value={a.id}>{a.number} {a.name}</option>)}
          </Select>}</Field>
          <Field label="Deposit date" required>{(p) => <Input {...p} type="date" value={depositDate} onChange={(e) => { setDate(e.target.value); setSelected(new Set()); }} />}</Field>
          <Field label="Memo">{(p) => <Input {...p} value={memo} maxLength={500} onChange={(e) => setMemo(e.target.value)} />}</Field>
        </form>
      </Card>
      <Card>
        <CardHeader title="Receipts in Undeposited Funds" description="Select the payments included on the bank deposit slip." />
        {!depositDate ? <EmptyState title="Choose a deposit date" /> : eligible.error ? <ErrorState error={eligible.error} retry={() => eligible.refetch()} />
          : !eligible.data ? <LoadingRows /> : eligible.data.data.length === 0 ? <EmptyState title="No available receipts on this date" />
          : <ReceiptTable receipts={eligible.data.data} selected={selected} onToggle={toggle} />}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border p-4" aria-live="polite">
          <span className="text-sm text-muted">{chosen.length} selected</span>
          <span className="font-semibold">Deposit total <Money value={total} /></span>
        </div>
      </Card>
      {chosen.length > 500 && <FormError message="A deposit can include up to 500 receipts." />}
      <div className="flex justify-end gap-2">
        <ButtonLink variant="secondary" href="/deposits">Cancel</ButtonLink>
        <Button type="submit" form="deposit-details" disabled={!bank || !chosen.length || chosen.length > 500 || eligible.isFetching || !!eligible.error}>Review deposit</Button>
      </div>
    </div>
    {review && <Dialog open title="Review bank deposit" description={`${money(review.total)} to ${review.bank.number} ${review.bank.name} on ${date(review.date)}.`}
      onOpenChange={(open) => { if (!open && !post.isPending && !post.isSuccess) setReview(null); }}
      footer={<>
        <Button variant="secondary" disabled={post.isPending || post.isSuccess} onClick={() => setReview(null)}>Back to edit</Button>
        <Button loading={post.isPending} disabled={post.isSuccess} onClick={() => post.mutate(review)}>{post.error ? "Retry posting" : "Post deposit"}</Button>
      </>}>
      {post.error && <FormError message={`Posting could not be confirmed. Retry this deposit to retrieve the result safely. ${post.error.message}`} />}
      <ul className="divide-y divide-border text-sm">
        {review.receipts.map((r) => <li key={r.id} className="flex items-start justify-between gap-3 py-2">
          <span>{r.number} · {r.customerName}</span><Money value={r.amount} />
        </li>)}
      </ul>
      {review.memo && <p className="mt-3 break-words text-sm text-muted">{review.memo}</p>}
    </Dialog>}
  </>;
}
