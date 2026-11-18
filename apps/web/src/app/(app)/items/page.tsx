"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Package, Plus } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { DataTable } from "@/components/data-table";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, ErrorState, LoadingRows, Money, PageHeader } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { quantity } from "@/lib/format";
import { useCan } from "@/lib/session";
import { ITEM_TYPES, ItemForm, type Item } from "./item-form";

function ItemsPage() {
  const params = useSearchParams();
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const canWrite = useCan("masterdata.write");
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  useEffect(() => {
    if (params.get("new") === "1") setCreating(true);
  }, [params]);
  const q = useQuery({
    queryKey: ["items", "list", showArchived],
    queryFn: () => api<{ data: Item[] }>(`/items?limit=500${showArchived ? "&includeArchived=true" : ""}`),
  });
  const archive = useMutation({
    mutationFn: (ids: string[]) => api<{ updated: number }>("/items/bulk-archive", { method: "POST", body: { ids, archived: true } }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["items"] });
      toast.success(`Archived ${r.updated} items.`);
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <>
      <PageHeader
        title="Products & Services"
        description="What you sell. Stocked products track quantity and cost automatically."
        actions={
          canWrite && (
            <Button onClick={() => setCreating(true)}>
              <Plus /> New item
            </Button>
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
            id="items"
            rows={q.data.data}
            href={(r) => `/items/${r.id}`}
            initialSort={{ key: "name", dir: "asc" }}
            facets={{ label: "Types", options: Object.entries(ITEM_TYPES).map(([value, label]) => ({ value, label })) }}
            facetValue={(r) => r.type}
            toolbar={
              <label className="flex items-center gap-2 text-sm text-muted">
                <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived
              </label>
            }
            bulkActions={
              canWrite
                ? (rows, clear) => (
                    <Button size="sm" variant="secondary" onClick={() => archive.mutate(rows.map((r) => r.id), { onSuccess: clear })}>
                      <Archive /> Archive
                    </Button>
                  )
                : undefined
            }
            empty={<EmptyState icon={<Package />} title="No items yet" description="Add the products and services you sell." action={canWrite && <Button onClick={() => setCreating(true)}>New item</Button>} />}
            columns={[
              { key: "sku", header: "SKU", value: (r) => r.sku, cell: (r) => <span className="font-mono text-xs">{r.sku}</span> },
              {
                key: "name",
                header: "Name",
                value: (r) => r.name,
                cell: (r) => (
                  <span className="flex items-center gap-2">
                    <span className="font-medium">{r.name}</span>
                    {!r.isActive && <Badge>Archived</Badge>}
                  </span>
                ),
              },
              { key: "type", header: "Type", value: (r) => ITEM_TYPES[r.type], cell: (r) => <span className="text-muted">{ITEM_TYPES[r.type]}</span>, hideBelow: "md" },
              { key: "price", header: "Price", align: "right", value: (r) => Number(r.salesPrice), cell: (r) => <Money value={r.salesPrice} /> },
              {
                key: "onHand",
                header: "On hand",
                align: "right",
                value: (r) => (r.type === "inventory" ? Number(r.qtyOnHand) : -1),
                cell: (r) =>
                  r.type === "inventory" ? (
                    <span className={r.reorderPoint !== null && Number(r.qtyOnHand) <= Number(r.reorderPoint) ? "font-medium text-warning" : ""}>
                      {quantity(r.qtyOnHand)} {r.unit}
                    </span>
                  ) : (
                    <span className="text-muted">—</span>
                  ),
              },
              { key: "value", header: "Stock value", align: "right", value: (r) => Number(r.valueOnHand), cell: (r) => (r.type === "inventory" ? <Money value={r.valueOnHand} /> : <span className="text-muted">—</span>), hideBelow: "lg" },
            ]}
          />
        )}
      </Card>
      <ItemForm open={creating} onOpenChange={(o) => (setCreating(o), !o && params.get("new") && router.replace("/items"))} onSaved={(i) => router.push(`/items/${i.id}`)} />
    </>
  );
}

export default function Page() {
  return (
    <Suspense>
      <ItemsPage />
    </Suspense>
  );
}
