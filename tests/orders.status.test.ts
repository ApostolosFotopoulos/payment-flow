import {
  CHECKOUT_PATH,
  WEBHOOK_PATH,
  checkoutBody,
  get,
  post,
  startTestServer,
  webhookBody,
  type TestContext,
} from "./helpers/test-server";

describe("order status lookups", () => {
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

  it("returns the order by business reference and by id", async () => {
    const created = await post(ctx, CHECKOUT_PATH, checkoutBody());

    const byReference = await get(ctx, "/orders/ORDER-1001");
    expect(byReference.status).toBe(200);
    expect(byReference.body.order).toEqual(created.body.order);
    expect(byReference.body.order.status).toBe("pending");

    const byId = await get(ctx, `/orders/id/${created.body.order.id}`);
    expect(byId.status).toBe(200);
    expect(byId.body.order).toEqual(created.body.order);
  });

  it("reflects the payment status after a webhook", async () => {
    await post(ctx, CHECKOUT_PATH, checkoutBody());
    await post(ctx, WEBHOOK_PATH, webhookBody({ id: "evt_status" }));

    const response = await get(ctx, "/orders/ORDER-1001");
    expect(response.body.order.status).toBe("succeeded");
    expect(new Date(response.body.order.updatedAt).getTime()).toBeGreaterThan(
      new Date(response.body.order.createdAt).getTime(),
    );
  });

  it("404s for an unknown reference or id", async () => {
    const missingReference = await get(ctx, "/orders/ORDER-DOES-NOT-EXIST");
    expect(missingReference.status).toBe(404);
    expect(missingReference.body.error.code).toBe("not_found");

    const missingId = await get(ctx, "/orders/id/2f1f9b1e-0000-4000-8000-000000000000");
    expect(missingId.status).toBe(404);
  });

  it("400s for a malformed id", async () => {
    const response = await get(ctx, "/orders/id/not-a-uuid");
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("invalid_request");
  });

  it("404s unknown routes", async () => {
    const response = await get(ctx, "/nope");
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("route_not_found");
  });

  it("exposes a health check that reaches the database", async () => {
    const response = await get(ctx, "/health");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok", database: "reachable" });
  });
});
