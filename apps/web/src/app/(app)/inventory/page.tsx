"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Boxes, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { DataTable } from "@/components/data-table";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, FormError, Input, Select } from "@/components/ui/inputs";
import { Badge, Card, CardHeader, EmptyState, ErrorState, LoadingRows, Money, PageHeader } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { api, ApiError } from "@/lib/api";
import { date, humanize, money, quantity, todayIso } from "@/lib/format";
import { useCan } from "@/lib/session";

type Stock = { itemId: string; sku: string; name: string; unit: string; reorderPoint: string | null; qtyOnHand: string; valueOnHand: string; averageCost: string; lowStock: boolean; isActive: boolean };
type Adjustment = { id: string; number: string; date: string; reason: string; memo: string | null; journalEntryId: string | null; valueChange: string };
type Account = { id: string; number: string; name: string; type: string; subtype: string };

const REASONS = [
  { value: "opening_balance", label: "Opening balance", hint: "Offsets Opening Balance Equity" },
  { value: "received", label: "Stock received", hint: "Choose the account the cost came from (e.g. Accounts Payable)" },
  { value: "count_correction", label: "Count correction", hint: "Offsets Inventory Shrinkage and Adjustments" },
  { value: "damaged", label: "Damaged or lost", hint: "Offsets Inventory Shrinkage and Adjustments" },
  { value: "other", label: "Other", hint: "Offsets Inventory Shrinkage and Adjustments" },
];

function AdjustDialog({ open, onOpenChange, items }: { open: boolean; onOpenChange: (o: boolean) => void; items: Stock[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState("opening_balance");
  const [adjDate, setAdjDate] = useState(todayIso());
  const [memo, setMemo] = useState("");
  const [offset, setOffset] = useState("");
  const [lines, setLines] = useState([{ itemId: "", quantityChange: "", unitCost: "" }]);
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: () => api<{ data: Account[] }>("/accounts"), enabled: open });
  const save = useMutation({
    mutationFn: () =>
      api<{ number: string }>("/inventory/adjustments", {
        method: "POST",
        body: {
          date: adjDate,
          reason,
          memo: memo || null,
          offsetAccountId: offset || undefined,
          lines: lines.filter((l) => l.itemId && l.quantityChange).map((l) => ({ itemId: l.itemId, quantityChange: l.quantityChange, unitCost: Number(l.quantityChange) > 0 ? l.unitCost || undefined : undefined })),
        },
      }),
    onSuccess: (r) => {
      qc.invalidateQueries();
      toast.success(`Adjustment ${r.number} posted.`);
      onOpenChange(false);
      setLines([{ itemId: "", quantityChange: "", unitCost: "" }]);
    },
  });
  const offsetAccounts = (accounts.data?.data ?? []).filter((a) => a.subtype !== "inventory" && a.type !== "revenue");
  const hint = REASONS.find((r) => r.value === reason)?.hint;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Adjust stock"
      description="Use a positive quantity to add stock at a unit cost, a negative quantity to remove it at average cost."
      wide
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending}>
            Post adjustment
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <FormError message={save.error instanceof ApiError ? save.error.message : null} />
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Reason" hint={hint}>
            {(p) => (
              <Select {...p} value={reason} onChange={(e) => setReason(e.target.value)}>
                {REASONS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Date">{(p) => <Input {...p} type="date" value={adjDate} onChange={(e) => setAdjDate(e.target.value)} />}</Field>
          <Field label="Offset account" hint="Leave as default unless you know otherwise.">
            {(p) => (
              <Select {...p} value={offset} onChange={(e) => setOffset(e.target.value)}>
                <option value="">Default for the reason</option>
                {offsetAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.number} {a.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted">
              <th className="pb-1 font-medium">Item</th>
              <th className="w-28 pb-1 text-right font-medium">Qty change</th>
              <th className="w-28 pb-1 text-right font-medium">Unit cost</th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td className="py-1 pr-2">
                  <Select
                    value={l.itemId}
                    aria-label={`Line ${i + 1} item`}
                    onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, itemId: e.target.value } : x)).concat(i === ls.length - 1 ? [{ itemId: "", quantityChange: "", unitCost: "" }] : []))}
                  >
                    <option value="">Choose a stocked item…</option>
                    {items.filter((s) => s.isActive).map((s) => (
                      <option key={s.itemId} value={s.itemId}>
                        {s.sku} · {s.name} ({quantity(s.qtyOnHand)} on hand)
                      </option>
                    ))}
                  </Select>
                </td>
                <td className="py-1 pr-2">
                  <Input aria-label={`Line ${i + 1} quantity change`} value={l.quantityChange} inputMode="decimal" className="text-right" placeholder="+10 or -2" onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, quantityChange: e.target.value } : x)))} />
                </td>
                <td className="py-1 pr-2">
                  <Input aria-label={`Line ${i + 1} unit cost`} value={l.unitCost} inputMode="decimal" className="text-right" placeholder={Number(l.quantityChange) < 0 ? "avg" : "0.00"} disabled={Number(l.quantityChange) < 0} onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, unitCost: e.target.value } : x)))} />
                </td>
                <td>
                  <Button variant="ghost" size="icon" aria-label={`Remove line ${i + 1}`} onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((_, j) => j !== i) : ls))}>
                    <Trash2 />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <Field label="Memo">{(p) => <Input {...p} value={memo} onChange={(e) => setMemo(e.target.value)} />}</Field>
      </div>
    </Dialog>
  );
}

