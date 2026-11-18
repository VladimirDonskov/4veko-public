"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { PartyForm } from "@/components/party-pages";
import { Button } from "@/components/ui/button";
import { Field, FormError, Input, Select, Textarea } from "@/components/ui/inputs";
import { Card, Kbd } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { api, ApiError } from "@/lib/api";
import { format2, lineAmount, mul, parse, toCents } from "@/lib/decimal";
import { money, quantity, todayIso } from "@/lib/format";

type Customer = { id: string; displayName: string; termsDays: number; taxExempt: boolean };
type Item = { id: string; sku: string; name: string; type: string; unit: string; salesPrice: string; taxable: boolean; qtyOnHand: string };
type Line = { key: number; itemId: string; description: string; quantity: string; unitPrice: string; discountPct: string };

let lineKey = 0;
const blankLine = (): Line => ({ key: ++lineKey, itemId: "", description: "", quantity: "1", unitPrice: "", discountPct: "" });

export type DocumentInitial = {
  customerId: string;
  date: string;
  expectedDate?: string | null;
  memo?: string | null;
  lines: { itemId: string; description: string | null; quantity: string; unitPrice: string; discountPct: string }[];
};

/**
 * Sales order and invoice editor. Totals preview with the same rounding rules
 * as the API (exact fixed-point, not floats); the server recomputes on save.
 */
