#!/usr/bin/env bash
# 7.23: the session-import source kinds and the fleet runner kinds no longer sit in core as provider-id literals.
set -euo pipefail
cd "$(dirname "$0")/../../../.."
step() {
  local name="$1" start=$SECONDS rc=0
  shift
  "$@" || rc=$?
  printf '7.23: %s seconds=%s exit=%s\n' "$name" "$((SECONDS-start))" "$rc"
  return "$rc"
}
step ratchet node platform/scripts/check-provider-literal-ratchet.mjs
step 'allowlist shrank back' python3 - <<'PY'
import json
b = json.load(open('platform/scripts/provider-literal-baseline.json'))
gone = ['apps/server/src/services/threads/thread-import/service.ts', 'packages/server-contract/src/api/threads.ts',
        'apps/app/src/components/settings/ImportSessionsSettingsSection.tsx', 'apps/app/src/components/settings/settings-search.ts',
        'plugins/hyperfide-dispatch/src/server-runtime.ts']
still = [f for f in gone if f in b['files'] or f in b.get('allowlist', {})]
assert not still, f'still counted or allowlisted: {still}'
assert b['total'] <= 14, b['total']
print('baseline total', b['total'])
PY
step 'scripts suite' pnpm -C platform --filter @hyperfide/scripts test
step 'import still works' pnpm -C platform --filter @hyperfide/server exec vitest run src/services/threads/thread-import --passWithNoTests
