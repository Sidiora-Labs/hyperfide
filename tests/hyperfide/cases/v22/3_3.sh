#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
pnpm -C platform exec turbo run build:types --filter=./packages/plugin-sdk
pnpm -C platform exec turbo run typecheck test --filter=./plugins/hyperfide-asks --filter=./plugins/secrets
python3 tests/hyperfide/cases/v22/identity_gate.py --changed
