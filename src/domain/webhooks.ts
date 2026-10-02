import { eq, sql } from "drizzle-orm";

import type { Db, Tx } from "../db/client";
import { orders, providerEvents, type WebhookOutcome } from "../db/schema";
import { sha256OfCanonicalJson } from "../util/json";
import { decideTransition, statusReportedByEvent } from "./payment-status";
import type { PaymentStatus } from "./types";

export type ProviderEventInput = {
  /** Provider's event id - the idempotency key. */
  id: string;
  type: string;
  /** Business order reference the provider echoes back to us. */
  orderReference: string;
  providerPaymentId: string | null;
  /** Full request body, stored as jsonb for auditing. */
  rawPayload: unknown;
};

export type OrderView = {
  id: string;
  orderReference: string;
  status: PaymentStatus;
  updatedAt: Date;
};

export type WebhookResult = {
  received: true;
  eventId: string;
  /** true only for the delivery that actually changed the order status */
  applied: boolean;
  /** true when this event id had already been received before */
  duplicate: boolean;
  outcome: WebhookOutcome;
  deliveryCount: number;
  order: OrderView | null;
};

/**
 * Applies one provider event, exactly once, inside a single transaction.
 *
 * Everything below happens in one `BEGIN ... COMMIT`:
 *
 *   1. INSERT the event row with ON CONFLICT (id) DO NOTHING. The primary key on
 *      `provider_events.id` is the deduplication guarantee; if another
 *      transaction is inserting the same id right now, this statement blocks
 *      until that transaction commits.
 *   2. If nothing was inserted, lock the existing event row FOR UPDATE and
 *      compare its payload hash with this delivery's:
 *        - different hash -> count an event_id_conflict, apply nothing, commit;
 *        - same hash and the first delivery already made a final decision
 *          -> apply nothing, commit;
 *        - same hash and the first delivery could not resolve an order
 *          -> fall through and try again (providers legitimately retry).
 *   3. Lock the order row FOR UPDATE, evaluate the status transition against the
 *      current status, and either update the order or record why we did not.
 *   4. Record the outcome on the event row and COMMIT.
 *
 * The HTTP response is only written after COMMIT returns (see
 * src/http/routes/webhooks.ts), so a 2xx always means "durably recorded".
 */
export async function processProviderEvent(
  db: Db,
  input: ProviderEventInput,
): Promise<WebhookResult> {
  // Only the fields that define the event's *meaning* are hashed. Provider-added
  // metadata (delivery attempt counters, signatures, extra keys) must not turn a
  // redelivery into a false conflict.
  const payloadHash = sha256OfCanonicalJson({
    id: input.id,
    type: input.type,
    data: { orderReference: input.orderReference, providerPaymentId: input.providerPaymentId },
  });
  const now = new Date();

  return db.transaction(async (tx: Tx) => {
    const inserted = await tx
      .insert(providerEvents)
      .values({
        id: input.id,
        type: input.type,
        orderReference: input.orderReference,
        providerPaymentId: input.providerPaymentId,
        payloadHash,
        payload: input.rawPayload as Record<string, unknown>,
        firstReceivedAt: now,
        lastReceivedAt: now,
      })
      .onConflictDoNothing({ target: providerEvents.id })
      .returning();

    let event = inserted[0];
    let duplicate = false;

    if (!event) {
      const storedRows = await tx
        .select()
        .from(providerEvents)
        .where(eq(providerEvents.id, input.id))
        .for("update")
        .limit(1);
      const stored = storedRows[0];
      /* istanbul ignore next - unreachable: the insert conflicted with a committed row */
      if (!stored) throw new Error(`Provider event ${input.id} vanished during processing`);

      await tx
        .update(providerEvents)
        .set({
          deliveryCount: sql`${providerEvents.deliveryCount} + 1`,
          lastReceivedAt: now,
        })
        .where(eq(providerEvents.id, input.id));
      duplicate = true;
      const deliveryCount = stored.deliveryCount + 1;

      if (stored.payloadHash !== payloadHash) {
        // Same event id, different payload: record the anomaly, change nothing.
        await tx
          .update(providerEvents)
          .set({
            payloadConflictCount: sql`${providerEvents.payloadConflictCount} + 1`,
          })
          .where(eq(providerEvents.id, input.id));
        return {
          received: true,
          eventId: input.id,
          applied: false,
          duplicate: true,
          outcome: "event_id_conflict" as const,
          deliveryCount,
          order: stored.orderId ? await loadOrderView(tx, stored.orderId) : null,
        };
      }

      const alreadyDecided =
        stored.applied ||
        stored.outcome === "ignored_terminal" ||
        stored.outcome === "ignored_unsupported_type" ||
        stored.outcome === "no_status_change";

      if (alreadyDecided) {
        return {
          received: true,
          eventId: input.id,
          applied: false,
          duplicate: true,
          outcome: stored.outcome as WebhookOutcome,
          deliveryCount,
          order: stored.orderId ? await loadOrderView(tx, stored.orderId) : null,
        };
      }

      // outcome === "order_not_found": the order had not been created yet. This
      // redelivery gets another attempt, with the event row locked so two
      // concurrent redeliveries cannot both apply it.
      event = { ...stored, deliveryCount };
    }

    // --- apply phase ---------------------------------------------------------
    const orderRows = await tx
      .select()
      .from(orders)
      .where(eq(orders.orderReference, input.orderReference))
      .for("update");
    const order = orderRows[0] ?? null;
    const previousStatus = order?.status ?? null;

    const reportedStatus = statusReportedByEvent(input.type);
    let applied = false;
    let outcome: WebhookOutcome;
    let orderId = order?.id ?? null;
    let resultingStatus = order?.status ?? null;

    if (!order) {
      outcome = "order_not_found";
    } else if (reportedStatus === null) {
      outcome = "ignored_unsupported_type";
    } else {
      const decision = decideTransition(order.status, reportedStatus);
      if (decision.kind === "apply") {
        const updated = await tx
          .update(orders)
          .set({ status: decision.next })
          .where(eq(orders.id, order.id))
          .returning();
        applied = true;
        outcome = "applied";
        orderId = updated[0]?.id ?? order.id;
        resultingStatus = updated[0]?.status ?? decision.next;
      } else {
        outcome = decision.outcome;
      }
    }

    await tx
      .update(providerEvents)
      .set({ applied, outcome, previousStatus, resultingStatus, orderId })
      .where(eq(providerEvents.id, input.id));

    return {
      received: true,
      eventId: input.id,
      applied,
      duplicate,
      outcome,
      deliveryCount: event.deliveryCount,
      order: orderId ? await loadOrderView(tx, orderId) : null,
    };
  });
}

async function loadOrderView(tx: Tx, orderId: string): Promise<OrderView | null> {
  const rows = await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  const order = rows[0];
  if (!order) return null;
  return {
    id: order.id,
    orderReference: order.orderReference,
    status: order.status,
    updatedAt: order.updatedAt,
  };
}
