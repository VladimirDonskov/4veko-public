"use client";

import { useQuery } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FormError, Input, Select, Textarea } from "@/components/ui/inputs";
import { Card } from "@/components/ui/misc";
import { api, ApiError } from "@/lib/api";
import { format2, mul, parse, toCents } from "@/lib/decimal";
import { money, quantity, todayIso } from "@/lib/format";

type Vendor = { id: string; displayName: string };
type Item = { id: string; sku: string; name: string; type: string; unit: string; purchaseCost: string; qtyOnHand: string; reorderPoint: string | null };
type Line = { key: number; itemId: string; quantity: string; unitCost: string };

let k = 0;
const blank = (): Line => ({ key: ++k, itemId: "", quantity: "", unitCost: "" });

export type PoInitial = { vendorId: string; orderDate: string; expectedDate: string | null; memo: string | null; lines: { itemId: string; quantity: string; unitCost: string }[] };

/** Purchase order editor. Lists stocked items only and shows on-hand and reorder points to help decide quantities. */
export function PoForm({ initial, onSubmit }: { initial?: PoInitial; onSubmit: (body: Record<string, unknown>) => Promise<void> }) {
  const params = useSearchParams();
  const router = useRouter();
  const vendors = useQuery({ queryKey: ["vendor", "list", false], queryFn: () => api<{ data: Vendor[] }>("/vendors?limit=500") });
  const items = useQuery({ queryKey: ["items", "list", "inventory"], queryFn: () => api<{ data: Item[] }>("/items?type=inventory&limit=500") });
  const [vendorId, setVendorId] = useState(initial?.vendorId ?? params.get("vendorId") ?? "");
  const [orderDate, setOrderDate] = useState(initial?.orderDate ?? todayIso());
  const [expectedDate, setExpectedDate] = useState(initial?.expectedDate ?? "");
  const [memo, setMemo] = useState(initial?.memo ?? "");
  const [lines, setLines] = useState<Line[]>(() =>
    initial?.lines.length ? initial.lines.map((l) => ({ key: ++k, itemId: l.itemId, quantity: String(Number(l.quantity)), unitCost: String(Number(l.unitCost)) })) : [blank()],
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const byId = useMemo(() => new Map((items.data?.data ?? []).map((i) => [i.id, i])), [items.data]);

  const total = lines.reduce((acc, l) => {
    const q = parse(l.quantity);
    const c = parse(l.unitCost || byId.get(l.itemId)?.purchaseCost || "0");
    return q !== null && c !== null && l.itemId ? acc + toCents(mul(q, c)) : acc;
  }, 0n);

  function update(key: number, patch: Partial<Line>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const used = lines.filter((l) => l.itemId);
    if (!vendorId) return setError("Choose a vendor.");
    if (used.length === 0) return setError("Add at least one item.");
    setSaving(true);
    try {
      await onSubmit({
        vendorId,
        orderDate,
        expectedDate: expectedDate || null,
        memo: memo || null,
        lines: used.map((l) => ({ itemId: l.itemId, quantity: l.quantity, unitCost: l.unitCost || undefined })),
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the purchase order.");
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-6">
      <FormError message={error} />
      <Card className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Vendor" required className="sm:col-span-2">
          {(p) => (
            <Select {...p} value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
              <option value="">Choose a vendor…</option>
              {vendors.data?.data.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.displayName}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Order date" required>{(p) => <Input {...p} type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} />}</Field>
        <Field label="Expected delivery">{(p) => <Input {...p} type="date" value={expectedDate ?? ""} onChange={(e) => setExpectedDate(e.target.value)} />}</Field>
      </Card>
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted">
                <th className="w-[44%] px-3 py-2 font-medium">Stocked item</th>
                <th className="w-28 px-3 py-2 text-right font-medium">Qty</th>
                <th className="w-32 px-3 py-2 text-right font-medium">Unit cost</th>
                <th className="w-32 px-3 py-2 text-right font-medium">Amount</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const item = byId.get(l.itemId);
                const q = parse(l.quantity);
                const c = parse(l.unitCost || item?.purchaseCost || "0");
                return (
                  <tr key={l.key} className="border-b border-border align-top last:border-0">
                    <td className="px-3 py-2">
                      <Select
                        aria-label={`Line ${i + 1} item`}
                        value={l.itemId}
                        onChange={(e) => {
                          const it = byId.get(e.target.value);
                          update(l.key, { itemId: e.target.value, unitCost: it ? String(Number(it.purchaseCost)) : "" });
                          setLines((ls) => (ls[ls.length - 1]?.key === l.key ? [...ls, blank()] : ls));
                        }}
                      >
                        <option value="">Choose a stocked item…</option>
                        {items.data?.data.map((it) => (
                          <option key={it.id} value={it.id}>
                            {it.sku} · {it.name}
                          </option>
                        ))}
                      </Select>
                      {item && (
                        <p className="mt-1 text-xs text-muted">
                          {quantity(item.qtyOnHand)} {item.unit} on hand{item.reorderPoint ? ` · reorder at ${quantity(item.reorderPoint)}` : ""}
                        </p>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <Input aria-label={`Line ${i + 1} quantity`} value={l.quantity} onChange={(e) => update(l.key, { quantity: e.target.value })} inputMode="decimal" className="text-right" />
                    </td>
                    <td className="px-3 py-2">
                      <Input aria-label={`Line ${i + 1} unit cost`} value={l.unitCost} onChange={(e) => update(l.key, { unitCost: e.target.value })} inputMode="decimal" className="text-right" />
                    </td>
                    <td className="px-3 py-2 pt-4 text-right tabular">{l.itemId && q !== null && c !== null ? money(format2(toCents(mul(q, c)))) : "—"}</td>
                    <td className="px-1 py-2">
                      <Button variant="ghost" size="icon" aria-label={`Remove line ${i + 1}`} onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((x) => x.key !== l.key) : [blank()]))}>
                        <Trash2 />
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between border-t border-border p-4">
          <Button variant="secondary" size="sm" onClick={() => setLines((ls) => [...ls, blank()])}>
            <Plus /> Add line
          </Button>
          <p className="text-base font-semibold">
            Total <span className="tabular">{money(format2(total))}</span>
          </p>
        </div>
      </Card>
      <Card className="p-4">
        <Field label="Memo" hint="Printed on the order; not sent anywhere automatically.">
          {(p) => <Textarea {...p} value={memo} onChange={(e) => setMemo(e.target.value)} />}
        </Field>
      </Card>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={() => router.back()}>
          Cancel
        </Button>
        <Button type="submit" loading={saving}>
          {initial ? "Save changes" : "Save draft"}
        </Button>
      </div>
    </form>
  );
}
