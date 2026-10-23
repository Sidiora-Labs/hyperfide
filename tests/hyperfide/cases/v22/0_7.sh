#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
node -e 'if (process.versions.node.split(".")[0] !== "24") throw Error("Node 24 is required")'
python3 tests/hyperfide/cases/v22/identity_gate.py
test -z "$(git ls-files -- platform/tools/rename)"
pnpm -C platform install --frozen-lockfile
pnpm -C platform typecheck
pnpm -C platform build
pnpm -C platform test
python3 tests/hyperfide/cases/v22/identity_gate.py
