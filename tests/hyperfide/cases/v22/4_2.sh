#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
pnpm exec turbo run test --filter=./plugins/hyperfide-qualify --filter=./plugins/hyperfide-spec
pnpm exec turbo run typecheck --filter=./plugins/hyperfide-qualify --filter=./plugins/hyperfide-spec
if [[ -f tests/hyperfide/cases/v22/identity_gate.py ]]; then
  python3 tests/hyperfide/cases/v22/identity_gate.py --changed 69eb3c69f5a846450c57247d9ba53d25b49bcc5a
else
  echo 'identity gate absent on base (0.7 pending); skipped'
fi
python3 tests/hyperfide/closure_check.py --selftest
