#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
python3 tests/hyperfide/cases/v22/identity_gate.py
node --import ./platform/node_modules/tsx/dist/loader.mjs --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveProdDataDir, resolveConfiguredDataDir } from './platform/packages/config/src/runtime.ts';

const tracked = execFileSync('git', ['ls-files', '-z', 'platform'], {encoding: 'utf8'}).split('\0').filter(Boolean);
const manifests = tracked.filter(name => name.endsWith('/package.json') && existsSync(name))
  .map(name => [name, JSON.parse(readFileSync(name, 'utf8'))]);
let scoped = 0, plugins = 0;
for (const [name, manifest] of manifests) {
  if (manifest.name?.startsWith('@')) {
    assert(manifest.name.startsWith('@hyperfide/'), `${name}: package scope`);
    scoped++;
  }
  for (const [dependency, version] of Object.entries({...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies})) {
    if (version.startsWith('workspace:')) {
      assert(dependency.startsWith('@hyperfide/') || dependency.startsWith('hyperfide-'), `${name}: ${dependency}`);
    }
  }
  if (name.startsWith('platform/plugins/') && manifest.hyperfide) {
    assert(manifest.name.startsWith('hyperfide-') || manifest.name.startsWith('@hyperfide/'), `${name}: plugin identity`);
    plugins++;
  }
}
assert(scoped > 0 && plugins > 0, 'must inspect packages and plugins');
const cli = JSON.parse(readFileSync('platform/apps/cli/package.json', 'utf8'));
assert.equal(cli.name, '@hyperfide/cli');
assert.equal(cli.bin['hyperfide-platform'], './bin/hyperfide-platform');
assert(tracked.includes('platform/apps/cli/bin/hyperfide-platform'));
const root = JSON.parse(readFileSync('platform/package.json', 'utf8'));
assert(root.scripts['hyperfide-platform']);
const homeDir = mkdtempSync(join(tmpdir(), 'hyperfide-identity-'));
try {
  assert.equal(resolveProdDataDir({homeDir}), join(homeDir, '.hyperfide'));
  assert.equal(resolveConfiguredDataDir({homeDir, env: {HYPERFIDE_DATA_DIR: '~/custom'}}), join(homeDir, 'custom'));
} finally {
  rmSync(homeDir, {recursive: true, force: true});
}
const context = readFileSync('platform/apps/cli/src/context-env.ts', 'utf8');
for (const key of ['HYPERFIDE_PROJECT_ID', 'HYPERFIDE_THREAD_ID', 'HYPERFIDE_SERVER_URL']) assert(context.includes(key), key);
console.log(`identity contracts: ${scoped} scoped packages, ${plugins} plugins, CLI, environment and data directory passed`);
JS
