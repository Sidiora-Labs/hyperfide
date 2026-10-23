#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
# The tests initialize isolated repositories and run the real binary there.
test -x ./cg
pnpm -C platform exec turbo run typecheck --filter=./plugins/memory
# Run fixtures every time; the binary's durable store is outside Turbo's inputs.
pnpm -C platform/plugins/memory test
if test -f tests/hyperfide/cases/v22/identity_gate.py; then
  python3 tests/hyperfide/cases/v22/identity_gate.py --changed
else
  # Local projection until task 0.7 supplies the shared gate.
  python3 platform/plugins/memory/identity_gate.py --changed
fi
