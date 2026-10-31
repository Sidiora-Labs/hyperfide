#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
pnpm exec turbo run test --filter=./plugins/machine-railway
pnpm exec turbo run typecheck --filter=./plugins/machine-railway
pnpm exec tsx plugins/machine-railway/live-smoke.ts
python3 tests/hyperfide/cases/v22/identity_gate.py --changed
