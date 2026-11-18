"use client";

import * as D from "@radix-ui/react-dialog";
import { useQuery } from "@tanstack/react-query";
import { Command } from "cmdk";
import { ArrowRight, FileText, Plus, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { humanize } from "@/lib/format";
import { DOC_ROUTE, NAV } from "./nav";

type Result = { type: string; id: string; title: string; subtitle: string | null };

const route = (type: string, id: string) => (DOC_ROUTE[type] ? `${DOC_ROUTE[type]}/${id}` : "/");

const ACTIONS = [
  { label: "New sales order", href: "/sales-orders/new", keywords: "create order sell" },
  { label: "New invoice", href: "/invoices/new", keywords: "create customer" },
  { label: "Record a payment", href: "/payments/new", keywords: "receive money cash check ach" },
  { label: "New purchase order", href: "/purchase-orders/new", keywords: "create po buy order vendor supplier" },
  { label: "Enter a bill", href: "/bills/new", keywords: "vendor invoice payable ap" },
  { label: "Pay bills", href: "/bill-payments/new", keywords: "vendor pay ap check ach" },
  { label: "New customer", href: "/customers?new=1", keywords: "create client" },
  { label: "New product or service", href: "/items?new=1", keywords: "create item sku" },
  { label: "Adjust inventory", href: "/inventory?adjust=1", keywords: "stock receive count" },
  { label: "New journal entry", href: "/journal/new", keywords: "gl ledger debit credit" },
];

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 150);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    if (!open) setQ("");
  }, [open]);

  const search = useQuery({
    queryKey: ["search", debounced],
    queryFn: () => api<{ results: Result[] }>(`/search?q=${encodeURIComponent(debounced)}`),
    enabled: open && debounced.length > 0,
    staleTime: 10_000,
  });

  function go(href: string) {
    onOpenChange(false);
    router.push(href);
  }

  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <D.Content className="fixed left-1/2 top-[12vh] z-50 w-[calc(100vw-32px)] max-w-xl -translate-x-1/2 overflow-hidden rounded-lg border border-border bg-bg shadow-pop">
          <D.Title className="sr-only">Search and commands</D.Title>
          <D.Description className="sr-only">Search records or run an action</D.Description>
          <Command shouldFilter={false} label="Search and commands" className="flex flex-col">
            <div className="flex items-center gap-2 border-b border-border px-3">
              <Search className="size-4 text-muted" aria-hidden />
              <Command.Input
                value={q}
                onValueChange={setQ}
                placeholder="Search customers, invoices, items… or type a command"
                className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted"
              />
            </div>
            <Command.List className="max-h-[60vh] overflow-y-auto p-2">
              <Command.Empty className="px-3 py-6 text-center text-sm text-muted">
                {search.isFetching ? "Searching…" : "No results."}
              </Command.Empty>
              {(search.data?.results.length ?? 0) > 0 && (
                <Command.Group heading="Records" className="text-xs text-muted [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5">
                  {search.data!.results.map((r) => (
                    <Item key={`${r.type}-${r.id}`} value={`${r.type}-${r.id}`} onSelect={() => go(route(r.type, r.id))}>
                      <FileText className="size-4 text-muted" />
                      <span className="flex-1 truncate text-fg">{r.title}</span>
                      <span className="truncate text-xs text-muted">
                        {humanize(r.type)}
                        {r.subtitle ? ` · ${r.subtitle}` : ""}
                      </span>
                    </Item>
                  ))}
                </Command.Group>
              )}
              <Command.Group heading="Actions" className="text-xs text-muted [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5">
                {ACTIONS.filter((a) => match(q, a.label + " " + a.keywords)).map((a) => (
                  <Item key={a.href} value={a.label} onSelect={() => go(a.href)}>
                    <Plus className="size-4 text-muted" />
                    <span className="text-fg">{a.label}</span>
                  </Item>
                ))}
              </Command.Group>
              <Command.Group heading="Go to" className="text-xs text-muted [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5">
                {NAV.flatMap((s) => s.items)
                  .filter((n) => match(q, n.label))
                  .map((n) => (
                    <Item key={n.href} value={`go-${n.href}`} onSelect={() => go(n.href)}>
                      <ArrowRight className="size-4 text-muted" />
                      <span className="text-fg">{n.label}</span>
                    </Item>
                  ))}
              </Command.Group>
            </Command.List>
          </Command>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

function match(q: string, text: string) {
  const t = q.trim().toLowerCase();
  return !t || text.toLowerCase().includes(t);
}

function Item({ children, value, onSelect }: { children: React.ReactNode; value: string; onSelect: () => void }) {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm data-[selected=true]:bg-accent-soft"
    >
      {children}
    </Command.Item>
  );
}
