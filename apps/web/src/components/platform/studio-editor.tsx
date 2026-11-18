"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { VksEditor, type VksEditorHandle } from "./vks-editor";
import { Button } from "@/components/ui/button";
import { Field, FormError, Input } from "@/components/ui/inputs";
import { Badge, Card, CardHeader, PageHeader } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api";
import { label, platform, type Diagnostic, type Model, type PlanStep } from "@/lib/platform";

type Draft = { name: string; version: number; source: string };
type Preview = { version: number; unchanged: boolean; diagnostics: Diagnostic[]; metadata: Model | null; plan: { steps: PlanStep[] } | null };

function stepName(step: PlanStep) {
  const field = typeof step.field === "string" ? step.field : (step.field as { name?: string } | undefined)?.name;
  const changed = (step.to as { name?: string } | undefined)?.name;
  const target = [step.name ?? step.object ?? step.document, step.rows, field ?? changed].filter(Boolean).join(".");
  return `${label(step.op)} ${target}`;
}

export function StudioEditor({ initial }: { initial: Draft }) {
  const router = useRouter();
  const cache = useQueryClient();
  const toast = useToast();
  const editor = useRef<VksEditorHandle>(null);
  const [base, setBase] = useState(initial);
  const [name, setName] = useState(initial.name);
  const [source, setSource] = useState(initial.source);
  const [approved, setApproved] = useState(false);
  const [checked, setChecked] = useState<{ draft: Draft; result: Preview } | null>(null);
  const validName = /^[a-z][a-z0-9-]{0,62}$/.test(name);
  const check = useMutation({
    mutationFn: async (draft: Draft) => ({
      draft,
      result: await platform<Preview>(`/apps/${draft.name}/preview`, { method: "POST", body: { source: draft.source, expectedVersion: draft.version } }),
    }),
    onSuccess: setChecked,
  });
  const review = checked && checked.draft.name === name && checked.draft.source === source && checked.draft.version === base.version ? checked.result : null;
  const publish = useMutation({
    mutationFn: (draft: Draft) => platform<{ version: number }>(`/apps/${draft.name}`, {
      method: "PUT", body: { source: draft.source, expectedVersion: draft.version, approveDestructive: approved },
    }),
    onSuccess: (result, draft) => {
      const active = { ...draft, version: result.version };
      setBase(active);
      setChecked(null);
      setApproved(false);
      cache.setQueryData(["platform", "source", draft.name], { version: result.version, source: draft.source });
      void cache.invalidateQueries({ queryKey: ["platform", "apps"] });
      void cache.invalidateQueries({ queryKey: ["platform", "app", draft.name] });
      toast.success(`Published ${draft.name} version ${result.version}.`);
      if (!initial.version) router.replace(`/studio/app/${draft.name}`);
    },
  });
  const reload = useMutation({
    mutationFn: () => platform<{ source: string; version: number }>(`/apps/${name}/source`),
    onSuccess: result => {
      setBase({ ...result, name }); setSource(result.source); setChecked(null); setApproved(false);
      cache.setQueryData(["platform", "source", name], result);
      publish.reset(); check.reset();
    },
  });
  const busy = check.isPending || publish.isPending || reload.isPending;
  const changed = source !== base.source;
  const stale = [check.error, publish.error].some(e => e instanceof ApiError && e.code === "VKS5013");
  const risk = review?.plan?.steps.some(step => step.requiresApproval);
  const canReview = validName && !!source.trim() && !busy;
  function checkSource() {
    if (!canReview) return;
    setChecked(null); setApproved(false); publish.reset();
    check.mutate({ name, source, version: base.version });
  }
  function changeSource(next: string) {
    setSource(next); setChecked(null); setApproved(false);
  }
  return <>
    <PageHeader title={base.version ? name : "New application"} breadcrumb={<Link href="/studio">Studio</Link>}
      description={base.version ? `Published version ${base.version}` : "Define the application in VekoScript."}
      actions={<Button disabled={!canReview} onClick={checkSource}>{check.isPending ? "Checking…" : "Check and review"}</Button>} />
    <div className="space-y-4">
      {!base.version && <div className="max-w-md"><Field label="Application name" required hint="Use lowercase letters, digits and dashes. Start with a letter."
        error={name && !validName ? "Enter a valid application name." : undefined}>
        {props => <Input {...props} value={name} maxLength={63} disabled={busy} onChange={e => { setName(e.target.value); setChecked(null); setApproved(false); }} />}
      </Field></div>}
      <Card><CardHeader title="Application source" action={<Badge>{changed ? "Edited" : base.version ? "Published" : "Draft"}</Badge>} />
        <div className="h-[54vh] min-h-72 overflow-hidden"><VksEditor ref={editor} value={source} onChange={changeSource}
          diagnostics={review?.diagnostics ?? []} model={review?.metadata ?? null} readOnly={busy} label="Application source" onSave={checkSource} /></div>
      </Card>
      <FormError message={(reload.error ?? publish.error ?? check.error)?.message} />
      {stale && <div className="flex flex-wrap items-center gap-3">
        <Link className="text-sm text-accent underline" href={`/studio/app/${name}`} target="_blank">Inspect active source in a new tab</Link>
        <Button variant="secondary" disabled={busy} onClick={() => {
          if (!changed || window.confirm("Replace the editor contents with the active version?")) reload.mutate();
        }}>Load active source</Button>
      </div>}
      {review && <Card><CardHeader title="Publication review" description={`Base version ${review.version} · ${name}`} />
        <div className="space-y-4 p-4">
          {review.diagnostics.map((d, i) => <button type="button" key={i} className="block text-left text-sm underline" onClick={() => editor.current?.goTo(d.line, d.col)}>
            {d.severity === "error" ? "Error" : "Warning"} at {d.line}:{d.col} · {d.message} ({d.code})
          </button>)}
          {review.unchanged && <p role="status" className="text-sm">This source matches the published version.</p>}
          {review.plan && !review.unchanged && <>
            <p className="text-sm">{review.plan.steps.length ? "Review the storage changes before publishing." : "This revision changes the source without changing storage."}</p>
            {review.plan.steps.map((step, i) => <details key={i} className="rounded-md border border-border p-3 text-sm">
              <summary className="cursor-pointer">{stepName(step)} {step.requiresApproval && <Badge tone="warning">Approval required</Badge>}</summary>
              {step.reason && <p className="mt-2">{step.reason}</p>}
              <pre className="mt-2 overflow-auto rounded bg-surface p-2 text-xs">{JSON.stringify(step, null, 2)}</pre>
            </details>)}
            {risk && <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={approved} disabled={busy} onChange={e => setApproved(e.target.checked)} />
              I approve the listed changes that may remove or invalidate stored data.</label>}
            <Button disabled={busy || (risk && !approved) || stale} onClick={() => checked && publish.mutate(checked.draft)}>
              {publish.isPending ? "Publishing…" : `Publish version ${review.version + 1}`}
            </Button>
          </>}
        </div>
      </Card>}
    </div>
  </>;
}
