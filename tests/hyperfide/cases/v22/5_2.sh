#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
sh -n plugins/machine-blaxel/bootstrap/alpine.sh
pnpm exec turbo run test --filter=./plugins/machine-blaxel
pnpm exec turbo run typecheck --filter=./plugins/machine-blaxel
node --experimental-transform-types plugins/machine-blaxel/src/live-smoke.ts "${1:-}"
if [ -f tests/hyperfide/cases/v22/identity_gate.py ]; then
  python3 tests/hyperfide/cases/v22/identity_gate.py --changed
else
  echo 'identity gate absent (task 0.7 pending)'
fi
