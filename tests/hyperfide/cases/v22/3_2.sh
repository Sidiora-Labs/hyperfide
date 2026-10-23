#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
pnpm -C platform/apps/server exec vitest run src/services/threads/ask-thread-lifecycle.test.ts
pnpm -C platform/packages/plugin-sdk exec vitest run src/__tests__/thread-ask-lifecycle.test.ts
pnpm -C platform --filter @hyperfide/server --filter @hyperfide/plugin-sdk run typecheck
pnpm -C platform exec tsc6 --noEmit --strict --skipLibCheck --target ES2023 --module NodeNext \
  plugins/hyperfide-asks/src/server.ts plugins/hyperfide-spec/src/ask-task-flags.ts
python3 tests/hyperfide/cases/v22/identity_gate.py --changed
