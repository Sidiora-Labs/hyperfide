#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
export HYPERFIDE_TEST_BINARY="$PWD/cg"
pnpm --filter @hyperfide/plugin-sdk build
pnpm --filter @hyperfide/plugin-sdk build:types
pnpm --filter @hyperfide/hyperfide-spec typecheck
pnpm --filter @hyperfide/hyperfide-spec prepare:bundled
pnpm --filter @hyperfide/hyperfide-spec test
python3 tests/hyperfide/cases/v22/identity_gate.py --changed
