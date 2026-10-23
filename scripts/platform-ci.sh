#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

quick=false
case "${1:-}" in
  '') ;;
  --quick) quick=true ;;
  *) echo 'usage: scripts/platform-ci.sh [--quick]' >&2; exit 2 ;;
esac
if (( $# > 1 )); then
  echo 'usage: scripts/platform-ci.sh [--quick]' >&2
  exit 2
fi
node -e 'if (Number(process.versions.node.split(".")[0]) !== 24) { console.error("Node 24 is required"); process.exit(1); }'

if ! "$quick"; then
  corepack pnpm -C platform install --frozen-lockfile
fi
corepack pnpm -C platform typecheck
if ! "$quick"; then
  corepack pnpm -C platform build
  corepack pnpm -C platform test
fi
python3 tests/hyperfide/cases/v22/identity_gate.py
