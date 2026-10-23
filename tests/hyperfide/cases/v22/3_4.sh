#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
pnpm -C platform exec turbo run typecheck test \
  --filter=./plugins/push-notifications --filter=./plugins/ask-user-question
if [ -f tests/hyperfide/cases/v22/identity_gate.py ]; then
  python3 tests/hyperfide/cases/v22/identity_gate.py --changed
else
  python3 platform/plugins/hyperfide-asks/identity_gate.py --changed
fi
