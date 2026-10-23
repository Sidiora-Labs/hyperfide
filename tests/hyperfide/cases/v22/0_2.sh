#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."

python3 tests/hyperfide/cases/v22/identity_gate.py

python3 - <<'PY'
import json
import os
import re
import subprocess
from pathlib import Path

root = Path('platform')
tracked = subprocess.check_output(['git', 'ls-files', '-z', '--', 'platform/'])
manifests = {}
for entry in tracked.split(b'\0'):
    if not entry:
        continue
    path = Path(os.fsdecode(entry))
    # Task 0.7 owns the historical changelog's removal or replacement.
    if (path == root / 'CHANGELOG.md' or path.name.startswith('.env')
            or 'node_modules' in path.parts or path.is_symlink()):
        continue
    if path.name == 'package.json':
        manifests[path] = json.loads(path.read_text())

packages = [manifest for path, manifest in manifests.items()
            if len(path.parts) == 4 and path.parts[1] in ('apps', 'packages')]
assert packages, 'No workspace package manifests found'
for manifest in packages:
    assert (manifest['name'].startswith('@hyperfide/')
            or manifest['name'] in ('hyperfide-app',
                                    'hyperfide-environment-provider-host')), manifest['name']
assert 'hyperfide-platform' in manifests[root / 'apps/cli/package.json']['bin']
plugins = [manifest for path, manifest in manifests.items()
           if len(path.parts) == 4 and path.parts[1] == 'plugins']
assert plugins, 'No plugin manifests found'
for manifest in plugins:
    assert manifest['name'].removeprefix('@hyperfide/').startswith('hyperfide-'), manifest['name']
env_source = (root / 'packages/config/src/env-vars.ts').read_text()
env_names = re.findall(r'\bname:\s*"([^"]+)"', env_source)
assert env_names, 'No environment variable definitions found'
assert all(name.startswith('HYPERFIDE_') for name in env_names), env_names
runtime = (root / 'packages/config/src/runtime.ts').read_text()
assert re.search(r'HYPERFIDE_PROD_DATA_DIR_NAME\s*=\s*"\.hyperfide"', runtime)
PY

pnpm -C platform install --frozen-lockfile
pnpm -C platform typecheck
pnpm -C platform exec turbo run test --filter=./packages/plugin-sdk --filter=./packages/config --filter=./apps/server
