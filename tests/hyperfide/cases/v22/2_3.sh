#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
pnpm -C core/server typecheck
pnpm -C core/server exec tsrs --project ../../plugins/hyperfide-spec/tsconfig.json --noEmit
pnpm -C core/server test src/services/spec-task-worker.test.ts
pnpm -C plugins/hyperfide-spec test
python3 tests/hyperfide/cases/v22/identity_gate.py --changed
