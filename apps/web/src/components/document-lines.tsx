import { Card, Money } from "@/components/ui/misc";
import { money, quantity } from "@/lib/format";

type Line = {
  lineNo: number;
  sku: string;
  description: string | null;
  quantity: string;
  unitPrice: string;
  discountPct: string;
  amount: string;
  taxable: boolean;
};

export function DocumentLines({ lines, subtotal, taxTotal, taxRate, total, after }: { lines: Line[]; subtotal: string; taxTotal: string; taxRate: string; total: string; after?: React.ReactNode }) {
  return (
    <Card>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted">
              <th className="px-4 py-2 font-medium">Item</th>
              <th className="px-4 py-2 text-right font-medium">Qty</th>
              <th className="px-4 py-2 text-right font-medium">Price</th>
              <th className="hidden px-4 py-2 text-right font-medium sm:table-cell">Disc.</th>
              <th className="px-4 py-2 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.lineNo} className="border-b border-border last:border-0">
                <td className="px-4 py-2.5">
                  <div className="font-medium">{l.description}</div>
                  <div className="font-mono text-xs text-muted">
                    {l.sku}
                    {l.taxable ? "" : " · not taxable"}
                  </div>
                </td>
                <td className="px-4 py-2.5 text-right tabular">{quantity(l.quantity)}</td>
                <td className="px-4 py-2.5 text-right tabular">{money(l.unitPrice)}</td>
                <td className="hidden px-4 py-2.5 text-right tabular sm:table-cell">{Number(l.discountPct) ? `${Number(l.discountPct)}%` : "—"}</td>
                <td className="px-4 py-2.5 text-right">
                  <Money value={l.amount} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dl className="ml-auto max-w-xs space-y-1.5 border-t border-border p-4 text-sm">
        <div className="flex justify-between">
          <dt className="text-muted">Subtotal</dt>
          <dd>
            <Money value={subtotal} />
          </dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted">Sales tax ({Number(taxRate)}%)</dt>
          <dd>
            <Money value={taxTotal} />
          </dd>
        </div>
        <div className="flex justify-between border-t border-border pt-1.5 text-base font-semibold">
          <dt>Total</dt>
          <dd>
            <Money value={total} />
          </dd>
        </div>
        {after}
      </dl>
    </Card>
  );
}
