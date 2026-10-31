#!/usr/bin/env bash
# 7.13 — the asks watcher coalesces graph writes and republishes only when the asks changed.
# The graph database is the control plane and is written many times a second; the bridge must not
# re-list and broadcast the whole ask list on every write. Proven by the plugin's typecheck and unit
# suite (write-storm and shared-watcher tests) and by bundling the plugin the way the server loads it.
# Prints timings and exit codes only.
set -euo pipefail
cd "$(dirname "$0")/../../../.."
for name in "coalesces write storms" "shares one graph watcher per repository"; do
  grep -qF "$name" plugins/hyperfide-asks/src/bridge.test.ts || { echo "7.13: missing test: $name"; exit 1; }
done
grep -qE 'minIntervalMs' plugins/hyperfide-asks/src/bridge.ts || { echo "7.13: bridge has no listing interval floor"; exit 1; }
started=$(date +%s)
pnpm -C plugins/hyperfide-asks typecheck >/tmp/7_13-typecheck.log 2>&1 || { echo "7.13: typecheck failed (exit $?)"; tail -20 /tmp/7_13-typecheck.log; exit 1; }
echo "7.13: typecheck ok ($(( $(date +%s) - started ))s)"
started=$(date +%s)
pnpm -C plugins/hyperfide-asks test >/tmp/7_13-test.log 2>&1 || { echo "7.13: tests failed (exit $?)"; tail -30 /tmp/7_13-test.log; exit 1; }
echo "7.13: hyperfide-asks tests ok ($(( $(date +%s) - started ))s)"
started=$(date +%s)
pnpm exec turbo run build --filter=@hyperfide/bundled-plugins... >/tmp/7_13-bundled.log 2>&1 || { echo "7.13: bundled-plugins build failed (exit $?)"; tail -30 /tmp/7_13-bundled.log; exit 1; }
echo "7.13: bundled-plugins build ok ($(( $(date +%s) - started ))s)"
ls plugins/hyperfide-asks/.bundled-runtime/ >/dev/null 2>&1 || ls plugins/hyperfide-asks/dist >/dev/null 2>&1 || { echo "7.13: no bundled output for hyperfide-asks"; exit 1; }
echo 'ok: 7.13'
