// Fixed-point helpers for live form previews (6 decimal places, BigInt).
// The API recomputes every total; these only keep the preview exact.

const SCALE = 1_000_000n;

export function parse(v: string | number | null | undefined): bigint | null {
  const s = String(v ?? "").trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const neg = s.startsWith("-");
  const [int = "0", frac = ""] = s.replace("-", "").split(".");
  const value = BigInt(int) * SCALE + BigInt((frac + "000000").slice(0, 6));
  return neg ? -value : value;
}

function roundTo(value: bigint, places: number): bigint {
  const unit = 10n ** BigInt(6 - places);
  const half = unit / 2n;
  const abs = value < 0n ? -value : value;
  const rounded = ((abs + half) / unit) * unit;
  return value < 0n ? -rounded : rounded;
}

export function mul(a: bigint, b: bigint) {
  return roundTo((a * b) / SCALE, 6);
}

export function toCents(value: bigint) {
  return roundTo(value, 2);
}

export function format2(value: bigint) {
  const v = toCents(value);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const int = abs / SCALE;
  const frac = String((abs % SCALE) / 10_000n).padStart(2, "0");
  return `${neg ? "-" : ""}${int}.${frac}`;
}

/** a − b for quantity strings, exact, rendered with up to 4 decimals and no trailing zeros. */
export function subQty(a: string, b: string): string {
  const diff = (parse(a) ?? 0n) - (parse(b) ?? 0n);
  const neg = diff < 0n;
  const abs = neg ? -diff : diff;
  const frac = String((abs % SCALE) / 100n).padStart(4, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${abs / SCALE}${frac ? `.${frac}` : ""}`;
}

/** Same rule as the API: qty × price × (1 − discount%), rounded to cents. */
export function lineAmount(qty: string, price: string, discountPct: string): bigint | null {
  const q = parse(qty);
  const p = parse(price);
  const d = parse(discountPct || "0");
  if (q === null || p === null || d === null) return null;
  const gross = mul(q, p);
  return toCents((gross * (100n * SCALE - d)) / (100n * SCALE));
}
