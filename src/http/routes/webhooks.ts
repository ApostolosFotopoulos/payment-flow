import { Router } from "express";

import type { Db } from "../../db/client";
import { processProviderEvent } from "../../domain/webhooks";
import { providerEventSchema } from "../schemas";
import { asyncRoute, parseBody } from "../validation";

/**
 * POST /webhooks/payment-provider
 *
 * Always answers 200 once the event has been committed - including for events
 * that were deliberately not applied (`outcome` explains why). The response is
 * written only after COMMIT, so a 200 means "durably recorded"; a failure rolls
 * the whole transaction back and answers 500, which makes the provider retry.
 *
 * Webhook authentication is out of scope for this exercise.
 */
export function webhooksRouter(db: Db): Router {
  const router = Router();

  router.post(
    "/webhooks/payment-provider",
    asyncRoute(async (req, res) => {
      const body = parseBody(providerEventSchema, req);

      const result = await processProviderEvent(db, {
        id: body.id,
        type: body.type,
        orderReference: body.data.orderReference,
        providerPaymentId: body.data.providerPaymentId ?? null,
        rawPayload: req.body,
      });

      res.status(200).json({
        received: true,
        eventId: result.eventId,
        applied: result.applied,
        duplicate: result.duplicate,
        outcome: result.outcome,
        deliveryCount: result.deliveryCount,
        order: result.order
          ? {
              ...result.order,
              updatedAt: result.order.updatedAt.toISOString(),
            }
          : null,
      });
    }),
  );

  return router;
}
