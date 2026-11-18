"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Plus, Send, Trash2, Undo2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useEffect, useState } from "react";
import { FieldInput } from "@/components/config-fields";
import { LedgerImpact } from "@/components/ledger-impact";
import { Button } from "@/components/ui/button";
import { Field, FormError, Input } from "@/components/ui/inputs";
import { Card, CardHeader, ErrorState, LoadingRows, PageHeader, StatusBadge } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { api, ApiError } from "@/lib/api";
import { displayValue, fieldLabel, NUMERIC, useConfig, type FieldMeta, type StoredRecord } from "@/lib/config";
import { todayIso } from "@/lib/format";
import { useCan } from "@/lib/session";

type Rows = Record<string, Record<string, unknown>[]>;

export default function ConfiguredRecordPage({ params }: { params: Promise<{ type: string; id: string }> }) {
  const { type, id } = use(params);
  const isNew = id === "new";
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const canWrite = useCan("masterdata.write");
  const canPost = useCan("journal.post");
  const config = useConfig();
  const meta = config.data?.metadata;
  const doc = meta?.documents.find((d) => d.name === type);
  const cat = meta?.catalogs.find((c) => c.name === type);
  const decl = doc ?? cat;

  const q = useQuery({ queryKey: ["x", type, id], queryFn: () => api<StoredRecord>(`/x/${type}/${id}`), enabled: !isNew && !!decl });
  const [data, setData] = useState<Record<string, unknown>>({});
  const [tables, setTables] = useState<Rows>({});
  const [docDate, setDocDate] = useState(todayIso());
  const [error, setError] = useState<{ message: string; line?: number } | null>(null);
  const [messages, setMessages] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (q.data) {
      setData(q.data.data);
      setTables(q.data.tables);
      if (q.data.date) setDocDate(q.data.date);
    } else if (isNew && doc) {
      setTables(Object.fromEntries(doc.tables.map((t) => [t.name, [{}]])));
    }
  }, [q.data, isNew, doc]);

  if (config.error) return <ErrorState error={config.error} />;
  if (!meta || (!isNew && !q.data && !q.error)) return <LoadingRows />;
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  if (!decl) return <ErrorState error={new Error(`"${type}" is not in the configuration.`)} />;
  const rec = q.data;
  const readOnly = !canWrite;

  async function submit(action: "save" | "post" | "unpost") {
    setBusy(action);
    setError(null);
    try {
      let result: StoredRecord;
      if (action === "unpost") {
        result = await api<StoredRecord>(`/x/${type}/${id}/unpost`, { method: "POST" });
      } else {
        const body = {
          ...(doc ? { date: docDate } : {}),
          data: Object.fromEntries(decl!.fields.map((f) => [f.name, emptyToNull(data[f.name])])),
          ...(doc
            ? {
                tables: Object.fromEntries(
                  doc.tables.map((t) => [t.name, (tables[t.name] ?? []).filter((row) => t.columns.some((c) => !isEmpty(row[c.name]))).map((row) => Object.fromEntries(t.columns.map((c) => [c.name, emptyToNull(row[c.name])])))]),
                ),
              }
            : {}),
          post: action === "post",
        };
        result = isNew ? await api<StoredRecord>(`/x/${type}`, { method: "POST", body }) : await api<StoredRecord>(`/x/${type}/${id}`, { method: "PUT", body });
      }
      qc.invalidateQueries({ queryKey: ["x", type] });
      qc.invalidateQueries({ queryKey: ["ref-options", type] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      setMessages(result.messages ?? []);
      toast.success(action === "post" ? `${result.number ?? "Saved"} posted.` : action === "unpost" ? "Unposted." : "Saved.");
      if (isNew) router.replace(`/x/${type}/${result.id}`);
      else {
        setData(result.data);
        setTables(result.tables);
        qc.setQueryData(["x", type, id], (old: StoredRecord | undefined) => ({ ...(old ?? result), ...result }));
        q.refetch();
      }
    } catch (err) {
      setError(err instanceof ApiError ? { message: err.message, line: err.details?.line as number | undefined } : { message: "Something went wrong." });
    } finally {
      setBusy(null);
    }
  }

  const title = isNew ? `New ${fieldLabel(type).toLowerCase()}` : (rec?.number ?? rec?.label ?? fieldLabel(type));
  return (
    <>
      <PageHeader
        breadcrumb={<Link href={`/x/${type}`} className="hover:underline">{fieldLabel(type)}</Link>}
        title={
          <span className="flex items-center gap-3">
            {title} {doc && !isNew && <StatusBadge status={rec?.posted ? "posted" : "draft"} />}
          </span>
        }
        actions={
          !readOnly && (
            <>
              {doc && rec?.posted && canPost && (
                <Button variant="ghost" onClick={() => submit("unpost")} loading={busy === "unpost"} disabled={!!busy}>
                  <Undo2 /> Unpost
                </Button>
              )}
              <Button variant={doc && canPost ? "secondary" : "primary"} onClick={() => submit("save")} loading={busy === "save"} disabled={!!busy}>
                {rec?.posted ? "Save (unposts)" : "Save"}
              </Button>
              {doc && canPost && (
                <Button onClick={() => submit("post")} loading={busy === "post"} disabled={!!busy}>
                  <Send /> {rec?.posted ? "Save and repost" : "Save and post"}
                </Button>
              )}
            </>
          )
        }
      />
      <div className="flex flex-col gap-6">
        {error && (
          <div>
            <FormError message={error.message} />
            {error.line && (
              <p className="mt-1 text-xs text-muted">
                The message comes from line {error.line} of the configuration. <Link href="/configurator" className="text-accent hover:underline">Open the Configurator</Link>
              </p>
            )}
          </div>
        )}
        {messages.length > 0 && (
          <div role="status" className="rounded-md border border-border bg-surface px-3 py-2 text-sm">
            {messages.map((m, i) => (
              <p key={i} className="flex items-center gap-2">
                <CheckCircle2 className="size-4 text-success" aria-hidden /> {m}
              </p>
            ))}
          </div>
        )}
        <Card className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3">
          {doc && (
            <Field label="Date" required>
              {(p) => <Input {...p} type="date" value={docDate} onChange={(e) => setDocDate(e.target.value)} disabled={readOnly} />}
            </Field>
          )}
          {decl.fields.map((f) => (
            <Field key={f.name} label={fieldLabel(f.name)} required={f.required}>
              {(p) => <FieldInput field={f} id={p.id} label={fieldLabel(f.name)} value={data[f.name]} onChange={(v) => setData((d) => ({ ...d, [f.name]: v }))} disabled={readOnly} />}
            </Field>
          ))}
        </Card>
        {doc?.tables.map((t) => (
          <TableEditor
            key={t.name}
            name={t.name}
            columns={t.columns}
            rows={tables[t.name] ?? []}
            readOnly={readOnly}
            onChange={(rows) => setTables((x) => ({ ...x, [t.name]: rows }))}
          />
        ))}
        {rec?.journalEntryId && <LedgerImpact entryId={rec.journalEntryId} />}
        {rec?.movements && rec.movements.length > 0 && (
          <Card>
            <CardHeader title="Register movements" description="Written when this document posted" />
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted">
                    <th className="px-4 py-2 font-medium">Register</th>
                    <th className="px-4 py-2 font-medium">Dimensions</th>
                    <th className="px-4 py-2 text-right font-medium">Change</th>
                  </tr>
                </thead>
                <tbody>
                  {rec.movements.map((m, i) => {
                    const reg = meta.registers.find((r) => r.name === m.register);
                    return (
                      <tr key={i} className="border-b border-border last:border-0">
                        <td className="px-4 py-2">
                          <Link href={`/x/registers/${m.register}`} className="text-accent hover:underline">
                            {fieldLabel(m.register)}
                          </Link>
                        </td>
                        <td className="px-4 py-2">
                          {(reg?.dimensions ?? []).map((d) => `${fieldLabel(d.name)}: ${displayValue(d.type, m.dimensions[d.name], rec.labels)}`).join(" · ")}
                        </td>
                        <td className="px-4 py-2 text-right tabular">
                          {(reg?.resources ?? []).map((r) => `${Number(m.resources[r.name]) > 0 ? "+" : ""}${displayValue(r.type, m.resources[r.name], rec.labels)} ${fieldLabel(r.name).toLowerCase()}`).join(", ")}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>
    </>
  );
}

function TableEditor({ name, columns, rows, readOnly, onChange }: { name: string; columns: FieldMeta[]; rows: Record<string, unknown>[]; readOnly: boolean; onChange: (rows: Record<string, unknown>[]) => void }) {
  return (
    <Card>
      <CardHeader
        title={fieldLabel(name)}
        action={
          !readOnly && (
            <Button size="sm" variant="secondary" onClick={() => onChange([...rows, {}])}>
              <Plus /> Add row
            </Button>
          )
        }
      />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted">
              <th className="w-10 px-3 py-2 font-medium">#</th>
              {columns.map((c) => (
                <th key={c.name} className={`px-3 py-2 font-medium ${NUMERIC.has(c.type) ? "text-right" : ""}`}>
                  {fieldLabel(c.name)}
                  {c.required && <span className="text-danger" aria-hidden> *</span>}
                </th>
              ))}
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={columns.length + 2} className="px-3 py-4 text-center text-muted">
                  No rows.
                </td>
              </tr>
            )}
            {rows.map((row, i) => (
              <tr key={i} className="border-b border-border last:border-0">
                <td className="px-3 py-2 text-muted">{i + 1}</td>
                {columns.map((c) => (
                  <td key={c.name} className="px-3 py-2">
                    <FieldInput
                      field={c}
                      label={`${fieldLabel(name)} row ${i + 1} ${fieldLabel(c.name)}`}
                      value={row[c.name]}
                      disabled={readOnly}
                      onChange={(v) => onChange(rows.map((r, j) => (j === i ? { ...r, [c.name]: v } : r)))}
                    />
                  </td>
                ))}
                <td className="px-1">
                  {!readOnly && (
                    <Button variant="ghost" size="icon" aria-label={`Remove ${fieldLabel(name)} row ${i + 1}`} onClick={() => onChange(rows.filter((_, j) => j !== i))}>
                      <Trash2 />
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

const isEmpty = (v: unknown) => v === null || v === undefined || v === "";
const emptyToNull = (v: unknown) => (isEmpty(v) ? null : v);
