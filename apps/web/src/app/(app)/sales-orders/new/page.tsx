"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense } from "react";
import { DocumentForm } from "@/components/document-form";
import { PageHeader } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { api, ApiError } from "@/lib/api";

export default function NewSalesOrderPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  return (
    <>
      <PageHeader breadcrumb={<Link href="/sales-orders" className="hover:underline">Sales Orders</Link>} title="New sales order" />
      <Suspense>
        <DocumentForm
          mode="order"
          onSubmit={async (body, { andInvoice }) => {
            const order = await api<{ id: string; number: string }>("/sales-orders", { method: "POST", body });
            qc.invalidateQueries({ queryKey: ["sales-orders"] });
            if (!andInvoice) {
              toast.success(`Saved draft ${order.number}.`);
              router.push(`/sales-orders/${order.id}`);
              return;
            }
            try {
              const invoice = await api<{ id: string; number: string }>(`/sales-orders/${order.id}/invoice`, { method: "POST", body: { issueDate: body.orderDate } });
              qc.invalidateQueries();
              toast.success(`Invoice ${invoice.number} posted.`);
              router.push(`/invoices/${invoice.id}`);
            } catch (err) {
              // The order was saved; show it with the reason invoicing failed.
              toast.error(`Saved ${order.number}, but it could not be invoiced: ${err instanceof ApiError ? err.message : "unknown error"}`);
              router.push(`/sales-orders/${order.id}`);
            }
          }}
        />
      </Suspense>
    </>
  );
}
