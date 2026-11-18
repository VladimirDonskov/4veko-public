import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { Card, PageHeader } from "@/components/ui/misc";

const REPORTS = [
  { href: "/reports/profit-and-loss", title: "Profit and Loss", text: "Income, cost of goods sold, expenses and net income for a period." },
  { href: "/reports/balance-sheet", title: "Balance Sheet", text: "Assets, liabilities and equity on a date. Always checks that it balances." },
  { href: "/reports/trial-balance", title: "Trial Balance", text: "Debit and credit balance of every account on a date." },
  { href: "/reports/ar-aging", title: "Receivables Aging", text: "What each customer owes, by how late it is." },
  { href: "/reports/ap-aging", title: "Payables Aging", text: "What you owe each vendor, by how late it is." },
  { href: "/reports/control-reconciliation", title: "Control Account Reconciliation", text: "Compare customer and vendor balances with their General Ledger control accounts on a selected date." },
];

export default function ReportsPage() {
  return (
    <>
      <PageHeader title="Reports" description="Financial statements computed live from the General Ledger." />
      <div className="grid gap-4 sm:grid-cols-2">
        {REPORTS.map((r) => (
          <Link key={r.href} href={r.href} className="group">
            <Card className="h-full p-5 transition-colors group-hover:border-accent">
              <h2 className="flex items-center justify-between font-semibold">
                {r.title} <ArrowRight className="size-4 text-muted group-hover:text-accent" aria-hidden />
              </h2>
              <p className="mt-1 text-sm text-muted">{r.text}</p>
            </Card>
          </Link>
        ))}
      </div>
    </>
  );
}
