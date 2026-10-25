#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/../../../.." && pwd)
cd "$root"
run_suites() {
  pnpm -C platform/apps/server run test \
    test/desktop-browsers.test.ts \
    test/public/public-thread-context-clear-dispatch.test.ts \
    --maxWorkers=2
}
if [[ ${1:-} == --postgres ]]; then
  export HYPERFIDE_DATABASE_URL="$DATABASE_URL"
  for run in 1 2 3 4 5; do
    echo "PostgreSQL run $run/5"
    run_suites
  done
  exit
fi
unset HYPERFIDE_DATABASE_URL
run_suites
python3 tests/hyperfide/support/withpg.py -- bash "$0" --postgres
