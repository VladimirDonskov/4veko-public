"use client";

import { useQuery } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import Link from "next/link";
import { use, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, DescriptionList, ErrorState, LoadingRows, Money, PageHeader } from "@/components/ui/misc";
import { api } from "@/lib/api";
import { sourceHref } from "@/components/nav";
import { date, humanize, money, quantity } from "@/lib/format";
import { useCan } from "@/lib/session";
import { ITEM_TYPES, ItemForm, type Item } from "../item-form";

type Detail = Item & {
  movements: { id: string; date: string; quantity: string; valueChange: string; sourceType: string; sourceId: string; sourceNumber: string | null; journalEntryId: string | null }[];
};


export default function ItemDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const canWrite = useCan("masterdata.write");
  const [editing, setEditing] = useState(false);
  const q = useQuery({ queryKey: ["items", id], queryFn: () => api<Detail>(`/items/${id}`) });
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  if (!q.data) return <LoadingRows />;
  const i = q.data;
  const avg = Number(i.qtyOnHand) > 0 ? Number(i.valueOnHand) / Number(i.qtyOnHand) : 0;

  return (
    <>
      <PageHeader
        breadcrumb={<Link href="/items" className="hover:underline">Products & Services</Link>}
        title={i.name}
        description={`${i.sku} · ${ITEM_TYPES[i.type]}`}
        actions={
          canWrite && (
            <Button variant="secondary" onClick={() => setEditing(true)}>
              <Pencil /> Edit
            </Button>
          )
        }
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="p-4 lg:col-span-2">
          <DescriptionList
            items={[
              { label: "Sales price", value: `${money(i.salesPrice)} / ${i.unit}` },
              { label: "Purchase cost", value: money(i.purchaseCost) },
              { label: "Sales tax", value: i.taxable ? "Taxable" : "Not taxable" },
              { label: "Reorder point", value: i.reorderPoint ? quantity(i.reorderPoint) : null },
              { label: "Status", value: i.isActive ? "Active" : "Archived" },
            ]}
          />
          {i.description && <p className="mt-4 border-t border-border pt-3 text-sm text-muted">{i.description}</p>}
        </Card>
        {i.type === "inventory" && (
          <Card className="p-4">
            <p className="text-xs text-muted">On hand</p>
            <p className="mt-1 text-3xl font-semibold tabular">
              {quantity(i.qtyOnHand)} <span className="text-base font-normal text-muted">{i.unit}</span>
            </p>
            <p className="mt-2 text-sm text-muted">
              Value <Money value={i.valueOnHand} /> · average cost {money(avg)}
            </p>
          </Card>
        )}
      </div>
      {i.type === "inventory" && (
        <Card className="mt-6">
          <CardHeader title="Stock movements" description="Every change to quantity and value, with its source document" />
          {i.movements.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted">No stock has moved yet. Use Inventory → Adjust stock to enter opening quantities.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted">
                    <th className="px-4 py-2 font-medium">Date</th>
                    <th className="px-4 py-2 font-medium">Source</th>
                    <th className="px-4 py-2 text-right font-medium">Quantity</th>
                    <th className="px-4 py-2 text-right font-medium">Value</th>
                    <th className="px-4 py-2 text-right font-medium">Ledger</th>
                  </tr>
                </thead>
                <tbody>
                  {i.movements.map((m) => (
                    <tr key={m.id} className="border-b border-border last:border-0">
                      <td className="px-4 py-2">{date(m.date)}</td>
                      <td className="px-4 py-2">
                        {sourceHref(m.sourceType, m.sourceId, m.sourceNumber) ? (
                          <Link className="text-accent hover:underline" href={sourceHref(m.sourceType, m.sourceId, m.sourceNumber)!}>
                            {m.sourceNumber}
                          </Link>
                        ) : (
                          m.sourceNumber
                        )}{" "}
                        <span className="text-xs text-muted">{humanize(m.sourceType)}</span>
                      </td>
                      <td className={`px-4 py-2 text-right tabular ${Number(m.quantity) < 0 ? "text-danger" : "text-success"}`}>
                        {Number(m.quantity) > 0 ? "+" : ""}
                        {quantity(m.quantity)}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <Money value={m.valueChange} />
                      </td>
                      <td className="px-4 py-2 text-right">
                        {m.journalEntryId ? (
                          <Link className="text-accent hover:underline" href={`/journal/${m.journalEntryId}`}>
                            Entry
                          </Link>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
      <ItemForm item={i} open={editing} onOpenChange={setEditing} />
    </>
  );
}
