import { sql } from "drizzle-orm";
import type { DbOrTx } from "../db/client";

export const SEQUENCES = {
  journal: { key: "JE", start: 1 },
  salesOrder: { key: "SO", start: 1001 },
  invoice: { key: "INV", start: 1001 },
  payment: { key: "PMT", start: 1001 },
  deposit: { key: "DEP", start: 1001 },
  adjustment: { key: "ADJ", start: 1001 },
  purchaseOrder: { key: "PO", start: 1001 },
  receipt: { key: "RCV", start: 1001 },
  bill: { key: "BILL", start: 1001 },
  billPayment: { key: "BP", start: 1001 },
} as const;

export type SequenceName = keyof typeof SEQUENCES;

/**
 * Gap-free per-organization numbering. The upsert takes a row lock, so
 * concurrent transactions in one organization queue here instead of
 * producing duplicates; the number is released if the transaction rolls back.
 */
export async function nextNumber(db: DbOrTx, organizationId: string, name: SequenceName): Promise<number> {
  const { key, start } = SEQUENCES[name];
  const result = await db.execute<{ value: number }>(sql`
    insert into number_sequences (organization_id, key, next_value)
    values (${organizationId}, ${key}, ${start + 1})
    on conflict (organization_id, key)
    do update set next_value = number_sequences.next_value + 1
    returning next_value - 1 as value
  `);
  const value = result.rows[0]?.value;
  if (value === undefined) throw new Error("Could not allocate a document number");
  return Number(value);
}

/** Numbers for documents declared in a configuration: "Rental-1001". */
export async function nextConfigDocumentNumber(db: DbOrTx, organizationId: string, typeName: string) {
  const result = await db.execute<{ value: number }>(sql`
    insert into number_sequences (organization_id, key, next_value)
    values (${organizationId}, ${`X:${typeName}`}, 1002)
    on conflict (organization_id, key)
    do update set next_value = number_sequences.next_value + 1
    returning next_value - 1 as value
  `);
  return `${typeName}-${Number(result.rows[0]!.value)}`;
}

export async function nextDocumentNumber(db: DbOrTx, organizationId: string, name: Exclude<SequenceName, "journal">) {
  const n = await nextNumber(db, organizationId, name);
  return `${SEQUENCES[name].key}-${n}`;
}
