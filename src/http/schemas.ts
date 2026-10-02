import { z } from "zod";

/**
 * POST /checkout-intents
 *
 * `amountMinor` is an integer number of minor currency units (1050 = 10.50 EUR).
 * Floats are rejected: an amount is money, and money is stored as an integer
 * count of minor units so no rounding error can ever enter the system.
 */
export const checkoutBodySchema = z
  .object({
    orderReference: z
      .string()
      .trim()
      .min(1, "orderReference must not be empty")
      .max(200, "orderReference must be at most 200 characters"),
    amountMinor: z
      .number()
      .int("amountMinor must be an integer number of minor units (e.g. 1050 for 10.50)")
      .positive("amountMinor must be greater than 0")
      .max(999_999_999_999, "amountMinor is too large"),
    currency: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{3}$/, "currency must be a 3 letter ISO-4217 alphabetic code")
      .transform((value) => value.toUpperCase()),
  })
  .strict();

/**
 * POST /webhooks/payment-provider
 *
 * Unknown top-level / `data` properties are accepted (a real provider sends more
 * than this) but are ignored: only `id`, `type`, `data.orderReference` and
 * `data.providerPaymentId` take part in the payload hash that detects "same
 * event id, different payload".
 */
export const providerEventSchema = z
  .object({
    id: z.string().trim().min(1, "id (the provider event id) is required").max(200),
    type: z.string().trim().min(1, "type is required").max(120),
    createdAt: z.string().datetime({ offset: true }).optional(),
    data: z
      .object({
        orderReference: z.string().trim().min(1).max(200),
        providerPaymentId: z.string().trim().min(1).max(200).optional(),
      })
      .passthrough(),
  })
  .passthrough();

export const uuidParamSchema = z.string().uuid("must be a UUID");
export const orderReferenceParamSchema = z.string().min(1).max(200);
