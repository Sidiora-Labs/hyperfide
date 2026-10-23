#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
pnpm -C platform exec turbo run build:types --filter=./packages/plugin-sdk
pnpm -C platform exec turbo run typecheck test --filter=./plugins/hyperfide-asks
if [ -f tests/hyperfide/cases/v22/identity_gate.py ]; then
  python3 tests/hyperfide/cases/v22/identity_gate.py --changed
else
  echo "identity_gate.py is pending task 0.7"
fi
