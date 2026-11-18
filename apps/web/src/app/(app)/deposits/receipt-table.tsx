import Link from "next/link";
import { DataTable } from "@/components/data-table";
import { Money } from "@/components/ui/misc";
import type { DepositReceipt } from "@/lib/deposits";
import { date } from "@/lib/format";

export function ReceiptTable({ receipts, selected, onToggle }: {
  receipts: DepositReceipt[]; selected?: ReadonlySet<string>; onToggle?: (id: string) => void;
}) {
  return (
    <DataTable id={onToggle ? "select-deposit-receipts" : "deposit-receipts"} rows={receipts}
      initialSort={{ key: "date", dir: "asc" }}
      columns={[
        { key: "number", header: "Receipt", value: (r) => r.number, cell: (r) => onToggle
          ? <label className="inline-flex cursor-pointer items-center gap-2 py-1 font-medium">
              <input type="checkbox" checked={selected?.has(r.id) ?? false} onChange={() => onToggle(r.id)} />{r.number}
            </label>
          : <Link className="inline-block py-1 font-medium text-accent underline" href={`/payments/${r.id}`}>{r.number}</Link> },
        { key: "customer", header: "Customer", value: (r) => r.customerName, cell: (r) => r.customerName },
        { key: "date", header: "Date received", value: (r) => r.date, cell: (r) => date(r.date) },
        { key: "reference", header: "Reference", value: (r) => r.reference, cell: (r) => r.reference ?? "—", hideBelow: "md" },
        { key: "amount", header: "Amount", align: "right", cell: (r) => <Money value={r.amount} /> },
      ]}
    />
  );
}
