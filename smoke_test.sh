#!/usr/bin/env bash
# Usage: ./smoke_test.sh https://your-service.onrender.com
BASE="${1:-http://localhost:8000}"
ID="txn_$(date +%s)"
BODY='{"transaction_id":"'$ID'","source_account":"acc_user_789","destination_account":"acc_merchant_456","amount":1500,"currency":"INR"}'

echo "Health:"; curl -s "$BASE/"; echo
echo "Sending the same webhook 3 times:"
for i in 1 2 3; do
  curl -s -o /dev/null -w "  attempt $i -> HTTP %{http_code} in %{time_total}s\n" \
    -X POST "$BASE/v1/webhooks/transactions" -H 'Content-Type: application/json' -d "$BODY"
done
echo "Immediately after:"; curl -s "$BASE/v1/transactions/$ID"; echo
echo "Waiting 35s..."; sleep 35
echo "After 35s:"; curl -s "$BASE/v1/transactions/$ID"; echo
