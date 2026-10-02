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
 * An event can arrive before the order exists. It is stored as
 * `order_not_found` and a later delivery of the same event applies it, exactly
 * once, because the event row is the idempotency key either way.
 */
describe("provider events for an unknown order", () => {
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

  it("records the event and applies it when the order shows up", async () => {
    const early = await post(
      ctx,
      WEBHOOK_PATH,
      webhookBody({ id: "evt_early" }, { orderReference: "ORDER-LATE" }),
    );

    expect(early.status).toBe(200);
    expect(early.body).toMatchObject({
      received: true,
      applied: false,
      outcome: "order_not_found",
      order: null,
    });
    expect(await ctx.getEvent("evt_early")).toMatchObject({
      applied: false,
      outcome: "order_not_found",
      orderId: null,
      previousStatus: null,
      resultingStatus: null,
      deliveryCount: 1,
    });

    // The order is created, the provider redelivers the event.
    await post(ctx, CHECKOUT_PATH, checkoutBody({ orderReference: "ORDER-LATE" }));
    const retry = await post(
      ctx,
      WEBHOOK_PATH,
      webhookBody({ id: "evt_early" }, { orderReference: "ORDER-LATE" }),
    );

    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({
      applied: true,
      duplicate: true,
      outcome: "applied",
      deliveryCount: 2,
    });
    expect(retry.body.order.status).toBe("succeeded");
    expect((await ctx.getOrder("ORDER-LATE"))?.status).toBe("succeeded");
    expect(await ctx.getEvent("evt_early")).toMatchObject({
      applied: true,
      outcome: "applied",
      previousStatus: "pending",
      resultingStatus: "succeeded",
      deliveryCount: 2,
    });
  });

  it("applies the event only once when several retries overlap after the order appears", async () => {
    await post(
      ctx,
      WEBHOOK_PATH,
      webhookBody({ id: "evt_early_2" }, { orderReference: "ORDER-E2" }),
    );
    await post(ctx, CHECKOUT_PATH, checkoutBody({ orderReference: "ORDER-E2" }));

    const retries = await Promise.all(
      Array.from({ length: 8 }, () =>
        post(ctx, WEBHOOK_PATH, webhookBody({ id: "evt_early_2" }, { orderReference: "ORDER-E2" })),
      ),
    );

    expect(retries.filter((response) => response.body.applied === true)).toHaveLength(1);
    expect(retries.every((response) => response.body.outcome === "applied")).toBe(true);
    expect(await ctx.countEvents()).toBe(1);
    expect(await ctx.getEvent("evt_early_2")).toMatchObject({
      applied: true,
      outcome: "applied",
      deliveryCount: 9,
    });
    expect((await ctx.getOrder("ORDER-E2"))?.status).toBe("succeeded");
  });

  it("does not apply anything while the order is still missing", async () => {
    const deliveries = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        post(
          ctx,
          WEBHOOK_PATH,
          webhookBody({ id: `evt_none_${i}` }, { orderReference: "ORDER-NONE" }),
        ),
      ),
    );

    expect(deliveries.every((response) => response.body.outcome === "order_not_found")).toBe(true);
    expect(deliveries.every((response) => response.body.applied === false)).toBe(true);
    expect(await ctx.countOrders()).toBe(0);
    expect(await ctx.countEvents()).toBe(5);
  });

  it("validates the webhook payload", async () => {
    const invalidBodies: [unknown, string][] = [
      [{ type: "payment.succeeded", data: { orderReference: "ORDER-1" } }, "missing id"],
      [{ id: "", type: "payment.succeeded", data: { orderReference: "ORDER-1" } }, "empty id"],
      [{ id: "evt_1", data: { orderReference: "ORDER-1" } }, "missing type"],
      [{ id: "evt_1", type: "payment.succeeded" }, "missing data"],
      [{ id: "evt_1", type: "payment.succeeded", data: {} }, "missing orderReference"],
      [{ id: "evt_1", type: "payment.succeeded", data: { orderReference: "" } }, "blank reference"],
    ];

    for (const [body, description] of invalidBodies) {
      const response = await post(ctx, WEBHOOK_PATH, body);
      expect({ description, status: response.status }).toEqual({ description, status: 400 });
    }
    expect(await ctx.countEvents()).toBe(0);
  });

  it("rejects malformed JSON with 400 and records nothing", async () => {
    const response = await fetch(`${ctx.baseUrl}${WEBHOOK_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_json");
    expect(await ctx.countEvents()).toBe(0);
  });
});
