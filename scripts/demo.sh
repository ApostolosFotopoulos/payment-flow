#!/usr/bin/env bash
# Drives the API with plain curl calls so the whole flow can be seen by hand.
#
#   ./scripts/demo.sh                # uses http://localhost:3000
#   BASE_URL=http://localhost:8080 ./scripts/demo.sh
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
REFERENCE="${ORDER_REFERENCE:-ORDER-DEMO-1}"

call() {
  printf '\n\033[1m$ %s\033[0m\n' "$*"
  curl -sS -w '\n--> HTTP %{http_code}\n' -X "$1" "${BASE_URL}$2" \
    -H 'content-type: application/json' \
    ${3:+-d "$3"}
}

echo "=== 1. create a checkout intent ==============================================="
call POST /checkout-intents "{\"orderReference\":\"$REFERENCE\",\"amountMinor\":2599,\"currency\":\"EUR\"}"

echo "=== 2. the same request again (retry: no duplicate order) ======================"
call POST /checkout-intents "{\"orderReference\":\"$REFERENCE\",\"amountMinor\":2599,\"currency\":\"EUR\"}"

echo "=== 3. same reference, different amount (must be rejected) ===================="
call POST /checkout-intents "{\"orderReference\":\"$REFERENCE\",\"amountMinor\":9999,\"currency\":\"EUR\"}"

echo "=== 4. provider says the payment succeeded ==================================="
call POST /webhooks/payment-provider \
  "{\"id\":\"evt_demo_1\",\"type\":\"payment.succeeded\",\"createdAt\":\"2026-01-05T10:00:00.000Z\",\"data\":{\"orderReference\":\"$REFERENCE\",\"providerPaymentId\":\"pay_demo_1\"}}"

echo "=== 5. the provider redelivers the same event (must not apply twice) ========="
call POST /webhooks/payment-provider \
  "{\"id\":\"evt_demo_1\",\"type\":\"payment.succeeded\",\"createdAt\":\"2026-01-05T10:00:00.000Z\",\"data\":{\"orderReference\":\"$REFERENCE\",\"providerPaymentId\":\"pay_demo_1\"}}"

echo "=== 6. a stale failure event arrives late (must be ignored) ==================="
call POST /webhooks/payment-provider \
  "{\"id\":\"evt_demo_2\",\"type\":\"payment.failed\",\"data\":{\"orderReference\":\"$REFERENCE\",\"providerPaymentId\":\"pay_demo_1\"}}"

echo "=== 7. same event id, different payload (conflict, never applied) ============"
call POST /webhooks/payment-provider \
  "{\"id\":\"evt_demo_1\",\"type\":\"payment.failed\",\"data\":{\"orderReference\":\"$REFERENCE\",\"providerPaymentId\":\"pay_demo_1\"}}"

echo "=== 8. current status ========================================================"
call GET "/orders/$REFERENCE"

echo "=== 9. five concurrent deliveries of one brand new event ===================="
call POST /checkout-intents "{\"orderReference\":\"ORDER-DEMO-2\",\"amountMinor\":1000,\"currency\":\"USD\"}"
EVENT_ID="evt_demo_$(date +%s)"
BODY="{\"id\":\"$EVENT_ID\",\"type\":\"payment.succeeded\",\"data\":{\"orderReference\":\"ORDER-DEMO-2\",\"providerPaymentId\":\"pay_demo_2\"}}"
printf '\033[1m$ 5 parallel POST /webhooks/payment-provider with id=%s\033[0m\n' "$EVENT_ID"
for _ in 1 2 3 4 5; do
  curl -sS -o /dev/null -w '%{http_code} ' -X POST "${BASE_URL}/webhooks/payment-provider" \
    -H 'content-type: application/json' -d "$BODY" &
done
wait
printf '\n'
call GET "/orders/ORDER-DEMO-2"