function InventoryPage() {
  const params = useSearchParams();
  const router = useRouter();
  const canAdjust = useCan("inventory.adjust");
  const [adjusting, setAdjusting] = useState(false);
  useEffect(() => {
    if (params.get("adjust") === "1") setAdjusting(true);
  }, [params]);
  const stock = useQuery({ queryKey: ["inventory", "stock"], queryFn: () => api<{ data: Stock[]; totalValue: string }>("/inventory") });
  const adjustments = useQuery({ queryKey: ["inventory", "adjustments"], queryFn: () => api<Adjustment[]>("/inventory/adjustments") });

  return (
    <>
      <PageHeader
        title="Inventory"
        description="Stock on hand at moving-average cost. The Inventory account always equals the value shown here."
        actions={
          canAdjust && (
            <Button onClick={() => setAdjusting(true)}>
              <Plus /> Adjust stock
            </Button>
          )
        }
      />
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Card className="p-4">
          <p className="text-xs text-muted">Total stock value</p>
          <p className="mt-1 text-2xl font-semibold">
            <Money value={stock.data?.totalValue} />
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-muted">Stocked items</p>
          <p className="mt-1 text-2xl font-semibold">{stock.data?.data.length ?? "—"}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-muted">At or below reorder point</p>
          <p className="mt-1 text-2xl font-semibold text-warning">{stock.data?.data.filter((s) => s.lowStock).length ?? "—"}</p>
        </Card>
      </div>
      <Card>
        {stock.error ? (
          <ErrorState error={stock.error} retry={() => stock.refetch()} />
        ) : !stock.data ? (
          <LoadingRows />
        ) : (
          <DataTable
            id="inventory"
            rows={stock.data.data.map((s) => ({ ...s, id: s.itemId }))}
            href={(r) => `/items/${r.itemId}`}
            initialSort={{ key: "name", dir: "asc" }}
            facets={{ label: "Stock levels", options: [{ value: "low", label: "Low stock" }, { value: "ok", label: "Above reorder point" }] }}
            facetValue={(r) => (r.lowStock ? "low" : "ok")}
            empty={<EmptyState icon={<Boxes />} title="No stocked products" description="Create a product with the type “Stocked product” to track it here." action={<Link className="text-accent hover:underline" href="/items?new=1">New product</Link>} />}
            columns={[
              { key: "sku", header: "SKU", value: (r) => r.sku, cell: (r) => <span className="font-mono text-xs">{r.sku}</span> },
              { key: "name", header: "Item", value: (r) => r.name, cell: (r) => <span className="flex items-center gap-2 font-medium">{r.name}{r.lowStock && <Badge tone="warning">Low stock</Badge>}</span> },
              { key: "qty", header: "On hand", align: "right", value: (r) => Number(r.qtyOnHand), cell: (r) => `${quantity(r.qtyOnHand)} ${r.unit}` },
              { key: "reorder", header: "Reorder at", align: "right", value: (r) => Number(r.reorderPoint ?? -1), cell: (r) => (r.reorderPoint ? quantity(r.reorderPoint) : "—"), hideBelow: "md" },
              { key: "avg", header: "Avg. cost", align: "right", value: (r) => Number(r.averageCost), cell: (r) => money(r.averageCost), hideBelow: "sm" },
              { key: "value", header: "Value", align: "right", value: (r) => Number(r.valueOnHand), cell: (r) => <Money value={r.valueOnHand} /> },
            ]}
          />
        )}
      </Card>
      <Card className="mt-6">
        <CardHeader title="Adjustments" description="Opening stock, receipts and write-downs" />
        {!adjustments.data ? (
          <LoadingRows rows={3} />
        ) : adjustments.data.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted">No adjustments yet.</p>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {adjustments.data.map((a) => (
                <tr key={a.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-2 font-medium">{a.number}</td>
                  <td className="px-4 py-2">{date(a.date)}</td>
                  <td className="px-4 py-2">{humanize(a.reason)}</td>
                  <td className="hidden px-4 py-2 text-muted md:table-cell">{a.memo}</td>
                  <td className="px-4 py-2 text-right">
                    <Money value={a.valueChange} />
                  </td>
                  <td className="px-4 py-2 text-right">
                    {a.journalEntryId && (
                      <Link className="text-accent hover:underline" href={`/journal/${a.journalEntryId}`}>
                        Entry
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <AdjustDialog open={adjusting} onOpenChange={(o) => (setAdjusting(o), !o && params.get("adjust") && router.replace("/inventory"))} items={stock.data?.data ?? []} />
    </>
  );
}

export default function Page() {
  return (
    <Suspense>
      <InventoryPage />
    </Suspense>
  );
}
