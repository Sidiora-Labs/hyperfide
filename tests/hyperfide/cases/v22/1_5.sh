#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
test -z "$(git ls-files -- platform/plugins/hyperfide-graph/language-server-index-projection.ts platform/plugins/monaco-editor/scripts/identity_gate.py)"
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--conditions=source"
pnpm -C platform/apps/host-daemon typecheck
pnpm -C platform/packages/host-daemon-contract typecheck
pnpm -C platform/plugins/monaco-editor typecheck
pnpm -C platform/apps/host-daemon exec vitest run --config vitest.config.ts src/language-server-relay.test.ts src/local-api.test.ts
pnpm -C platform/packages/host-daemon-contract test
pnpm -C platform/plugins/monaco-editor test
pnpm -C platform/plugins/hyperfide-graph typecheck
pnpm -C platform/plugins/hyperfide-graph test
python3 tests/hyperfide/cases/v22/identity_gate.py --changed
