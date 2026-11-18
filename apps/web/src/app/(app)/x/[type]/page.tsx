"use client";

import { useQuery } from "@tanstack/react-query";
import { FileCode2, Plus } from "lucide-react";
import Link from "next/link";
import { use } from "react";
import { DataTable, type Column } from "@/components/data-table";
import { ButtonLink } from "@/components/ui/button";
import { Card, EmptyState, ErrorState, LoadingRows, PageHeader, StatusBadge } from "@/components/ui/misc";
import { api } from "@/lib/api";
import { displayValue, fieldLabel, NUMERIC, useConfig, type StoredRecord } from "@/lib/config";
import { date } from "@/lib/format";
import { useCan } from "@/lib/session";

export default function ConfiguredListPage({ params }: { params: Promise<{ type: string }> }) {
  const { type } = use(params);
  const config = useConfig();
  const canWrite = useCan("masterdata.write");
  const meta = config.data?.metadata;
  const doc = meta?.documents.find((d) => d.name === type);
  const cat = meta?.catalogs.find((c) => c.name === type);
  const q = useQuery({ queryKey: ["x", type, "list"], queryFn: () => api<{ data: StoredRecord[] }>(`/x/${type}?limit=1000`), enabled: !!(doc || cat) });

  if (config.error) return <ErrorState error={config.error} />;
  if (!meta) return <LoadingRows />;
  if (!doc && !cat) {
    return (
      <EmptyState
        icon={<FileCode2 />}
        title={`"${type}" is not in the configuration`}
        description="It may have been renamed or removed in the Configurator."
        action={<ButtonLink href="/configurator">Open the Configurator</ButtonLink>}
      />
    );
  }
  const fields = (doc ?? cat)!.fields.slice(0, doc ? 4 : 5);
  const columns: Column<StoredRecord>[] = [
    ...(doc
      ? [
          { key: "number", header: "Number", value: (r: StoredRecord) => r.number, cell: (r: StoredRecord) => <span className="font-medium">{r.number}</span> },
          { key: "date", header: "Date", value: (r: StoredRecord) => r.date, cell: (r: StoredRecord) => date(r.date) },
        ]
      : []),
    ...fields.map((f, i) => ({
      key: f.name,
      header: fieldLabel(f.name),
      align: NUMERIC.has(f.type) ? ("right" as const) : undefined,
      hideBelow: i > 1 ? ("md" as const) : undefined,
      value: (r: StoredRecord) => {
        const v = r.data[f.name];
        return NUMERIC.has(f.type) ? Number(v ?? 0) : displayValue(f.type, v, r.labels);
      },
      cell: (r: StoredRecord) => <span className={!doc && i === 0 ? "font-medium" : ""}>{displayValue(f.type, r.data[f.name], r.labels)}</span>,
    })),
    ...(doc ? [{ key: "posted", header: "Status", value: (r: StoredRecord) => (r.posted ? "posted" : "draft"), cell: (r: StoredRecord) => <StatusBadge status={r.posted ? "posted" : "draft"} /> }] : []),
  ];

  return (
    <>
      <PageHeader
        breadcrumb={<Link href="/configurator" className="hover:underline">Configuration</Link>}
        title={fieldLabel(type)}
        description={doc ? `Documents declared in your configuration${doc.hasPost ? "; posting runs its “on post” code" : ""}.` : "Catalog declared in your configuration."}
        actions={
          canWrite && (
            <ButtonLink href={`/x/${type}/new`}>
              <Plus /> New {fieldLabel(type).toLowerCase()}
            </ButtonLink>
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
            id={`x-${type}`}
            rows={q.data.data}
            href={(r) => `/x/${type}/${r.id}`}
            columns={columns}
            initialSort={doc ? { key: "number", dir: "desc" } : undefined}
            facets={doc ? { label: "Statuses", options: [{ value: "posted", label: "Posted" }, { value: "draft", label: "Draft" }] } : undefined}
            facetValue={doc ? (r) => (r.posted ? "posted" : "draft") : undefined}
            empty={<EmptyState icon={<FileCode2 />} title={`No ${fieldLabel(type).toLowerCase()} yet`} action={canWrite && <ButtonLink href={`/x/${type}/new`}>Create one</ButtonLink>} />}
          />
        )}
      </Card>
    </>
  );
}
