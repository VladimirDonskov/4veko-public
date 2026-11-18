"use client";

import { Download, Printer } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Money } from "@/components/ui/misc";

export type Section = { title: string; accounts: { accountId: string; number: string; name: string; amount: string }[]; total: string };

export function ReportSection({ section, totalLabel }: { section: Section; totalLabel?: string }) {
  return (
    <>
      <tr>
        <th colSpan={2} className="px-4 pb-1 pt-4 text-left text-xs font-semibold uppercase tracking-wider text-muted">
          {section.title}
        </th>
      </tr>
      {section.accounts.length === 0 && (
        <tr>
          <td className="px-4 py-1.5 text-muted" colSpan={2}>
            None
          </td>
        </tr>
      )}
      {section.accounts.map((a, i) => (
        <tr key={a.accountId || `${section.title}-${i}`}>
          <td className="px-4 py-1.5 pl-8">
            {a.accountId ? (
              <Link href={`/accounts/${a.accountId}`} className="hover:underline">
                <span className="font-mono text-xs text-muted">{a.number}</span> {a.name}
              </Link>
            ) : (
              <span className="italic">{a.name}</span>
            )}
          </td>
          <td className="px-4 py-1.5 text-right">
            <Money value={a.amount} />
          </td>
        </tr>
      ))}
      <ReportTotal label={totalLabel ?? `Total ${section.title.toLowerCase()}`} value={section.total} />
    </>
  );
}

export function ReportTotal({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <tr className={strong ? "border-t-2 border-fg/70 text-base" : "border-t border-border"}>
      <td className="px-4 py-2 font-semibold">{label}</td>
      <td className="px-4 py-2 text-right font-semibold">
        <Money value={value} />
      </td>
    </tr>
  );
}

function csvCell(value: string | number) {
  const raw = String(value);
  // Keep signed decimal amounts numeric. Treat formula-like labels as spreadsheet text.
  const formulaLike = /^[\s\uFEFF]*[=+@\-＝＋＠－]|^[\t\r\n]/u.test(raw);
  const cell = formulaLike && !/^-?\d+(\.\d+)?$/.test(raw) ? "'" + raw : raw;
  return `"${cell.replaceAll('"', '""')}"`;
}

/** Print and CSV export for any report rendered as rows. */
export function ReportActions({ filename, rows }: { filename: string; rows: (string | number)[][] }) {
  function exportCsv() {
    const csv = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div className="flex gap-2 print:hidden">
      <Button variant="secondary" onClick={exportCsv}>
        <Download /> CSV
      </Button>
      <Button variant="secondary" onClick={() => window.print()}>
        <Printer /> Print
      </Button>
    </div>
  );
}

export function sectionRows(s: Section): (string | number)[][] {
  return [[s.title, ""], ...s.accounts.map((a) => [`${a.number} ${a.name}`.trim(), a.amount]), [`Total ${s.title.toLowerCase()}`, s.total]];
}

export function DateControl({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="text-xs text-muted print:hidden">
      {label}
      <input type="date" value={value} onChange={(e) => onChange(e.target.value)} className="mt-1 block h-9 rounded-md border border-border-input bg-bg px-2 text-sm text-fg" />
    </label>
  );
}

export function BalanceCheck({ ok, children }: { ok: boolean; children: ReactNode }) {
  return <p className={`mt-3 text-sm ${ok ? "text-success" : "text-danger"}`} role="status">{children}</p>;
}
