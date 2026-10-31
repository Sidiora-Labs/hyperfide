#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
# Bound worker contention so child-process deadlines measure the daemon.
export VITEST_MAX_WORKERS="${VITEST_MAX_WORKERS:-2}"
result=0
pnpm exec turbo run test --filter=./core/host-daemon --filter=./contracts/host-daemon --filter=./core/server || result=$?
pnpm -C contracts/host-daemon exec vitest run --config src/hyperfide-status.vitest.config.ts || result=$?
base=$(git merge-base HEAD hyperfide-v22 2>/dev/null || git merge-base HEAD main)
python3 tests/hyperfide/cases/v22/identity_gate.py --changed "$base" || result=$?
exit "$result"
