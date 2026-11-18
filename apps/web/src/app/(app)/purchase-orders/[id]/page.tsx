"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PackageCheck, Pencil, Receipt } from "lucide-react";
import Link from "next/link";
import { Suspense, use, useState } from "react";
import { Button, ButtonLink } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, FormError, Input } from "@/components/ui/inputs";
import { Card, CardHeader, DescriptionList, ErrorState, LoadingRows, Money, PageHeader, StatusBadge } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { api, ApiError } from "@/lib/api";
import { subQty } from "@/lib/decimal";
import { date, money, quantity, todayIso } from "@/lib/format";
import { useCan } from "@/lib/session";
import { PoForm } from "../po-form";

type Po = {
  id: string;
  number: string;
  status: string;
  vendorId: string;
  vendorName: string;
  orderDate: string;
  expectedDate: string | null;
  memo: string | null;
  total: string;
  lines: { id: string; lineNo: number; itemId: string; sku: string; description: string | null; quantity: string; unitCost: string; amount: string; qtyReceived: string; qtyBilled: string }[];
  receipts: { id: string; number: string; date: string; total: string; journalEntryId: string | null }[];
  bills: { id: string; number: string; vendorReference: string; status: string; total: string }[];
};

function ReceiveDialog({ po, open, onOpenChange }: { po: Po; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const outstanding = po.lines.filter((l) => Number(l.quantity) > Number(l.qtyReceived));
  const [qty, setQty] = useState<Record<string, string>>(() => Object.fromEntries(outstanding.map((l) => [l.id, subQty(l.quantity, l.qtyReceived)])));
  const [receiveDate, setReceiveDate] = useState(todayIso());
  const receive = useMutation({
    mutationFn: () =>
      api<{ number: string }>(`/purchase-orders/${po.id}/receive`, {
        method: "POST",
        body: {
          date: receiveDate,
          lines: Object.entries(qty)
            .filter(([, v]) => Number(v) > 0)
            .map(([purchaseOrderLineId, quantity]) => ({ purchaseOrderLineId, quantity })),
        },
      }),
    onSuccess: (r) => {
      qc.invalidateQueries();
      toast.success(`Receipt ${r.number} posted. Stock updated.`);
      onOpenChange(false);
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Receive items on ${po.number}`}
      description="Adds the items to stock at the order cost. The cost waits in Received Not Billed until the vendor's bill arrives."
      wide
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => receive.mutate()} loading={receive.isPending}>
            Receive into stock
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <FormError message={receive.error instanceof ApiError ? receive.error.message : null} />
        <Field label="Date received">{(p) => <Input {...p} type="date" value={receiveDate} onChange={(e) => setReceiveDate(e.target.value)} className="w-48" />}</Field>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted">
              <th className="pb-1 font-medium">Item</th>
              <th className="pb-1 text-right font-medium">Outstanding</th>
              <th className="w-32 pb-1 text-right font-medium">Receiving now</th>
            </tr>
          </thead>
          <tbody>
            {outstanding.map((l) => (
              <tr key={l.id}>
                <td className="py-1.5">
                  <span className="font-mono text-xs text-muted">{l.sku}</span> {l.description}
                </td>
                <td className="py-1.5 text-right tabular">{quantity(subQty(l.quantity, l.qtyReceived))}</td>
                <td className="py-1.5 pl-3">
                  <Input aria-label={`Quantity received for ${l.sku}`} value={qty[l.id] ?? ""} onChange={(e) => setQty((q) => ({ ...q, [l.id]: e.target.value }))} inputMode="decimal" className="text-right" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Dialog>
  );
}

export default function PurchaseOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const qc = useQueryClient();
  const toast = useToast();
  const canWrite = useCan("purchasing.write");
  const canBill = useCan("bills.post");
  const [editing, setEditing] = useState(false);
  const [receiving, setReceiving] = useState(false);
  const q = useQuery({ queryKey: ["purchase-orders", id], queryFn: () => api<Po>(`/purchase-orders/${id}`) });
  const action = useMutation({
    mutationFn: (a: "issue" | "cancel" | "close") => api(`/purchase-orders/${id}/${a}`, { method: "POST" }),
    onSuccess: (_r, a) => {
      qc.invalidateQueries({ queryKey: ["purchase-orders"] });
      toast.success(a === "issue" ? "Purchase order issued." : a === "close" ? "Purchase order closed." : "Purchase order cancelled.");
    },
    onError: (e) => toast.error(e.message),
  });

  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  if (!q.data) return <LoadingRows />;
  const po = q.data;

  if (editing) {
    return (
      <>
        <PageHeader breadcrumb={<Link href={`/purchase-orders/${id}`} className="hover:underline">{po.number}</Link>} title={`Edit ${po.number}`} />
        <Suspense>
          <PoForm
            initial={{ vendorId: po.vendorId, orderDate: po.orderDate, expectedDate: po.expectedDate, memo: po.memo, lines: po.lines }}
            onSubmit={async (body) => {
              await api(`/purchase-orders/${id}`, { method: "PATCH", body });
              qc.invalidateQueries({ queryKey: ["purchase-orders"] });
              toast.success("Purchase order updated.");
              setEditing(false);
            }}
          />
        </Suspense>
      </>
    );
  }

  const receivable = po.status === "issued" || po.status === "partially_received";
  const billable = po.lines.some((l) => Number(l.qtyReceived) > Number(l.qtyBilled));
  return (
    <>
      <PageHeader
        breadcrumb={<Link href="/purchase-orders" className="hover:underline">Purchase Orders</Link>}
        title={
          <span className="flex items-center gap-3">
            {po.number} <StatusBadge status={po.status} />
          </span>
        }
        description={
          <Link href={`/vendors/${po.vendorId}`} className="hover:underline">
            {po.vendorName}
          </Link>
        }
        actions={
          <>
            {canWrite && po.status === "draft" && (
              <Button variant="secondary" onClick={() => setEditing(true)}>
                <Pencil /> Edit
              </Button>
            )}
            {canWrite && (po.status === "draft" || po.status === "issued") && (
              <Button variant="ghost" onClick={() => confirm(`Cancel ${po.number}?`) && action.mutate("cancel")}>
                Cancel order
              </Button>
            )}
            {canWrite && po.status === "partially_received" && (
              <Button variant="ghost" onClick={() => confirm(`Close ${po.number}? Nothing more can be received on it.`) && action.mutate("close")}>
                Close
              </Button>
            )}
            {canWrite && po.status === "draft" && (
              <Button onClick={() => action.mutate("issue")} loading={action.isPending}>
                Issue to vendor
              </Button>
            )}
            {canBill && billable && (
              <ButtonLink variant="secondary" href={`/bills/new?vendorId=${po.vendorId}&purchaseOrderId=${po.id}`}>
                <Receipt /> Enter bill
              </ButtonLink>
            )}
            {canWrite && receivable && (
              <Button onClick={() => setReceiving(true)}>
                <PackageCheck /> Receive items
              </Button>
            )}
          </>
        }
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted">
                  <th className="px-4 py-2 font-medium">Item</th>
                  <th className="px-4 py-2 text-right font-medium">Ordered</th>
                  <th className="px-4 py-2 text-right font-medium">Received</th>
                  <th className="px-4 py-2 text-right font-medium">Billed</th>
                  <th className="px-4 py-2 text-right font-medium">Unit cost</th>
                  <th className="px-4 py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {po.lines.map((l) => (
                  <tr key={l.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-2.5">
                      <Link href={`/items/${l.itemId}`} className="font-medium hover:underline">
                        {l.description}
                      </Link>
                      <div className="font-mono text-xs text-muted">{l.sku}</div>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular">{quantity(l.quantity)}</td>
                    <td className={`px-4 py-2.5 text-right tabular ${Number(l.qtyReceived) < Number(l.quantity) ? "text-warning" : "text-success"}`}>{quantity(l.qtyReceived)}</td>
                    <td className="px-4 py-2.5 text-right tabular">{quantity(l.qtyBilled)}</td>
                    <td className="px-4 py-2.5 text-right tabular">{money(l.unitCost)}</td>
                    <td className="px-4 py-2.5 text-right">
                      <Money value={l.amount} />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-border font-semibold">
                  <td className="px-4 py-2" colSpan={5}>
                    Total
                  </td>
                  <td className="px-4 py-2 text-right">
                    <Money value={po.total} />
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </Card>
        <div className="flex flex-col gap-6">
          <Card className="p-4">
            <DescriptionList
              items={[
                { label: "Order date", value: date(po.orderDate) },
                { label: "Expected", value: po.expectedDate ? date(po.expectedDate) : null },
              ]}
            />
            {po.memo && <p className="mt-3 border-t border-border pt-3 text-sm text-muted">{po.memo}</p>}
          </Card>
          <Card>
            <CardHeader title="Receipts" />
            {po.receipts.length === 0 ? (
              <p className="px-4 py-4 text-sm text-muted">Nothing received yet.</p>
            ) : (
              <ul className="divide-y divide-border text-sm">
                {po.receipts.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-2 px-4 py-2">
                    <span>
                      <span className="font-medium">{r.number}</span> <span className="text-xs text-muted">{date(r.date)}</span>
                    </span>
                    <span className="flex items-center gap-3">
                      <Money value={r.total} />
                      {r.journalEntryId && (
                        <Link className="text-xs text-accent hover:underline" href={`/journal/${r.journalEntryId}`}>
                          Entry
                        </Link>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card>
            <CardHeader title="Bills" />
            {po.bills.length === 0 ? (
              <p className="px-4 py-4 text-sm text-muted">No bills yet.</p>
            ) : (
              <ul className="divide-y divide-border text-sm">
                {po.bills.map((b) => (
                  <li key={b.id} className="flex items-center justify-between gap-2 px-4 py-2">
                    <Link className="font-medium text-accent hover:underline" href={`/bills/${b.id}`}>
                      {b.number}
                    </Link>
                    <StatusBadge status={b.status} />
                    <Money value={b.total} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
      {receiving && <ReceiveDialog po={po} open={receiving} onOpenChange={setReceiving} />}
    </>
  );
}
