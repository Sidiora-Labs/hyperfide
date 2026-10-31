#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
node -e 'if (process.versions.node.split(".")[0] !== "24") throw Error("Node 24 is required")'
python3 tests/hyperfide/cases/v22/identity_gate.py
test -z "$(git ls-files -- platform/tools/rename)"
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
python3 tests/hyperfide/cases/v22/identity_gate.py
