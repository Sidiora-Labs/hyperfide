#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
unset HYPERFIDE_RATCHET_ALLOW_INCREASE
node tools/workspace/check-provider-literal-ratchet.mjs
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const baseline = JSON.parse(readFileSync('tools/workspace/provider-literal-baseline.json', 'utf8'));
assert.ok(baseline.total <= 14);
for (const path of [
  'apps/server/src/services/threads/thread-import/service.ts',
  'packages/server-contract/src/api/threads.ts',
  'apps/app/src/components/settings/ImportSessionsSettingsSection.tsx',
  'apps/app/src/components/settings/settings-search.ts',
  'plugins/hyperfide-dispatch/src/server-runtime.ts',
]) {
  assert.equal(baseline.allowlist[path], undefined, path);
  assert.equal(baseline.files[path], undefined, path);
}
JS
pnpm --filter @hyperfide/scripts test
pnpm --filter @hyperfide/server exec vitest run src/services/threads/thread-import
pnpm --filter @hyperfide/hyperfide-dispatch test
