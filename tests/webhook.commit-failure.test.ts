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
 * What happens when a webhook transaction fails before COMMIT.
 *
 * Instead of mocking the database, this suite makes the *commit itself* fail.
 * It installs a deferred constraint trigger on `provider_events`: PostgreSQL
 * evaluates it at COMMIT time, not at statement time. A webhook whose event id
 * starts with `evt_block_` therefore inserts its event row, does all its work,
 * and only then fails on the way out - the worst possible moment to fail, and
 * exactly the case the exercise asks about.
 *
 * The assertions that matter:
 *   - the response is 500, never 2xx, so the provider retries;
 *   - NOTHING survives: neither the event row nor any status change;
 *   - because the event insert rolled back too, the retry is handled as a first
 *     delivery and applies normally instead of being mistaken for a duplicate.
 */
describe("webhook transactions that fail before commit", () => {
  /** Any delivery of an event id with this prefix fails at COMMIT. */
  const BLOCKED_PREFIX = "evt_block_";
  const blockedId = (suffix: string) => `${BLOCKED_PREFIX}${suffix}`;

  let ctx: TestContext;

  const installFailure = async () => {
    await ctx.db.execute(`
      CREATE OR REPLACE FUNCTION test_fail_at_commit() RETURNS trigger AS $fn$
      BEGIN
        IF NEW.id LIKE '${BLOCKED_PREFIX}%' THEN
          RAISE EXCEPTION 'simulated failure at commit time for %', NEW.id;
        END IF;
        RETURN NULL;
      END;
      $fn$ LANGUAGE plpgsql
    `);
    await ctx.db.execute(`
      CREATE CONSTRAINT TRIGGER test_commit_block
      AFTER INSERT OR UPDATE ON provider_events
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION test_fail_at_commit()
    `);
  };

  const removeFailure = async () => {
    await ctx.db.execute("DROP TRIGGER IF EXISTS test_commit_block ON provider_events");
    await ctx.db.execute("DROP FUNCTION IF EXISTS test_fail_at_commit()");
  };

  beforeAll(async () => {
    ctx = await startTestServer();
  });

  afterAll(async () => {
    await removeFailure();
    await ctx.close();
  });

  beforeEach(async () => {
    // Start from a clean slate even if a previous run was interrupted.
    await removeFailure();
    await ctx.reset();
  });

  it("answers 500 and persists nothing when the commit fails", async () => {
    await post(ctx, CHECKOUT_PATH, checkoutBody({ orderReference: "ORDER-1001" }));
    await installFailure();

    const failed = await post(ctx, WEBHOOK_PATH, webhookBody({ id: blockedId("commit_fail") }));

    expect(failed.status).toBe(500);
    expect(failed.body.error.code).toBe("internal_error");

    // The event row was inserted first and is gone again: the rollback undid the
    // idempotency claim as well as the status change.
    expect(await ctx.getEvent(blockedId("commit_fail"))).toBeNull();
    expect(await ctx.countEvents()).toBe(0);

    const order = await ctx.getOrder("ORDER-1001");
    expect(order?.status).toBe("pending");
    expect(order?.updatedAt).toEqual(order?.createdAt);
  });

  it("treats a retry after the failure as a first delivery, not a duplicate", async () => {
    await post(ctx, CHECKOUT_PATH, checkoutBody({ orderReference: "ORDER-1001" }));
    await installFailure();

    const failed = await post(ctx, WEBHOOK_PATH, webhookBody({ id: blockedId("retry") }));
    expect(failed.status).toBe(500);
    expect(await ctx.countEvents()).toBe(0);

    // The provider retries and this time the database accepts the commit.
    await removeFailure();
    const retried = await post(ctx, WEBHOOK_PATH, webhookBody({ id: blockedId("retry") }));

    expect(retried.status).toBe(200);
    expect(retried.body.applied).toBe(true);
    expect(retried.body.duplicate).toBe(false);
    expect(retried.body.outcome).toBe("applied");
    expect(retried.body.deliveryCount).toBe(1);
    expect((await ctx.getOrder("ORDER-1001"))?.status).toBe("succeeded");
  });

  it("leaves previously committed state untouched", async () => {
    await post(ctx, CHECKOUT_PATH, checkoutBody({ orderReference: "ORDER-OK" }));
    const applied = await post(
      ctx,
      WEBHOOK_PATH,
      webhookBody({ id: "evt_ok" }, { orderReference: "ORDER-OK" }),
    );
    expect(applied.body.applied).toBe(true);
    const committedAt = (await ctx.getOrder("ORDER-OK"))?.updatedAt;

    // A different order, an event that cannot commit. It must not disturb the
    // order that already succeeded, nor its event row.
    await post(ctx, CHECKOUT_PATH, checkoutBody({ orderReference: "ORDER-BROKEN" }));
    await installFailure();
    const failed = await post(
      ctx,
      WEBHOOK_PATH,
      webhookBody({ id: blockedId("isolated") }, { orderReference: "ORDER-BROKEN" }),
    );
    expect(failed.status).toBe(500);

    expect(await ctx.getEvent(blockedId("isolated"))).toBeNull();
    expect(await ctx.countEvents()).toBe(1);
    expect(await ctx.getEvent("evt_ok")).toMatchObject({ applied: true, outcome: "applied" });
    expect(await ctx.getOrder("ORDER-OK")).toMatchObject({ status: "succeeded" });
    expect((await ctx.getOrder("ORDER-OK"))?.updatedAt).toEqual(committedAt);
    expect((await ctx.getOrder("ORDER-BROKEN"))?.status).toBe("pending");
  });

  it("keeps the connection pool usable across repeated failures", async () => {
    await post(ctx, CHECKOUT_PATH, checkoutBody({ orderReference: "ORDER-1001" }));
    await installFailure();

    for (const suffix of ["pool_1", "pool_2", "pool_3"]) {
      const failed = await post(ctx, WEBHOOK_PATH, webhookBody({ id: blockedId(suffix) }));
      expect(failed.status).toBe(500);
    }

    await removeFailure();

    // Nothing partial survived, so the first of those retries applies as a first
    // delivery and the pool is still healthy afterwards.
    expect(await ctx.countEvents()).toBe(0);
    const ok = await post(ctx, WEBHOOK_PATH, webhookBody({ id: blockedId("pool_1") }));
    expect(ok.status).toBe(200);
    expect(ok.body.applied).toBe(true);
    expect(ok.body.duplicate).toBe(false);
    expect(ok.body.outcome).toBe("applied");
    expect(ok.body.order.status).toBe("succeeded");

    // The event the provider never got acknowledged for is now recorded, so a
    // further redelivery is an ordinary duplicate.
    const again = await post(ctx, WEBHOOK_PATH, webhookBody({ id: blockedId("pool_1") }));
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);
    expect(again.body.applied).toBe(false);
    expect(again.body.deliveryCount).toBe(2);
  });
});
