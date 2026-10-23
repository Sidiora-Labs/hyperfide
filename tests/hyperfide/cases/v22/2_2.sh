#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
pnpm -C platform --filter @hyperfide/hyperfide-spec typecheck
pnpm -C platform --filter @hyperfide/hyperfide-spec test
if [[ -f tests/hyperfide/cases/v22/identity_gate.py ]]; then
  python3 tests/hyperfide/cases/v22/identity_gate.py --changed
else
  python3 platform/plugins/hyperfide-spec/src/board/identity_gate_projection.py --changed
fi
