#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
export HYPERFIDE_BINARY="$PWD/cg"
pnpm -C platform exec tsc6 -p plugins/environment-slices/tsconfig.json
node --experimental-transform-types --test platform/plugins/environment-slices/provider.test.ts
identity_gate=tests/hyperfide/cases/v22/identity_gate.py
if [ ! -f "$identity_gate" ]; then
  identity_gate=platform/plugins/environment-slices/projected-identity-gate.py
fi
python3 "$identity_gate" --changed
