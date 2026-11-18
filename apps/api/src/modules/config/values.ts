import type { FieldDecl } from "../../lang/ast";
import { KERNEL_TYPES, NUMERIC_TYPES } from "../../lang/checker";
import { VDate, VRecord, VRef, isDec, typeName, type Value } from "../../lang/interpreter";
import { invalid } from "../../lib/errors";
import { cents, D, MONEY_RE, qty4, QTY_RE } from "../../lib/money";
import { DATE_RE } from "../../lib/dates";

// Conversions between three forms of a field value:
//   input  — JSON from the API (strings, numbers, booleans, ids)
//   stored — JSON in config_records.data (decimal strings, ISO dates, ids)
//   value  — Veko runtime values (Decimal, VDate, VRef…)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isRefType = (t: string) => !["Text", "Number", "Money", "Quantity", "Date", "Boolean"].includes(t);
export const isKernelType = (t: string) => (KERNEL_TYPES as readonly string[]).includes(t);

/** Validate API input for one field and return its stored form. */
export function inputToStored(field: FieldDecl, raw: unknown, where: string): unknown {
  if (raw === null || raw === undefined || raw === "") return null;
  const t = field.type.name;
  const bad = (what: string) => invalid(`${where}: enter ${what}.`, { field: field.name });
  switch (t) {
    case "Text":
      if (typeof raw !== "string") throw bad("text");
      if (raw.length > 10_000) throw bad("at most 10,000 characters");
      return raw.trim() || null;
    case "Boolean":
      if (typeof raw !== "boolean") throw bad("true or false");
      return raw;
    case "Date":
      if (typeof raw !== "string" || !DATE_RE.test(raw)) throw bad("a date (YYYY-MM-DD)");
      return raw;
    case "Money": {
      const s = String(raw).trim();
      if (!MONEY_RE.test(s)) throw bad("an amount with at most 2 decimals");
      return cents(s);
    }
    case "Quantity": {
      const s = String(raw).trim();
      if (!QTY_RE.test(s)) throw bad("a quantity with at most 4 decimals");
      return qty4(s);
    }
    case "Number": {
      const s = String(raw).trim();
      if (!/^-?\d{1,18}(\.\d{1,6})?$/.test(s)) throw bad("a number");
      return new D(s).toFixed();
    }
    default:
      if (typeof raw !== "string" || !UUID_RE.test(raw)) throw bad(`a ${t}`);
      return raw.toLowerCase();
  }
}

/** Stored JSON → runtime value. */
export function storedToValue(field: FieldDecl, stored: unknown): Value {
  if (stored === null || stored === undefined) return null;
  const t = field.type.name;
  if (t === "Text") return String(stored);
  if (t === "Boolean") return Boolean(stored);
  if (t === "Date") return new VDate(String(stored));
  if (NUMERIC_TYPES.has(t)) return new D(String(stored));
  return new VRef(t, String(stored));
}

/** Runtime value (possibly changed by code) → stored JSON, checking its type. */
export function valueToStored(field: FieldDecl, value: Value, where: string): unknown {
  if (value === null) return null;
  const t = field.type.name;
  const wrong = () => invalid(`${where}: expected ${t} but the code set ${typeName(value)}.`, { field: field.name });
  switch (t) {
    case "Text":
      if (typeof value !== "string") throw wrong();
      return value;
    case "Boolean":
      if (typeof value !== "boolean") throw wrong();
      return value;
    case "Date":
      if (!(value instanceof VDate)) throw wrong();
      return value.iso;
    case "Money":
      if (!isDec(value)) throw wrong();
      return cents(value);
    case "Quantity":
      if (!isDec(value)) throw wrong();
      return qty4(value);
    case "Number":
      if (!isDec(value)) throw wrong();
      return value.toDecimalPlaces(6).toFixed();
    default:
      if (!(value instanceof VRef) || value.type !== t) throw wrong();
      return value.id;
  }
}

/** Build the runtime record for one row or object from stored JSON. */
export function recordFromStored(fields: FieldDecl[], data: Record<string, unknown>, label: string, extra: Map<string, Value> = new Map()) {
  const m = new Map<string, Value>(extra);
  for (const f of fields) m.set(f.name, storedToValue(f, data[f.name]));
  return new VRecord(m, new Set([...fields.map((f) => f.name), ...extra.keys()]), label);
}

/** Register dimension/resource values are stored as plain strings for exact JSON matching. */
export function dimensionKey(field: FieldDecl, value: Value, where: string): string | null {
  const stored = valueToStored(field, value, where);
  return stored === null ? null : String(stored);
}
