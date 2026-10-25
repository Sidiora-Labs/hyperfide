#!/usr/bin/env bash
# 7.25: sidebar bootstrap refetches coalesce under realtime churn instead of cancelling each other.
set -euo pipefail
cd "$(dirname "$0")/../../../.."
step() {
  local name="$1" start=$SECONDS rc=0
  shift
  "$@" || rc=$?
  printf '7.25: %s seconds=%s exit=%s\n' "$name" "$((SECONDS-start))" "$rc"
  return "$rc"
}
step "app typecheck" pnpm -C platform --filter @hyperfide/app typecheck
step "realtime cache tests" pnpm -C platform/apps/app exec vitest run \
  src/hooks/realtime-cache-effects.test.ts \
  src/hooks/realtime-cache-effects.coarse-pointer.test.ts \
  src/hooks/queries/sidebar-navigation-query.test.tsx \
  --maxWorkers=2
echo "7.25: ok"