export function DocumentForm({
  mode,
  initial,
  onSubmit,
}: {
  mode: "order" | "invoice";
  initial?: DocumentInitial;
  onSubmit: (body: Record<string, unknown>, opts: { andInvoice: boolean }) => Promise<void>;
}) {
  const params = useSearchParams();
  const qc = useQueryClient();
  const router = useRouter();
  const toast = useToast();
  const customers = useQuery({ queryKey: ["customer", "list", false], queryFn: () => api<{ data: Customer[] }>("/customers?limit=500") });
  const items = useQuery({ queryKey: ["items", "list", false], queryFn: () => api<{ data: Item[] }>("/items?limit=500") });
  const org = useQuery({ queryKey: ["org"], queryFn: () => api<{ defaultTaxRate: string }>("/org") });

  const [customerId, setCustomerId] = useState(initial?.customerId ?? params.get("customerId") ?? "");
  const [docDate, setDocDate] = useState(initial?.date ?? todayIso());
  const [expectedDate, setExpectedDate] = useState(initial?.expectedDate ?? "");
  const [memo, setMemo] = useState(initial?.memo ?? "");
  const [lines, setLines] = useState<Line[]>(() =>
    initial?.lines.length
      ? initial.lines.map((l) => ({ key: ++lineKey, itemId: l.itemId, description: l.description ?? "", quantity: String(Number(l.quantity)), unitPrice: l.unitPrice, discountPct: Number(l.discountPct) ? String(Number(l.discountPct)) : "" }))
      : [blankLine()],
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState<null | "save" | "invoice">(null);
  const [newCustomer, setNewCustomer] = useState(false);

  const itemById = useMemo(() => new Map((items.data?.data ?? []).map((i) => [i.id, i])), [items.data]);
  const customer = customers.data?.data.find((c) => c.id === customerId);
  const taxRate = customer?.taxExempt ? "0" : (org.data?.defaultTaxRate ?? "0");

  const totals = useMemo(() => {
    let subtotal = 0n;
    let taxable = 0n;
    for (const l of lines) {
      const item = itemById.get(l.itemId);
      if (!item) continue;
      const amt = lineAmount(l.quantity, l.unitPrice || item.salesPrice, l.discountPct || "0");
      if (amt === null) continue;
      subtotal += amt;
      if (item.taxable) taxable += amt;
    }
    const rate = parse(taxRate) ?? 0n;
    const tax = toCents(mul(taxable, rate / 100n));
    return { subtotal, tax, total: subtotal + tax };
  }, [lines, itemById, taxRate]);

  function update(key: number, patch: Partial<Line>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function pickItem(key: number, itemId: string) {
    const item = itemById.get(itemId);
    update(key, { itemId, unitPrice: item?.salesPrice ?? "", description: item?.name ?? "" });
    setLines((ls) => (ls[ls.length - 1]?.key === key ? [...ls, blankLine()] : ls));
  }

  async function submit(andInvoice: boolean) {
    setErrors({});
    setFormError(null);
    const used = lines.filter((l) => l.itemId);
    if (!customerId) return setFormError("Choose a customer.");
    if (used.length === 0) return setFormError("Add at least one line.");
    const body: Record<string, unknown> = {
      customerId,
      memo: memo || null,
      lines: used.map((l) => ({
        itemId: l.itemId,
        description: l.description || null,
        quantity: l.quantity,
        unitPrice: l.unitPrice || undefined,
        discountPct: l.discountPct || undefined,
      })),
    };
    if (mode === "order") {
      body.orderDate = docDate;
      body.expectedDate = expectedDate || null;
    } else body.issueDate = docDate;
    setSaving(andInvoice ? "invoice" : "save");
    try {
      await onSubmit(body, { andInvoice });
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fieldErrors());
        setFormError(err.message);
      } else setFormError("Something went wrong. Please try again.");
      setSaving(null);
    }
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        void submit(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const stockWarning = (l: Line) => {
    const item = itemById.get(l.itemId);
    if (!item || item.type !== "inventory") return null;
    const q = Number(l.quantity);
    return q > Number(item.qtyOnHand) ? `Only ${quantity(item.qtyOnHand)} on hand` : null;
  };

  return (
    <form onSubmit={(e) => (e.preventDefault(), void submit(false))} className="flex flex-col gap-6">
      <FormError message={formError} />
      <Card className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Customer" required error={errors.customerId} className="sm:col-span-2">
          {(p) => (
            <div className="flex gap-2">
              <Select {...p} value={customerId} onChange={(e) => setCustomerId(e.target.value)} autoFocus={!customerId}>
                <option value="">Choose a customer…</option>
                {customers.data?.data.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.displayName}
                  </option>
                ))}
              </Select>
              <Button variant="secondary" onClick={() => setNewCustomer(true)} aria-label="New customer" title="New customer">
                <Plus />
              </Button>
            </div>
          )}
        </Field>
        <Field label={mode === "order" ? "Order date" : "Invoice date"} required error={errors.orderDate ?? errors.issueDate}>
          {(p) => <Input {...p} type="date" value={docDate} onChange={(e) => setDocDate(e.target.value)} />}
        </Field>
        {mode === "order" ? (
          <Field label="Expected ship date" error={errors.expectedDate}>
            {(p) => <Input {...p} type="date" value={expectedDate ?? ""} onChange={(e) => setExpectedDate(e.target.value)} />}
          </Field>
        ) : (
          <div className="text-sm">
            <p className="text-[13px] font-medium">Due date</p>
            <p className="mt-2 text-muted">{customer ? `Net ${customer.termsDays} from the invoice date` : "From the customer's terms"}</p>
          </div>
        )}
      </Card>

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted">
                <th className="w-[34%] px-3 py-2 font-medium">Item</th>
                <th className="px-3 py-2 font-medium">Description</th>
                <th className="w-24 px-3 py-2 text-right font-medium">Qty</th>
                <th className="w-28 px-3 py-2 text-right font-medium">Price</th>
                <th className="w-20 px-3 py-2 text-right font-medium">Disc. %</th>
                <th className="w-28 px-3 py-2 text-right font-medium">Amount</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, idx) => {
                const item = itemById.get(l.itemId);
                const amt = item ? lineAmount(l.quantity, l.unitPrice || item.salesPrice, l.discountPct || "0") : null;
                const warn = stockWarning(l);
                return (
                  <tr key={l.key} className="border-b border-border align-top last:border-0">
                    <td className="px-3 py-2">
                      <Select value={l.itemId} onChange={(e) => pickItem(l.key, e.target.value)} aria-label={`Line ${idx + 1} item`} aria-invalid={!!errors[`lines.${idx}.itemId`] || undefined}>
                        <option value="">Choose an item…</option>
                        {items.data?.data.map((i) => (
                          <option key={i.id} value={i.id}>
                            {i.sku} · {i.name}
                          </option>
                        ))}
                      </Select>
                      {warn && <p className="mt-1 text-xs text-warning">{warn}</p>}
                    </td>
                    <td className="px-3 py-2">
                      <Input value={l.description} onChange={(e) => update(l.key, { description: e.target.value })} aria-label={`Line ${idx + 1} description`} />
                    </td>
                    <td className="px-3 py-2">
                      <Input value={l.quantity} onChange={(e) => update(l.key, { quantity: e.target.value })} inputMode="decimal" className="text-right" aria-label={`Line ${idx + 1} quantity`} aria-invalid={!!errors[`lines.${idx}.quantity`] || undefined} />
                      {errors[`lines.${idx}.quantity`] && <p className="mt-1 text-xs text-danger">{errors[`lines.${idx}.quantity`]}</p>}
                    </td>
                    <td className="px-3 py-2">
                      <Input value={l.unitPrice} placeholder={item?.salesPrice} onChange={(e) => update(l.key, { unitPrice: e.target.value })} inputMode="decimal" className="text-right" aria-label={`Line ${idx + 1} price`} />
                    </td>
                    <td className="px-3 py-2">
                      <Input value={l.discountPct} placeholder="0" onChange={(e) => update(l.key, { discountPct: e.target.value })} inputMode="decimal" className="text-right" aria-label={`Line ${idx + 1} discount percent`} />
                    </td>
                    <td className="px-3 py-2 pt-4 text-right tabular">{amt === null ? "—" : money(format2(amt))}</td>
                    <td className="px-1 py-2">
                      <Button variant="ghost" size="icon" onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((x) => x.key !== l.key) : [blankLine()]))} aria-label={`Remove line ${idx + 1}`}>
                        <Trash2 />
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="flex flex-col gap-4 border-t border-border p-4 sm:flex-row sm:items-start sm:justify-between">
          <Button variant="secondary" size="sm" onClick={() => setLines((ls) => [...ls, blankLine()])}>
            <Plus /> Add line
          </Button>
          <dl className="w-full max-w-xs space-y-1.5 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted">Subtotal</dt>
              <dd className="tabular">{money(format2(totals.subtotal))}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">Sales tax ({customer?.taxExempt ? "exempt" : `${Number(taxRate)}%`})</dt>
              <dd className="tabular">{money(format2(totals.tax))}</dd>
            </div>
            <div className="flex justify-between border-t border-border pt-1.5 text-base font-semibold">
              <dt>Total</dt>
              <dd className="tabular">{money(format2(totals.total))}</dd>
            </div>
          </dl>
        </div>
      </Card>

      <Card className="p-4">
        <Field label="Memo" hint="Shown on the document and in the ledger.">
          {(p) => <Textarea {...p} value={memo} onChange={(e) => setMemo(e.target.value)} />}
        </Field>
      </Card>

      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="mr-auto hidden text-xs text-muted sm:inline">
          <Kbd>Ctrl</Kbd> <Kbd>Enter</Kbd> to save
        </span>
        <Button variant="secondary" onClick={() => router.back()}>
          Cancel
        </Button>
        {mode === "order" ? (
          <>
            <Button type="submit" variant="secondary" loading={saving === "save"} disabled={!!saving}>
              Save draft
            </Button>
            <Button onClick={() => void submit(true)} loading={saving === "invoice"} disabled={!!saving}>
              Save and invoice
            </Button>
          </>
        ) : (
          <Button type="submit" loading={saving === "save"} disabled={!!saving}>
            Post invoice
          </Button>
        )}
      </div>
      <PartyForm
        kind="customer"
        open={newCustomer}
        onOpenChange={setNewCustomer}
        onSaved={(c) => {
          qc.invalidateQueries({ queryKey: ["customer"] });
          setCustomerId(c.id);
          toast.success(`Customer ${c.displayName} added.`);
        }}
      />
    </form>
  );
}
