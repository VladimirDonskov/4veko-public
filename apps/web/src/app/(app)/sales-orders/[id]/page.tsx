"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Pencil } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, use, useState } from "react";
import { DocumentForm } from "@/components/document-form";
import { DocumentLines } from "@/components/document-lines";
import { Button } from "@/components/ui/button";
import { Card, DescriptionList, ErrorState, LoadingRows, Money, PageHeader, StatusBadge } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { date, todayIso } from "@/lib/format";
import { useCan } from "@/lib/session";

type Order = {
  id: string;
  number: string;
  status: string;
  customerId: string;
  customerName: string;
  orderDate: string;
  expectedDate: string | null;
  memo: string | null;
  taxRate: string;
  subtotal: string;
  taxTotal: string;
  total: string;
  lines: { lineNo: number; itemId: string; sku: string; description: string | null; quantity: string; unitPrice: string; discountPct: string; amount: string; taxable: boolean }[];
  invoices: { id: string; number: string; status: string; total: string }[];
};

export default function SalesOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const canWrite = useCan("sales.write");
  const canInvoice = useCan("invoice.post");
  const [editing, setEditing] = useState(false);
  const q = useQuery({ queryKey: ["sales-orders", id], queryFn: () => api<Order>(`/sales-orders/${id}`) });

  const action = useMutation({
    mutationFn: (a: "confirm" | "cancel" | "invoice") =>
      api<{ id: string; number: string }>(`/sales-orders/${id}/${a}`, { method: "POST", body: a === "invoice" ? { issueDate: todayIso() } : undefined }),
    onSuccess: (res, a) => {
      qc.invalidateQueries();
      if (a === "invoice") {
        toast.success(`Invoice ${res.number} posted.`);
        router.push(`/invoices/${res.id}`);
      } else toast.success(a === "confirm" ? "Order confirmed." : "Order cancelled.");
    },
    onError: (e) => toast.error(e.message),
  });

  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  if (!q.data) return <LoadingRows />;
  const o = q.data;

  if (editing) {
    return (
      <>
        <PageHeader breadcrumb={<Link href={`/sales-orders/${id}`} className="hover:underline">{o.number}</Link>} title={`Edit ${o.number}`} />
        <Suspense>
          <DocumentForm
            mode="order"
            initial={{ customerId: o.customerId, date: o.orderDate, expectedDate: o.expectedDate, memo: o.memo, lines: o.lines }}
            onSubmit={async (body) => {
              await api(`/sales-orders/${id}`, { method: "PATCH", body });
              qc.invalidateQueries({ queryKey: ["sales-orders"] });
              toast.success("Order updated.");
              setEditing(false);
            }}
          />
        </Suspense>
      </>
    );
  }

  const open = o.status === "draft" || o.status === "confirmed";
  return (
    <>
      <PageHeader
        breadcrumb={<Link href="/sales-orders" className="hover:underline">Sales Orders</Link>}
        title={
          <span className="flex items-center gap-3">
            {o.number} <StatusBadge status={o.status} />
          </span>
        }
        description={
          <Link href={`/customers/${o.customerId}`} className="hover:underline">
            {o.customerName}
          </Link>
        }
        actions={
          <>
            {canWrite && o.status === "draft" && (
              <Button variant="secondary" onClick={() => setEditing(true)}>
                <Pencil /> Edit
              </Button>
            )}
            {canWrite && open && (
              <Button variant="ghost" onClick={() => confirm(`Cancel ${o.number}?`) && action.mutate("cancel")} disabled={action.isPending}>
                Cancel order
              </Button>
            )}
            {canWrite && o.status === "draft" && (
              <Button variant="secondary" onClick={() => action.mutate("confirm")} loading={action.isPending && action.variables === "confirm"}>
                Confirm
              </Button>
            )}
            {canInvoice && open && (
              <Button onClick={() => action.mutate("invoice")} loading={action.isPending && action.variables === "invoice"}>
                <FileText /> Create invoice
              </Button>
            )}
          </>
        }
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <DocumentLines lines={o.lines} subtotal={o.subtotal} taxTotal={o.taxTotal} taxRate={o.taxRate} total={o.total} />
        </div>
        <div className="flex flex-col gap-6">
          <Card className="p-4">
            <DescriptionList
              items={[
                { label: "Order date", value: date(o.orderDate) },
                { label: "Expected ship", value: o.expectedDate ? date(o.expectedDate) : null },
                { label: "Total", value: <Money value={o.total} strong /> },
              ]}
            />
            {o.memo && <p className="mt-3 border-t border-border pt-3 text-sm text-muted">{o.memo}</p>}
          </Card>
          {o.invoices.length > 0 && (
            <Card className="p-4">
              <p className="mb-2 text-xs font-medium text-muted">Invoices</p>
              <ul className="space-y-1.5 text-sm">
                {o.invoices.map((i) => (
                  <li key={i.id} className="flex items-center justify-between gap-2">
                    <Link href={`/invoices/${i.id}`} className="font-medium text-accent hover:underline">
                      {i.number}
                    </Link>
                    <StatusBadge status={i.status} />
                    <Money value={i.total} />
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
