"use client";

import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { Archive, CheckCircle2, Plus, RotateCcw, Save, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FormError, Input } from "@/components/ui/inputs";
import { Badge, Card, CardHeader, PageHeader } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api";
import { can, COLLECTION, label, objectMeta, platform, show, STATUS_TONE, type AppInfo, type FieldMeta, type PlatformObject, type RowsMeta, type Value } from "@/lib/platform";
import { defaultDraft, draftProblem, FieldInput, fromDraft, toDraft, type Draft } from "./fields";

type Drafts = Record<string, Draft>;
type Problem = { message: string; code?: string; kind?: string; line?: number; col?: number };

function initialFields(fields: FieldMeta[], object?: PlatformObject): Drafts {
  return Object.fromEntries(fields.map((f) => [f.name, object ? toDraft(f.type, object.fields[f.name]) : defaultDraft(f)]));
}

function initialRows(rows: RowsMeta[], object?: PlatformObject): Record<string, Drafts[]> {
  return Object.fromEntries(rows.map((r) => [r.name, (object?.rows?.[r.name] ?? []).map((row) => Object.fromEntries(r.fields.map((f) => [f.name, toDraft(f.type, row[f.name] as Value)])))]));
}

/**
 * Where a platform message points: `Products: "name" is required.` → "name";
 * `GoodsReceipt items line 2: "quantity" ...` → "rows.items.1.quantity".
 */
export function fieldOfMessage(message: string): string | null {
  const m = /^\w+(?: (\w+) line (\d+))?: "(\w+)"/.exec(message);
  if (!m) return null;
  return m[1] ? `rows.${m[1]}.${Number(m[2]) - 1}.${m[3]}` : m[3]!;
}

function problemOf(err: unknown): Problem {
  if (err instanceof ApiError) {
    const d = err.details as { kind?: string; line?: number; col?: number } | undefined;
    return { message: err.message, code: err.code, kind: d?.kind, line: d?.line, col: d?.col };
  }
  return { message: err instanceof Error ? err.message : "Something went wrong." };
}

