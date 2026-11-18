"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Wallet } from "lucide-react";
import Link from "next/link";
import { use, useState } from "react";
import { LedgerImpact } from "@/components/ledger-impact";
import { Button, ButtonLink } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/inputs";
import { Card, CardHeader, DescriptionList, ErrorState, LoadingRows, Money, PageHeader, StatusBadge } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { date, money, quantity, todayIso } from "@/lib/format";
import { useCan } from "@/lib/session";

type Bill = {
  id: string;
  number: string;
  vendorId: string;
  vendorName: string;
  vendorReference: string;
  purchaseOrderId: string | null;
  purchaseOrderNumber: string | null;
  billDate: string;
  dueDate: string;
  status: string;
  memo: string | null;
  total: string;
  amountPaid: string;
  balanceDue: string;
  journalEntryId: string;
  voidJournalEntryId: string | null;
  lines: { lineNo: number; purchaseOrderLineId: string | null; sku: string | null; quantity: string | null; unitCost: string | null; account: string | null; description: string | null; amount: string }[];
  payments: { paymentId: string; number: string; date: string; method: string; amount: string }[];
};

export default function BillPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const qc = useQueryClient();
  const toast = useToast();
  const canPost = useCan("bills.post");
  const canPay = useCan("bills.pay");
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState("");
  const q = useQuery({ queryKey: ["bills", id], queryFn: () => api<Bill>(`/bills/${id}`) });
  const voidMut = useMutation({
    mutationFn: () => api(`/bills/${id}/void`, { method: "POST", body: { date: todayIso(), reason: reason || null } }),
    onSuccess: () => {
      qc.invalidateQueries();
      setVoiding(false);
      toast.success("Bill voided. A reversing entry was posted.");
    },
    onError: (e) => toast.error(e.message),
  });
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  if (!q.data) return <LoadingRows />;
  const b = q.data;
  const unpaid = b.status === "open" || b.status === "partially_paid";
  const overdue = unpaid && b.dueDate < todayIso();

  return (
    <>
      <PageHeader
        breadcrumb={<Link href="/bills" className="hover:underline">Bills</Link>}
        title={
          <span className="flex items-center gap-3">
            Bill {b.number} <StatusBadge status={b.status} overdue={overdue} />
          </span>
        }
        description={
          <>
            <Link href={`/vendors/${b.vendorId}`} className="hover:underline">
              {b.vendorName}
            </Link>{" "}
            · vendor invoice {b.vendorReference}
          </>
        }
        actions={
          <>
            {canPost && b.status === "open" && Number(b.amountPaid) === 0 && (
              <Button variant="secondary" onClick={() => setVoiding(true)}>
                <Ban /> Void
              </Button>
            )}
            {canPay && unpaid && (
              <ButtonLink href={`/bill-payments/new?vendorId=${b.vendorId}&billId=${b.id}`}>
                <Wallet /> Pay bill
              </ButtonLink>
            )}
          </>
        }
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <Card>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted">
                  <th className="px-4 py-2 font-medium">Line</th>
                  <th className="px-4 py-2 text-right font-medium">Qty × cost</th>
                  <th className="px-4 py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {b.lines.map((l) => (
                  <tr key={l.lineNo} className="border-b border-border last:border-0">
                    <td className="px-4 py-2">
                      <div className="font-medium">{l.description ?? l.account}</div>
                      <div className="text-xs text-muted">{l.purchaseOrderLineId ? <span className="font-mono">{l.sku}</span> : l.account}</div>
                    </td>
                    <td className="px-4 py-2 text-right tabular text-muted">{l.quantity ? `${quantity(l.quantity)} × ${money(l.unitCost)}` : "—"}</td>
                    <td className="px-4 py-2 text-right">
                      <Money value={l.amount} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <dl className="ml-auto max-w-xs space-y-1.5 border-t border-border p-4 text-sm">
              <div className="flex justify-between font-semibold">
                <dt>Total</dt>
                <dd>
                  <Money value={b.total} />
                </dd>
              </div>
              <div className="flex justify-between text-muted">
                <dt>Paid</dt>
                <dd>
                  <Money value={b.amountPaid} />
                </dd>
              </div>
              <div className="flex justify-between font-semibold">
                <dt>Balance due</dt>
                <dd>{b.status === "void" ? "—" : <Money value={b.balanceDue} />}</dd>
              </div>
            </dl>
          </Card>
          <LedgerImpact entryId={b.journalEntryId} />
          {b.voidJournalEntryId && <LedgerImpact entryId={b.voidJournalEntryId} title="Void (reversing entry)" />}
        </div>
        <div className="flex flex-col gap-6">
          <Card className="p-4">
            <DescriptionList
              items={[
                { label: "Bill date", value: date(b.billDate) },
                { label: "Due date", value: <span className={overdue ? "text-danger" : ""}>{date(b.dueDate)}</span> },
                { label: "Purchase order", value: b.purchaseOrderId ? <Link className="text-accent hover:underline" href={`/purchase-orders/${b.purchaseOrderId}`}>{b.purchaseOrderNumber}</Link> : "None" },
              ]}
            />
            {b.memo && <p className="mt-3 border-t border-border pt-3 text-sm text-muted">{b.memo}</p>}
          </Card>
          <Card>
            <CardHeader title="Payments" />
            {b.payments.length === 0 ? (
              <p className="px-4 py-4 text-sm text-muted">Not paid yet.</p>
            ) : (
              <ul className="divide-y divide-border text-sm">
                {b.payments.map((p) => (
                  <li key={p.paymentId} className="flex justify-between gap-2 px-4 py-2">
                    <span>
                      <Link className="font-medium text-accent hover:underline" href={`/bill-payments/${p.paymentId}`}>
                        {p.number}
                      </Link>{" "}
                      <span className="text-xs text-muted">
                        {date(p.date)} · {p.method.toUpperCase()}
                      </span>
                    </span>
                    <Money value={p.amount} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
      <Dialog
        open={voiding}
        onOpenChange={setVoiding}
        title={`Void bill ${b.number}?`}
        description="Posts a reversing entry dated today. Any purchase order lines on it can be billed again."
        footer={
          <>
            <Button variant="secondary" onClick={() => setVoiding(false)}>
              Keep bill
            </Button>
            <Button variant="danger" onClick={() => voidMut.mutate()} loading={voidMut.isPending}>
              Void bill
            </Button>
          </>
        }
      >
        <Field label="Reason (optional)">{(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
      </Dialog>
    </>
  );
}
