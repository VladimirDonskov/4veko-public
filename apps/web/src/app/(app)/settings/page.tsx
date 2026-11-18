"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, Trash2, UserPlus } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, FormError, Input, Select } from "@/components/ui/inputs";
import { Badge, Card, CardHeader, ErrorState, LoadingRows, PageHeader } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { api, ApiError } from "@/lib/api";
import { date } from "@/lib/format";
import { useCan, useMe } from "@/lib/session";

type Org = { id: string; name: string; legalName: string | null; phone: string | null; email: string | null; fiscalYearStartMonth: number; defaultTaxRate: string; booksClosedThrough: string | null; address: { line1?: string; city?: string; state?: string; postalCode?: string } | null };
type Member = { id: string; userId: string; name: string; email: string; role: string };

const ROLES = [
  { value: "owner", label: "Owner", text: "Everything, including other owners" },
  { value: "admin", label: "Admin", text: "Everything except changing owners" },
  { value: "accountant", label: "Accountant", text: "Books, payments, inventory, reports, audit log" },
  { value: "sales", label: "Sales", text: "Customers, items, sales orders and invoices" },
  { value: "viewer", label: "Viewer", text: "Read-only access and reports" },
];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export default function SettingsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const me = useMe();
  const canManage = useCan("org.manage");
  const canMembers = useCan("members.manage");
  const org = useQuery({ queryKey: ["org"], queryFn: () => api<Org>("/org") });
  const members = useQuery({ queryKey: ["members"], queryFn: () => api<Member[]>("/org/members") });
  const [adding, setAdding] = useState(false);

  const saveOrg = useMutation({
    mutationFn: (body: unknown) => api<Org>("/org", { method: "PATCH", body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["org"] });
      qc.invalidateQueries({ queryKey: ["me"] });
      toast.success("Settings saved.");
    },
    onError: (e) => toast.error(e.message),
  });
  const changeRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: string }) => api(`/org/members/${id}`, { method: "PATCH", body: { role } }),
    onSuccess: () => (qc.invalidateQueries({ queryKey: ["members"] }), toast.success("Role updated.")),
    onError: (e) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/org/members/${id}`, { method: "DELETE" }),
    onSuccess: () => (qc.invalidateQueries({ queryKey: ["members"] }), toast.success("Member removed and signed out.")),
    onError: (e) => toast.error(e.message),
  });

  if (org.error) return <ErrorState error={org.error} />;
  if (!org.data) return <LoadingRows />;
  const o = org.data;

  return (
    <>
      <PageHeader title="Settings" description="Company profile, tax defaults, period close and your team." />
      <div className="flex max-w-4xl flex-col gap-6">
        <Card>
          <CardHeader title="Company" />
          <form
            className="grid gap-4 p-4 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              saveOrg.mutate({
                name: f.get("name"),
                legalName: f.get("legalName") || null,
                email: f.get("email") || null,
                phone: f.get("phone") || null,
                fiscalYearStartMonth: Number(f.get("fy")),
                defaultTaxRate: f.get("tax") || "0",
                address: { line1: String(f.get("line1") || "") || undefined, city: String(f.get("city") || "") || undefined, state: String(f.get("state") || "") || undefined, postalCode: String(f.get("zip") || "") || undefined, country: "US" },
              });
            }}
          >
            <fieldset disabled={!canManage} className="contents">
              <Field label="Company name" required>{(p) => <Input {...p} name="name" defaultValue={o.name} />}</Field>
              <Field label="Legal name">{(p) => <Input {...p} name="legalName" defaultValue={o.legalName ?? ""} />}</Field>
              <Field label="Billing email">{(p) => <Input {...p} name="email" type="email" defaultValue={o.email ?? ""} />}</Field>
              <Field label="Phone">{(p) => <Input {...p} name="phone" defaultValue={o.phone ?? ""} />}</Field>
              <Field label="Street address" className="sm:col-span-2">{(p) => <Input {...p} name="line1" defaultValue={o.address?.line1 ?? ""} />}</Field>
              <Field label="City">{(p) => <Input {...p} name="city" defaultValue={o.address?.city ?? ""} />}</Field>
              <div className="grid grid-cols-2 gap-4">
                <Field label="State">{(p) => <Input {...p} name="state" maxLength={2} defaultValue={o.address?.state ?? ""} />}</Field>
                <Field label="ZIP code">{(p) => <Input {...p} name="zip" defaultValue={o.address?.postalCode ?? ""} />}</Field>
              </div>
              <Field label="Fiscal year starts in">
                {(p) => (
                  <Select {...p} name="fy" defaultValue={o.fiscalYearStartMonth}>
                    {MONTHS.map((m, i) => (
                      <option key={m} value={i + 1}>
                        {m}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Default sales tax rate (%)" hint="Applied to taxable lines unless the customer is exempt. Not a substitute for a tax engine.">
                {(p) => <Input {...p} name="tax" inputMode="decimal" defaultValue={Number(o.defaultTaxRate)} />}
              </Field>
              {canManage && (
                <div className="sm:col-span-2">
                  <Button type="submit" loading={saveOrg.isPending}>
                    Save company settings
                  </Button>
                </div>
              )}
            </fieldset>
          </form>
        </Card>

        <Card>
          <CardHeader title={<span className="flex items-center gap-2"><Lock className="size-4" aria-hidden /> Close the books</span>} description="No one can post, void or reverse with a date on or before the closed date, including through the API." />
          <form
            className="flex flex-wrap items-end gap-3 p-4"
            onSubmit={(e) => {
              e.preventDefault();
              const v = String(new FormData(e.currentTarget).get("closed") || "");
              saveOrg.mutate({ booksClosedThrough: v || null });
            }}
          >
            <Field label="Books closed through">{(p) => <Input {...p} name="closed" type="date" defaultValue={o.booksClosedThrough ?? ""} disabled={!canManage} key={o.booksClosedThrough ?? "open"} />}</Field>
            {canManage && <Button type="submit" variant="secondary">Update</Button>}
            <p className="w-full text-sm text-muted">{o.booksClosedThrough ? `Currently closed through ${date(o.booksClosedThrough)}. Clear the date to reopen.` : "All periods are open."}</p>
          </form>
        </Card>

        <Card>
          <CardHeader
            title="Team"
            description="Roles decide what each person can change. Everyone can read business records."
            action={
              canMembers && (
                <Button size="sm" onClick={() => setAdding(true)}>
                  <UserPlus /> Add member
                </Button>
              )
            }
          />
          {!members.data ? (
            <LoadingRows rows={3} />
          ) : (
            <ul className="divide-y divide-border">
              {members.data.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">
                      {m.name} {m.userId === me.data?.user.id && <Badge>You</Badge>}
                    </p>
                    <p className="truncate text-sm text-muted">{m.email}</p>
                  </div>
                  {canMembers && m.userId !== me.data?.user.id ? (
                    <>
                      <Select aria-label={`Role for ${m.name}`} className="w-40" value={m.role} onChange={(e) => changeRole.mutate({ id: m.id, role: e.target.value })}>
                        {ROLES.map((r) => (
                          <option key={r.value} value={r.value}>
                            {r.label}
                          </option>
                        ))}
                      </Select>
                      <Button variant="ghost" size="icon" aria-label={`Remove ${m.name}`} onClick={() => confirm(`Remove ${m.name} from the organization?`) && remove.mutate(m.id)}>
                        <Trash2 />
                      </Button>
                    </>
                  ) : (
                    <Badge tone="accent">{ROLES.find((r) => r.value === m.role)?.label ?? m.role}</Badge>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <AddMemberDialog open={adding} onOpenChange={setAdding} />
    </>
  );
}

function AddMemberDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [role, setRole] = useState("accountant");
  const add = useMutation({
    mutationFn: (body: unknown) => api("/org/members", { method: "POST", body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["members"] });
      toast.success("Member added. Share their temporary password with them securely.");
      onOpenChange(false);
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add a team member"
      description="Email invitations are planned. For now, set a temporary password and share it securely."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="member-form" loading={add.isPending}>
            Add member
          </Button>
        </>
      }
    >
      <form
        id="member-form"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          add.mutate({ name: f.get("name"), email: f.get("email"), role, temporaryPassword: f.get("password") || undefined });
        }}
      >
        <FormError message={add.error instanceof ApiError ? add.error.message : null} />
        <Field label="Name" required>{(p) => <Input {...p} name="name" autoFocus />}</Field>
        <Field label="Email" required>{(p) => <Input {...p} name="email" type="email" />}</Field>
        <Field label="Temporary password" hint="Needed only if they do not have a 4VEKO account yet. At least 10 characters.">
          {(p) => <Input {...p} name="password" type="password" autoComplete="new-password" />}
        </Field>
        <fieldset>
          <legend className="mb-1.5 text-[13px] font-medium">Role</legend>
          <div className="flex flex-col gap-1.5">
            {ROLES.map((r) => (
              <label key={r.value} className={`flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm ${role === r.value ? "border-accent bg-accent-soft" : "border-border"}`}>
                <input type="radio" name="role" value={r.value} checked={role === r.value} onChange={() => setRole(r.value)} className="mt-1" />
                <span>
                  <span className="font-medium">{r.label}</span>
                  <span className="block text-xs text-muted">{r.text}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      </form>
    </Dialog>
  );
}
