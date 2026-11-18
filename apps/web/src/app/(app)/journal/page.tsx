"use client";

import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { DataTable } from "@/components/data-table";
import { ButtonLink } from "@/components/ui/button";
import { Badge, Card, ErrorState, LoadingRows, Money, PageHeader } from "@/components/ui/misc";
import { api } from "@/lib/api";
import { date, humanize } from "@/lib/format";
import { useCan } from "@/lib/session";

type Entry = { id: string; number: number; date: string; memo: string | null; sourceType: string; sourceNumber: string | null; reversedById: string | null; reversalOfId: string | null; total: string };

export default function JournalPage() {
  const canPost = useCan("journal.post");
  const q = useQuery({ queryKey: ["journal", "list"], queryFn: () => api<{ data: Entry[] }>("/journal-entries?limit=500") });
  return (
    <>
      <PageHeader
        title="Journal Entries"
        description="Every posting in the General Ledger. Posted entries are permanent; corrections are reversing entries."
        actions={
          canPost && (
            <ButtonLink href="/journal/new">
              <Plus /> New journal entry
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
            id="journal"
            rows={q.data.data}
            href={(r) => `/journal/${r.id}`}
            initialSort={{ key: "number", dir: "desc" }}
            facets={{
              label: "Sources",
              options: ["manual", "invoice", "invoice_void", "payment", "inventory_adjustment", "reversal"].map((v) => ({ value: v, label: humanize(v) })),
            }}
            facetValue={(r) => r.sourceType}
            columns={[
              { key: "number", header: "#", value: (r) => r.number, cell: (r) => <span className="font-mono">{r.number}</span> },
              { key: "date", header: "Date", value: (r) => r.date, cell: (r) => date(r.date) },
              {
                key: "memo",
                header: "Memo",
                value: (r) => `${r.memo ?? ""} ${r.sourceNumber ?? ""}`,
                cell: (r) => (
                  <span className="flex items-center gap-2">
                    <span className="truncate">{r.memo}</span>
                    {r.reversedById && <Badge tone="warning">Reversed</Badge>}
                    {r.reversalOfId && <Badge>Reversal</Badge>}
                  </span>
                ),
              },
              { key: "source", header: "Source", value: (r) => r.sourceType, cell: (r) => <span className="text-muted">{humanize(r.sourceType)}</span>, hideBelow: "md" },
              { key: "total", header: "Amount", align: "right", value: (r) => Number(r.total), cell: (r) => <Money value={r.total} /> },
            ]}
          />
        )}
      </Card>
    </>
  );
}