/** Form generated from metadata for any catalog item or document of a VekoScript application. */
export function ObjectForm({ app, info, type, object }: { app: string; info: AppInfo; type: string; object?: PlatformObject }) {
  const meta = objectMeta(info.metadata, type)!;
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const isDoc = meta.kind === "document";
  const collection = COLLECTION[meta.kind];
  const base = `/platform/${app}/${collection}/${type}`;

  const [fields, setFields] = useState<Drafts>(() => initialFields(meta.fields, object));
  const [rows, setRows] = useState<Record<string, Drafts[]>>(() => initialRows(meta.rows, object));
  const [date, setDate] = useState(object?.date ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<Problem | null>(null);
  const [dirty, setDirty] = useState(false);

  // A saved object coming back from the server replaces the drafts.
  useEffect(() => {
    setFields(initialFields(meta.fields, object));
    setRows(initialRows(meta.rows, object));
    setDate(object?.date ?? "");
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [object?.id, object?.version]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const writable = can(info.you, `${meta.kind}.write`) && !object?.deleted;
  const posted = object?.status === "posted";
  const readOnly = !writable || posted;

  function body() {
    const out: Record<string, unknown> = { fields: Object.fromEntries(meta.fields.map((f) => [f.name, fromDraft(f.type, fields[f.name] ?? null)])) };
    if (isDoc) {
      if (date) out.date = date;
      out.rows = Object.fromEntries(meta.rows.map((r) => [r.name, (rows[r.name] ?? []).map((row) => Object.fromEntries(r.fields.map((f) => [f.name, fromDraft(f.type, row[f.name] ?? null)])))]));
    }
    if (object) out.version = object.version;
    return out;
  }

  function validate() {
    const found: Record<string, string> = {};
    for (const f of meta.fields) {
      const p = draftProblem(f, fields[f.name] ?? null);
      if (p) found[f.name] = p;
    }
    for (const r of meta.rows) {
      (rows[r.name] ?? []).forEach((row, i) => {
        for (const f of r.fields) {
          const p = draftProblem(f, row[f.name] ?? null);
          if (p) found[`rows.${r.name}.${i}.${f.name}`] = p;
        }
      });
    }
    setErrors(found);
    return Object.keys(found).length === 0;
  }

  function fail(err: unknown) {
    const p = problemOf(err);
    setProblem(p);
    const at = fieldOfMessage(p.message);
    if (at) setErrors((e) => ({ ...e, [at]: p.message.replace(/^[^:]*: /, "") }));
  }

  async function saveNow(): Promise<PlatformObject> {
    return object
      ? platform<PlatformObject>(`/apps/${app}/${collection}/${type}/${object.id}`, { method: "PUT", body: body() })
      : platform<PlatformObject>(`/apps/${app}/${collection}/${type}`, { method: "POST", body: body() });
  }

  function refresh(o: PlatformObject) {
    qc.setQueryData(["platform", "object", app, type, o.id], o);
    qc.invalidateQueries({ queryKey: ["platform", "objects", app, type] });
    qc.invalidateQueries({ queryKey: ["platform", "movements", app, o.id] });
  }

  const save = useMutation({
    mutationFn: saveNow,
    onMutate: () => setProblem(null),
    onSuccess: (o) => {
      refresh(o);
      setDirty(false);
      toast.success(object ? "Saved." : `${label(type)} ${o.display ?? ""} created.`);
      if (!object) router.replace(`${base}/${o.id}`);
    },
    onError: fail,
  });

  const action = useMutation({
    mutationFn: async (what: "post" | "reverse" | "archive") => {
      if (what === "archive") {
        await platform(`/apps/${app}/${collection}/${type}/${object!.id}`, { method: "DELETE" });
        return null;
      }
      if (what === "post" && dirty) await saveNow();
      return platform<PlatformObject>(`/apps/${app}/documents/${type}/${object!.id}/${what}`, { method: "POST" });
    },
    onMutate: () => setProblem(null),
    onSuccess: (o, what) => {
      if (o) {
        refresh(o);
        setDirty(false);
        toast.success(what === "post" ? `${o.display} posted.` : `${o.display} reversed.`);
      } else {
        qc.invalidateQueries({ queryKey: ["platform", "objects", app, type] });
        toast.success("Archived.");
        router.replace(base);
      }
    },
    onError: fail,
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (validate()) save.mutate();
  }

  const setField = (name: string, v: Draft) => {
    setFields((s) => ({ ...s, [name]: v }));
    setErrors(({ [name]: _gone, ...rest }) => rest);
    setDirty(true);
  };
  const setCell = (rowsName: string, i: number, name: string, v: Draft) => {
    setRows((s) => ({ ...s, [rowsName]: s[rowsName]!.map((row, j) => (j === i ? { ...row, [name]: v } : row)) }));
    setErrors(({ [`rows.${rowsName}.${i}.${name}`]: _gone, ...rest }) => rest);
    setDirty(true);
  };

  const busy = save.isPending || action.isPending;
  const canPost = isDoc && object && can(info.you, "document.post");

  return (
    <form onSubmit={submit} noValidate>
      <PageHeader
        breadcrumb={
          <Link href={base} className="hover:underline">
            {label(type)}
          </Link>
        }
        title={object ? (object.display ?? label(type)) : `New ${label(type).toLowerCase()}`}
        description={
          object && isDoc ? (
            <span className="inline-flex items-center gap-2">
              <Badge tone={STATUS_TONE[object.status ?? "draft"]}>{label(object.status ?? "draft")}</Badge>
              {object.deleted && <Badge tone="danger">Archived</Badge>}
            </span>
          ) : object?.deleted ? (
            <Badge tone="danger">Archived</Badge>
          ) : undefined
        }
        actions={
          <>
            {!readOnly && (
              <Button type="submit" loading={save.isPending} disabled={busy}>
                <Save /> {object ? "Save" : "Create"}
              </Button>
            )}
            {canPost && object.status !== "posted" && !object.deleted && (
              <Button variant="secondary" loading={action.isPending && action.variables === "post"} disabled={busy} onClick={() => validate() && action.mutate("post")}>
                <CheckCircle2 /> {dirty ? "Save and post" : "Post"}
              </Button>
            )}
            {canPost && object.status === "posted" && (
              <Button variant="secondary" loading={action.isPending && action.variables === "reverse"} disabled={busy} onClick={() => action.mutate("reverse")}>
                <RotateCcw /> Reverse
              </Button>
            )}
            {object && writable && !posted && (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => confirm(`Archive ${object.display ?? "this record"}? It stays available to existing references.`) && action.mutate("archive")}
              >
                <Archive /> Archive
              </Button>
            )}
          </>
        }
      />

      <div className="flex flex-col gap-4">
        {problem && (
          <FormError
            message={`${problem.message}${problem.kind === "rejected" ? "" : problem.code ? ` (${problem.code}${problem.line ? `, line ${problem.line}` : ""})` : ""}`}
          />
        )}
        {posted && <p className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-muted">Posted documents cannot be changed. Reverse it to edit.</p>}

        <Card>
          <CardHeader title="Details" />
          <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2">
            {isDoc && (
              <>
                <Field label="Number">{(p) => <Input {...p} value={object?.number ?? "Assigned on save"} disabled readOnly />}</Field>
                <Field label="Date" hint={object ? undefined : "Today if left empty."}>
                  {(p) => (
                    <Input
                      {...p}
                      type="date"
                      value={date}
                      disabled={readOnly}
                      onChange={(e) => {
                        setDate(e.target.value);
                        setDirty(true);
                      }}
                    />
                  )}
                </Field>
              </>
            )}
            {meta.fields.map((f) => (
              <Field key={f.name} label={label(f.name)} required={f.required} error={errors[f.name]} hint={hintFor(f)}>
                {(p) => <FieldInput app={app} field={f} value={fields[f.name] ?? null} onChange={(v) => setField(f.name, v)} disabled={readOnly} control={p} />}
              </Field>
            ))}
          </div>
        </Card>

        {meta.rows.map((r) => (
          <RowsEditor
            key={r.name}
            app={app}
            rows={r}
            values={rows[r.name] ?? []}
            errors={errors}
            readOnly={readOnly}
            onCell={(i, name, v) => setCell(r.name, i, name, v)}
            onAdd={() => {
              setRows((s) => ({ ...s, [r.name]: [...(s[r.name] ?? []), initialFields(r.fields)] }));
              setDirty(true);
            }}
            onRemove={(i) => {
              setRows((s) => ({ ...s, [r.name]: s[r.name]!.filter((_, j) => j !== i) }));
              setErrors({});
              setDirty(true);
            }}
          />
        ))}

        {isDoc && object && object.status !== "draft" && can(info.you, "register.read") && <Movements app={app} info={info} id={object.id} />}
      </div>
    </form>
  );
}

function hintFor(f: FieldMeta) {
  const t = f.type;
  if (t.kind === "decimal") return t.scale ? `Up to ${t.scale} decimal places.` : "Whole number.";
  if (t.kind === "dateTime") return "UTC.";
  if (t.kind === "string" && t.maxLength) return undefined;
  return undefined;
}

function RowsEditor({
  app,
  rows,
  values,
  errors,
  readOnly,
  onCell,
  onAdd,
  onRemove,
}: {
  app: string;
  rows: RowsMeta;
  values: Drafts[];
  errors: Record<string, string>;
  readOnly: boolean;
  onCell: (i: number, name: string, v: Draft) => void;
  onAdd: () => void;
  onRemove: (i: number) => void;
}) {
  const rowErrors = Object.entries(errors).filter(([k]) => k.startsWith(`rows.${rows.name}.`));
  return (
    <Card>
      <CardHeader
        title={label(rows.name)}
        description={`${values.length} line${values.length === 1 ? "" : "s"}`}
        action={
          !readOnly && (
            <Button size="sm" variant="secondary" onClick={onAdd}>
              <Plus /> Add line
            </Button>
          )
        }
      />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted">
              <th className="w-10 px-3 py-2 font-medium">#</th>
              {rows.fields.map((f) => (
                <th key={f.name} className={`px-2 py-2 font-medium ${f.type.kind === "decimal" || f.type.kind === "integer" ? "text-right" : ""}`}>
                  {label(f.name)}
                  {f.required && <span className="text-danger" aria-hidden> *</span>}
                </th>
              ))}
              {!readOnly && <th className="w-10" aria-label="Remove" />}
            </tr>
          </thead>
          <tbody>
            {values.length === 0 && (
              <tr>
                <td colSpan={rows.fields.length + 2} className="px-3 py-6 text-center text-muted">
                  No lines yet.
                </td>
              </tr>
            )}
            {values.map((row, i) => (
              <tr key={i} className="border-b border-border last:border-0">
                <td className="px-3 py-1.5 text-muted tabular">{i + 1}</td>
                {rows.fields.map((f) => {
                  const err = errors[`rows.${rows.name}.${i}.${f.name}`];
                  return (
                    <td key={f.name} className="px-2 py-1.5 align-top">
                      <FieldInput
                        app={app}
                        field={f}
                        value={row[f.name] ?? null}
                        onChange={(v) => onCell(i, f.name, v)}
                        disabled={readOnly}
                        compact
                        label={`${label(f.name)}, line ${i + 1}`}
                        control={err ? { "aria-invalid": true } : undefined}
                      />
                    </td>
                  );
                })}
                {!readOnly && (
                  <td className="px-1 py-1.5">
                    <Button size="icon" variant="ghost" aria-label={`Remove line ${i + 1}`} onClick={() => onRemove(i)}>
                      <Trash2 />
                    </Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rowErrors.length > 0 && (
        <ul className="border-t border-border px-4 py-2 text-xs text-danger" role="alert">
          {rowErrors.map(([k, m]) => (
            <li key={k}>
              Line {Number(k.split(".")[2]) + 1}, {label(k.split(".")[3]!).toLowerCase()}: {m}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

type Movement = { period: string; lineNo: number; direction: "in" | "out"; active: boolean; dimensions: Record<string, Value>; measures: Record<string, Value> };

/** Register movements a posted document made, per register. */
function Movements({ app, info, id }: { app: string; info: AppInfo; id: string }) {
  const registers = useMemo(() => info.metadata.registers.filter((r) => r.type.kind === "accumulation"), [info]);
  const results = useQueries({
    queries: registers.map((r) => ({
      queryKey: ["platform", "movements", app, id, r.name],
      queryFn: () => platform<Movement[]>(`/apps/${app}/registers/${r.name}/movements?recorder=${id}`),
    })),
  });
  const withData = registers.map((r, i) => ({ r, data: results[i]?.data ?? [] })).filter((x) => x.data.length > 0);
  if (withData.length === 0) return null;
  return (
    <>
      {withData.map(({ r, data }) => (
        <Card key={r.name}>
          <CardHeader
            title={`${label(r.name)} movements`}
            action={
              <Link className="text-sm text-accent hover:underline" href={`/platform/${app}/registers/${r.name}`}>
                Balances
              </Link>
            }
          />
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted">
                  <th className="px-3 py-2 font-medium">Line</th>
                  <th className="px-3 py-2 font-medium">Period</th>
                  <th className="px-3 py-2 font-medium">Direction</th>
                  {r.dimensions.map((d) => (
                    <th key={d.name} className="px-3 py-2 font-medium">
                      {label(d.name)}
                    </th>
                  ))}
                  {r.values.map((v) => (
                    <th key={v.name} className="px-3 py-2 text-right font-medium">
                      {label(v.name)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.map((m, i) => (
                  <tr key={i} className={`border-b border-border last:border-0 ${m.active ? "" : "text-muted line-through"}`}>
                    <td className="px-3 py-1.5 tabular">{m.lineNo}</td>
                    <td className="px-3 py-1.5">{show({ kind: "date" }, m.period)}</td>
                    <td className="px-3 py-1.5">{m.direction === "in" ? "In" : "Out"}{!m.active && <span className="sr-only"> (reversed)</span>}</td>
                    {r.dimensions.map((d) => (
                      <td key={d.name} className="px-3 py-1.5">
                        {show(d.type, m.dimensions[d.name])}
                      </td>
                    ))}
                    {r.values.map((v) => (
                      <td key={v.name} className="px-3 py-1.5 text-right tabular">
                        {show(v.type, m.measures[v.name])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ))}
    </>
  );
}
