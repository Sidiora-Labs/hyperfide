#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
pnpm -C platform/apps/server typecheck
pnpm -C platform/apps/server exec tsrs --project ../../plugins/hyperfide-spec/tsconfig.json --noEmit
pnpm -C platform/apps/server test src/services/spec-task-worker.test.ts
pnpm -C platform/plugins/hyperfide-spec test
python3 tests/hyperfide/cases/v22/identity_gate.py --changed
