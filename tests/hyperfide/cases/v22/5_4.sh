#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
pnpm -C platform exec turbo run test typecheck --filter=./plugins/hyperfide-dispatch --filter=./plugins/concurrency-limit
if [[ -f tests/hyperfide/cases/v22/identity_gate.py ]]; then
  python3 tests/hyperfide/cases/v22/identity_gate.py --changed
else
  echo 'identity gate absent (task 0.7 pending)'
fi
