# payment-flow

Idempotent checkout intents and payment-provider webhooks. Express + TypeScript, PostgreSQL with
Drizzle, Jest.

Everything below is the local operator flow: configure → migrate → run → test → call → reset.

## 1. Configure the application

Docker (PostgreSQL only) or Node >= 20 on the host.

```bash
cp .env.example .env          # only needed for host runs; compose sets its own env
```

`docker compose` provides everything itself, so with Docker there is nothing to edit. For a host
run, `.env` needs:

| variable                         | purpose                               | default                                                       |
| -------------------------------- | ------------------------------------- | ------------------------------------------------------------- |
| `DATABASE_URL`                   | the service and `npm run db:migrate`  | `postgres://payment:payment@localhost:5432/payment_flow`      |
| `TEST_DATABASE_URL`              | the database `npm test` truncates     | `postgres://payment:payment@localhost:5432/payment_flow_test` |
| `PORT`                           | HTTP port                             | `3000`                                                        |
| `DATABASE_POOL_MAX`              | max pool connections                  | `10`                                                          |
| `DATABASE_STATEMENT_TIMEOUT_MS`  | longest a SQL statement may run       | `5000`                                                        |
| `DATABASE_CONNECTION_TIMEOUT_MS` | longest wait for a free connection    | `5000`                                                        |
| `NODE_ENV`                       | `development` / `test` / `production` | `development`                                                 |

`DATABASE_URL` and `TEST_DATABASE_URL` are required — the process refuses to start without them.
Tests only ever touch `TEST_DATABASE_URL`.

```bash
npm install                    # host runs only
```

## 2. Apply migrations

```bash
npm run db:migrate             # host
```

Idempotent: Drizzle keeps its own ledger table, so re-running is safe. `docker compose up` does
this for you — the `app` container's command is `node dist/db/migrate.js && node dist/index.js`,
so it migrates before it starts listening. **On the host you must run this step yourself**; neither
`npm run dev` nor `npm start` migrates.

The SQL lives in `drizzle/`; `drizzle/meta/` is Drizzle's snapshot for `npm run db:generate`.

## 3. Start the service

```bash
docker compose up --build       # db + app; http://localhost:3000
```

Or on the host, against a database you already have:

```bash
docker compose up -d db        # just PostgreSQL, published on 5432
npm run db:migrate             # required: the host start script does NOT migrate
npm run dev                     # watch mode
npm run build && npm start      # or: production build + node dist/index.js
```

```bash
curl -s localhost:3000/health   # {"status":"ok","database":"reachable"}
```

## 4. Run the tests

```bash
docker compose run --rm tests   # preferred: no host install needed
npm test                        # host, needs TEST_DATABASE_URL reachable
npm run typecheck               # tsc --noEmit
npm run format                  # prettier --write .
npm run format:check            # prettier --check .
```

The suite truncates `payment_flow_test` between suites and runs `--runInBand`, so it needs no
concurrency flags and no manual cleanup.

## 5. Call the API and send sample webhooks

Either import `postman/` into Postman (collection + environment + a request-by-request guide), or
drive it with curl:

```bash
./scripts/demo.sh
```

That walks the whole flow: create, retry, conflicting retry, `payment.succeeded`, redelivery,
stale failure, same-id-different-payload, read back, and five parallel deliveries of one event.

By hand:

```bash
REF=ORDER-$(date +%s)

# 1. create a checkout intent -> 201, status pending
curl -s -X POST localhost:3000/checkout-intents \
  -H 'content-type: application/json' \
  -d "{\"orderReference\":\"$REF\",\"amountMinor\":2599,\"currency\":\"EUR\"}"

# 2. same request again -> 200, created:false, same order
# 3. same reference, different amount -> 409, nothing changed

# 4. the provider reports success -> 200, applied:true, order succeeded
curl -s -X POST localhost:3000/webhooks/payment-provider \
  -H 'content-type: application/json' \
  -d "{\"id\":\"evt_$REF\",\"type\":\"payment.succeeded\",
       \"createdAt\":\"2026-01-05T10:00:00.000Z\",
       \"data\":{\"orderReference\":\"$REF\",\"providerPaymentId\":\"pay_1\"}}"

# 5. the provider redelivers the same event -> 200, duplicate:true, not applied again
# 6. a stale failure arrives late -> 200, ignored_terminal
# 7. same event id, different payload -> 200, event_id_conflict

# 8. read the order
curl -s "localhost:3000/orders/$REF"
curl -s "localhost:3000/orders/id/<id from step 1>"
```

`amountMinor` is an integer count of minor units, so `2599` EUR is 25.99 EUR. The order reference
is the checkout idempotency key; the provider's event `id` is the webhook idempotency key.

## 6. Reset the local environment

```bash
docker compose down -v          # stops everything and DELETES the database volume
docker compose up -d --build       # fresh database; db/init recreates payment_flow_test on first boot
```

The `db` service mounts `./db/init:/docker-entrypoint-initdb.d`, so `payment_flow_test` only exists
after the first boot of a fresh volume — that is why the tests need `docker compose up` at least
once. To wipe test data without touching everything else:

```bash
docker compose exec db psql -U payment -d payment_flow_test \
  -c 'TRUNCATE orders, provider_events CASCADE;'
```
