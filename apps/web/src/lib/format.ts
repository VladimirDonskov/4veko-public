// Intl accepts numeric strings directly and preserves all database decimal digits.

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usdCompact = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });
const qtyFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });
const dateFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const dateTimeFmt = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });
const monthFmt = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });

export const money = (v: string | number | null | undefined) => usd.format((v ?? 0) as number | Intl.StringNumericLiteral);
export const moneyCompact = (v: string | number | null | undefined) => usdCompact.format(Number(v ?? 0));
export const quantity = (v: string | number | null | undefined) => qtyFmt.format(Number(v ?? 0));
export const date = (iso: string | null | undefined) => (iso ? dateFmt.format(new Date(`${iso.slice(0, 10)}T00:00:00Z`)) : "—");
export const dateTime = (iso: string | null | undefined) => (iso ? dateTimeFmt.format(new Date(iso)) : "—");
export const monthLabel = (yyyyMm: string) => monthFmt.format(new Date(`${yyyyMm}-01T00:00:00Z`));

export function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function humanize(s: string) {
  const t = s.replaceAll("_", " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export const isNegative = (v: string | number | null | undefined) => Number(v ?? 0) < 0;
