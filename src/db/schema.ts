import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Payment status of an order.
 *
 * `succeeded` is terminal: no later event may move an order out of it.
 * `failed` is NOT terminal - a later, differently identified event may still
 * report success (e.g. the provider first reports a declined attempt and then a
 * retry that succeeds). See src/domain/payment-status.ts.
 */
export const paymentStatus = pgEnum("payment_status", ["pending", "succeeded", "failed"]);

/**
 * What the service did with a provider event. Persisted on every event so that
 * late-arriving duplicates can be explained instead of silently dropped.
 */
export const webhookOutcome = pgEnum("webhook_outcome", [
  "applied", // the order status was changed to match the event
  "no_status_change", // the order already had the status this event reports
  "ignored_terminal", // order already succeeded; a failure event cannot regress it
  "ignored_unsupported_type", // event type this service does not act on
  "order_not_found", // no order matches the referenced order; delivery may retry
  "event_id_conflict", // same event id, different payload: stored, never applied twice
]);

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Business order reference (merchant's order number). Service-wide unique. */
    orderReference: text("order_reference").notNull(),
    /** Amount in minor currency units (e.g. 1050 = 10.50 EUR). Never a float. */
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    /** ISO-4217 alphabetic code, uppercase. */
    currency: varchar("currency", { length: 3 }).notNull(),
    status: paymentStatus("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * THE idempotency constraint for checkout retries: the business order
     * reference is unique for the whole service, so concurrent inserts of the
     * same reference can never produce two orders.
     */
    uniqueIndex("orders_order_reference_key").on(table.orderReference),
    check("orders_amount_minor_positive", sql`${table.amountMinor} > 0`),
    /** Guard rail so `amountMinor` always fits in a JS safe integer. */
    check("orders_amount_minor_max", sql`${table.amountMinor} < 1000000000000`),
    check("orders_currency_iso4217", sql`${table.currency} ~ '^[A-Z]{3}$'`),
    check("orders_order_reference_not_blank", sql`length(btrim(${table.orderReference})) > 0`),
  ],
);

/**
 * One row per provider event id. The primary key is the deduplication
 * mechanism: a second delivery of the same event id cannot insert a second row,
 * so the event is applied at most once.
 */
export const providerEvents = pgTable(
  "provider_events",
  {
    /** Provider's event id - the idempotency key for webhooks. */
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    /** Order this event resolved to, NULL when no order matched. */
    orderId: uuid("order_id").references(() => orders.id),
    orderReference: text("order_reference"),
    providerPaymentId: text("provider_payment_id"),
    /** SHA-256 over the canonical JSON body, used to detect the same id + new payload. */
    payloadHash: text("payload_hash").notNull(),
    /** First-seen raw body, kept for audit/debugging. */
    payload: jsonb("payload").notNull(),
    applied: boolean("applied").notNull().default(false),
    outcome: webhookOutcome("outcome"),
    /** Order status after the event was processed (NULL if nothing was applied). */
    resultingStatus: paymentStatus("resulting_status"),
    /** Status the order had before this event was processed. */
    previousStatus: paymentStatus("previous_status"),
    /** How often this event id was delivered, including the first delivery. */
    deliveryCount: integer("delivery_count").notNull().default(1),
    /** How often the same event id arrived with a *different* payload. */
    payloadConflictCount: integer("payload_conflict_count").notNull().default(0),
    firstReceivedAt: timestamp("first_received_at", { withTimezone: true }).notNull().defaultNow(),
    lastReceivedAt: timestamp("last_received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("provider_events_order_id_idx").on(table.orderId),
    index("provider_events_received_at_idx").on(table.firstReceivedAt),
  ],
);

export type Order = typeof orders.$inferSelect;
export type ProviderEvent = typeof providerEvents.$inferSelect;
export type WebhookOutcome = (typeof webhookOutcome.enumValues)[number];
