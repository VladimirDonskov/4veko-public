"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FormError, Input, Select, Textarea } from "@/components/ui/inputs";
import { Card, CardHeader, PageHeader } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { api, ApiError } from "@/lib/api";
import { format2, mul, parse, toCents } from "@/lib/decimal";
import { money, quantity, todayIso } from "@/lib/format";

type Vendor = { id: string; displayName: string; termsDays: number };
type Account = { id: string; number: string; name: string; type: string; subtype: string; systemKey: string | null };
type Billable = {
  purchaseOrderLineId: string;
  purchaseOrderId: string;
  purchaseOrderNumber: string;
  lineNo: number;
  sku: string;
  description: string | null;
  unitCost: string;
  billableQuantity: string;
};
type PoPick = { include: boolean; quantity: string; unitCost: string };
type ExpenseLine = { key: number; accountId: string; description: string; amount: string };

let k = 0;
const blankExpense = (): ExpenseLine => ({ key: ++k, accountId: "", description: "", amount: "" });
const BLOCKED = new Set(["accounts_receivable", "accounts_payable", "inventory", "bank", "cash"]);
const trim = (v: string) => String(Number(v));

function NewBill() {
  const params = useSearchParams();
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const [vendorId, setVendorId] = useState(params.get("vendorId") ?? "");
  const [vendorReference, setVendorReference] = useState("");
  const [billDate, setBillDate] = useState(todayIso());
  const [dueDate, setDueDate] = useState("");
  const [memo, setMemo] = useState("");
  const [picks, setPicks] = useState<Record<string, PoPick>>({});
  const [expenses, setExpenses] = useState<ExpenseLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const vendors = useQuery({ queryKey: ["vendor", "list", false], queryFn: () => api<{ data: Vendor[] }>("/vendors?limit=500") });
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: () => api<{ data: Account[] }>("/accounts") });
  const billable = useQuery({
    queryKey: ["bills", "billable", vendorId],
    queryFn: () => api<Billable[]>(`/bills/billable-lines?vendorId=${vendorId}`),
    enabled: !!vendorId,
  });
  const vendor = vendors.data?.data.find((v) => v.id === vendorId);
  const expenseAccounts = (accounts.data?.data ?? []).filter((a) => (a.type === "expense" || a.type === "asset") && !BLOCKED.has(a.subtype) && !a.systemKey);

  // Pre-select the received lines of the order we came from.
  useEffect(() => {
    if (!billable.data) return;
    const fromPo = params.get("purchaseOrderId");
    setPicks(
      Object.fromEntries(
        billable.data.map((b) => [b.purchaseOrderLineId, { include: !!fromPo && b.purchaseOrderId === fromPo, quantity: trim(b.billableQuantity), unitCost: trim(b.unitCost) }]),
      ),
    );
    if (!fromPo && billable.data.length === 0 && expenses.length === 0) setExpenses([blankExpense()]);
  }, [billable.data, params]); // eslint-disable-line react-hooks/exhaustive-deps

  const poTotal = Object.values(picks).reduce((acc, p) => {
    if (!p.include) return acc;
    const q = parse(p.quantity);
    const c = parse(p.unitCost);
    return q !== null && c !== null ? acc + toCents(mul(q, c)) : acc;
  }, 0n);
  const expTotal = expenses.reduce((acc, e) => acc + (e.accountId ? (parse(e.amount) ?? 0n) : 0n), 0n);
  const total = poTotal + expTotal;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!vendorId) return setError("Choose a vendor.");
    if (!vendorReference.trim()) return setError("Enter the vendor's invoice number so it cannot be entered twice.");
    const poLines = Object.entries(picks)
      .filter(([, p]) => p.include)
      .map(([purchaseOrderLineId, p]) => ({ purchaseOrderLineId, quantity: p.quantity, unitCost: p.unitCost }));
    const expenseLines = expenses.filter((x) => x.accountId && x.amount).map((x) => ({ accountId: x.accountId, amount: x.amount, description: x.description || null }));
    if (poLines.length + expenseLines.length === 0) return setError("Add at least one line.");
    setSaving(true);
    try {
      const bill = await api<{ id: string; number: string }>("/bills", {
        method: "POST",
        body: { vendorId, vendorReference, billDate, dueDate: dueDate || undefined, memo: memo || null, poLines, expenseLines },
      });
      qc.invalidateQueries();
      toast.success(`Bill ${bill.number} entered.`);
      router.push(`/bills/${bill.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not enter the bill.");
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-6">
      <FormError message={error} />
      <Card className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Vendor" required>
          {(p) => (
            <Select {...p} value={vendorId} onChange={(e) => (setVendorId(e.target.value), setPicks({}))}>
              <option value="">Choose a vendor…</option>
              {vendors.data?.data.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.displayName}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Vendor invoice number" required hint="As printed on their invoice. Duplicates are refused.">
          {(p) => <Input {...p} value={vendorReference} onChange={(e) => setVendorReference(e.target.value)} />}
        </Field>
        <Field label="Bill date" required>{(p) => <Input {...p} type="date" value={billDate} onChange={(e) => setBillDate(e.target.value)} />}</Field>
        <Field label="Due date" hint={vendor ? `Leave empty for Net ${vendor.termsDays}.` : "Defaults from the vendor's terms."}>
          {(p) => <Input {...p} type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />}
        </Field>
      </Card>

      {vendorId && (
        <Card>
          <CardHeader title="Received items not yet billed" description="Bill only what has arrived. A different unit cost is recorded as purchase price variance." />
          {!billable.data ? (
            <p className="px-4 py-4 text-sm text-muted">Loading…</p>
          ) : billable.data.length === 0 ? (
            <p className="px-4 py-4 text-sm text-muted">Nothing received from this vendor is waiting for a bill.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted">
                    <th className="px-4 py-2 font-medium">Order line</th>
                    <th className="px-4 py-2 text-right font-medium">Billable</th>
                    <th className="w-28 px-4 py-2 text-right font-medium">Qty</th>
                    <th className="w-32 px-4 py-2 text-right font-medium">Unit cost</th>
                  </tr>
                </thead>
                <tbody>
                  {billable.data.map((b) => {
                    const p = picks[b.purchaseOrderLineId];
                    if (!p) return null;
                    const set = (patch: Partial<PoPick>) => setPicks((x) => ({ ...x, [b.purchaseOrderLineId]: { ...p, ...patch } }));
                    return (
                      <tr key={b.purchaseOrderLineId} className="border-b border-border last:border-0">
                        <td className="px-4 py-2">
                          <label className="flex items-center gap-2">
                            <input type="checkbox" checked={p.include} onChange={(e) => set({ include: e.target.checked })} aria-label={`Bill ${b.purchaseOrderNumber} line ${b.lineNo}`} />
                            <span>
                              <span className="font-medium">{b.purchaseOrderNumber}</span> · <span className="font-mono text-xs text-muted">{b.sku}</span> {b.description}
                            </span>
                          </label>
                        </td>
                        <td className="px-4 py-2 text-right tabular">
                          {quantity(b.billableQuantity)} at {money(b.unitCost)}
                        </td>
                        <td className="px-4 py-2">
                          <Input aria-label={`Quantity to bill for ${b.sku}`} value={p.quantity} onChange={(e) => set({ quantity: e.target.value, include: true })} inputMode="decimal" className="text-right" />
                        </td>
                        <td className="px-4 py-2">
                          <Input aria-label={`Unit cost for ${b.sku}`} value={p.unitCost} onChange={(e) => set({ unitCost: e.target.value, include: true })} inputMode="decimal" className="text-right" />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      <Card>
        <CardHeader
          title="Expenses and other purchases"
          description="Rent, utilities, services, supplies or equipment: anything not on a purchase order."
          action={
            <Button size="sm" variant="secondary" onClick={() => setExpenses((x) => [...x, blankExpense()])}>
              <Plus /> Add expense line
            </Button>
          }
        />
        {expenses.length === 0 ? (
          <p className="px-4 py-4 text-sm text-muted">No expense lines.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] text-sm">
              <tbody>
                {expenses.map((x, i) => (
                  <tr key={x.key} className="border-b border-border last:border-0">
                    <td className="w-[40%] px-4 py-2">
                      <Select aria-label={`Expense line ${i + 1} account`} value={x.accountId} onChange={(e) => setExpenses((ls) => ls.map((l) => (l.key === x.key ? { ...l, accountId: e.target.value } : l)))}>
                        <option value="">Choose an account…</option>
                        {expenseAccounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.number} {a.name}
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td className="px-4 py-2">
                      <Input aria-label={`Expense line ${i + 1} description`} placeholder="Description" value={x.description} onChange={(e) => setExpenses((ls) => ls.map((l) => (l.key === x.key ? { ...l, description: e.target.value } : l)))} />
                    </td>
                    <td className="w-36 px-4 py-2">
                      <Input aria-label={`Expense line ${i + 1} amount`} placeholder="0.00" value={x.amount} onChange={(e) => setExpenses((ls) => ls.map((l) => (l.key === x.key ? { ...l, amount: e.target.value } : l)))} inputMode="decimal" className="text-right" />
                    </td>
                    <td className="w-10 px-1">
                      <Button variant="ghost" size="icon" aria-label={`Remove expense line ${i + 1}`} onClick={() => setExpenses((ls) => ls.filter((l) => l.key !== x.key))}>
                        <Trash2 />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="border-t border-border p-4 text-right text-base font-semibold">
          Bill total <span className="tabular">{money(format2(total))}</span>
        </div>
      </Card>
      <Card className="p-4">
        <Field label="Memo">{(p) => <Textarea {...p} value={memo} onChange={(e) => setMemo(e.target.value)} />}</Field>
      </Card>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={() => router.back()}>
          Cancel
        </Button>
        <Button type="submit" loading={saving}>
          Enter bill
        </Button>
      </div>
    </form>
  );
}

export default function Page() {
  return (
    <>
      <PageHeader
        breadcrumb={<Link href="/bills" className="hover:underline">Bills</Link>}
        title="Enter a bill"
        description="Records what you owe a vendor. Posts to Accounts Payable when you save."
      />
      <Suspense>
        <NewBill />
      </Suspense>
    </>
  );
}
