"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { DataTable } from "@/components/data-table";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, FormError, Input, Select } from "@/components/ui/inputs";
import { Badge, Card, ErrorState, LoadingRows, Money, PageHeader } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { api, ApiError } from "@/lib/api";
import { humanize } from "@/lib/format";
import { useCan } from "@/lib/session";

type Account = { id: string; number: string; name: string; type: string; subtype: string; systemKey: string | null; isActive: boolean; balance: string; normalBalance: string };
const TYPES = ["asset", "liability", "equity", "revenue", "expense"];

export default function AccountsPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const canWrite = useCan("accounts.write");
  const [creating, setCreating] = useState(false);
  const [type, setType] = useState("expense");
  const q = useQuery({ queryKey: ["accounts"], queryFn: () => api<{ data: Account[]; subtypes: Record<string, string[]> }>("/accounts") });
  const create = useMutation({
    mutationFn: (body: unknown) => api<Account>("/accounts", { method: "POST", body }),
    onSuccess: (a) => {
      qc.invalidateQueries({ queryKey: ["accounts"] });
      toast.success(`Account ${a.number} ${a.name} created.`);
      setCreating(false);
    },
  });

  return (
    <>
      <PageHeader
        title="Chart of Accounts"
        description="Balances are live from posted journal entries. Accounts with a lock are used automatically and cannot be archived."
        actions={
          canWrite && (
            <Button onClick={() => setCreating(true)}>
              <Plus /> New account
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
            id="accounts"
            rows={q.data.data}
            href={(r) => `/accounts/${r.id}`}
            initialSort={{ key: "number", dir: "asc" }}
            facets={{ label: "Types", options: TYPES.map((t) => ({ value: t, label: humanize(t) })) }}
            facetValue={(r) => r.type}
            columns={[
              { key: "number", header: "Number", value: (r) => r.number, cell: (r) => <span className="font-mono">{r.number}</span> },
              {
                key: "name",
                header: "Name",
                value: (r) => r.name,
                cell: (r) => (
                  <span className="flex items-center gap-2 font-medium">
                    {r.name}
                    {r.systemKey && <Lock className="size-3.5 text-muted" aria-label="System account" />}
                  </span>
                ),
              },
              { key: "type", header: "Type", value: (r) => r.type, cell: (r) => <Badge>{humanize(r.type)}</Badge> },
              { key: "subtype", header: "Detail type", value: (r) => r.subtype, cell: (r) => <span className="text-muted">{humanize(r.subtype)}</span>, hideBelow: "md" },
              { key: "balance", header: "Balance", align: "right", value: (r) => Number(r.balance), cell: (r) => <Money value={r.balance} /> },
            ]}
          />
        )}
      </Card>
      <Dialog
        open={creating}
        onOpenChange={setCreating}
        title="New account"
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button type="submit" form="account-form" loading={create.isPending}>
              Create
            </Button>
          </>
        }
      >
        <form
          id="account-form"
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            create.mutate({ number: f.get("number"), name: f.get("name"), type, subtype: f.get("subtype") }, { onSuccess: (a) => router.push(`/accounts/${a.id}`) });
          }}
        >
          <div className="sm:col-span-2">
            <FormError message={create.error instanceof ApiError ? create.error.message : null} />
          </div>
          <Field label="Number" required>
            {(p) => <Input {...p} name="number" placeholder="6150" autoFocus />}
          </Field>
          <Field label="Name" required>
            {(p) => <Input {...p} name="name" />}
          </Field>
          <Field label="Type" required>
            {(p) => (
              <Select {...p} value={type} onChange={(e) => setType(e.target.value)}>
                {TYPES.map((t) => (
                  <option key={t} value={t}>
                    {humanize(t)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Detail type" required>
            {(p) => (
              <Select {...p} name="subtype" key={type}>
                {(q.data?.subtypes[type] ?? []).map((s) => (
                  <option key={s} value={s}>
                    {humanize(s)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </form>
      </Dialog>
    </>
  );
}
