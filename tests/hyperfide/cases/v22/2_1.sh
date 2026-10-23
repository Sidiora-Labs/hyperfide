#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
export HYPERFIDE_TEST_BINARY="$PWD/cg"
pnpm -C platform --filter @hyperfide/plugin-sdk build
pnpm -C platform --filter @hyperfide/plugin-sdk build:types
pnpm -C platform --filter @hyperfide/hyperfide-spec typecheck
pnpm -C platform --filter @hyperfide/hyperfide-spec prepare:bundled
pnpm -C platform --filter @hyperfide/hyperfide-spec test
python3 tests/hyperfide/cases/v22/identity_gate.py --changed
