#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
export HYPERFIDE_BINARY="$PWD/cg"
test -z "$(git ls-files -- platform/plugins/environment-slices/projected-lifecycle.ts platform/plugins/environment-slices/projected-identity-gate.py)"
pnpm -C platform exec tsc6 -p plugins/environment-slices/tsconfig.json
node --experimental-transform-types --test platform/plugins/environment-slices/provider.test.ts
pnpm -C platform --filter @hyperfide/hyperfide-environment-slices prepare:bundled
python3 tests/hyperfide/cases/v22/identity_gate.py --changed
