#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
pnpm -C platform exec turbo run test --filter=./plugins/hyperfide-qualify --output-logs=errors-only
pnpm -C platform exec turbo run typecheck --filter=./plugins/hyperfide-qualify --output-logs=errors-only
if [[ -f tests/hyperfide/cases/v22/identity_gate.py ]]; then
  python3 tests/hyperfide/cases/v22/identity_gate.py --changed f75c1f7f9824301ec315beddc1ef116530c5ab03
else
  echo 'identity gate absent on base (0.7 pending); skipped'
fi
