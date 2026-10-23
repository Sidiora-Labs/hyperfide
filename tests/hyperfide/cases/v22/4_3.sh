#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
pnpm -C platform exec turbo run test --filter=./plugins/hyperfide-qualify --filter=./plugins/hyperfide-spec
pnpm -C platform exec turbo run typecheck --filter=./plugins/hyperfide-qualify --filter=./plugins/hyperfide-spec
if [[ -f tests/hyperfide/cases/v22/identity_gate.py ]]; then
  python3 tests/hyperfide/cases/v22/identity_gate.py --changed 3a85072eb82e06eaf6693bd007ea5432270892f3
else
  echo 'identity gate absent on base (0.7 pending); skipped'
fi
