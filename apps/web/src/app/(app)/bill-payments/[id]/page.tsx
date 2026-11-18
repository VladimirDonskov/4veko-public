"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { use } from "react";
import { LedgerImpact } from "@/components/ledger-impact";
import { Card, CardHeader, DescriptionList, ErrorState, LoadingRows, Money, PageHeader } from "@/components/ui/misc";
import { api } from "@/lib/api";
import { date } from "@/lib/format";

type BillPayment = {
  id: string;
  number: string;
  date: string;
  vendorId: string;
  vendorName: string;
  amount: string;
  method: string;
  reference: string | null;
  memo: string | null;
  payFromAccount: string;
  journalEntryId: string;
  applications: { billId: string; number: string; vendorReference: string; total: string; amount: string }[];
};

export default function BillPaymentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const q = useQuery({ queryKey: ["bill-payments", id], queryFn: () => api<BillPayment>(`/bill-payments/${id}`) });
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  if (!q.data) return <LoadingRows />;
  const p = q.data;
  return (
    <>
      <PageHeader
        breadcrumb={<Link href="/bill-payments" className="hover:underline">Bill Payments</Link>}
        title={`Bill payment ${p.number}`}
        description={
          <Link href={`/vendors/${p.vendorId}`} className="hover:underline">
            {p.vendorName}
          </Link>
        }
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <Card>
            <CardHeader title="Bills paid" />
            <table className="w-full text-sm">
              <tbody>
                {p.applications.map((a) => (
                  <tr key={a.billId} className="border-b border-border last:border-0">
                    <td className="px-4 py-2">
                      <Link href={`/bills/${a.billId}`} className="font-medium text-accent hover:underline">
                        {a.number}
                      </Link>
                      <span className="ml-2 text-xs text-muted">{a.vendorReference}</span>
                    </td>
                    <td className="px-4 py-2 text-right text-muted">
                      of <Money value={a.total} />
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Money value={a.amount} strong />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <LedgerImpact entryId={p.journalEntryId} />
        </div>
        <Card className="p-4">
          <DescriptionList
            items={[
              { label: "Amount", value: <Money value={p.amount} strong /> },
              { label: "Date", value: date(p.date) },
              { label: "Method", value: p.method.toUpperCase() },
              { label: "Reference", value: p.reference },
              { label: "Paid from", value: p.payFromAccount },
            ]}
          />
          {p.memo && <p className="mt-3 border-t border-border pt-3 text-sm text-muted">{p.memo}</p>}
        </Card>
      </div>
    </>
  );
}
