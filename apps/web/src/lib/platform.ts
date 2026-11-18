"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

/** Calls the Java VekoScript platform through the API's /platform gateway. */
export function platform<T = unknown>(path: string, opts: Parameters<typeof api>[1] = {}) {
  return api<T>(`/platform${path}`, opts);
}

// ----- metadata, as the platform describes it (docs/vekoscript/metadata.md) ---------------

export type FieldType = {
  kind: "string" | "decimal" | "integer" | "boolean" | "date" | "dateTime" | "ref";
  maxLength?: number | null;
  precision?: number | null;
  scale?: number | null;
  target?: string | null;
  targetKind?: "catalog" | "document" | null;
};
export type FieldMeta = { name: string; type: FieldType; required: boolean; unique: boolean; default: { type: string; value: unknown } | null };
export type CatalogMeta = { name: string; fields: FieldMeta[] };
export type RowsMeta = { name: string; fields: FieldMeta[] };
export type DocumentMeta = { name: string; fields: FieldMeta[]; rows: RowsMeta[] };
export type RegisterMeta = { name: string; type: { kind: "accumulation" | "information"; periodic?: boolean }; dimensions: FieldMeta[]; values: FieldMeta[] };
export type Model = { catalogs: CatalogMeta[]; documents: DocumentMeta[]; registers: RegisterMeta[] };

export type You = { user: string; roles: string[]; capabilities: string[] };
export type AppInfo = { application: string; version: number; metadata: Model; handlers: string[]; you: You };
export type AppSummary = { name: string; version: number; deployedAt: string; deployedBy: string };

export type Kind = "catalog" | "document";
export const COLLECTION: Record<Kind, "catalogs" | "documents"> = { catalog: "catalogs", document: "documents" };

export type Ref = { type: string; id: string; display?: string };
export type Value = string | number | boolean | null | Ref | Record<string, unknown>;
export type Row = { lineNo?: number; [field: string]: Value | undefined };
export type PlatformObject = {
  id: string;
  type: string;
  display?: string;
  version: number;
  deleted: boolean;
  number?: string;
  date?: string;
  status?: "draft" | "posted" | "reversed";
  fields: Record<string, Value>;
  rows?: Record<string, Row[]>;
};

export type Diagnostic = { code: string; kind: string; severity: "error" | "warning"; message: string; line: number; col: number; offset: number; len: number };
export type PlanStep = { op: string; requiresApproval: boolean; reason: string | null; [k: string]: unknown };

export function can(you: You | undefined, capability: string) {
  return !!you && (you.capabilities.includes("*") || you.capabilities.includes(capability));
}

export function objectMeta(model: Model, type: string): { kind: Kind; fields: FieldMeta[]; rows: RowsMeta[] } | null {
  const c = model.catalogs.find((x) => x.name === type);
  if (c) return { kind: "catalog", fields: c.fields, rows: [] };
  const d = model.documents.find((x) => x.name === type);
  if (d) return { kind: "document", fields: d.fields, rows: d.rows };
  return null;
}

// ----- queries -----------------------------------------------------------------------------

export function usePlatformApps() {
  return useQuery({ queryKey: ["platform", "apps"], queryFn: () => platform<{ applications: AppSummary[]; you: You }>("/apps"), retry: false, staleTime: 30_000 });
}

export function usePlatformApp(app: string) {
  return useQuery({ queryKey: ["platform", "app", app], queryFn: () => platform<AppInfo>(`/apps/${app}`), retry: false, staleTime: 30_000 });
}

export function useObjects(app: string, kind: Kind, type: string, search = "") {
  const q = new URLSearchParams({ limit: "200" });
  if (search.trim()) q.set("q", search.trim());
  return useQuery({
    queryKey: ["platform", "objects", app, type, search.trim()],
    queryFn: () => platform<PlatformObject[]>(`/apps/${app}/${COLLECTION[kind]}/${type}?${q}`),
    placeholderData: (prev) => prev,
  });
}

// ----- presentation ------------------------------------------------------------------------

/** "unitPrice" → "Unit price", "GoodsReceipt" → "Goods receipt". */
export function label(name: string) {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Group the integer part of a decimal string without going through floating point. */
export function groupDecimal(s: string) {
  const negative = s.startsWith("-");
  const [int, frac] = (negative ? s.slice(1) : s).split(".");
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "−" : ""}${grouped}${frac !== undefined ? `.${frac}` : ""}`;
}

export function isRef(v: unknown): v is Ref {
  return typeof v === "object" && v !== null && "id" in v && "type" in v;
}

const dateFmt = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });
const dateTimeFmt = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

/** Human form of a field value for lists and read-only views. */
export function show(type: FieldType, v: Value | undefined): string {
  if (v === null || v === undefined || v === "") return "—";
  switch (type.kind) {
    case "boolean":
      return v ? "Yes" : "No";
    case "decimal":
    case "integer":
      return groupDecimal(String(v));
    case "date":
      return dateFmt.format(new Date(`${String(v)}T00:00:00Z`));
    case "dateTime":
      return `${dateTimeFmt.format(new Date(String(v)))} UTC`;
    case "ref":
      return isRef(v) ? (v.display ?? v.id.slice(0, 8)) : String(v);
    default:
      return String(v);
  }
}

export const STATUS_TONE = { draft: "neutral", posted: "success", reversed: "warning" } as const;
