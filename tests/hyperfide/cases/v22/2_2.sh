#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
pnpm exec turbo run prepare:bundled --filter=@hyperfide/hyperfide-spec
pnpm --filter @hyperfide/plugin-sdk build:types
pnpm --filter @hyperfide/hyperfide-spec typecheck
pnpm --filter @hyperfide/hyperfide-spec test
python3 tests/hyperfide/cases/v22/identity_gate.py --changed
