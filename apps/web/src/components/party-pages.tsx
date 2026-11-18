"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Pencil, Plus, Users } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { DataTable } from "@/components/data-table";
import { Button, ButtonLink } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, FormError, Input, Textarea } from "@/components/ui/inputs";
import { Badge, Card, CardHeader, DescriptionList, EmptyState, ErrorState, LoadingRows, Money, PageHeader, StatusBadge } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { api, ApiError } from "@/lib/api";
import { date } from "@/lib/format";
import { useCan } from "@/lib/session";

type Kind = "customer" | "vendor";
type Party = {
  id: string;
  displayName: string;
  companyName: string | null;
  email: string | null;
  phone: string | null;
  termsDays: number;
  taxExempt: boolean;
  isActive: boolean;
  balance: string;
  notes?: string | null;
  billingAddress?: { line1?: string; city?: string; state?: string; postalCode?: string } | null;
};

const label = (kind: Kind, plural = false) => (kind === "customer" ? (plural ? "Customers" : "Customer") : plural ? "Vendors" : "Vendor");
const path = (kind: Kind) => (kind === "customer" ? "/customers" : "/vendors");

export function PartyForm({ kind, party, open, onOpenChange, onSaved }: { kind: Kind; party?: Party; open: boolean; onOpenChange: (o: boolean) => void; onSaved?: (p: Party) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: (body: unknown) => (party ? api<Party>(`${path(kind)}/${party.id}`, { method: "PATCH", body }) : api<Party>(path(kind), { method: "POST", body })),
    onSuccess: (p) => {
      qc.invalidateQueries({ queryKey: [kind] });
      toast.success(`${label(kind)} ${party ? "updated" : "created"}: ${p.displayName}`);
      onOpenChange(false);
      onSaved?.(p);
    },
    onError: (err) => err instanceof ApiError && setErrors(err.fieldErrors()),
  });

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErrors({});
    const f = new FormData(e.currentTarget);
    save.mutate({
      displayName: f.get("displayName"),
      companyName: f.get("companyName") || null,
      email: f.get("email") || null,
      phone: f.get("phone") || null,
      termsDays: Number(f.get("termsDays") || 30),
      taxExempt: f.get("taxExempt") === "on",
      notes: f.get("notes") || null,
      billingAddress: {
        line1: String(f.get("line1") || "") || undefined,
        city: String(f.get("city") || "") || undefined,
        state: String(f.get("state") || "") || undefined,
        postalCode: String(f.get("postalCode") || "") || undefined,
        country: "US",
      },
    });
  }

  const a = party?.billingAddress ?? {};
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={party ? `Edit ${party.displayName}` : `New ${label(kind).toLowerCase()}`}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="party-form" loading={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form id="party-form" onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <FormError message={save.error instanceof ApiError && !Object.keys(errors).length ? save.error.message : null} />
        </div>
        <Field label="Display name" required error={errors.displayName} className="sm:col-span-2">
          {(p) => <Input {...p} name="displayName" defaultValue={party?.displayName} autoFocus />}
        </Field>
        <Field label="Company name" error={errors.companyName}>
          {(p) => <Input {...p} name="companyName" defaultValue={party?.companyName ?? ""} />}
        </Field>
        <Field label="Email" error={errors.email}>
          {(p) => <Input {...p} name="email" type="email" defaultValue={party?.email ?? ""} />}
        </Field>
        <Field label="Phone" error={errors.phone}>
          {(p) => <Input {...p} name="phone" type="tel" defaultValue={party?.phone ?? ""} />}
        </Field>
        <Field label="Payment terms (days)" error={errors.termsDays} hint="Net days until an invoice is due.">
          {(p) => <Input {...p} name="termsDays" type="number" min={0} max={365} defaultValue={party?.termsDays ?? 30} />}
        </Field>
        <Field label="Street address" className="sm:col-span-2">
          {(p) => <Input {...p} name="line1" defaultValue={a.line1 ?? ""} autoComplete="street-address" />}
        </Field>
        <Field label="City">{(p) => <Input {...p} name="city" defaultValue={a.city ?? ""} />}</Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="State">{(p) => <Input {...p} name="state" defaultValue={a.state ?? ""} maxLength={2} />}</Field>
          <Field label="ZIP code">{(p) => <Input {...p} name="postalCode" defaultValue={a.postalCode ?? ""} inputMode="numeric" />}</Field>
        </div>
        {kind === "customer" && (
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" name="taxExempt" defaultChecked={party?.taxExempt} /> Tax exempt (no sales tax on invoices)
          </label>
        )}
        <Field label="Notes" className="sm:col-span-2">
          {(p) => <Textarea {...p} name="notes" defaultValue={party?.notes ?? ""} />}
        </Field>
      </form>
    </Dialog>
  );
}

