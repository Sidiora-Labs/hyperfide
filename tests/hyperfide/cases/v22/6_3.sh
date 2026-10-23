#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
npm --prefix services/hyperfide run check
npm --prefix services/hyperfide run build
pnpm -C platform exec turbo run typecheck test \
  --filter=./packages/hyperfide-authority \
  --filter=./plugins/hyperfide-spec --filter=./plugins/hyperfide-asks \
  --filter=./plugins/hyperfide-qualify --filter=./plugins/hyperfide-dispatch --force
python3 tests/hyperfide/support/withpg.py -- python3 platform/packages/hyperfide-authority/test/run-service.py --plugins
embedded_directory=$(mktemp -d /tmp/hyperfide-embedded-6-3-XXXXXX)
trap 'rm -rf "$embedded_directory"' EXIT
export HYPERFIDE_AUTHORITY_EMBEDDED_DIRECTORY="$embedded_directory"
HYPERFIDE_AUTHORITY_EMBEDDED=1 python3 platform/packages/hyperfide-authority/bin/embedded.py -- \
  pnpm -C platform exec tsx packages/hyperfide-authority/test/embedded-smoke.ts
HYPERFIDE_AUTHORITY_EMBEDDED=1 HYPERFIDE_AUTHORITY_TEST_RESTART=1 \
  python3 platform/packages/hyperfide-authority/bin/embedded.py -- \
  pnpm -C platform exec tsx packages/hyperfide-authority/test/embedded-smoke.ts
if [ -f tests/hyperfide/cases/v22/identity_gate.py ]; then
  python3 tests/hyperfide/cases/v22/identity_gate.py --changed
else
  echo 'SKIP identity gate: absent at this base'
fi
