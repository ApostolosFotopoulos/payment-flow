import {
  CHECKOUT_PATH,
  checkoutBody,
  post,
  startTestServer,
  type TestContext,
} from "./helpers/test-server";

describe("reusing a business order reference", () => {
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

  it("returns the existing order for a retry with an identical payload", async () => {
    const first = await post(ctx, CHECKOUT_PATH, checkoutBody());
    const second = await post(ctx, CHECKOUT_PATH, checkoutBody());

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.created).toBe(false);
    expect(second.body.order).toEqual(first.body.order);
    expect(await ctx.countOrders()).toBe(1);
  });

  it("treats a lower-case currency as the same checkout payload", async () => {
    const first = await post(ctx, CHECKOUT_PATH, checkoutBody({ currency: "EUR" }));
    const second = await post(ctx, CHECKOUT_PATH, checkoutBody({ currency: "eur" }));

    expect(second.status).toBe(200);
    expect(second.body.order).toEqual(first.body.order);
    expect(await ctx.countOrders()).toBe(1);
  });

  it("rejects a changed amount and leaves the stored order untouched", async () => {
    const created = await post(ctx, CHECKOUT_PATH, checkoutBody());
    const before = await ctx.getOrder("ORDER-1001");

    const conflictResponse = await post(ctx, CHECKOUT_PATH, checkoutBody({ amountMinor: 9999 }));

    expect(conflictResponse.status).toBe(409);
    expect(conflictResponse.body.error.code).toBe("checkout_payload_conflict");
    expect(conflictResponse.body.error.details.conflictingFields).toEqual(["amountMinor"]);
    expect(conflictResponse.body.error.details.existingOrder.amountMinor).toBe(2599);

    // Nothing about the order changed - not even updated_at.
    const after = await ctx.getOrder("ORDER-1001");
    expect(after).toEqual(before);
    expect(after?.updatedAt.toISOString()).toEqual(created.body.order.createdAt);
  });

  it("rejects a changed currency and lists both conflicting fields", async () => {
    await post(ctx, CHECKOUT_PATH, checkoutBody());
    const before = await ctx.getOrder("ORDER-1001");

    const conflictResponse = await post(
      ctx,
      CHECKOUT_PATH,
      checkoutBody({ amountMinor: 10, currency: "GBP" }),
    );

    expect(conflictResponse.status).toBe(409);
    expect(conflictResponse.body.error.details.conflictingFields).toEqual([
      "amountMinor",
      "currency",
    ]);
    expect(await ctx.getOrder("ORDER-1001")).toEqual(before);
  });

  it("keeps rejecting mismatched payloads after the payment succeeded", async () => {
    await post(ctx, CHECKOUT_PATH, checkoutBody());
    await post(ctx, "/webhooks/payment-provider", {
      id: "evt_success",
      type: "payment.succeeded",
      data: { orderReference: "ORDER-1001", providerPaymentId: "pay_1" },
    });

    const conflictResponse = await post(ctx, CHECKOUT_PATH, checkoutBody({ amountMinor: 1 }));

    expect(conflictResponse.status).toBe(409);
    const stored = await ctx.getOrder("ORDER-1001");
    expect(stored).toMatchObject({ amountMinor: 2599, status: "succeeded" });
  });

  it("validates the checkout payload", async () => {
    const invalidBodies = [
      [{ amountMinor: 10, currency: "EUR" }, "missing orderReference"],
      [{ orderReference: "", amountMinor: 10, currency: "EUR" }, "empty orderReference"],
      [{ orderReference: "ORDER-X", amountMinor: 10.5, currency: "EUR" }, "fractional amount"],
      [{ orderReference: "ORDER-X", amountMinor: "10", currency: "EUR" }, "string amount"],
      [{ orderReference: "ORDER-X", amountMinor: 0, currency: "EUR" }, "zero amount"],
      [{ orderReference: "ORDER-X", amountMinor: -10, currency: "EUR" }, "negative amount"],
      [{ orderReference: "ORDER-X", amountMinor: 10, currency: "EURO" }, "bad currency"],
      [{ orderReference: "ORDER-X", amountMinor: 10, currency: 42 }, "non-string currency"],
      [
        { orderReference: "ORDER-X", amountMinor: 10, currency: "EUR", extra: true },
        "unknown field",
      ],
    ];

    for (const [body, description] of invalidBodies) {
      const response = await post(ctx, CHECKOUT_PATH, body);
      expect({ description, status: response.status }).toEqual({ description, status: 400 });
      expect(response.body.error.code).toBe("invalid_request");
    }
    expect(await ctx.countOrders()).toBe(0);
  });
});
