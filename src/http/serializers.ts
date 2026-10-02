import type { Order } from "../db/schema";

export type OrderResponse = {
  id: string;
  orderReference: string;
  amountMinor: number;
  currency: string;
  status: Order["status"];
  createdAt: string;
  updatedAt: string;
};

export function toOrderResponse(order: Order): OrderResponse {
  return {
    id: order.id,
    orderReference: order.orderReference,
    amountMinor: order.amountMinor,
    currency: order.currency,
    status: order.status,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
  };
}
