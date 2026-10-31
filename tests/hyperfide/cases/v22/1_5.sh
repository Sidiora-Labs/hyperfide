#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
test -z "$(git ls-files -- plugins/hyperfide-graph/language-server-index-projection.ts plugins/monaco-editor/scripts/identity_gate.py)"
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--conditions=source"
pnpm -C core/host-daemon typecheck
pnpm -C contracts/host-daemon typecheck
pnpm -C plugins/monaco-editor typecheck
pnpm -C core/host-daemon exec vitest run --config vitest.config.ts src/language-server-relay.test.ts src/local-api.test.ts
pnpm -C contracts/host-daemon test
pnpm -C plugins/monaco-editor test
pnpm -C plugins/hyperfide-graph typecheck
pnpm -C plugins/hyperfide-graph test
python3 tests/hyperfide/cases/v22/identity_gate.py --changed
