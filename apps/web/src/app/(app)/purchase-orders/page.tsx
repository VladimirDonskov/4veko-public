"use client";

import { useQuery } from "@tanstack/react-query";
import { Plus, ShoppingCart } from "lucide-react";
import { DataTable } from "@/components/data-table";
import { ButtonLink } from "@/components/ui/button";
import { Card, EmptyState, ErrorState, LoadingRows, Money, PageHeader, StatusBadge } from "@/components/ui/misc";
import { api } from "@/lib/api";
import { date } from "@/lib/format";
import { useCan } from "@/lib/session";

type Po = { id: string; number: string; orderDate: string; expectedDate: string | null; status: string; vendorName: string; total: string };

const STATUSES = [
  { value: "draft", label: "Draft" },
  { value: "issued", label: "Issued" },
  { value: "partially_received", label: "Partially received" },
  { value: "received", label: "Received" },
  { value: "closed", label: "Closed" },
  { value: "cancelled", label: "Cancelled" },
];

export default function PurchaseOrdersPage() {
  const canWrite = useCan("purchasing.write");
  const q = useQuery({ queryKey: ["purchase-orders", "list"], queryFn: () => api<{ data: Po[] }>("/purchase-orders?limit=500") });
  return (
    <>
      <PageHeader
        title="Purchase Orders"
        description="What you have ordered from vendors, and how much has arrived and been billed."
        actions={
          canWrite && (
            <ButtonLink href="/purchase-orders/new">
              <Plus /> New purchase order
            </ButtonLink>
          )
        }
      />
      <Card>
        {q.error ? (
          <ErrorState error={q.error} retry={() => q.refetch()} />
        ) : !q.data ? (
          <LoadingRows />
        ) : (
          <DataTable
            id="purchase-orders"
            rows={q.data.data}
            href={(r) => `/purchase-orders/${r.id}`}
            initialSort={{ key: "date", dir: "desc" }}
            facets={{ label: "Statuses", options: STATUSES }}
            facetValue={(r) => r.status}
            empty={<EmptyState icon={<ShoppingCart />} title="No purchase orders" description="Order stock from a vendor to keep shelves full." action={canWrite && <ButtonLink href="/purchase-orders/new">New purchase order</ButtonLink>} />}
            columns={[
              { key: "number", header: "Number", value: (r) => r.number, cell: (r) => <span className="font-medium">{r.number}</span> },
              { key: "date", header: "Date", value: (r) => r.orderDate, cell: (r) => date(r.orderDate) },
              { key: "vendor", header: "Vendor", value: (r) => r.vendorName, cell: (r) => r.vendorName },
              { key: "expected", header: "Expected", value: (r) => r.expectedDate ?? "", cell: (r) => (r.expectedDate ? date(r.expectedDate) : "—"), hideBelow: "md" },
              { key: "status", header: "Status", value: (r) => r.status, cell: (r) => <StatusBadge status={r.status} /> },
              { key: "total", header: "Total", align: "right", value: (r) => Number(r.total), cell: (r) => <Money value={r.total} /> },
            ]}
          />
        )}
      </Card>
    </>
  );
}
