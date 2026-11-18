"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FormError, Input, Select } from "@/components/ui/inputs";
import { Card, CardHeader, Money, PageHeader } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { api, ApiError, newIdempotencyKey } from "@/lib/api";
import { format2, parse } from "@/lib/decimal";
import { date, money, todayIso } from "@/lib/format";

type Customer = { id: string; displayName: string };
type OpenInvoice = { id: string; number: string; issueDate: string; dueDate: string; total: string; balanceDue: string; daysOverdue: number };
type Account = { id: string; number: string; name: string; type: string; subtype: string; systemKey: string | null };

const METHODS = [
  { value: "ach", label: "ACH transfer" },
  { value: "check", label: "Check" },
  { value: "wire", label: "Wire" },
  { value: "card", label: "Card" },
  { value: "cash", label: "Cash" },
  { value: "other", label: "Other" },
];

function NewPayment() {
  const params = useSearchParams();
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  // One key per form: a double click or network retry cannot record the payment twice.
  const [idempotencyKey] = useState(newIdempotencyKey);
  const [customerId, setCustomerId] = useState(params.get("customerId") ?? "");
  const [payDate, setPayDate] = useState(todayIso());
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("ach");
  const [reference, setReference] = useState("");
  const [depositAccountId, setDepositAccountId] = useState("");
  const [applied, setApplied] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const customers = useQuery({ queryKey: ["customer", "list", false], queryFn: () => api<{ data: Customer[] }>("/customers?limit=500") });
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: () => api<{ data: Account[] }>("/accounts") });
  const invoices = useQuery({
    queryKey: ["invoices", "open", customerId],
    queryFn: () => api<{ data: OpenInvoice[] }>(`/invoices?status=unpaid&customerId=${customerId}&limit=500`),
    enabled: !!customerId,
  });
  const depositAccounts = (accounts.data?.data ?? []).filter((a) => a.type === "asset" && (a.subtype === "bank" || a.subtype === "cash"));

  useEffect(() => {
    const undeposited = depositAccounts.find((a) => a.systemKey === "undeposited_funds");
    if (!depositAccountId && undeposited) setDepositAccountId(undeposited.id);
  }, [depositAccounts, depositAccountId]);

  // Pre-select the invoice we came from, or the oldest invoices, when the list loads.
  useEffect(() => {
    if (!invoices.data) return;
    const target = params.get("invoiceId");
    const rows = [...invoices.data.data].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    if (target) {
      const inv = rows.find((r) => r.id === target);
      if (inv) {
        setApplied({ [inv.id]: inv.balanceDue });
        setAmount(inv.balanceDue);
      }
    } else setApplied({});
  }, [invoices.data, params]);

  const appliedTotal = useMemo(() => Object.values(applied).reduce((acc, v) => acc + (parse(v) ?? 0n), 0n), [applied]);
  const amountValue = parse(amount) ?? 0n;
  const unapplied = amountValue - appliedTotal;

  function autoApply(total: bigint) {
    let left = total;
    const next: Record<string, string> = {};
    for (const inv of [...(invoices.data?.data ?? [])].sort((a, b) => a.dueDate.localeCompare(b.dueDate))) {
      if (left <= 0n) break;
      const bal = parse(inv.balanceDue) ?? 0n;
      const take = left >= bal ? bal : left;
      next[inv.id] = format2(take);
      left -= take;
    }
    setApplied(next);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setFieldErrors({});
    if (!customerId) return setError("Choose a customer.");
    if (amountValue <= 0n) return setError("Enter the amount received.");
    if (unapplied < 0n) return setError("You applied more than the payment amount.");
    setSaving(true);
    try {
      const applications = Object.entries(applied)
        .filter(([, v]) => (parse(v) ?? 0n) > 0n)
        .map(([invoiceId, v]) => ({ invoiceId, amount: v }));
      const payment = await api<{ id: string; number: string }>("/payments", {
        method: "POST",
        headers: { "idempotency-key": idempotencyKey },
        body: { customerId, date: payDate, amount, method, reference: reference || null, depositAccountId, autoApply: false, applications },
      });
      qc.invalidateQueries();
      toast.success(`Payment ${payment.number} recorded.`);
      router.push(`/payments/${payment.id}`);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setFieldErrors(err.fieldErrors());
      } else setError("Could not record the payment.");
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-6">
      <FormError message={error} />
      <Card className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Customer" required className="lg:col-span-1">
          {(p) => (
            <Select {...p} value={customerId} onChange={(e) => (setCustomerId(e.target.value), setApplied({}))}>
              <option value="">Choose a customer…</option>
              {customers.data?.data.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.displayName}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Amount received" required error={fieldErrors.amount}>
          {(p) => <Input {...p} value={amount} onChange={(e) => setAmount(e.target.value)} onBlur={() => amountValue > 0n && Object.keys(applied).length === 0 && autoApply(amountValue)} inputMode="decimal" placeholder="0.00" />}
        </Field>
        <Field label="Payment date" required error={fieldErrors.date}>
          {(p) => <Input {...p} type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} />}
        </Field>
        <Field label="Method">
          {(p) => (
            <Select {...p} value={method} onChange={(e) => setMethod(e.target.value)}>
              {METHODS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Reference" hint="Check number or transfer ID.">
          {(p) => <Input {...p} value={reference} onChange={(e) => setReference(e.target.value)} />}
        </Field>
        <Field label="Deposit to">
          {(p) => (
            <Select {...p} value={depositAccountId} onChange={(e) => setDepositAccountId(e.target.value)}>
              {depositAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.number} {a.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </Card>

      <Card>
        <CardHeader
          title="Apply to invoices"
          description="Oldest due first. Anything not applied stays as a credit for this customer."
          action={
            amountValue > 0n && (
              <Button size="sm" variant="secondary" onClick={() => autoApply(amountValue)}>
                Apply oldest first
              </Button>
            )
          }
        />
        {!customerId ? (
          <p className="px-4 py-6 text-sm text-muted">Choose a customer to see their open invoices.</p>
        ) : invoices.data?.data.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted">This customer has no open invoices. The payment will be kept as a credit.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted">
                  <th className="px-4 py-2 font-medium">Invoice</th>
                  <th className="px-4 py-2 font-medium">Due</th>
                  <th className="px-4 py-2 text-right font-medium">Open balance</th>
                  <th className="w-40 px-4 py-2 text-right font-medium">Payment</th>
                </tr>
              </thead>
              <tbody>
                {invoices.data?.data.map((inv) => (
                  <tr key={inv.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-2">
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={!!applied[inv.id] && applied[inv.id] !== "0.00"}
                          onChange={(e) =>
                            setApplied((a) => {
                              const n = { ...a };
                              if (e.target.checked) n[inv.id] = inv.balanceDue;
                              else delete n[inv.id];
                              return n;
                            })
                          }
                          aria-label={`Apply to ${inv.number}`}
                        />
                        <span className="font-medium">{inv.number}</span>
                      </label>
                    </td>
                    <td className={`px-4 py-2 ${inv.daysOverdue > 0 ? "text-danger" : ""}`}>{date(inv.dueDate)}</td>
                    <td className="px-4 py-2 text-right">
                      <Money value={inv.balanceDue} />
                    </td>
                    <td className="px-4 py-2">
                      <Input
                        value={applied[inv.id] ?? ""}
                        onChange={(e) => setApplied((a) => ({ ...a, [inv.id]: e.target.value }))}
                        inputMode="decimal"
                        className="text-right"
                        placeholder="0.00"
                        aria-label={`Amount applied to ${inv.number}`}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <dl className="ml-auto max-w-xs space-y-1.5 border-t border-border p-4 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted">Applied</dt>
            <dd className="tabular">{money(format2(appliedTotal))}</dd>
          </div>
          <div className={`flex justify-between font-semibold ${unapplied < 0n ? "text-danger" : ""}`}>
            <dt>{unapplied < 0n ? "Over-applied" : "Customer credit"}</dt>
            <dd className="tabular">{money(format2(unapplied < 0n ? -unapplied : unapplied))}</dd>
          </div>
        </dl>
      </Card>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={() => router.back()}>
          Cancel
        </Button>
        <Button type="submit" loading={saving}>
          Record payment
        </Button>
      </div>
    </form>
  );
}

export default function Page() {
  return (
    <>
      <PageHeader
        breadcrumb={<Link href="/payments" className="hover:underline">Payments</Link>}
        title="Record a payment"
        description="Posts Dr deposit account / Cr Accounts Receivable and marks invoices paid."
      />
      <Suspense>
        <NewPayment />
      </Suspense>
    </>
  );
}
