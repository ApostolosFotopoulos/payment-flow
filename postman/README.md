# Postman collection

Import both files, then run the requests in order.

| File                                    | What it is                                                         |
| --------------------------------------- | ------------------------------------------------------------------ |
| `payment-flow.postman_collection.json`  | The requests, grouped into `01 Checkout`, `02 Webhooks`, `03 Read` |
| `payment-flow.postman_environment.json` | Environment `payment-flow local`                                   |

## Import

1. Postman → **Import** → drop the two JSON files in (or _Import_ → _Folder_ and pick `postman/`).
2. Pick the **payment-flow local** environment in the environment selector, top right.
   `base_url` is `http://localhost:3000`; change it if you run the service elsewhere.
3. Start the service first: `docker compose up --build`.

## Run

Run the whole collection from the top, or send the requests in order starting at `01 Checkout`.
Order matters: the requests pass the order reference and event ids to each other, and each request
asserts what the previous one set up.

Every request carries a test script, so the Postman test results show whether the behaviour matched
the spec. Expected results:

| Request                                               | Expect                                                  |
| ----------------------------------------------------- | ------------------------------------------------------- |
| `1. Create checkout intent`                           | `201`, `created: true`, status `pending`                |
| `2. Retry with identical payload`                     | `200`, `created: false`, same order                     |
| `3. Retry with a different amount`                    | `409`, `checkout_payload_conflict`, amount untouched    |
| `1. payment.succeeded`                                | `applied: true`, order `succeeded`                      |
| `2. Same event again`                                 | `duplicate: true`, `applied: false`, `deliveryCount: 2` |
| `3. Stale payment.failed after success`               | `ignored_terminal`                                      |
| `4. Same event id, different payload`                 | `event_id_conflict`                                     |
| `5. Event for an unknown order`                       | `order_not_found`                                       |
| `Get order by business reference` / `Get order by id` | `200` with the stored order                             |
| `Unknown reference`                                   | `404 not_found`                                         |
| `Malformed id`                                        | `400 invalid_request`                                   |
| `Health check`                                        | `200`, `database: reachable`                            |

Order references and event ids are generated per run (a timestamp suffix), so you can run the
collection as often as you like without colliding with earlier data.

## Concurrent requests

The collection sends its requests one at a time. Overlapping requests are covered by the test suite
instead:

```bash
npm test
```

`tests/checkout.concurrent.test.ts` and `tests/webhook.concurrent-duplicates.test.ts` fire requests
in parallel and check that exactly one order is created and exactly one delivery applies an event.

## Note

The collection posts to the webhook route without a signature. Signature verification is
explicitly out of scope for the exercise.
