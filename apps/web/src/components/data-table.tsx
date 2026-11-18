"use client";

import { ArrowDown, ArrowUp, Bookmark, Search, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Button } from "./ui/button";
import { Input, Select } from "./ui/inputs";
import { EmptyState, Kbd } from "./ui/misc";

export type Column<T> = {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  /** Value used for sorting and text filtering. */
  value?: (row: T) => string | number | null | undefined;
  align?: "left" | "right";
  className?: string;
  hideBelow?: "sm" | "md" | "lg";
};

type SavedView = { name: string; filter: string; sortKey: string | null; sortDir: "asc" | "desc"; facet: string };

const hide = { sm: "hidden sm:table-cell", md: "hidden md:table-cell", lg: "hidden lg:table-cell" } as const;

function loadViews(id: string): SavedView[] {
  try {
    return JSON.parse(localStorage.getItem(`veko-views:${id}`) ?? "[]");
  } catch {
    return [];
  }
}

/**
 * Keyboard-first table: "/" focuses the filter, ↑/↓ move between rows,
 * Enter opens the row, x toggles selection. Sorting, a facet filter, bulk
 * actions and saved views (kept in this browser) are built in.
 */
export function DataTable<T extends { id: string }>({
  id,
  rows,
  columns,
  href,
  empty,
  facets,
  facetValue,
  bulkActions,
  initialSort,
  toolbar,
}: {
  id: string;
  rows: T[];
  columns: Column<T>[];
  href?: (row: T) => string;
  empty?: ReactNode;
  facets?: { label: string; options: { value: string; label: string }[] };
  facetValue?: (row: T) => string;
  bulkActions?: (selected: T[], clear: () => void) => ReactNode;
  initialSort?: { key: string; dir: "asc" | "desc" };
  toolbar?: ReactNode;
}) {
  const router = useRouter();
  const [filter, setFilter] = useState("");
  const [facet, setFacet] = useState("");
  const [sortKey, setSortKey] = useState<string | null>(initialSort?.key ?? null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">(initialSort?.dir ?? "asc");
  const [active, setActive] = useState(-1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [views, setViews] = useState<SavedView[]>([]);
  const filterRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTableSectionElement>(null);

  useEffect(() => setViews(loadViews(id)), [id]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    let out = rows.filter((r) => {
      if (facet && facetValue && facetValue(r) !== facet) return false;
      if (!q) return true;
      return columns.some((c) => String(c.value?.(r) ?? "").toLowerCase().includes(q));
    });
    const col = columns.find((c) => c.key === sortKey);
    if (col?.value) {
      out = [...out].sort((a, b) => {
        const va = col.value!(a);
        const vb = col.value!(b);
        const na = typeof va === "number" ? va : Number.NaN;
        const nb = typeof vb === "number" ? vb : Number.NaN;
        const cmp = !Number.isNaN(na) && !Number.isNaN(nb) ? na - nb : String(va ?? "").localeCompare(String(vb ?? ""), "en", { numeric: true });
        return sortDir === "asc" ? cmp : -cmp;
      });
    }
    return out;
  }, [rows, filter, facet, facetValue, columns, sortKey, sortDir]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable;
      if (e.key === "/" && !typing) {
        e.preventDefault();
        filterRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function toggleSort(key: string) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  function focusRow(i: number) {
    const next = Math.max(0, Math.min(visible.length - 1, i));
    setActive(next);
    (bodyRef.current?.querySelectorAll("tr")[next] as HTMLElement | undefined)?.focus();
  }

  function onRowKey(e: React.KeyboardEvent, row: T, i: number) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusRow(i + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusRow(i - 1);
    } else if (e.key === "Enter" && href) {
      router.push(href(row));
    } else if (e.key === "x" && bulkActions) {
      toggle(row.id);
    }
  }

  function toggle(rowId: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(rowId)) n.delete(rowId);
      else n.add(rowId);
      return n;
    });
  }

  function saveView() {
    const name = window.prompt("Name this view");
    if (!name) return;
    const next = [...views.filter((v) => v.name !== name), { name, filter, sortKey, sortDir, facet }];
    setViews(next);
    try {
      localStorage.setItem(`veko-views:${id}`, JSON.stringify(next));
    } catch {
      /* storage unavailable: the view lasts for this visit only */
    }
  }

  function applyView(name: string) {
    const v = views.find((x) => x.name === name);
    if (!v) return;
    setFilter(v.filter);
    setSortKey(v.sortKey);
    setSortDir(v.sortDir);
    setFacet(v.facet);
  }

  const selectedRows = rows.filter((r) => selected.has(r.id));
  const allVisibleSelected = visible.length > 0 && visible.every((r) => selected.has(r.id));

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
        <div className="relative min-w-48 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted" aria-hidden />
          <Input
            ref={filterRef}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                focusRow(0);
              }
              if (e.key === "Escape") setFilter("");
            }}
            placeholder="Filter"
            aria-label="Filter rows"
            className="pl-8 pr-8"
          />
          <span className="pointer-events-none absolute right-2 top-2 hidden sm:block">
            <Kbd>/</Kbd>
          </span>
        </div>
        {facets && (
          <Select value={facet} onChange={(e) => setFacet(e.target.value)} aria-label={facets.label} className="w-auto">
            <option value="">All {facets.label.toLowerCase()}</option>
            {facets.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        )}
        {views.length > 0 && (
          <Select value="" onChange={(e) => applyView(e.target.value)} aria-label="Saved views" className="w-auto">
            <option value="">Saved views</option>
            {views.map((v) => (
              <option key={v.name} value={v.name}>
                {v.name}
              </option>
            ))}
          </Select>
        )}
        <Button variant="ghost" size="sm" onClick={saveView} title="Save the current filter and sort as a view">
          <Bookmark /> Save view
        </Button>
        {(filter || facet) && (
          <Button variant="ghost" size="sm" onClick={() => (setFilter(""), setFacet(""))}>
            <X /> Clear
          </Button>
        )}
        <div className="ml-auto flex items-center gap-2">{toolbar}</div>
      </div>

      {bulkActions && selectedRows.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 border-b border-border bg-accent-soft px-3 py-2 text-sm" role="region" aria-label="Bulk actions">
          <span className="font-medium text-accent">{selectedRows.length} selected</span>
          {bulkActions(selectedRows, () => setSelected(new Set()))}
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
            Clear selection
          </Button>
        </div>
      )}

      {visible.length === 0 ? (
        (empty ?? <EmptyState title="Nothing matches" description="Try a different filter." />)
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted">
                {bulkActions && (
                  <th className="w-10 px-3 py-2">
                    <input
                      type="checkbox"
                      aria-label="Select all rows"
                      checked={allVisibleSelected}
                      onChange={() => setSelected(allVisibleSelected ? new Set() : new Set(visible.map((r) => r.id)))}
                    />
                  </th>
                )}
                {columns.map((c) => (
                  <th
                    key={c.key}
                    scope="col"
                    className={cn("px-3 py-2 font-medium", c.align === "right" && "text-right", c.hideBelow && hide[c.hideBelow])}
                    aria-sort={sortKey === c.key ? (sortDir === "asc" ? "ascending" : "descending") : undefined}
                  >
                    {c.value ? (
                      <button className={cn("inline-flex items-center gap-1 hover:text-fg", c.align === "right" && "flex-row-reverse")} onClick={() => toggleSort(c.key)}>
                        {c.header}
                        {sortKey === c.key && (sortDir === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody ref={bodyRef}>
              {visible.map((row, i) => (
                <tr
                  key={row.id}
                  tabIndex={0}
                  onFocus={() => setActive(i)}
                  onKeyDown={(e) => onRowKey(e, row, i)}
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest("a,button,input")) return;
                    if (href) router.push(href(row));
                  }}
                  className={cn(
                    "border-b border-border last:border-0 outline-none focus-visible:bg-accent-soft",
                    href && "cursor-pointer hover:bg-surface",
                    active === i && "bg-surface",
                    selected.has(row.id) && "bg-accent-soft/60",
                  )}
                >
                  {bulkActions && (
                    <td className="px-3 py-2">
                      <input type="checkbox" aria-label="Select row" checked={selected.has(row.id)} onChange={() => toggle(row.id)} />
                    </td>
                  )}
                  {columns.map((c) => (
                    <td key={c.key} className={cn("px-3 py-2.5", c.align === "right" && "text-right tabular", c.hideBelow && hide[c.hideBelow], c.className)}>
                      {c.cell(row)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex justify-between border-t border-border px-3 py-2 text-xs text-muted">
        <span>
          {visible.length} of {rows.length} shown
        </span>
        <span className="hidden sm:inline">
          <Kbd>↑</Kbd> <Kbd>↓</Kbd> move · <Kbd>Enter</Kbd> open{bulkActions ? <> · <Kbd>x</Kbd> select</> : null}
        </span>
      </div>
    </div>
  );
}
