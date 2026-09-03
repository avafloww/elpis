#!/bin/bash
set -uo pipefail

log="$(mktemp)" || exit 1
trap 'rm -f "$log"' EXIT

for attempt in 1 2 3; do
  npm audit \
    --omit=dev \
    --audit-level=moderate \
    --color=false \
    --fetch-retries=1 \
    --fetch-retry-mintimeout=2000 \
    --fetch-retry-maxtimeout=10000 \
    --fetch-timeout=60000 2>&1 | tee "$log"
  statuses=("${PIPESTATUS[@]}")
  audit_status="${statuses[0]}"
  tee_status="${statuses[1]}"

  if [ "$tee_status" -ne 0 ]; then
    exit "$tee_status"
  fi
  if [ "$audit_status" -eq 0 ]; then
    exit 0
  fi

  grep -Eq \
    '^(npm warn audit (50[0234] |network timeout at:)|npm error (code|errno) (EAI_AGAIN|ENETUNREACH|ECONNRESET|ETIMEDOUT)( |$))' \
    "$log"
  retryable="$?"
  if [ "$retryable" -eq 2 ]; then
    exit 2
  fi
  if [ "$retryable" -ne 0 ] || [ "$attempt" -eq 3 ]; then
    exit "$audit_status"
  fi
  sleep "$((attempt * 10))" || exit 1
done

exit 1
