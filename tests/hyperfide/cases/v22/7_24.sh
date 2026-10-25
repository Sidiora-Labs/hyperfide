#!/usr/bin/env bash
# 7.24: queued notices and desktop tab owners survive concurrent writes on PostgreSQL.
# The two server race files run once on SQLite and five times in a row on PostgreSQL; every run must pass.
set -euo pipefail
cd "$(dirname "$0")/../../../.."
files="test/desktop-browsers.test.ts test/public/public-thread-context-clear-dispatch.test.ts"
log=$(mktemp /tmp/hyperfide-7-24-XXXXXX.log)
trap 'rm -f "$log"' EXIT
step() {
  local name=$1; shift
  local started rc=0
  started=$(date +%s)
  "$@" >"$log" 2>&1 || rc=$?
  echo "7.24: $name seconds=$(( $(date +%s) - started )) exit=$rc"
  if [ "$rc" -ne 0 ]; then
    sed 's/\x1b\[[0-9;]*m//g' "$log" | grep -E '×|FAIL|AssertionError|Error:' | head -20
    exit "$rc"
  fi
}
step sqlite pnpm -C platform/apps/server exec vitest run $files --maxWorkers=2
for i in 1 2 3 4 5; do
  step "postgres-$i" python3 tests/hyperfide/support/withpg.py -- bash -c \
    'export HYPERFIDE_DATABASE_URL="$DATABASE_URL"; pnpm -C platform/apps/server exec vitest run '"$files"' --maxWorkers=2'
done
echo "7.24: ok"
