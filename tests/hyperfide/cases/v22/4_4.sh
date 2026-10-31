#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
# The qualify and spec plugins drive the real Hyperfide binary; point them at this checkout's build, not whatever is on PATH.
if [[ -x ./cg ]]; then export HYPERFIDE_BIN="$PWD/cg"; fi
pnpm exec turbo run test --filter=./plugins/hyperfide-qualify --filter=./plugins/hyperfide-spec --filter=./plugins/github --output-logs=errors-only
pnpm exec turbo run typecheck --filter=./plugins/hyperfide-qualify --filter=./plugins/hyperfide-spec --filter=./plugins/github --output-logs=errors-only
if [[ -f tests/hyperfide/cases/v22/identity_gate.py ]]; then
  python3 tests/hyperfide/cases/v22/identity_gate.py --changed 5a41bcd6ecd92aa715e0ee916202122109638267
else
  echo 'identity gate absent on base (0.7 pending); skipped'
fi
