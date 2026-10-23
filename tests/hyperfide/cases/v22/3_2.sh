#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
pnpm -C platform/apps/server exec vitest run src/services/threads/ask-thread-lifecycle.test.ts
pnpm -C platform/packages/plugin-sdk exec vitest run src/__tests__/thread-ask-lifecycle.test.ts
pnpm -C platform --filter @hyperfide/server --filter @hyperfide/plugin-sdk run typecheck
pnpm -C platform --filter @hyperfide/hyperfide-asks --filter @hyperfide/hyperfide-spec run typecheck
pnpm -C platform/plugins/hyperfide-asks exec vitest run src/bridge.test.ts
pnpm -C platform/plugins/hyperfide-spec test
python3 tests/hyperfide/cases/v22/identity_gate.py --changed
