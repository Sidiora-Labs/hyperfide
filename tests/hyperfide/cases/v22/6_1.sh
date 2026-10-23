#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/../../../.." && pwd)
cd "$root"
run_suites() {
  pnpm -C platform/packages/db run test --maxWorkers=4 || return $?
  pnpm -C platform/apps/server run test --maxWorkers=2 --reporter=default --reporter=./test/helpers/qualification-reporter.mjs || return $?
  pnpm -C platform/tests/integration exec vitest run --config storage.vitest.config.ts
}
if [[ ${1:-} == --postgres ]]; then
  export HYPERFIDE_DATABASE_URL="$DATABASE_URL"
  run_suites
  exit
fi
unset HYPERFIDE_DATABASE_URL
pnpm -C platform/packages/plugin-sdk run build:runtime
pnpm -C platform exec turbo run typecheck --filter=./packages/db --filter=./apps/server --filter=./packages/config --filter=./packages/scripts --filter=./packages/plugin-sdk
sqlite_status=0
postgres_status=0
(run_suites) || sqlite_status=$?
python3 tests/hyperfide/support/withpg.py -- bash "$0" --postgres || postgres_status=$?
if (( sqlite_status != 0 || postgres_status != 0 )); then
  exit 1
fi
if [[ -f tests/hyperfide/cases/v22/identity_gate.py ]]; then
  python3 tests/hyperfide/cases/v22/identity_gate.py --changed 5a41bcd6ecd92aa715e0ee916202122109638267
fi
