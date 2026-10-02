import { Router } from "express";

import type { Db } from "../../db/client";
import { createCheckoutIntent } from "../../domain/checkout";
import { conflict } from "../errors";
import { toOrderResponse } from "../serializers";
import { checkoutBodySchema } from "../schemas";
import { asyncRoute, parseBody } from "../validation";

/**
 * POST /checkout-intents
 *
 * 201 -> the order was created by this request
 * 200 -> this request was recognised as a retry; the existing order is returned
 * 409 -> the reference already exists with a different amount/currency
 *
 * The business order reference is the idempotency key, so no separate
 * `Idempotency-Key` header is required (or accepted).
 */
export function checkoutRouter(db: Db): Router {
  const router = Router();

  const handler = asyncRoute(async (req, res) => {
    const body = parseBody(checkoutBodySchema, req);
    const result = await createCheckoutIntent(db, body);

    switch (result.kind) {
      case "created":
        res.status(201).json({ created: true, order: toOrderResponse(result.order) });
        return;
      case "existing":
        res.status(200).json({ created: false, order: toOrderResponse(result.order) });
        return;
      case "payload_conflict":
        throw conflict(
          "checkout_payload_conflict",
          `Order reference "${result.order.orderReference}" already exists with a different checkout payload`,
          {
            conflictingFields: result.conflictingFields,
            existingOrder: toOrderResponse(result.order),
          },
        );
    }
  });

  router.post("/checkout-intents", handler);
  // Convenience alias with the same semantics.
  router.post("/orders", handler);

  return router;
}
