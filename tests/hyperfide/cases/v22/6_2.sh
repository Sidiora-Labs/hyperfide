#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
npm --prefix services/hyperfide run check
npm --prefix services/hyperfide run build
pnpm -C platform exec turbo run typecheck --filter=./packages/hyperfide-authority --filter=./apps/server
python3 tests/hyperfide/support/withpg.py -- python3 platform/packages/hyperfide-authority/test/run-service.py
pnpm -C platform --filter @hyperfide/server exec vitest run --config vitest.config.ts src/authority-bridge.test.ts
if [ -f tests/hyperfide/cases/v22/identity_gate.py ]; then
  python3 tests/hyperfide/cases/v22/identity_gate.py --changed
else
  echo "SKIP identity gate: absent at this base"
fi
