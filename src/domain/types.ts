/** Payment status values, mirroring the `payment_status` PostgreSQL enum. */
export type PaymentStatus = "pending" | "succeeded" | "failed";

/** Alias kept for readability at call sites that only pass statuses through. */
export type PaymentStatusLike = PaymentStatus;

/** Provider event types this service reacts to. Anything else is stored but ignored. */
export const supportedProviderEventTypes = ["payment.succeeded", "payment.failed"] as const;

export type SupportedProviderEventType = (typeof supportedProviderEventTypes)[number];

/** A checkout intent as accepted by POST /checkout-intents (already normalized). */
export type CheckoutRequest = {
  orderReference: string;
  amountMinor: number;
  currency: string;
};
