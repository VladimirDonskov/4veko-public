"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, CreditCard, Printer } from "lucide-react";
import Link from "next/link";
import { use, useState } from "react";
import { DocumentLines } from "@/components/document-lines";
import { LedgerImpact } from "@/components/ledger-impact";
import { Button, ButtonLink } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/inputs";
import { Card, DescriptionList, ErrorState, LoadingRows, Money, PageHeader, StatusBadge } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { date, todayIso } from "@/lib/format";
import { useCan } from "@/lib/session";

type Invoice = {
  id: string;
  number: string;
  status: string;
  customerId: string;
  customerName: string;
  customerEmail: string | null;
  salesOrderId: string | null;
  salesOrderNumber: string | null;
  issueDate: string;
  dueDate: string;
  memo: string | null;
  taxRate: string;
  subtotal: string;
  taxTotal: string;
  total: string;
  amountPaid: string;
  balanceDue: string;
  journalEntryId: string;
  voidJournalEntryId: string | null;
  lines: { lineNo: number; itemId: string; sku: string; description: string | null; quantity: string; unitPrice: string; discountPct: string; amount: string; taxable: boolean }[];
  payments: { paymentId: string; number: string; date: string; method: string; amount: string }[];
};

export default function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const qc = useQueryClient();
  const toast = useToast();
  const canPay = useCan("payments.write");
  const canVoid = useCan("invoice.void");
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState("");
  const q = useQuery({ queryKey: ["invoices", id], queryFn: () => api<Invoice>(`/invoices/${id}`) });
  const voidMut = useMutation({
    mutationFn: () => api(`/invoices/${id}/void`, { method: "POST", body: { date: todayIso(), reason: reason || null } }),
    onSuccess: () => {
      qc.invalidateQueries();
      setVoiding(false);
      toast.success("Invoice voided. A reversing entry was posted and stock returned.");
    },
    onError: (e) => toast.error(e.message),
  });

  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  if (!q.data) return <LoadingRows />;
  const inv = q.data;
  const overdue = (inv.status === "open" || inv.status === "partially_paid") && inv.dueDate < todayIso();
  const unpaid = inv.status === "open" || inv.status === "partially_paid";

  return (
    <>
      <PageHeader
        breadcrumb={<Link href="/invoices" className="hover:underline">Invoices</Link>}
        title={
          <span className="flex items-center gap-3">
            Invoice {inv.number} <StatusBadge status={inv.status} overdue={overdue} />
          </span>
        }
        description={
          <Link href={`/customers/${inv.customerId}`} className="hover:underline">
            {inv.customerName}
          </Link>
        }
        actions={
          <>
            <Button variant="ghost" onClick={() => window.print()}>
              <Printer /> Print
            </Button>
            {canVoid && inv.status === "open" && Number(inv.amountPaid) === 0 && (
              <Button variant="secondary" onClick={() => setVoiding(true)}>
                <Ban /> Void
              </Button>
            )}
            {canPay && unpaid && (
              <ButtonLink href={`/payments/new?customerId=${inv.customerId}&invoiceId=${inv.id}`}>
                <CreditCard /> Record payment
              </ButtonLink>
            )}
          </>
        }
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <DocumentLines
            lines={inv.lines}
            subtotal={inv.subtotal}
            taxTotal={inv.taxTotal}
            taxRate={inv.taxRate}
            total={inv.total}
            after={
              <>
                <div className="flex justify-between text-muted">
                  <dt>Paid</dt>
                  <dd>
                    <Money value={inv.amountPaid} />
                  </dd>
                </div>
                <div className="flex justify-between font-semibold">
                  <dt>Balance due</dt>
                  <dd>{inv.status === "void" ? "—" : <Money value={inv.balanceDue} />}</dd>
                </div>
              </>
            }
          />
          <div className="print:hidden">
            <LedgerImpact entryId={inv.journalEntryId} />
          </div>
          {inv.voidJournalEntryId && (
            <div className="print:hidden">
              <LedgerImpact entryId={inv.voidJournalEntryId} title="Void (reversing entry)" />
            </div>
          )}
        </div>
        <div className="flex flex-col gap-6">
          <Card className="p-4">
            <DescriptionList
              items={[
                { label: "Invoice date", value: date(inv.issueDate) },
                { label: "Due date", value: <span className={overdue ? "text-danger" : ""}>{date(inv.dueDate)}</span> },
                { label: "Sales order", value: inv.salesOrderId ? <Link className="text-accent hover:underline" href={`/sales-orders/${inv.salesOrderId}`}>{inv.salesOrderNumber}</Link> : "None" },
                { label: "Email", value: inv.customerEmail },
              ]}
            />
            {inv.memo && <p className="mt-3 border-t border-border pt-3 text-sm text-muted">{inv.memo}</p>}
          </Card>
          <Card className="p-4 print:hidden">
            <p className="mb-2 text-xs font-medium text-muted">Payments</p>
            {inv.payments.length === 0 ? (
              <p className="text-sm text-muted">No payments yet.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {inv.payments.map((p) => (
                  <li key={p.paymentId} className="flex justify-between gap-2">
                    <span>
                      <Link className="font-medium text-accent hover:underline" href={`/payments/${p.paymentId}`}>
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
        title={`Void invoice ${inv.number}?`}
        description="4VEKO posts a reversing entry dated today and returns any stock at its original cost. The invoice stays on record as void."
        footer={
          <>
            <Button variant="secondary" onClick={() => setVoiding(false)}>
              Keep invoice
            </Button>
            <Button variant="danger" onClick={() => voidMut.mutate()} loading={voidMut.isPending}>
              Void invoice
            </Button>
          </>
        }
      >
        <Field label="Reason (optional)">{(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
      </Dialog>
    </>
  );
}
