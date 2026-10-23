#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
pnpm -C platform exec tsc6 --noEmit --allowJs --checkJs --module nodenext --target es2022 --skipLibCheck --types node --typeRoots apps/cli/node_modules/@types plugins/hyperfide-spec/src/cli/index.mjs
pnpm -C platform exec turbo run typecheck test --filter=./plugins/hyperfide-spec
pnpm -C platform exec turbo run typecheck test --filter=./apps/cli
pnpm -C platform exec turbo run build --filter=./apps/cli
if [ -x ./cg ]; then
  export HYPERFIDE_BIN="$PWD/cg"
  fixture="$(mktemp -d)"
  trap 'rm -rf "$fixture"' EXIT
  cp -R tests/fixtures/specrepo/. "$fixture/"
  ./cg spec status -f demo --root "$fixture" --json > "$fixture/direct.json"
  ./cg platform spec status -f demo --root "$fixture" --json > "$fixture/platform.json" 2> "$fixture/stderr"
  cmp "$fixture/direct.json" "$fixture/platform.json"
  grep -q 'Board: .*plugins/hyperfide-spec?feature=demo' "$fixture/stderr"
else
  echo 'SKIP: ./cg absent; front-door round trip unavailable'
fi
python3 tests/hyperfide/cases/v22/identity_gate.py --changed
