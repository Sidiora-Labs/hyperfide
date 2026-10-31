#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
pnpm exec turbo run test typecheck --filter=./plugins/hyperfide-dispatch --filter=./plugins/hyperfide-spec
python3 tests/hyperfide/cases/v22/identity_gate.py --changed
