#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
pnpm -C platform exec turbo run prepare:bundled --filter=@hyperfide/hyperfide-spec
pnpm -C platform --filter @hyperfide/plugin-sdk build:types
pnpm -C platform --filter @hyperfide/hyperfide-spec typecheck
pnpm -C platform --filter @hyperfide/hyperfide-spec test
python3 tests/hyperfide/cases/v22/identity_gate.py --changed
