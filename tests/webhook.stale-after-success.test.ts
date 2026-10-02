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
 * A stale or conflicting event arriving after a payment succeeded must never
 * move the order out of `succeeded`.
 */
describe("stale or conflicting events after a successful payment", () => {
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

  it("refuses a late failure event for an order that already succeeded", async () => {
    const success = await post(
      ctx,
      WEBHOOK_PATH,
      webhookBody({ id: "evt_ok_1" }, { providerPaymentId: "pay_1" }),
    );
    expect(success.body.applied).toBe(true);
    const succeededAt = (await ctx.getOrder("ORDER-1001"))!.updatedAt;

    // A different event id reports failure for the same order, long after the fact.
    const stale = await post(
      ctx,
      WEBHOOK_PATH,
      webhookBody(
        { id: "evt_stale_failed", type: "payment.failed" },
        { providerPaymentId: "pay_1" },
      ),
    );

    expect(stale.status).toBe(200);
    expect(stale.body).toMatchObject({
      received: true,
      applied: false,
      duplicate: false,
      outcome: "ignored_terminal",
    });
    expect(stale.body.order.status).toBe("succeeded");

    const order = await ctx.getOrder("ORDER-1001");
    expect(order?.status).toBe("succeeded");
    expect(order?.updatedAt).toEqual(succeededAt); // not rewritten

    const staleEvent = await ctx.getEvent("evt_stale_failed");
    expect(staleEvent).toMatchObject({
      applied: false,
      outcome: "ignored_terminal",
      previousStatus: "succeeded",
      resultingStatus: "succeeded",
      deliveryCount: 1,
    });
  });

  it("keeps refusing it when the stale failure is redelivered many times", async () => {
    await post(ctx, WEBHOOK_PATH, webhookBody({ id: "evt_ok_2" }));
    const before = await ctx.getOrder("ORDER-1001");

    const redeliveries = await Promise.all(
      Array.from({ length: 5 }, () =>
        post(ctx, WEBHOOK_PATH, webhookBody({ id: "evt_stale_failed_2", type: "payment.failed" })),
      ),
    );

    expect(redeliveries.every((response) => response.body.outcome === "ignored_terminal")).toBe(
      true,
    );
    expect(redeliveries.every((response) => response.body.applied === false)).toBe(true);
    expect(await ctx.getOrder("ORDER-1001")).toEqual(before);
    expect(await ctx.getEvent("evt_stale_failed_2")).toMatchObject({
      deliveryCount: 5,
      applied: false,
      outcome: "ignored_terminal",
    });
  });

  it("records a redundant success event without rewriting the order", async () => {
    await post(ctx, WEBHOOK_PATH, webhookBody({ id: "evt_ok_3" }));
    const before = await ctx.getOrder("ORDER-1001");

    const secondSuccess = await post(
      ctx,
      WEBHOOK_PATH,
      webhookBody({ id: "evt_ok_4" }, { providerPaymentId: "pay_2" }),
    );

    expect(secondSuccess.body).toMatchObject({
      applied: false,
      outcome: "no_status_change",
    });
    expect(secondSuccess.body.order.status).toBe("succeeded");
    expect(await ctx.getOrder("ORDER-1001")).toEqual(before);
    expect(await ctx.getEvent("evt_ok_4")).toMatchObject({
      applied: false,
      outcome: "no_status_change",
      previousStatus: "succeeded",
      resultingStatus: "succeeded",
    });
  });

  it("replays a duplicate of the success event without applying it twice", async () => {
    const first = await post(ctx, WEBHOOK_PATH, webhookBody({ id: "evt_ok_5" }));
    const before = await ctx.getOrder("ORDER-1001");

    const replay = await post(ctx, WEBHOOK_PATH, webhookBody({ id: "evt_ok_5" }));

    expect(replay.body).toMatchObject({
      applied: false,
      duplicate: true,
      outcome: "applied",
    });
    expect(replay.body.order.updatedAt).toBe(first.body.order.updatedAt);
    expect(await ctx.getOrder("ORDER-1001")).toEqual(before);
  });

  it("lets a success event override an earlier failure (out-of-order delivery)", async () => {
    const failure = await post(
      ctx,
      WEBHOOK_PATH,
      webhookBody({ id: "evt_fail_first", type: "payment.failed" }),
    );
    expect(failure.body).toMatchObject({ applied: true, outcome: "applied" });
    expect((await ctx.getOrder("ORDER-1001"))?.status).toBe("failed");

    // The success event for the retry arrives later: success always wins.
    const success = await post(
      ctx,
      WEBHOOK_PATH,
      webhookBody({ id: "evt_success_second" }, { providerPaymentId: "pay_retry" }),
    );
    expect(success.body).toMatchObject({ applied: true, outcome: "applied" });
    expect(success.body.order.status).toBe("succeeded");
    expect(await ctx.getEvent("evt_success_second")).toMatchObject({
      previousStatus: "failed",
      resultingStatus: "succeeded",
    });

    // ...and the earlier failure being redelivered afterwards still cannot regress it.
    const replayedFailure = await post(
      ctx,
      WEBHOOK_PATH,
      webhookBody({ id: "evt_fail_first", type: "payment.failed" }),
    );
    expect(replayedFailure.body).toMatchObject({
      applied: false,
      duplicate: true,
      outcome: "applied",
    });
    expect(replayedFailure.body.order.status).toBe("succeeded");
    expect((await ctx.getOrder("ORDER-1001"))?.status).toBe("succeeded");
  });

  it("ignores unsupported event types without touching the order", async () => {
    const before = await ctx.getOrder("ORDER-1001");

    const refund = await post(
      ctx,
      WEBHOOK_PATH,
      webhookBody({ id: "evt_refund", type: "refund.created" }),
    );

    expect(refund.status).toBe(200);
    expect(refund.body).toMatchObject({ applied: false, outcome: "ignored_unsupported_type" });
    expect(await ctx.getOrder("ORDER-1001")).toEqual(before);
    expect(await ctx.getEvent("evt_refund")).toMatchObject({
      applied: false,
      outcome: "ignored_unsupported_type",
      deliveryCount: 1,
    });
  });
});
