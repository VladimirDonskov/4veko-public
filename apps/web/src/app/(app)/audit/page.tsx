"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, ErrorState, LoadingRows, PageHeader } from "@/components/ui/misc";
import { api } from "@/lib/api";
import { dateTime, humanize } from "@/lib/format";

type Event = { id: number; action: string; entityType: string; summary: string; actorName: string | null; actorEmail: string | null; ip: string | null; createdAt: string };

export default function AuditPage() {
  const q = useInfiniteQuery({
    queryKey: ["audit"],
    initialPageParam: null as number | null,
    queryFn: ({ pageParam }) => api<{ data: Event[]; nextBefore: number | null }>(`/audit-events?limit=100${pageParam ? `&before=${pageParam}` : ""}`),
    getNextPageParam: (last) => last.nextBefore,
  });
  const events = q.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <>
      <PageHeader title="Audit Log" description="An append-only record of who changed what. Entries cannot be edited or deleted, even by owners." />
      <Card>
        {q.error ? (
          <ErrorState error={q.error} />
        ) : !q.data ? (
          <LoadingRows />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted">
                  <th className="px-4 py-2 font-medium">When</th>
                  <th className="px-4 py-2 font-medium">Who</th>
                  <th className="px-4 py-2 font-medium">Action</th>
                  <th className="px-4 py-2 font-medium">Details</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id} className="border-b border-border last:border-0">
                    <td className="whitespace-nowrap px-4 py-2 text-muted">{dateTime(e.createdAt)}</td>
                    <td className="px-4 py-2">
                      {e.actorName ?? "System"}
                      {e.ip && <div className="text-xs text-muted">{e.ip}</div>}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 font-mono text-xs">{e.action}</td>
                    <td className="px-4 py-2">
                      {e.summary}
                      <div className="text-xs text-muted">{humanize(e.entityType)}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {q.hasNextPage && (
          <div className="border-t border-border p-3 text-center">
            <Button variant="secondary" onClick={() => q.fetchNextPage()} loading={q.isFetchingNextPage}>
              Load older events
            </Button>
          </div>
        )}
      </Card>
    </>
  );
}
