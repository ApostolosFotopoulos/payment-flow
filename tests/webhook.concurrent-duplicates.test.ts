import { Client } from "pg";

import { sha256OfCanonicalJson } from "../src/util/json";
import {
  CHECKOUT_PATH,
  WEBHOOK_PATH,
  checkoutBody,
  post,
  startTestServer,
  webhookBody,
  type TestContext,
} from "./helpers/test-server";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("concurrent deliveries of the same provider event", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startTestServer();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  it("applies the event exactly once for overlapping deliveries", async () => {
    await post(ctx, CHECKOUT_PATH, checkoutBody());
    const deliveries = 10;

    // Same event id, ten overlapping deliveries. Exactly one of them may apply.
    const responses = await Promise.all(
      Array.from({ length: deliveries }, () =>
        post(ctx, WEBHOOK_PATH, webhookBody({ id: "evt_dup_1" })),
      ),
    );

    expect(responses.every((response) => response.status === 200)).toBe(true);

    const applied = responses.filter((response) => response.body.applied === true);
    expect(applied).toHaveLength(1);
    expect(applied[0]!.body.outcome).toBe("applied");
    expect(applied[0]!.body.duplicate).toBe(false);

    const duplicates = responses.filter((response) => response.body.duplicate === true);
    expect(duplicates).toHaveLength(deliveries - 1);
    expect(duplicates.every((response) => response.body.applied === false)).toBe(true);
    // Duplicates report the decision the first delivery already made.
    expect(duplicates.every((response) => response.body.outcome === "applied")).toBe(true);
    expect(duplicates.every((response) => response.body.order.status === "succeeded")).toBe(true);

    // Stored data: one event row, recorded once, counted ten times.
    expect(await ctx.countEvents()).toBe(1);
    const event = await ctx.getEvent("evt_dup_1");
    expect(event).toMatchObject({
      id: "evt_dup_1",
      type: "payment.succeeded",
      applied: true,
      outcome: "applied",
      previousStatus: "pending",
      resultingStatus: "succeeded",
      deliveryCount: deliveries,
      payloadConflictCount: 0,
    });

    // Stored data: the order moved pending -> succeeded exactly once.
    const order = await ctx.getOrder("ORDER-1001");
    expect(order?.status).toBe("succeeded");
    expect(event?.orderId).toBe(order?.id);
    // The status change is the only write to the order: updated_at moved, and no
    // duplicate delivery touched it again.
    expect(order!.updatedAt.getTime()).toBeGreaterThan(order!.createdAt.getTime());
  });

  it("applies a redelivered failure exactly once as well", async () => {
    await post(ctx, CHECKOUT_PATH, checkoutBody());
    const deliveries = 6;

    const responses = await Promise.all(
      Array.from({ length: deliveries }, () =>
        post(
          ctx,
          WEBHOOK_PATH,
          webhookBody({ id: "evt_fail_1", type: "payment.failed" }, { providerPaymentId: "pay_x" }),
        ),
      ),
    );

    expect(responses.filter((response) => response.body.applied === true)).toHaveLength(1);
    expect(await ctx.countEvents()).toBe(1);
    expect(await ctx.getEvent("evt_fail_1")).toMatchObject({
      applied: true,
      outcome: "applied",
      previousStatus: "pending",
      resultingStatus: "failed",
      deliveryCount: deliveries,
    });
    expect((await ctx.getOrder("ORDER-1001"))?.status).toBe("failed");
  });

  it("keeps idempotency when overlapping deliveries carry extra provider metadata", async () => {
    await post(ctx, CHECKOUT_PATH, checkoutBody());

    const responses = await Promise.all([
      post(ctx, WEBHOOK_PATH, webhookBody({ id: "evt_meta_1" })),
      post(
        ctx,
        WEBHOOK_PATH,
        webhookBody(
          { id: "evt_meta_1", deliveryAttempt: 2, signature: "sig-abc" },
          { providerPaymentId: "pay_abc", riskScore: 0.1 },
        ),
      ),
      post(ctx, WEBHOOK_PATH, webhookBody({ id: "evt_meta_1", deliveryAttempt: 3 })),
    ]);

    // Only semantically relevant fields are hashed, so these are all duplicates.
    expect(responses.filter((response) => response.body.applied === true)).toHaveLength(1);
    expect(responses.every((response) => response.body.outcome === "applied")).toBe(true);
    expect(await ctx.getEvent("evt_meta_1")).toMatchObject({
      applied: true,
      deliveryCount: 3,
      payloadConflictCount: 0,
    });
    expect((await ctx.getOrder("ORDER-1001"))?.status).toBe("succeeded");
  });
  it("blocks overlapping deliveries on an event row inserted by another transaction", async () => {
    await post(ctx, CHECKOUT_PATH, checkoutBody());
    const data = { orderReference: "ORDER-1001", providerPaymentId: "pay_abc" };

    // Another transaction has already inserted this event - the first delivery -
    // but has not committed yet. Every overlapping delivery must wait for that
    // transaction instead of inserting a second row.
    const blocker = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await blocker.connect();
    await blocker.query("BEGIN");
    await blocker.query(
      `INSERT INTO provider_events
         (id, type, order_reference, provider_payment_id, payload_hash, payload, applied, outcome)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, false, NULL)`,
      [
        "evt_blocked",
        "payment.succeeded",
        "ORDER-1001",
        "pay_abc",
        sha256OfCanonicalJson({ id: "evt_blocked", type: "payment.succeeded", data }),
        JSON.stringify(webhookBody({ id: "evt_blocked" }, data)),
      ],
    );

    const inflight = Promise.all(
      Array.from({ length: 5 }, () => post(ctx, WEBHOOK_PATH, webhookBody({ id: "evt_blocked" }))),
    );

    try {
      expect(
        await Promise.race([inflight.then(() => "finished"), delay(300).then(() => "blocked")]),
      ).toBe("blocked");
      expect((await ctx.getOrder("ORDER-1001"))?.status).toBe("pending");
    } finally {
      await blocker.query("COMMIT");
      await blocker.end();
    }

    const responses = await inflight;
    expect(responses.every((response) => response.status === 200)).toBe(true);
    // The deliveries serialize on the event row: exactly one applies the event.
    expect(responses.filter((response) => response.body.applied === true)).toHaveLength(1);
    expect(responses.filter((response) => response.body.duplicate === true)).toHaveLength(5);
    expect(await ctx.countEvents()).toBe(1);
    expect(await ctx.getEvent("evt_blocked")).toMatchObject({
      applied: true,
      outcome: "applied",
      previousStatus: "pending",
      resultingStatus: "succeeded",
      // the blocked first delivery plus the five that waited for it
      deliveryCount: 6,
      payloadConflictCount: 0,
    });
    expect((await ctx.getOrder("ORDER-1001"))?.status).toBe("succeeded");
  });
});
