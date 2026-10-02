import {
  CHECKOUT_PATH,
  WEBHOOK_PATH,
  checkoutBody,
  post,
  startTestServer,
  webhookBody,
  type TestContext,
} from "./helpers/test-server";

/**
 * The provider reuses an event id for a different payload. Policy: record the
 * anomaly, change nothing, answer 200 (the provider already got its answer for
 * this event id).
 */
describe("same provider event id with a different payload", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startTestServer();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    await post(ctx, CHECKOUT_PATH, checkoutBody());
  });

  it("does not apply the changed payload as a second event", async () => {
    const first = await post(
      ctx,
      WEBHOOK_PATH,
      webhookBody({ id: "evt_reused" }, { providerPaymentId: "pay_1" }),
    );
    expect(first.body).toMatchObject({ applied: true, outcome: "applied" });
    const afterFirst = await ctx.getOrder("ORDER-1001");

    // Same id, but now the provider claims the payment failed.
    const conflicting = await post(
      ctx,
      WEBHOOK_PATH,
      webhookBody({ id: "evt_reused", type: "payment.failed" }, { providerPaymentId: "pay_1" }),
    );

    expect(conflicting.status).toBe(200);
    expect(conflicting.body).toMatchObject({
      received: true,
      eventId: "evt_reused",
      applied: false,
      duplicate: true,
      outcome: "event_id_conflict",
      deliveryCount: 2,
    });
    expect(conflicting.body.order.status).toBe("succeeded");

    // The order and the stored event are unchanged apart from the counters.
    expect(await ctx.getOrder("ORDER-1001")).toEqual(afterFirst);
    const stored = await ctx.getEvent("evt_reused");
    expect(stored).toMatchObject({
      type: "payment.succeeded",
      applied: true,
      outcome: "applied",
      payloadConflictCount: 1,
      deliveryCount: 2,
    });
    expect(stored?.payload).toMatchObject({ type: "payment.succeeded" });
    expect(await ctx.countEvents()).toBe(1);
  });

  it("treats a different order reference under the same id as a conflict", async () => {
    await post(ctx, "/checkout-intents", checkoutBody({ orderReference: "ORDER-1002" }));
    await post(
      ctx,
      WEBHOOK_PATH,
      webhookBody({ id: "evt_moved" }, { orderReference: "ORDER-1002" }),
    );

    const conflicting = await post(
      ctx,
      WEBHOOK_PATH,
      webhookBody({ id: "evt_moved" }, { orderReference: "ORDER-1001" }),
    );

    expect(conflicting.body.outcome).toBe("event_id_conflict");
    expect(conflicting.body.applied).toBe(false);
    expect((await ctx.getOrder("ORDER-1001"))?.status).toBe("pending");
    expect((await ctx.getOrder("ORDER-1002"))?.status).toBe("succeeded");
    expect(await ctx.getEvent("evt_moved")).toMatchObject({
      orderReference: "ORDER-1002",
      payloadConflictCount: 1,
    });
  });

  it("keeps counting conflicts when the same id is reused repeatedly", async () => {
    await post(ctx, WEBHOOK_PATH, webhookBody({ id: "evt_repeat" }));
    const before = await ctx.getOrder("ORDER-1001");

    for (let i = 0; i < 3; i += 1) {
      const response = await post(
        ctx,
        WEBHOOK_PATH,
        webhookBody({ id: "evt_repeat", type: "payment.failed" }),
      );
      expect(response.body.outcome).toBe("event_id_conflict");
    }

    expect(await ctx.getOrder("ORDER-1001")).toEqual(before);
    expect(await ctx.getEvent("evt_repeat")).toMatchObject({
      applied: true,
      outcome: "applied",
      deliveryCount: 4,
      payloadConflictCount: 3,
    });
  });

  it("applies exactly one event when conflicting payloads for one id overlap", async () => {
    const responses = await Promise.all([
      post(ctx, WEBHOOK_PATH, webhookBody({ id: "evt_overlap" })),
      post(
        ctx,
        WEBHOOK_PATH,
        webhookBody({ id: "evt_overlap", type: "payment.failed" }, { providerPaymentId: "pay_a" }),
      ),
      post(ctx, WEBHOOK_PATH, webhookBody({ id: "evt_overlap" }, { orderReference: "ORDER-9999" })),
    ]);

    expect(responses.every((response) => response.status === 200)).toBe(true);
    const applied = responses.filter((response) => response.body.applied === true);
    const conflicts = responses.filter((response) => response.body.outcome === "event_id_conflict");
    expect(applied).toHaveLength(1);
    expect(conflicts).toHaveLength(2);

    // The stored order matches the payload that actually won the insert.
    const winner = applied[0]!;
    const order = await ctx.getOrder("ORDER-1001");
    if (winner.body.order === null) {
      expect(order?.status).toBe("pending");
    } else {
      expect(order?.status).toBe(winner.body.order.status);
    }
    expect(await ctx.countEvents()).toBe(1);
    expect(await ctx.getEvent("evt_overlap")).toMatchObject({
      applied: true,
      deliveryCount: 3,
      payloadConflictCount: 2,
    });
  });
});
