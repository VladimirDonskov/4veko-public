"use client";

import { useQuery } from "@tanstack/react-query";
import { ClipboardList, Plus } from "lucide-react";
import { DataTable } from "@/components/data-table";
import { ButtonLink } from "@/components/ui/button";
import { Card, EmptyState, ErrorState, LoadingRows, Money, PageHeader, StatusBadge } from "@/components/ui/misc";
import { api } from "@/lib/api";
import { date } from "@/lib/format";
import { useCan } from "@/lib/session";

type Order = { id: string; number: string; orderDate: string; status: string; customerName: string; total: string };

export default function SalesOrdersPage() {
  const canWrite = useCan("sales.write");
  const q = useQuery({ queryKey: ["sales-orders", "list"], queryFn: () => api<{ data: Order[] }>("/sales-orders?limit=500") });
  return (
    <>
      <PageHeader
        title="Sales Orders"
        description="What customers have committed to buy. Invoice an order in one click when it ships."
        actions={
          canWrite && (
            <ButtonLink href="/sales-orders/new">
              <Plus /> New sales order
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
            id="sales-orders"
            rows={q.data.data}
            href={(r) => `/sales-orders/${r.id}`}
            initialSort={{ key: "date", dir: "desc" }}
            facets={{
              label: "Statuses",
              options: [
                { value: "draft", label: "Draft" },
                { value: "confirmed", label: "Confirmed" },
                { value: "invoiced", label: "Invoiced" },
                { value: "cancelled", label: "Cancelled" },
              ],
            }}
            facetValue={(r) => r.status}
            empty={<EmptyState icon={<ClipboardList />} title="No sales orders" description="Create an order to reserve what a customer is buying." action={canWrite && <ButtonLink href="/sales-orders/new">New sales order</ButtonLink>} />}
            columns={[
              { key: "number", header: "Number", value: (r) => r.number, cell: (r) => <span className="font-medium">{r.number}</span> },
              { key: "date", header: "Date", value: (r) => r.orderDate, cell: (r) => date(r.orderDate) },
              { key: "customer", header: "Customer", value: (r) => r.customerName, cell: (r) => r.customerName },
              { key: "status", header: "Status", value: (r) => r.status, cell: (r) => <StatusBadge status={r.status} /> },
              { key: "total", header: "Total", align: "right", value: (r) => Number(r.total), cell: (r) => <Money value={r.total} /> },
            ]}
          />
        )}
      </Card>
    </>
  );
}
