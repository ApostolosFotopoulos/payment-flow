import { Router } from "express";

import type { Db } from "../../db/client";
import { findOrderById, findOrderByReference } from "../../domain/checkout";
import { notFound } from "../errors";
import { toOrderResponse } from "../serializers";
import { orderReferenceParamSchema, uuidParamSchema } from "../schemas";
import { asyncRoute, parseWith } from "../validation";

/**
 * GET /orders/id/:orderId        -> order status by internal id
 * GET /orders/:orderReference    -> order status by business order reference
 *
 * Both return the stored order, including `updatedAt`, so a caller can tell
 * whether anything changed since it last looked.
 */
export function ordersRouter(db: Db): Router {
  const router = Router();

  // Declared before `/orders/:orderReference` so "id" is never read as a reference.
  router.get(
    "/orders/id/:orderId",
    asyncRoute(async (req, res) => {
      const orderId = parseWith(uuidParamSchema, req.params.orderId);
      const order = await findOrderById(db, orderId);
      if (!order) throw notFound(`No order with id ${orderId}`);
      res.status(200).json({ order: toOrderResponse(order) });
    }),
  );

  router.get(
    "/orders/:orderReference",
    asyncRoute(async (req, res) => {
      const orderReference = parseWith(orderReferenceParamSchema, req.params.orderReference);
      const order = await findOrderByReference(db, orderReference);
      if (!order) throw notFound(`No order with reference ${orderReference}`);
      res.status(200).json({ order: toOrderResponse(order) });
    }),
  );

  return router;
}
