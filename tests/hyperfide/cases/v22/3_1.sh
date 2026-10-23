#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
pnpm -C platform exec turbo run build:types --filter=./packages/plugin-sdk
pnpm -C platform exec turbo run typecheck test --filter=./plugins/hyperfide-asks
python3 tests/hyperfide/cases/v22/identity_gate.py --changed
for path in platform/plugins/hyperfide-asks/src/graph-host-projection.ts \
  platform/plugins/hyperfide-asks/src/bridge-projection.ts \
  platform/plugins/hyperfide-asks/src/task-3-2-projection.ts \
  platform/plugins/hyperfide-asks/bridge-projection.ts; do
  test -z "$(git ls-files -- "$path")"
done
