import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "../../db/client";
import { items, locations, stockLevels, stockMoves } from "../../db/schema";
import { AppError, invalid } from "../../lib/errors";
import { cents, dec, qty4 } from "../../lib/money";

type MoveSource = {
  organizationId: string;
  itemId: string;
  locationId: string;
  date: string;
  sourceType: string;
  sourceId: string;
  sourceNumber?: string | null;
};

export async function defaultLocationId(tx: Tx, organizationId: string) {
  const [loc] = await tx
    .select({ id: locations.id })
    .from(locations)
    .where(and(eq(locations.organizationId, organizationId), eq(locations.isDefault, true)));
  if (!loc) throw new AppError(500, "missing_location", "The organization has no default warehouse.");
  return loc.id;
}

/** Lock (creating if needed) the stock row for an item at a location. */
async function lockLevel(tx: Tx, organizationId: string, itemId: string, locationId: string) {
  await tx
    .insert(stockLevels)
    .values({ organizationId, itemId, locationId })
    .onConflictDoNothing();
  const [level] = await tx
    .select()
    .from(stockLevels)
    .where(
      and(
        eq(stockLevels.organizationId, organizationId),
        eq(stockLevels.itemId, itemId),
        eq(stockLevels.locationId, locationId),
      ),
    )
    .for("update");
  if (!level) throw new Error("Stock level row missing after upsert");
  return level;
}

/** Add stock at a known total value. Moving average falls out of value / quantity. */
export async function receiveStock(tx: Tx, src: MoveSource & { quantity: string; value: string }) {
  const quantity = dec(src.quantity);
  if (quantity.lte(0)) throw invalid("Received quantity must be greater than zero.");
  const value = dec(cents(src.value));
  if (value.isNegative()) throw invalid("Received value cannot be negative.");
  const level = await lockLevel(tx, src.organizationId, src.itemId, src.locationId);
  await tx
    .update(stockLevels)
    .set({
      qtyOnHand: qty4(dec(level.qtyOnHand).plus(quantity)),
      valueOnHand: cents(dec(level.valueOnHand).plus(value)),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(stockLevels.organizationId, src.organizationId),
        eq(stockLevels.itemId, src.itemId),
        eq(stockLevels.locationId, src.locationId),
      ),
    );
  await tx.insert(stockMoves).values({
    organizationId: src.organizationId,
    itemId: src.itemId,
    locationId: src.locationId,
    date: src.date,
    quantity: qty4(quantity),
    valueChange: cents(value),
    sourceType: src.sourceType,
    sourceId: src.sourceId,
    sourceNumber: src.sourceNumber ?? null,
  });
  return cents(value);
}

/**
 * Remove stock at moving-average cost. Taking the last unit takes the whole
 * remaining value, so the Inventory account always equals stock value exactly.
 * Returns the cost removed (positive, in cents).
 */
export async function issueStock(tx: Tx, src: MoveSource & { quantity: string }) {
  const quantity = dec(src.quantity);
  if (quantity.lte(0)) throw invalid("Issued quantity must be greater than zero.");
  const level = await lockLevel(tx, src.organizationId, src.itemId, src.locationId);
  const onHand = dec(level.qtyOnHand);
  if (onHand.lt(quantity)) {
    const [item] = await tx.select({ sku: items.sku, name: items.name }).from(items).where(eq(items.id, src.itemId));
    throw new AppError(
      422,
      "insufficient_stock",
      `Not enough stock for ${item?.sku ?? "item"} ${item?.name ?? ""}: ${onHand.toFixed()} on hand, ${quantity.toFixed()} needed.`,
      { itemId: src.itemId, onHand: onHand.toFixed(4), requested: quantity.toFixed(4) },
    );
  }
  const value = dec(level.valueOnHand);
  const cost = onHand.equals(quantity) ? value : dec(cents(value.times(quantity).dividedBy(onHand)));
  await tx
    .update(stockLevels)
    .set({
      qtyOnHand: qty4(onHand.minus(quantity)),
      valueOnHand: cents(value.minus(cost)),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(stockLevels.organizationId, src.organizationId),
        eq(stockLevels.itemId, src.itemId),
        eq(stockLevels.locationId, src.locationId),
      ),
    );
  await tx.insert(stockMoves).values({
    organizationId: src.organizationId,
    itemId: src.itemId,
    locationId: src.locationId,
    date: src.date,
    quantity: qty4(quantity.negated()),
    valueChange: cents(cost.negated()),
    sourceType: src.sourceType,
    sourceId: src.sourceId,
    sourceNumber: src.sourceNumber ?? null,
  });
  return cents(cost);
}

/**
 * Remove an exact quantity and value (used to undo a receipt when a document
 * is unposted). Fails if the stock has since been sold below that level.
 */
export async function removeStockExact(tx: Tx, src: MoveSource & { quantity: string; value: string }) {
  const quantity = dec(src.quantity);
  const value = dec(cents(src.value));
  const level = await lockLevel(tx, src.organizationId, src.itemId, src.locationId);
  if (dec(level.qtyOnHand).lt(quantity) || dec(level.valueOnHand).lt(value)) {
    throw new AppError(422, "insufficient_stock", "This stock has already been used, so the receipt cannot be undone.", { itemId: src.itemId });
  }
  const qtyAfter = dec(level.qtyOnHand).minus(quantity);
  const valueAfter = dec(level.valueOnHand).minus(value);
  // Keep the Inventory account equal to stock value: an emptied bin must hold exactly nothing.
  if (qtyAfter.isZero() && !valueAfter.isZero()) {
    throw new AppError(422, "insufficient_stock", "Stock has moved since this receipt at a different cost, so it cannot be undone exactly.", { itemId: src.itemId });
  }
  await tx
    .update(stockLevels)
    .set({ qtyOnHand: qty4(qtyAfter), valueOnHand: cents(valueAfter), updatedAt: new Date() })
    .where(
      and(
        eq(stockLevels.organizationId, src.organizationId),
        eq(stockLevels.itemId, src.itemId),
        eq(stockLevels.locationId, src.locationId),
      ),
    );
  await tx.insert(stockMoves).values({
    organizationId: src.organizationId,
    itemId: src.itemId,
    locationId: src.locationId,
    date: src.date,
    quantity: qty4(quantity.negated()),
    valueChange: cents(value.negated()),
    sourceType: src.sourceType,
    sourceId: src.sourceId,
    sourceNumber: src.sourceNumber ?? null,
  });
}

/** Link the stock moves of a source document to the journal entry it produced. */
export async function linkMovesToEntry(tx: Tx, organizationId: string, sourceId: string, journalEntryId: string) {
  await tx
    .update(stockMoves)
    .set({ journalEntryId })
    .where(
      and(
        eq(stockMoves.organizationId, organizationId),
        eq(stockMoves.sourceId, sourceId),
        sql`${stockMoves.journalEntryId} is null`,
      ),
    );
}
