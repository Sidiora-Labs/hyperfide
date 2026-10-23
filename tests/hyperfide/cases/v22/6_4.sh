#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
NODE_OPTIONS="${NODE_OPTIONS:-} --conditions=source" pnpm -C platform exec tsx --test plugins/hyperfide-dispatch/test/multi-host.test.mts
pnpm -C platform exec tsc6 --noEmit --strict --skipLibCheck --target ES2022 --module ESNext --moduleResolution bundler plugins/hyperfide-dispatch/src/host-capacity.ts
pnpm -C platform exec turbo run typecheck --filter=./apps/server --filter=./apps/host-daemon --filter=./packages/plugin-sdk --filter=./plugins/machine-railway
VITEST_MAX_WORKERS=2 pnpm -C platform exec turbo run test --concurrency=1 --filter=./packages/plugin-sdk --filter=./plugins/machine-railway
VITEST_MAX_WORKERS=2 pnpm -C platform/apps/server test src/services/machines/enrollments.test.ts src/services/machines/bootstrap.test.ts test/services/plugins/plugin-authoring-docs.test.ts
VITEST_MAX_WORKERS=2 pnpm -C platform/apps/host-daemon test src/auth-state.test.ts src/server-connection.test.ts src/daemon.test.ts
python3 tests/hyperfide/cases/v22/identity_gate.py --changed
