import { eq } from "drizzle-orm";

import type { Db, Tx } from "../db/client";
import { orders, type Order } from "../db/schema";
import type { CheckoutRequest } from "./types";

export type CheckoutResult =
  /** This request created the order (HTTP 201). */
  | { kind: "created"; order: Order }
  /** A retry of an identical checkout: the existing order is returned (HTTP 200). */
  | { kind: "existing"; order: Order }
  /**
   * The reference is taken but the payload differs (amount/currency changed).
   * Nothing is written; the caller answers 409 (HTTP 409).
   */
  | { kind: "payload_conflict"; order: Order; conflictingFields: string[] };

/**
 * Creates a checkout intent, or recognises it as a retry.
 *
 * Concurrency: the whole thing is one transaction whose first statement is
 *
 *     INSERT ... ON CONFLICT (order_reference) DO NOTHING RETURNING *
 *
 * The unique index on `order_reference` is what makes this safe. If another
 * transaction is concurrently inserting the same reference, PostgreSQL blocks
 * this statement until that transaction commits or rolls back, and then either
 * returns this insert's row (the other one rolled back) or nothing (the other one
 * won). Under the default READ COMMITTED isolation the follow-up SELECT takes a
 * fresh snapshot, so it always sees the committed row. No application-level lock
 * or "check then insert" race is involved.
 */
export async function createCheckoutIntent(
  db: Db,
  request: CheckoutRequest,
): Promise<CheckoutResult> {
  return db.transaction(async (tx: Tx) => {
    const inserted = await tx
      .insert(orders)
      .values({
        orderReference: request.orderReference,
        amountMinor: request.amountMinor,
        currency: request.currency,
      })
      .onConflictDoNothing({ target: orders.orderReference })
      .returning();

    const created = inserted[0];
    if (created) return { kind: "created", order: created };

    // Somebody else already owns this reference. Compare the *checkout* part of
    // the stored order with the incoming payload; status and timestamps are
    // owned by the webhook flow and are irrelevant here.
    const existingRows = await tx
      .select()
      .from(orders)
      .where(eq(orders.orderReference, request.orderReference))
      .limit(1);

    const existing = existingRows[0];
    /* istanbul ignore next - unreachable: the insert conflicted with a committed row */
    if (!existing) throw new Error(`Order ${request.orderReference} vanished during checkout`);

    const conflictingFields: string[] = [];
    if (existing.amountMinor !== request.amountMinor) conflictingFields.push("amountMinor");
    if (existing.currency !== request.currency) conflictingFields.push("currency");

    return conflictingFields.length > 0
      ? { kind: "payload_conflict", order: existing, conflictingFields }
      : { kind: "existing", order: existing };
  });
}

export async function findOrderByReference(db: Db, orderReference: string): Promise<Order | null> {
  const rows = await db
    .select()
    .from(orders)
    .where(eq(orders.orderReference, orderReference))
    .limit(1);
  return rows[0] ?? null;
}

export async function findOrderById(db: Db, id: string): Promise<Order | null> {
  const rows = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
  return rows[0] ?? null;
}
