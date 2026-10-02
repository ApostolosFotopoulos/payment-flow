import { Client } from "pg";

import {
  CHECKOUT_PATH,
  checkoutBody,
  post,
  startTestServer,
  type TestContext,
} from "./helpers/test-server";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("concurrent checkout requests with the same business order reference", () => {
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

  it("creates exactly one order and returns that same order for every overlapping request", async () => {
    const concurrency = 12;

    // All requests are fired before any response is awaited, so they overlap in
    // the database (separate HTTP connections, separate pool connections).
    const responses = await Promise.all(
      Array.from({ length: concurrency }, () => post(ctx, CHECKOUT_PATH, checkoutBody())),
    );

    const created = responses.filter((response) => response.status === 201);
    const firstCreated = created[0]!;
    const retried = responses.filter((response) => response.status === 200);
    expect(created).toHaveLength(1);
    expect(retried).toHaveLength(concurrency - 1);
    expect(firstCreated.body.created).toBe(true);
    expect(retried.every((response) => response.body.created === false)).toBe(true);

    // Every response points at the same order.
    const ids = new Set(responses.map((response) => response.body.order.id));
    expect(ids.size).toBe(1);

    // ...and the database holds exactly one row with that payload.
    expect(await ctx.countOrders()).toBe(1);
    const stored = await ctx.getOrder("ORDER-1001");
    expect(stored).toMatchObject({
      id: firstCreated.body.order.id,
      orderReference: "ORDER-1001",
      amountMinor: 2599,
      currency: "EUR",
      status: "pending",
    });
    expect(stored?.createdAt).toEqual(stored?.updatedAt);
  });

  it("keeps the winner's payload intact when concurrent requests disagree", async () => {
    const payloads = [
      { orderReference: "ORDER-2002", amountMinor: 1000, currency: "USD" },
      { orderReference: "ORDER-2002", amountMinor: 2500, currency: "USD" },
      { orderReference: "ORDER-2002", amountMinor: 1000, currency: "GBP" },
      { orderReference: "ORDER-2002", amountMinor: 2500, currency: "GBP" },
    ];

    const responses = await Promise.all(payloads.map((body) => post(ctx, CHECKOUT_PATH, body)));

    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(
      payloads.length - 1,
    );

    const winner = responses.find((response) => response.status === 201)!.body.order;
    const stored = await ctx.getOrder("ORDER-2002");
    expect(await ctx.countOrders()).toBe(1);
    expect(stored?.amountMinor).toBe(winner.amountMinor);
    expect(stored?.currency).toBe(winner.currency);

    // Each rejection explains which field clashes with the stored order, and
    // reports the unchanged order.
    for (const response of responses.filter((r) => r.status === 409)) {
      expect(response.body.error.code).toBe("checkout_payload_conflict");
      expect(response.body.error.details.conflictingFields.length).toBeGreaterThan(0);
      expect(response.body.error.details.existingOrder).toMatchObject({
        id: winner.id,
        amountMinor: winner.amountMinor,
        currency: winner.currency,
        status: "pending",
      });
    }
  });
  it("blocks concurrent retries on the row another transaction is inserting", async () => {
    // A transaction that has inserted the order but has not committed yet. The
    // overlapping checkout requests must wait for it instead of creating a
    // duplicate - which is only possible if the unique index does the work.
    const blocker = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await blocker.connect();
    await blocker.query("BEGIN");
    const inserted = await blocker.query<{ id: string }>(
      `INSERT INTO orders (order_reference, amount_minor, currency)
       VALUES ($1, $2, $3) RETURNING id`,
      ["ORDER-BLOCKED", 1000, "USD"],
    );

    const inflight = Promise.all(
      Array.from({ length: 5 }, () =>
        post(
          ctx,
          CHECKOUT_PATH,
          checkoutBody({ orderReference: "ORDER-BLOCKED", amountMinor: 1000, currency: "USD" }),
        ),
      ),
    );

    // Nothing may complete while the other transaction holds the unique row.
    expect(
      await Promise.race([inflight.then(() => "finished"), delay(300).then(() => "blocked")]),
    ).toBe("blocked");
    expect(await ctx.countOrders()).toBe(0);

    await blocker.query("COMMIT");
    await blocker.end();

    const responses = await inflight;
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(responses.every((response) => response.body.created === false)).toBe(true);
    expect(new Set(responses.map((response) => response.body.order.id))).toEqual(
      new Set([inserted.rows[0]!.id]),
    );
    expect(await ctx.countOrders()).toBe(1);
  });
});
