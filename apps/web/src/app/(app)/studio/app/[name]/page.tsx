"use client";

import { use } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { StudioEditor } from "@/components/platform/studio-editor";
import { Badge, Card, CardHeader, EmptyState, ErrorState, LoadingRows, PageHeader } from "@/components/ui/misc";
import { platform, usePlatformApp } from "@/lib/platform";

export default function ApplicationPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = use(params);
  const app = usePlatformApp(encodeURIComponent(name));
  const manage = !!app.data?.you.roles.includes("admin");
  const source = useQuery({
    queryKey: ["platform", "source", name],
    queryFn: () => platform<{ version: number; source: string }>(`/apps/${encodeURIComponent(name)}/source`),
    enabled: manage, retry: false, refetchOnWindowFocus: false,
  });
  if (app.isError) return <ErrorState error={app.error} retry={() => app.refetch()} />;
  if (app.isPending || (manage && source.isPending)) return <LoadingRows />;
  if (manage && source.isError) return <ErrorState error={source.error} retry={() => source.refetch()} />;
  if (manage && source.data) return <StudioEditor key={name} initial={{ name, ...source.data }} />;
  const { metadata, handlers } = app.data;
  const objects = [
    ...metadata.catalogs.map(x => ({ name: x.name, kind: "Catalog", detail: `${x.fields.length} fields` })),
    ...metadata.documents.map(x => ({ name: x.name, kind: "Document", detail: `${x.rows.length} line collections` })),
    ...metadata.registers.map(x => ({ name: x.name, kind: "Register", detail: `${x.dimensions.length} dimensions` })),
  ];
  return <>
    <PageHeader title={name} description={`Published version ${app.data.version}`} breadcrumb={<Link href="/studio">Studio</Link>} />
    <Card><CardHeader title="Application objects" />
      {objects.length === 0 && <EmptyState title="No objects declared" />}
      {objects.map(o => <div key={o.name} className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-0"><Badge>{o.kind}</Badge><span>{o.name}</span><span className="ml-auto text-xs text-muted">{o.detail}</span></div>)}
    </Card>
    {handlers.length > 0 && <Card className="mt-4"><CardHeader title="Lifecycle handlers" /><ul className="space-y-1 p-4">{handlers.map(h => <li key={h}>{h}</li>)}</ul></Card>}
  </>;
}
