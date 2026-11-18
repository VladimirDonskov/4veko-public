"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { use } from "react";
import { Badge, Card, ErrorState, LoadingRows, PageHeader } from "@/components/ui/misc";
import { api } from "@/lib/api";
import { displayValue, fieldLabel, NUMERIC } from "@/lib/config";

type Balances = {
  register: { name: string; nonnegative: boolean; dimensions: { name: string; type: string }[]; resources: { name: string; type: string }[] };
  balances: { dimensions: Record<string, string | null>; resources: Record<string, string> }[];
  labels: Record<string, string>;
};

export default function RegisterPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = use(params);
  const q = useQuery({ queryKey: ["x", "register", name], queryFn: () => api<Balances>(`/registers/${name}/balances`) });
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  if (!q.data) return <LoadingRows />;
  const { register: reg, balances, labels } = q.data;
  return (
    <>
      <PageHeader
        breadcrumb={<Link href="/configurator" className="hover:underline">Configuration</Link>}
        title={
          <span className="flex items-center gap-3">
            {fieldLabel(reg.name)} {reg.nonnegative && <Badge tone="info">Never below zero</Badge>}
          </span>
        }
        description="Current balances, from the movements of posted documents."
      />
      <Card>
        {balances.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted">All balances are zero.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted">
                  {reg.dimensions.map((d) => (
                    <th key={d.name} className="px-4 py-2 font-medium">
                      {fieldLabel(d.name)}
                    </th>
                  ))}
                  {reg.resources.map((r) => (
                    <th key={r.name} className="px-4 py-2 text-right font-medium">
                      {fieldLabel(r.name)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {balances.map((b, i) => (
                  <tr key={i} className="border-b border-border last:border-0">
                    {reg.dimensions.map((d) => (
                      <td key={d.name} className="px-4 py-2">
                        {displayValue(d.type, b.dimensions[d.name], labels)}
                      </td>
                    ))}
                    {reg.resources.map((r) => (
                      <td key={r.name} className={`px-4 py-2 text-right tabular ${NUMERIC.has(r.type) && Number(b.resources[r.name]) < 0 ? "text-danger" : ""}`}>
                        {displayValue(r.type, b.resources[r.name], labels)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
