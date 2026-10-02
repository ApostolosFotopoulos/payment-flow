import { eq, sql } from "drizzle-orm";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { createApp } from "../../src/app";
import { createDb, createPool, type Db } from "../../src/db/client";
import { orders, providerEvents } from "../../src/db/schema";
import type { Order, ProviderEvent } from "../../src/db/schema";

export type TestContext = {
  baseUrl: string;
  db: Db;
  /** Direct database access, for asserting on stored rows. */
  getOrder: (orderReference: string) => Promise<Order | null>;
  getOrderById: (id: string) => Promise<Order | null>;
  getEvent: (eventId: string) => Promise<ProviderEvent | null>;
  countOrders: () => Promise<number>;
  countEvents: () => Promise<number>;
  reset: () => Promise<void>;
  close: () => Promise<void>;
};

/**
 * Boots the real Express app on an ephemeral port so tests exercise real HTTP
 * requests over separate connections (which is what makes the concurrency tests
 * meaningful) instead of calling handlers in-process.
 */
export async function startTestServer(): Promise<TestContext> {
  const pool = createPool({ connectionString: process.env.TEST_DATABASE_URL, max: 20 });
  const db = createDb(pool);
  const app = createApp(db);

  const server: Server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  const reset = async () => {
    await db.execute("TRUNCATE provider_events, orders RESTART IDENTITY CASCADE");
  };

  return {
    baseUrl,
    db,
    getOrder: async (orderReference) => {
      const rows = await db
        .select()
        .from(orders)
        .where(eq(orders.orderReference, orderReference))
        .limit(1);
      return rows[0] ?? null;
    },
    getOrderById: async (id) => {
      const rows = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
      return rows[0] ?? null;
    },
    getEvent: async (eventId) => {
      const rows = await db
        .select()
        .from(providerEvents)
        .where(eq(providerEvents.id, eventId))
        .limit(1);
      return rows[0] ?? null;
    },
    countOrders: async () => {
      const result = await db.select({ value: sql<number>`count(*)::int` }).from(orders);
      return result[0]?.value ?? 0;
    },
    countEvents: async () => {
      const result = await db.select({ value: sql<number>`count(*)::int` }).from(providerEvents);
      return result[0]?.value ?? 0;
    },
    reset,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await pool.end();
    },
  };
}

export type HttpResponse<T = any> = {
  status: number;
  body: T;
};

/** Small fetch wrapper so tests read as one-liners. */
export async function post<T = any>(ctx: TestContext, path: string, body: unknown) {
  const response = await fetch(`${ctx.baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as T } as HttpResponse<T>;
}

export async function get<T = any>(ctx: TestContext, path: string) {
  const response = await fetch(`${ctx.baseUrl}${path}`);
  return { status: response.status, body: (await response.json()) as T } as HttpResponse<T>;
}

export const checkoutBody = (overrides: Record<string, unknown> = {}) => ({
  orderReference: "ORDER-1001",
  amountMinor: 2599,
  currency: "EUR",
  ...overrides,
});

export const webhookBody = (
  overrides: Record<string, unknown> = {},
  data: Record<string, unknown> = {},
) => ({
  id: "evt_0001",
  type: "payment.succeeded",
  createdAt: "2026-01-05T10:00:00.000Z",
  data: { orderReference: "ORDER-1001", providerPaymentId: "pay_abc", ...data },
  ...overrides,
});

export const CHECKOUT_PATH = "/checkout-intents";
export const WEBHOOK_PATH = "/webhooks/payment-provider";