export function PartyList({ kind }: { kind: Kind }) {
  const params = useSearchParams();
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const canWrite = useCan("masterdata.write");
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    if (params.get("new") === "1") setCreating(true);
  }, [params]);

  const q = useQuery({
    queryKey: [kind, "list", showArchived],
    queryFn: () => api<{ data: Party[] }>(`${path(kind)}?limit=500${showArchived ? "&includeArchived=true" : ""}`),
  });
  const archive = useMutation({
    mutationFn: ({ ids, archived }: { ids: string[]; archived: boolean }) => api<{ updated: number }>(`${path(kind)}/bulk-archive`, { method: "POST", body: { ids, archived } }),
    onSuccess: (r, v) => {
      qc.invalidateQueries({ queryKey: [kind] });
      toast.success(`${v.archived ? "Archived" : "Restored"} ${r.updated} ${label(kind, true).toLowerCase()}.`);
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <>
      <PageHeader
        title={label(kind, true)}
        description={kind === "customer" ? "Everyone you sell to, with what they owe you." : "Everyone you buy from."}
        actions={
          canWrite && (
            <Button onClick={() => setCreating(true)}>
              <Plus /> New {label(kind).toLowerCase()}
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
            id={kind}
            rows={q.data.data}
            href={(r) => `${path(kind)}/${r.id}`}
            initialSort={{ key: "name", dir: "asc" }}
            toolbar={
              <label className="flex items-center gap-2 text-sm text-muted">
                <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived
              </label>
            }
            empty={
              <EmptyState
                icon={<Users />}
                title={`No ${label(kind, true).toLowerCase()} yet`}
                description={kind === "customer" ? "Add a customer to start selling." : "Add the vendors you buy from."}
                action={canWrite && <Button onClick={() => setCreating(true)}>New {label(kind).toLowerCase()}</Button>}
              />
            }
            bulkActions={
              canWrite
                ? (rows, clear) => (
                    <>
                      <Button size="sm" variant="secondary" onClick={() => archive.mutate({ ids: rows.map((r) => r.id), archived: true }, { onSuccess: clear })}>
                        <Archive /> Archive
                      </Button>
                      {showArchived && (
                        <Button size="sm" variant="secondary" onClick={() => archive.mutate({ ids: rows.map((r) => r.id), archived: false }, { onSuccess: clear })}>
                          Restore
                        </Button>
                      )}
                    </>
                  )
                : undefined
            }
            columns={[
              {
                key: "name",
                header: "Name",
                value: (r) => r.displayName,
                cell: (r) => (
                  <span className="flex items-center gap-2">
                    <span className="font-medium">{r.displayName}</span>
                    {!r.isActive && <Badge>Archived</Badge>}
                    {r.taxExempt && <Badge tone="info">Tax exempt</Badge>}
                  </span>
                ),
              },
              { key: "email", header: "Email", value: (r) => r.email, cell: (r) => <span className="text-muted">{r.email ?? "—"}</span>, hideBelow: "md" },
              { key: "phone", header: "Phone", value: (r) => r.phone, cell: (r) => <span className="text-muted">{r.phone ?? "—"}</span>, hideBelow: "lg" },
              { key: "terms", header: "Terms", value: (r) => r.termsDays, cell: (r) => `Net ${r.termsDays}`, hideBelow: "sm" },
              ...(kind === "customer"
                ? [{ key: "balance", header: "Open balance", align: "right" as const, value: (r: Party) => Number(r.balance), cell: (r: Party) => <Money value={r.balance} /> }]
                : []),
            ]}
          />
        )}
      </Card>
      <PartyForm kind={kind} open={creating} onOpenChange={(o) => (setCreating(o), !o && params.get("new") && router.replace(path(kind)))} onSaved={(p) => router.push(`${path(kind)}/${p.id}`)} />
    </>
  );
}

type PartyDetailData = Party & {
  invoices: { id: string; number: string; issueDate: string; dueDate: string; status: string; total: string; balanceDue: string }[];
  payments: { id: string; number: string; date: string; amount: string; unappliedAmount: string; method: string }[];
  bills?: { id: string; number: string; vendorReference: string; dueDate: string; status: string; total: string; balanceDue: string }[];
  billPayments?: { id: string; number: string; date: string; amount: string; method: string }[];
  purchaseOrders?: { id: string; number: string; orderDate: string; status: string; total: string }[];
};

function VendorActivity({ p, today }: { p: PartyDetailData; today: string }) {
  return (
    <div className="mt-6 grid gap-6 lg:grid-cols-3">
      <Card>
        <CardHeader title="Bills" />
        {!p.bills?.length ? (
          <p className="px-4 py-6 text-sm text-muted">No bills yet.</p>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {p.bills.map((b) => (
              <li key={b.id} className="flex items-center justify-between gap-2 px-4 py-2">
                <span>
                  <Link href={`/bills/${b.id}`} className="font-medium text-accent hover:underline">
                    {b.number}
                  </Link>
                  <span className="block text-xs text-muted">
                    {b.vendorReference} · due {date(b.dueDate)}
                  </span>
                </span>
                <StatusBadge status={b.status} overdue={b.dueDate < today} />
                <Money value={b.status === "paid" || b.status === "void" ? b.total : b.balanceDue} />
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card>
        <CardHeader title="Purchase orders" />
        {!p.purchaseOrders?.length ? (
          <p className="px-4 py-6 text-sm text-muted">No purchase orders yet.</p>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {p.purchaseOrders.map((o) => (
              <li key={o.id} className="flex items-center justify-between gap-2 px-4 py-2">
                <span>
                  <Link href={`/purchase-orders/${o.id}`} className="font-medium text-accent hover:underline">
                    {o.number}
                  </Link>
                  <span className="block text-xs text-muted">{date(o.orderDate)}</span>
                </span>
                <StatusBadge status={o.status} />
                <Money value={o.total} />
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card>
        <CardHeader title="Payments" />
        {!p.billPayments?.length ? (
          <p className="px-4 py-6 text-sm text-muted">No payments yet.</p>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {p.billPayments.map((bp) => (
              <li key={bp.id} className="flex items-center justify-between gap-2 px-4 py-2">
                <span>
                  <Link href={`/bill-payments/${bp.id}`} className="font-medium text-accent hover:underline">
                    {bp.number}
                  </Link>
                  <span className="block text-xs text-muted">
                    {date(bp.date)} · {bp.method.toUpperCase()}
                  </span>
                </span>
                <Money value={bp.amount} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

export function PartyDetail({ kind, id }: { kind: Kind; id: string }) {
  const canWrite = useCan("masterdata.write");
  const [editing, setEditing] = useState(false);
  const q = useQuery({ queryKey: [kind, id], queryFn: () => api<PartyDetailData>(`${path(kind)}/${id}`) });
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  if (!q.data) return <LoadingRows />;
  const p = q.data;
  const a = p.billingAddress;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <PageHeader
        breadcrumb={<Link href={path(kind)} className="hover:underline">{label(kind, true)}</Link>}
        title={p.displayName}
        description={p.companyName ?? undefined}
        actions={
          <>
            {canWrite && (
              <Button variant="secondary" onClick={() => setEditing(true)}>
                <Pencil /> Edit
              </Button>
            )}
            {kind === "customer" && (
              <>
                <ButtonLink variant="secondary" href={`/payments/new?customerId=${p.id}`}>
                  Record payment
                </ButtonLink>
                <ButtonLink href={`/sales-orders/new?customerId=${p.id}`}>
                  <Plus /> New sales order
                </ButtonLink>
              </>
            )}
            {kind === "vendor" && (
              <>
                <ButtonLink variant="secondary" href={`/bill-payments/new?vendorId=${p.id}`}>
                  Pay bills
                </ButtonLink>
                <ButtonLink variant="secondary" href={`/bills/new?vendorId=${p.id}`}>
                  Enter bill
                </ButtonLink>
                <ButtonLink href={`/purchase-orders/new?vendorId=${p.id}`}>
                  <Plus /> New purchase order
                </ButtonLink>
              </>
            )}
          </>
        }
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="p-4 lg:col-span-2">
          <DescriptionList
            items={[
              { label: "Email", value: p.email },
              { label: "Phone", value: p.phone },
              { label: "Payment terms", value: `Net ${p.termsDays}` },
              ...(kind === "customer" ? [{ label: "Sales tax", value: p.taxExempt ? "Exempt" : "Taxable" }] : []),
              { label: "Billing address", value: a?.line1 ? `${a.line1}, ${a.city ?? ""} ${a.state ?? ""} ${a.postalCode ?? ""}` : null },
              { label: "Status", value: p.isActive ? "Active" : "Archived" },
            ]}
          />
          {p.notes && <p className="mt-4 whitespace-pre-wrap border-t border-border pt-3 text-sm text-muted">{p.notes}</p>}
        </Card>
        <Card className="p-4">
          <p className="text-xs text-muted">{kind === "customer" ? "Open balance" : "You owe"}</p>
          <p className="mt-1 text-3xl font-semibold tracking-tight">
            <Money value={p.balance} />
          </p>
          {Number(p.balance) < 0 && <p className="mt-1 text-xs text-muted">The customer has an unapplied credit.</p>}
        </Card>
      </div>
      {kind === "vendor" && <VendorActivity p={p} today={today} />}
      {kind === "customer" && (
        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader title="Invoices" />
            {p.invoices.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted">No invoices yet.</p>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {p.invoices.map((i) => (
                    <tr key={i.id} className="border-b border-border last:border-0">
                      <td className="px-4 py-2">
                        <Link href={`/invoices/${i.id}`} className="font-medium text-accent hover:underline">
                          {i.number}
                        </Link>
                        <div className="text-xs text-muted">Due {date(i.dueDate)}</div>
                      </td>
                      <td className="px-2 py-2">
                        <StatusBadge status={i.status} overdue={i.dueDate < today} />
                      </td>
                      <td className="px-4 py-2 text-right">
                        <Money value={i.total} />
                        {i.status !== "paid" && i.status !== "void" && (
                          <div className="text-xs text-muted">
                            <Money value={i.balanceDue} /> due
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
          <Card>
            <CardHeader title="Payments" />
            {p.payments.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted">No payments yet.</p>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {p.payments.map((pm) => (
                    <tr key={pm.id} className="border-b border-border last:border-0">
                      <td className="px-4 py-2">
                        <Link href={`/payments/${pm.id}`} className="font-medium text-accent hover:underline">
                          {pm.number}
                        </Link>
                        <div className="text-xs text-muted">
                          {date(pm.date)} · {pm.method.toUpperCase()}
                        </div>
                      </td>
                      <td className="px-4 py-2 text-right">
                        <Money value={pm.amount} />
                        {Number(pm.unappliedAmount) > 0 && (
                          <div className="text-xs text-muted">
                            <Money value={pm.unappliedAmount} /> unapplied
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>
      )}
      <PartyForm kind={kind} party={p} open={editing} onOpenChange={setEditing} />
    </>
  );
}
