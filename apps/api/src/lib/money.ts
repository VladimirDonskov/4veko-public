import Decimal from "decimal.js";

// One configured Decimal class for the whole API. Never use JS numbers for money.
export const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export type Dec = InstanceType<typeof D>;

export function dec(value: Decimal.Value | null | undefined): Dec {
  return new D(value ?? 0);
}

/** Round to cents and render for a numeric(18,2) column. */
export function cents(value: Decimal.Value): string {
  return new D(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

/** Render a quantity for a numeric(18,4) column. */
export function qty4(value: Decimal.Value): string {
  return new D(value).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4);
}

export function sum(values: Decimal.Value[]): Dec {
  return values.reduce<Dec>((acc, v) => acc.plus(v), new D(0));
}

/** Line amount = qty × unit price × (1 − discount%), rounded to cents. */
export function lineAmount(quantity: Decimal.Value, unitPrice: Decimal.Value, discountPct: Decimal.Value = 0): string {
  const gross = new D(quantity).times(unitPrice);
  const net = gross.times(new D(100).minus(discountPct)).dividedBy(100);
  return cents(net);
}

/** Sales tax on the taxable subtotal, rounded once at document level. */
export function taxOn(taxableSubtotal: Decimal.Value, ratePct: Decimal.Value): string {
  return cents(new D(taxableSubtotal).times(ratePct).dividedBy(100));
}

export const MONEY_RE = /^-?\d{1,16}(\.\d{1,2})?$/;
export const QTY_RE = /^-?\d{1,14}(\.\d{1,4})?$/;
