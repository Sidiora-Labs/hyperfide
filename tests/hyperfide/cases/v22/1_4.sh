#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."

pnpm -C platform --filter @hyperfide/plugin-sdk build
pnpm -C platform --filter @hyperfide/plugin-sdk build:types
pnpm -C platform --filter @hyperfide/provider-bridge-protocol typecheck
pnpm -C platform --filter @hyperfide/plugin-sdk typecheck
pnpm -C platform --filter hyperfide-plugin-provider-claude-code typecheck
pnpm -C platform --filter hyperfide-plugin-provider-codex typecheck
pnpm -C platform --filter @hyperfide/hyperfide-graph typecheck
pnpm -C platform --filter @hyperfide/hyperfide-graph test
pnpm -C platform exec tsrs --noEmit --strict --skipLibCheck --target ES2022 --module ESNext --moduleResolution bundler --typeRoots plugins/provider-codex/node_modules/@types --types node plugins/hyperfide-graph/src/worker-injection/worker-injection.ts plugins/hyperfide-graph/src/worker-injection/worker-injection.test.ts plugins/hyperfide-graph/src/worker-injection/vitest.config.ts
pnpm -C platform exec vitest run --config plugins/hyperfide-graph/src/worker-injection/vitest.config.ts
pnpm -C platform --filter @hyperfide/provider-bridge-protocol test
pnpm -C platform --filter @hyperfide/plugin-sdk exec vitest run --config vitest.config.ts --maxWorkers=2
pnpm -C platform --filter hyperfide-plugin-provider-claude-code test
# Auth tests create their own temporary home; do not inherit the agent's override.
env -u CODEX_HOME pnpm -C platform --filter hyperfide-plugin-provider-codex test

python3 tests/hyperfide/cases/v22/identity_gate.py --changed
