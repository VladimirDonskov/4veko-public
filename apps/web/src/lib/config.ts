"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

export type FieldMeta = { name: string; type: string; required: boolean };
export type Metadata = {
  catalogs: { name: string; fields: FieldMeta[]; hasWrite: boolean }[];
  documents: { name: string; fields: FieldMeta[]; tables: { name: string; columns: FieldMeta[] }[]; hasWrite: boolean; hasPost: boolean }[];
  registers: { name: string; nonnegative: boolean; dimensions: FieldMeta[]; resources: FieldMeta[] }[];
  functions: { name: string; params: string[] }[];
};
export type ConfigResponse = { version: number; source: string; metadata: Metadata };

export function useConfig() {
  return useQuery({ queryKey: ["config"], queryFn: () => api<ConfigResponse>("/config"), staleTime: 30_000 });
}

export type StoredRecord = {
  id: string;
  kind: "catalog" | "document";
  typeName: string;
  number: string | null;
  date: string | null;
  posted: boolean;
  data: Record<string, unknown>;
  tables: Record<string, Record<string, unknown>[]>;
  journalEntryId: string | null;
  labels: Record<string, string>;
  label?: string;
  messages?: string[];
  movements?: { register: string; dimensions: Record<string, string | null>; resources: Record<string, string>; period: string }[];
};

export const NUMERIC = new Set(["Number", "Money", "Quantity"]);
export const SCALAR = new Set(["Text", "Number", "Money", "Quantity", "Date", "Boolean"]);

/** Options for a reference field: kernel records or records of a configured type. */
export function useRefOptions(type: string, enabled = true) {
  return useQuery({
    queryKey: ["ref-options", type],
    enabled: enabled && !SCALAR.has(type),
    staleTime: 15_000,
    queryFn: async (): Promise<{ id: string; label: string }[]> => {
      switch (type) {
        case "Customer":
        case "Vendor": {
          const r = await api<{ data: { id: string; displayName: string }[] }>(`/${type === "Customer" ? "customers" : "vendors"}?limit=500`);
          return r.data.map((x) => ({ id: x.id, label: x.displayName }));
        }
        case "Item": {
          const r = await api<{ data: { id: string; sku: string; name: string }[] }>("/items?limit=500");
          return r.data.map((x) => ({ id: x.id, label: `${x.sku} · ${x.name}` }));
        }
        case "Account": {
          const r = await api<{ data: { id: string; number: string; name: string }[] }>("/accounts");
          return r.data.map((x) => ({ id: x.id, label: `${x.number} ${x.name}` }));
        }
        default: {
          const r = await api<{ data: { id: string; label: string }[] }>(`/x/${type}?limit=1000`);
          return r.data.map((x) => ({ id: x.id, label: x.label }));
        }
      }
    },
  });
}

/** Human form of a stored value for lists and read-only views. */
export function displayValue(type: string, v: unknown, labels: Record<string, string>): string {
  if (v === null || v === undefined || v === "") return "—";
  if (type === "Boolean") return v ? "Yes" : "No";
  if (type === "Money") return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(v));
  if (NUMERIC.has(type)) return new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(Number(v));
  if (type === "Date") return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${v}T00:00:00Z`));
  if (!SCALAR.has(type)) return labels[String(v)] ?? String(v).slice(0, 8);
  return String(v);
}

/** Split camelCase field names into words: "dailyRate" → "Daily rate". */
export function fieldLabel(name: string) {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
