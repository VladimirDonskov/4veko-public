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

type Vendor = { id: string; displayName: string };
type OpenBill = { id: string; number: string; vendorReference: string; dueDate: string; balanceDue: string; daysOverdue: number };
type Account = { id: string; number: string; name: string; type: string; subtype: string; systemKey: string | null; balance: string };

const METHODS = [
  { value: "ach", label: "ACH transfer" },
  { value: "check", label: "Check" },
  { value: "wire", label: "Wire" },
  { value: "card", label: "Card" },
  { value: "other", label: "Other" },
];

function NewBillPayment() {
  const params = useSearchParams();
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  // One key per form: a double click or retry cannot pay twice.
  const [idempotencyKey] = useState(newIdempotencyKey);
  const [vendorId, setVendorId] = useState(params.get("vendorId") ?? "");
  const [payDate, setPayDate] = useState(todayIso());
  const [method, setMethod] = useState("ach");
  const [reference, setReference] = useState("");
  const [payFromAccountId, setPayFrom] = useState("");
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const vendors = useQuery({ queryKey: ["vendor", "list", false], queryFn: () => api<{ data: Vendor[] }>("/vendors?limit=500") });
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: () => api<{ data: Account[] }>("/accounts") });
  const openBills = useQuery({
    queryKey: ["bills", "open", vendorId],
    queryFn: () => api<{ data: OpenBill[] }>(`/bills?status=unpaid&vendorId=${vendorId}&limit=500`),
    enabled: !!vendorId,
  });
  const banks = (accounts.data?.data ?? []).filter((a) => a.type === "asset" && a.subtype === "bank");
  useEffect(() => {
    const operating = banks.find((a) => a.systemKey === "cash_operating") ?? banks[0];
    if (!payFromAccountId && operating) setPayFrom(operating.id);
  }, [banks, payFromAccountId]);
  useEffect(() => {
    if (!openBills.data) return;
    const target = params.get("billId");
    setAmounts(target ? Object.fromEntries(openBills.data.data.filter((b) => b.id === target).map((b) => [b.id, b.balanceDue])) : {});
  }, [openBills.data, params]);

  const total = useMemo(() => Object.values(amounts).reduce((a, v) => a + (parse(v) ?? 0n), 0n), [amounts]);
  const bank = banks.find((a) => a.id === payFromAccountId);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const applications = Object.entries(amounts)
      .filter(([, v]) => (parse(v) ?? 0n) > 0n)
      .map(([billId, amount]) => ({ billId, amount }));
    if (!vendorId) return setError("Choose a vendor.");
    if (applications.length === 0) return setError("Choose at least one bill and an amount.");
    setSaving(true);
    try {
      const payment = await api<{ id: string; number: string }>("/bill-payments", {
        method: "POST",
        headers: { "idempotency-key": idempotencyKey },
        body: { vendorId, date: payDate, method, reference: reference || null, payFromAccountId, applications },
      });
      qc.invalidateQueries();
      toast.success(`Payment ${payment.number} recorded.`);
      router.push(`/bill-payments/${payment.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not record the payment.");
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-6">
      <FormError message={error} />
      <Card className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Vendor" required>
          {(p) => (
            <Select {...p} value={vendorId} onChange={(e) => (setVendorId(e.target.value), setAmounts({}))}>
              <option value="">Choose a vendor…</option>
              {vendors.data?.data.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.displayName}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Pay from" hint={bank ? `Balance ${money(bank.balance)}` : undefined}>
          {(p) => (
            <Select {...p} value={payFromAccountId} onChange={(e) => setPayFrom(e.target.value)}>
              {banks.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.number} {a.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Payment date" required>{(p) => <Input {...p} type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} />}</Field>
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
        <Field label="Reference" hint="Check number or transfer ID.">{(p) => <Input {...p} value={reference} onChange={(e) => setReference(e.target.value)} />}</Field>
      </Card>
      <Card>
        <CardHeader
          title="Bills to pay"
          action={
            openBills.data && openBills.data.data.length > 0 && (
              <Button size="sm" variant="secondary" onClick={() => setAmounts(Object.fromEntries(openBills.data!.data.map((b) => [b.id, b.balanceDue])))}>
                Pay all in full
              </Button>
            )
          }
        />
        {!vendorId ? (
          <p className="px-4 py-6 text-sm text-muted">Choose a vendor to see their unpaid bills.</p>
        ) : openBills.data?.data.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted">This vendor has no unpaid bills.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted">
                  <th className="px-4 py-2 font-medium">Bill</th>
                  <th className="px-4 py-2 font-medium">Due</th>
                  <th className="px-4 py-2 text-right font-medium">Open balance</th>
                  <th className="w-40 px-4 py-2 text-right font-medium">Payment</th>
                </tr>
              </thead>
              <tbody>
                {openBills.data?.data.map((b) => (
                  <tr key={b.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-2">
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          aria-label={`Pay ${b.number}`}
                          checked={!!amounts[b.id]}
                          onChange={(e) =>
                            setAmounts((a) => {
                              const n = { ...a };
                              if (e.target.checked) n[b.id] = b.balanceDue;
                              else delete n[b.id];
                              return n;
                            })
                          }
                        />
                        <span className="font-medium">{b.number}</span>
                        <span className="text-xs text-muted">{b.vendorReference}</span>
                      </label>
                    </td>
                    <td className={`px-4 py-2 ${b.daysOverdue > 0 ? "text-danger" : ""}`}>{date(b.dueDate)}</td>
                    <td className="px-4 py-2 text-right">
                      <Money value={b.balanceDue} />
                    </td>
                    <td className="px-4 py-2">
                      <Input aria-label={`Amount for ${b.number}`} value={amounts[b.id] ?? ""} onChange={(e) => setAmounts((a) => ({ ...a, [b.id]: e.target.value }))} inputMode="decimal" className="text-right" placeholder="0.00" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="border-t border-border p-4 text-right text-base font-semibold">
          Payment total <span className="tabular">{money(format2(total))}</span>
        </div>
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
        breadcrumb={<Link href="/bill-payments" className="hover:underline">Bill Payments</Link>}
        title="Pay bills"
        description="Records money paid to a vendor: Dr Accounts Payable / Cr the bank account. 4VEKO does not move money."
      />
      <Suspense>
        <NewBillPayment />
      </Suspense>
    </>
  );
}
