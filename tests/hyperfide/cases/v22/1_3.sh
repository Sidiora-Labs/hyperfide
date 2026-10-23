#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
pnpm -C platform exec turbo run typecheck --filter=@hyperfide/hyperfide-graph
NODE_OPTIONS="${NODE_OPTIONS:-} --conditions=source" pnpm -C platform --filter @hyperfide/hyperfide-graph test
python3 tests/hyperfide/cases/v22/identity_gate.py --changed
