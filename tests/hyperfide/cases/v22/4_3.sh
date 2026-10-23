#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
pnpm -C platform exec turbo run test --filter=./plugins/hyperfide-qualify --filter=./plugins/hyperfide-spec
pnpm -C platform exec turbo run typecheck --filter=./plugins/hyperfide-qualify --filter=./plugins/hyperfide-spec
python3 tests/hyperfide/cases/v22/identity_gate.py --changed f70a5d2159b3b356ad62590505b703da8e9864d2
