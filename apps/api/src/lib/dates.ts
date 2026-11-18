/** Dates in the API are ISO calendar dates ("YYYY-MM-DD"), never timestamps. */
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function today(): string {
  return toIsoDate(new Date());
}

export function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
}

export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** First day of the fiscal year that contains `isoDate`. */
export function fiscalYearStart(isoDate: string, startMonth: number): string {
  const [y, m] = isoDate.split("-").map(Number) as [number, number];
  const year = m >= startMonth ? y : y - 1;
  return `${year}-${String(startMonth).padStart(2, "0")}-01`;
}

export function monthStart(isoDate: string): string {
  return `${isoDate.slice(0, 7)}-01`;
}
