"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CircleAlert, FileCode2, History, Save, Wand2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { CodeEditor, type CodeEditorHandle } from "@/components/code-editor";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/inputs";
import { Badge, Card, CardHeader, ErrorState, Kbd, LoadingRows, PageHeader } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { api, ApiError } from "@/lib/api";
import { useConfig, type Metadata } from "@/lib/config";
import { dateTime } from "@/lib/format";
import { useCan } from "@/lib/session";

type Diagnostic = { line: number; col: number; message: string; kind: string };
type Version = { version: number; comment: string | null; createdAt: string; createdBy: string | null; lines: number };

export default function ConfiguratorPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const canEdit = useCan("config.manage");
  const config = useConfig();
  const versions = useQuery({ queryKey: ["config", "versions"], queryFn: () => api<Version[]>("/config/versions") });
  const editor = useRef<CodeEditorHandle>(null);
  const [source, setSource] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [diagnostics, setDiagnostics] = useState<Diagnostic[] | null>(null);
  const [preview, setPreview] = useState<Metadata | null>(null);

  useEffect(() => {
    if (config.data && source === null) setSource(config.data.source);
  }, [config.data, source]);

  const dirty = config.data !== undefined && source !== null && source !== config.data.source;
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const check = useMutation({
    mutationFn: (src: string) => api<{ ok: boolean; diagnostics: Diagnostic[]; metadata: Metadata | null }>("/config/check", { method: "POST", body: { source: src } }),
    onSuccess: (r) => {
      setDiagnostics(r.diagnostics);
      setPreview(r.metadata);
    },
  });
  const save = useMutation({
    mutationFn: (src: string) => api<{ version: number }>("/config", { method: "PUT", body: { source: src, comment: comment || undefined } }),
    onSuccess: (r) => {
      setDiagnostics([]);
      setComment("");
      qc.invalidateQueries({ queryKey: ["config"] });
      qc.invalidateQueries({ queryKey: ["x"] });
      toast.success(`Saved and applied version ${r.version}.`);
    },
    onError: (err) => {
      if (err instanceof ApiError && Array.isArray(err.details?.diagnostics)) setDiagnostics(err.details.diagnostics as Diagnostic[]);
      else toast.error(err.message);
    },
  });

  async function loadSample() {
    if (source && source.trim() && !confirm("Replace the code in the editor with the sample configuration?")) return;
    const r = await api<{ source: string }>("/config/sample");
    setSource(r.source);
    setDiagnostics(null);
  }

  async function loadVersion(v: string) {
    if (!v) return;
    if (dirty && !confirm("Discard your unsaved changes and load this version?")) return;
    const r = await api<{ source: string }>(`/config/versions/${v}`);
    setSource(r.source);
    setDiagnostics(null);
    toast.success(`Loaded version ${v} into the editor. Save to make it active again.`);
  }

  if (config.error) return <ErrorState error={config.error} retry={() => config.refetch()} />;
  if (!config.data || source === null) return <LoadingRows />;
  const errorLines = new Set((diagnostics ?? []).map((d) => d.line));
  const meta = preview ?? config.data.metadata;

  return (
    <>
      <PageHeader
        title="Configurator"
        description={
          <>
            Describe catalogs, documents and registers in the <Link href="#language" className="text-accent">Veko language</Link>. Saving checks the code and applies it as a new version.
          </>
        }
        actions={
          <>
            <Badge tone={config.data.version ? "accent" : "neutral"}>{config.data.version ? `Active: version ${config.data.version}` : "No configuration yet"}</Badge>
            {dirty && <Badge tone="warning">Unsaved changes</Badge>}
          </>
        }
      />
      <div className="grid gap-6 xl:grid-cols-[1fr_320px]">
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={() => check.mutate(source)} loading={check.isPending}>
              <CheckCircle2 /> Check
            </Button>
            {canEdit && (
              <>
                <Input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="What changed? (optional)" aria-label="Version comment" className="w-64" />
                <Button onClick={() => save.mutate(source)} loading={save.isPending} disabled={!dirty && config.data.version > 0}>
                  <Save /> Save and apply
                </Button>
                <Button variant="ghost" onClick={loadSample}>
                  <Wand2 /> Load sample
                </Button>
              </>
            )}
            <div className="ml-auto flex items-center gap-2">
              <History className="size-4 text-muted" aria-hidden />
              <Select aria-label="Load a previous version" value="" onChange={(e) => void loadVersion(e.target.value)} className="w-48">
                <option value="">Version history</option>
                {versions.data?.map((v) => (
                  <option key={v.version} value={v.version}>
                    v{v.version} · {dateTime(v.createdAt)}
                    {v.comment ? ` · ${v.comment}` : ""}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <CodeEditor ref={editor} value={source} onChange={setSource} readOnly={!canEdit} errorLines={errorLines} onSave={() => canEdit && save.mutate(source)} label="Configuration source code" />
          <p className="text-xs text-muted">
            <Kbd>Ctrl</Kbd> <Kbd>S</Kbd> saves · <Kbd>Tab</Kbd> indents (press <Kbd>Esc</Kbd> first to move focus out) {canEdit ? "" : "· You can read this configuration; owners and admins can change it."}
          </p>
          {diagnostics !== null && (
            <Card>
              <CardHeader title={diagnostics.length ? `${diagnostics.length} problem${diagnostics.length === 1 ? "" : "s"}` : "No problems found"} />
              {diagnostics.length === 0 ? (
                <p className="flex items-center gap-2 px-4 py-3 text-sm text-success">
                  <CheckCircle2 className="size-4" aria-hidden /> The configuration compiles.
                </p>
              ) : (
                <ul className="divide-y divide-border" role="list">
                  {diagnostics.map((d, i) => (
                    <li key={i}>
                      <button className="flex w-full items-start gap-2 px-4 py-2 text-left text-sm hover:bg-surface" onClick={() => editor.current?.goTo(d.line, d.col)}>
                        <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
                        <span className="font-mono text-xs text-muted">
                          {d.line}:{d.col}
                        </span>
                        <span>{d.message}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
        </div>
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader title="Objects" description={preview ? "From the code you just checked" : "In the active configuration"} />
            <ObjectList meta={meta} />
          </Card>
          <Card id="language" className="p-4 text-sm">
            <h2 className="mb-2 flex items-center gap-2 font-semibold">
              <FileCode2 className="size-4" aria-hidden /> Veko at a glance
            </h2>
            <pre className="overflow-x-auto rounded bg-surface p-2 font-mono text-xs leading-5">{`catalog Name
  field x: Text required
end
document Name
  field c: Customer
  table lines
    item: Item
  end
  on write … end
  on post … end
end
register Name nonnegative
  dimension d: Item
  resource qty: Quantity
end`}</pre>
            <p className="mt-2 text-muted">
              In <code>on post</code>: <code>ledger.post(debit:, credit:, amount:)</code>, <code>stock.issue(item, qty)</code>, <code>Register.add(…)</code>. Use <code>fail &quot;message&quot;</code> to stop with an error.
            </p>
          </Card>
        </div>
      </div>
    </>
  );
}

function ObjectList({ meta }: { meta: Metadata }) {
  const groups = [
    { title: "Catalogs", items: meta.catalogs.map((c) => ({ name: c.name, href: `/x/${c.name}`, detail: `${c.fields.length} fields` })) },
    { title: "Documents", items: meta.documents.map((d) => ({ name: d.name, href: `/x/${d.name}`, detail: `${d.fields.length} fields${d.tables.length ? `, ${d.tables.length} table` : ""}${d.hasPost ? ", posts" : ""}` })) },
    { title: "Registers", items: meta.registers.map((r) => ({ name: r.name, href: `/x/registers/${r.name}`, detail: `${r.dimensions.length} dimensions, ${r.resources.length} resources` })) },
    { title: "Functions", items: meta.functions.map((f) => ({ name: `${f.name}(${f.params.join(", ")})`, href: null, detail: "" })) },
  ].filter((g) => g.items.length);
  if (groups.length === 0) return <p className="px-4 py-4 text-sm text-muted">Nothing declared yet. Load the sample to see how it works.</p>;
  return (
    <div className="divide-y divide-border">
      {groups.map((g) => (
        <div key={g.title} className="px-4 py-3">
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">{g.title}</p>
          <ul className="space-y-1 text-sm">
            {g.items.map((i) => (
              <li key={i.name} className="flex justify-between gap-2">
                {i.href ? (
                  <Link href={i.href} className="font-medium text-accent hover:underline">
                    {i.name}
                  </Link>
                ) : (
                  <span className="font-mono text-xs">{i.name}</span>
                )}
                <span className="text-xs text-muted">{i.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
