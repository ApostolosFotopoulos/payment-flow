import { supportedProviderEventTypes, type PaymentStatusLike } from "./types";

/**
 * Payment status transitions.
 *
 * Policy (the whole policy is these 8 table entries):
 *
 *   current     | payment.succeeded        | payment.failed
 *   ------------+---------------------------+------------------
 *   pending     | -> succeeded              | -> failed
 *   failed      | -> succeeded              | no_status_change
 *   succeeded   | no_status_change          | ignored_terminal
 *
 * Two properties matter:
 *
 *  1. `succeeded` is terminal. Once a payment succeeded no later event - however
 *     old or however often delivered - can move the order to a non-successful
 *     status. This is what protects against a late `payment.failed` for a charge
 *     that already went through.
 *  2. `failed` is NOT terminal. A different event may still report success after
 *     a failure (the provider declined an attempt, a retry succeeded, or the two
 *     events simply arrived out of order). Success always wins.
 *
 * Because the decision depends only on the *current* status, and the caller holds
 * a row lock (`SELECT ... FOR UPDATE`) while reading it and writing the new value,
 * concurrent conflicting events are serialized and can never interleave into an
 * invalid state.
 */
export type TransitionDecision =
  | { kind: "apply"; next: PaymentStatusLike; reason: "status_changed" }
  | { kind: "keep"; outcome: "no_status_change" | "ignored_terminal" };

export function isSupportedEventType(type: string): boolean {
  return (supportedProviderEventTypes as readonly string[]).includes(type);
}

export function statusReportedByEvent(type: string): PaymentStatusLike | null {
  switch (type) {
    case "payment.succeeded":
      return "succeeded";
    case "payment.failed":
      return "failed";
    default:
      return null;
  }
}

export function decideTransition(
  current: PaymentStatusLike,
  reportedStatus: PaymentStatusLike,
): TransitionDecision {
  if (current === "succeeded") {
    // Success is final: same status is a no-op, anything else is refused.
    return current === reportedStatus
      ? { kind: "keep", outcome: "no_status_change" }
      : { kind: "keep", outcome: "ignored_terminal" };
  }
  if (current === reportedStatus) {
    return { kind: "keep", outcome: "no_status_change" };
  }
  return { kind: "apply", next: reportedStatus, reason: "status_changed" };
}
