import { Client } from "pg";

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

/**
 * Different event ids reporting conflicting outcomes for the same order, all
 * delivered at the same time.
 */
describe("concurrent conflicting provider events for one order", () => {
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

  it("always ends in succeeded, whatever order the events are processed in", async () => {
    const successes = 6;
    const failures = 6;

    const responses = await Promise.all([
      ...Array.from({ length: successes }, (_, i) =>
        post(ctx, WEBHOOK_PATH, webhookBody({ id: `evt_ok_${i}` })),
      ),
      ...Array.from({ length: failures }, (_, i) =>
        post(ctx, WEBHOOK_PATH, webhookBody({ id: `evt_fail_${i}`, type: "payment.failed" })),
      ),
    ]);

    expect(responses.every((response) => response.status === 200)).toBe(true);

    // Each response reports the status its own transaction committed, so a failure
    // event that ran first legitimately reports "failed". What must hold:
    //  - a success event never reports anything but "succeeded";
    //  - a failure event is never the last word for the order.
    for (const response of responses.filter((r) => r.body.eventId.startsWith("evt_ok_"))) {
      expect(response.body.order.status).toBe("succeeded");
      expect(response.body.outcome).not.toBe("ignored_terminal");
    }
    for (const response of responses.filter((r) => r.body.eventId.startsWith("evt_fail_"))) {
      expect(["failed", "succeeded"]).toContain(response.body.order.status);
      expect(["applied", "no_status_change", "ignored_terminal"]).toContain(response.body.outcome);
    }

    const order = await ctx.getOrder("ORDER-1001");
    expect(order?.status).toBe("succeeded");

    // Every event is recorded; each one describes what it did.
    expect(await ctx.countEvents()).toBe(successes + failures);
    const successEvent = await ctx.getEvent("evt_ok_0");
    expect(successEvent?.applied).toBe(true);
    expect(successEvent?.resultingStatus).toBe("succeeded");

    for (let i = 0; i < failures; i += 1) {
      const failureEvent = await ctx.getEvent(`evt_fail_${i}`);
      expect(["applied", "ignored_terminal", "no_status_change"]).toContain(failureEvent?.outcome);
      // A failure event can never end up as the final status of the order.
      expect(failureEvent?.resultingStatus).not.toBe("failed");
      if (failureEvent?.applied) {
        // If a failure was applied it must have been followed by a success.
        expect(failureEvent.previousStatus).toBe("pending");
      }
    }
  });

  it("serializes a failure that arrives while the success is still being applied", async () => {
    const [failure, success] = await Promise.all([
      post(ctx, WEBHOOK_PATH, webhookBody({ id: "evt_race_fail", type: "payment.failed" })),
      post(ctx, WEBHOOK_PATH, webhookBody({ id: "evt_race_ok" })),
    ]);

    expect(failure.status).toBe(200);
    expect(success.status).toBe(200);

    // Each response reports the status its own transaction committed, so the
    // failure may legitimately report `failed` - what matters is that the stored
    // history is a coherent chain ending in succeeded.
    const failureEvent = await ctx.getEvent("evt_race_fail");
    const successEvent = await ctx.getEvent("evt_race_ok");

    expect(successEvent?.applied).toBe(true);
    expect(successEvent?.resultingStatus).toBe("succeeded");
    expect(["failed", "pending"]).toContain(successEvent?.previousStatus);

    if (failureEvent?.applied === true) {
      // Failure first, then the success overrode it: previousStatus must line up.
      expect(failureEvent.previousStatus).toBe("pending");
      expect(failureEvent.resultingStatus).toBe("failed");
      expect(successEvent?.previousStatus).toBe("failed");
      expect(failure.body.order.status).toBe("failed");
      expect(success.body.order.status).toBe("succeeded");
    } else {
      // Success first: the failure was refused without touching the order.
      expect(failureEvent?.outcome).toBe("ignored_terminal");
      expect(failureEvent?.previousStatus).toBe("succeeded");
      expect(failureEvent?.resultingStatus).toBe("succeeded");
      expect(successEvent?.previousStatus).toBe("pending");
      expect(failure.body.order.status).toBe("succeeded");
    }

    expect((await ctx.getOrder("ORDER-1001"))?.status).toBe("succeeded");
  });
  it("queues overlapping conflicting events behind the order row lock", async () => {
    // Hold a row lock on the order, so every overlapping event has to wait for
    // it. Without the lock these events could read-modify-write the same row at
    // the same time and lose a valid status change.
    const blocker = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await blocker.connect();
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM orders WHERE order_reference = $1 FOR UPDATE", [
      "ORDER-1001",
    ]);

    const inflight = Promise.all([
      post(ctx, WEBHOOK_PATH, webhookBody({ id: "evt_locked_ok" })),
      post(ctx, WEBHOOK_PATH, webhookBody({ id: "evt_locked_fail", type: "payment.failed" })),
      post(ctx, WEBHOOK_PATH, webhookBody({ id: "evt_locked_ok_2" })),
    ]);

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
    expect(
      responses
        .filter((response) => response.body.eventId !== "evt_locked_fail")
        .every((response) => response.body.order.status === "succeeded"),
    ).toBe(true);
    expect(["failed", "succeeded"]).toContain(
      responses.find((response) => response.body.eventId === "evt_locked_fail")!.body.order.status,
    );
    expect((await ctx.getOrder("ORDER-1001"))?.status).toBe("succeeded");

    // Exactly one success event applies and the other merely confirms the status;
    // the failure event can never be the last word. Which event reached the lock
    // first is a race, so both orderings are legal and must be handled.
    const successes = [await ctx.getEvent("evt_locked_ok"), await ctx.getEvent("evt_locked_ok_2")];
    expect(successes.filter((event) => event?.applied)).toHaveLength(1);

    const failureEvent = await ctx.getEvent("evt_locked_fail");
    if (failureEvent?.applied) {
      // Failure reached the lock first: pending -> failed, then a success
      // overrode it, which is allowed because failed is not terminal.
      expect(failureEvent.previousStatus).toBe("pending");
      expect(failureEvent.resultingStatus).toBe("failed");
    } else {
      // A success reached the lock first: the failure was refused outright.
      expect(failureEvent?.outcome).toBe("ignored_terminal");
      expect(failureEvent?.previousStatus).toBe("succeeded");
      expect(failureEvent?.resultingStatus).toBe("succeeded");
    }
  });
});
