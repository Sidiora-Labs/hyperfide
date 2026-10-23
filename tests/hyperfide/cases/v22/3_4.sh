#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
pnpm -C platform exec turbo run typecheck test --concurrency=1 \
  --filter=./plugins/hyperfide-asks --filter=./plugins/push-notifications --filter=./plugins/ask-user-question
python3 tests/hyperfide/cases/v22/identity_gate.py --changed
