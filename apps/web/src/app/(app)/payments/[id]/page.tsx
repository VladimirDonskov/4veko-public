"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { use } from "react";
import { LedgerImpact } from "@/components/ledger-impact";
import { Card, CardHeader, DescriptionList, ErrorState, LoadingRows, Money, PageHeader } from "@/components/ui/misc";
import { api } from "@/lib/api";
import { date } from "@/lib/format";

type Payment = {
  id: string;
  number: string;
  date: string;
  customerId: string;
  customerName: string;
  amount: string;
  unappliedAmount: string;
  method: string;
  reference: string | null;
  memo: string | null;
  depositAccount: string;
  journalEntryId: string;
  applications: { invoiceId: string; number: string; issueDate: string; total: string; amount: string }[];
};

export default function PaymentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const q = useQuery({ queryKey: ["payments", id], queryFn: () => api<Payment>(`/payments/${id}`) });
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  if (!q.data) return <LoadingRows />;
  const p = q.data;
  return (
    <>
      <PageHeader
        breadcrumb={<Link href="/payments" className="hover:underline">Payments</Link>}
        title={`Payment ${p.number}`}
        description={
          <Link href={`/customers/${p.customerId}`} className="hover:underline">
            {p.customerName}
          </Link>
        }
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <Card>
            <CardHeader title="Applied to" />
            {p.applications.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted">Not applied to any invoice. The full amount is a customer credit.</p>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {p.applications.map((a) => (
                    <tr key={a.invoiceId} className="border-b border-border last:border-0">
                      <td className="px-4 py-2">
                        <Link href={`/invoices/${a.invoiceId}`} className="font-medium text-accent hover:underline">
                          {a.number}
                        </Link>
                        <span className="ml-2 text-xs text-muted">{date(a.issueDate)}</span>
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
            )}
          </Card>
          <LedgerImpact entryId={p.journalEntryId} />
        </div>
        <Card className="p-4">
          <DescriptionList
            items={[
              { label: "Amount", value: <Money value={p.amount} strong /> },
              { label: "Unapplied credit", value: <Money value={p.unappliedAmount} /> },
              { label: "Date", value: date(p.date) },
              { label: "Method", value: p.method.toUpperCase() },
              { label: "Reference", value: p.reference },
              { label: "Deposited to", value: p.depositAccount },
            ]}
          />
          {p.memo && <p className="mt-3 border-t border-border pt-3 text-sm text-muted">{p.memo}</p>}
        </Card>
      </div>
    </>
  );
}
