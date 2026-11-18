import { z } from "zod";
import { MONEY_RE, QTY_RE } from "./money";

/** Money accepted as a JSON string ("12.50") or number; stored as a string. */
export const moneyInput = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((v) => MONEY_RE.test(v), { message: "Enter an amount with at most 2 decimal places." });

export const positiveMoney = moneyInput.refine((v) => Number(v) > 0, { message: "Amount must be greater than zero." });
export const nonNegativeMoney = moneyInput.refine((v) => !v.startsWith("-"), { message: "Amount cannot be negative." });

export const quantityInput = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((v) => QTY_RE.test(v), { message: "Enter a quantity with at most 4 decimal places." });

export const positiveQuantity = quantityInput.refine((v) => Number(v) > 0, {
  message: "Quantity must be greater than zero.",
});

export const percentInput = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((v) => /^\d{1,3}(\.\d{1,4})?$/.test(v) && Number(v) <= 100, { message: "Enter a percentage from 0 to 100." });

export const isoDate = z.iso.date("Enter a valid calendar date in YYYY-MM-DD format.")
  .refine((value) => !value.startsWith("0000-"), "The year must be 0001 or later.");
export const uuidParam = z.object({ id: z.uuid() });

export const listQuery = z.object({
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  includeArchived: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
});

export const addressSchema = z
  .object({
    line1: z.string().max(200).optional(),
    line2: z.string().max(200).optional(),
    city: z.string().max(100).optional(),
    state: z.string().max(50).optional(),
    postalCode: z.string().max(20).optional(),
    country: z.string().max(60).optional(),
  })
  .nullable()
  .optional();

export const optionalText = (max = 2000) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

/** ILIKE pattern for user search text, with wildcards escaped. */
export function likePattern(q: string) {
  return `%${q.replace(/[\\%_]/g, "\\$&")}%`;
}
