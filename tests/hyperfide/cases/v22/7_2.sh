#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
# The tests initialize isolated repositories and run the real binary there.
test -x ./cg
# Removal is checked against the tracked tree, allowing ignored build leftovers.
test -z "$(git ls-files -- plugins/memory/graph-memory-projection.ts plugins/memory/identity_gate.py plugins/hyperfide-spec/memory-packet-projection.ts)"
pnpm exec turbo run typecheck --filter=./plugins/memory
# Run fixtures every time; the binary's durable store is outside Turbo's inputs.
pnpm -C sdk/plugins build:runtime
pnpm -C plugins/memory test
pnpm exec turbo run typecheck test --filter=./plugins/hyperfide-spec
python3 tests/hyperfide/cases/v22/identity_gate.py --changed
