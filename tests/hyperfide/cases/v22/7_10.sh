#!/usr/bin/env bash
# 7.10 — UI parity: the Hyperfide plugin pages are built on the native app kit.
# Proves the rebuilt surfaces by their unit suites (asks, graph, spec board, guide) and by bundling them
# into @hyperfide/bundled-plugins, which is what the server loads. Prints timings and exit codes only.
set -euo pipefail
cd "$(dirname "$0")/../../../.."
for plugin in hyperfide-asks hyperfide-graph hyperfide-spec hyperfide-guide; do
  started=$(date +%s)
  pnpm -C "platform/plugins/$plugin" test >"/tmp/7_10-$plugin.log" 2>&1 || { echo "7.10: $plugin tests failed (exit $?)"; tail -20 "/tmp/7_10-$plugin.log"; exit 1; }
  echo "7.10: $plugin tests ok ($(( $(date +%s) - started ))s)"
done
# the rebuilt views must not fall back to the raw hand-rolled surfaces
grep -q 'ResourceCollectionPage' platform/plugins/hyperfide-asks/views/*.tsx
grep -q 'ResourceCollectionPage' platform/plugins/hyperfide-spec/src/board/views/board-panel.tsx
grep -q 'ResourceDetailPage' platform/plugins/hyperfide-spec/src/board/views/task-detail.tsx
started=$(date +%s)
pnpm -C platform exec turbo run build --filter=@hyperfide/bundled-plugins... >/tmp/7_10-bundled.log 2>&1 || { echo "7.10: bundled-plugins build failed (exit $?)"; tail -30 /tmp/7_10-bundled.log; exit 1; }
echo "7.10: bundled-plugins build ok ($(( $(date +%s) - started ))s)"
for plugin in hyperfide-asks hyperfide-graph hyperfide-spec hyperfide-guide; do
  ls "platform/plugins/$plugin/.bundled-runtime/" >/dev/null 2>&1 || ls "platform/plugins/$plugin/dist" >/dev/null 2>&1 || { echo "7.10: no bundled output for $plugin"; exit 1; }
done
echo 'ok: 7.10'
