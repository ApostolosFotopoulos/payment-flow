CREATE TYPE "public"."payment_status" AS ENUM('pending', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."webhook_outcome" AS ENUM('applied', 'no_status_change', 'ignored_terminal', 'ignored_unsupported_type', 'order_not_found', 'event_id_conflict');--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_reference" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" varchar(3) NOT NULL,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- amount_minor > 0            : a checkout intent always has a positive amount
	-- amount_minor < 1e12         : keeps the value inside a JS safe integer
	-- currency matches ^[A-Z]{3}$  : ISO-4217 alphabetic code, uppercase
	-- order_reference is non-blank
	CONSTRAINT "orders_amount_minor_positive" CHECK ("orders"."amount_minor" > 0),
	CONSTRAINT "orders_amount_minor_max" CHECK ("orders"."amount_minor" < 1000000000000),
	CONSTRAINT "orders_currency_iso4217" CHECK ("orders"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "orders_order_reference_not_blank" CHECK (length(btrim("orders"."order_reference")) > 0)
);
--> statement-breakpoint
CREATE TABLE "provider_events" (
	-- the provider's event id IS the primary key: that is the deduplication guard
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	-- order this event resolved to; NULL when no order matched (late/unknown order)
	"order_id" uuid,
	-- order reference exactly as the provider reported it
	"order_reference" text,
	"provider_payment_id" text,
	-- sha256 of the canonical JSON body, detects "same event id, different payload"
	"payload_hash" text NOT NULL,
	-- first-seen raw body, kept for auditing and debugging
	"payload" jsonb NOT NULL,
	-- true only if this event was the one that changed the order status
	"applied" boolean DEFAULT false NOT NULL,
	"outcome" "webhook_outcome",
	-- order status before / after this event was processed
	"previous_status" "payment_status",
	"resulting_status" "payment_status",
	-- deliveries of this event id, including the first one
	"delivery_count" integer DEFAULT 1 NOT NULL,
	-- deliveries of this event id that carried a *different* payload
	"payload_conflict_count" integer DEFAULT 0 NOT NULL,
	"first_received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_events_delivery_count_positive" CHECK ("provider_events"."delivery_count" > 0),
	CONSTRAINT "provider_events_payload_conflict_count_non_negative" CHECK ("provider_events"."payload_conflict_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "provider_events" ADD CONSTRAINT "provider_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Retry-safety: the business order reference is unique for the whole service.
-- Two concurrent checkouts with the same reference cannot both insert.
CREATE UNIQUE INDEX "orders_order_reference_key" ON "orders" USING btree ("order_reference");--> statement-breakpoint
CREATE INDEX "provider_events_order_id_idx" ON "provider_events" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "provider_events_received_at_idx" ON "provider_events" USING btree ("first_received_at");--> statement-breakpoint
-- Keep `updated_at` trustworthy no matter which code path writes to the row.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS orders_set_updated_at ON "orders";--> statement-breakpoint
CREATE TRIGGER orders_set_updated_at BEFORE UPDATE ON "orders" FOR EACH ROW EXECUTE FUNCTION set_updated_at();