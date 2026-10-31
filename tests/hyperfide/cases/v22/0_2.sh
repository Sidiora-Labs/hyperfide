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

root = Path('.')
source_roots = json.loads(Path('tools/workspace/source-roots.json').read_text())['roots']
tracked = subprocess.check_output(['git', 'ls-files', '-z', '--', *source_roots])
manifests = {}
for entry in tracked.split(b'\0'):
    if not entry:
        continue
    path = Path(os.fsdecode(entry))
    # Task 0.7 owns the historical changelog's removal or replacement.
    if (path == root / 'docs/history/runtime-port.md' or path.name.startswith('.env')
            or 'node_modules' in path.parts or path.is_symlink()):
        continue
    if path.name == 'package.json':
        manifests[path] = json.loads(path.read_text())

packages = [manifest for path, manifest in manifests.items()
            if len(path.parts) == 3 and path.parts[0] in ('apps', 'core', 'sdk', 'contracts', 'lib', 'tools')]
assert packages, 'No workspace package manifests found'
for manifest in packages:
    assert (manifest['name'].startswith('@hyperfide/')
            or manifest['name'] in ('hyperfide-app',
                                    'hyperfide-environment-provider-host')), manifest['name']
assert 'hyperfide-platform' in manifests[root / 'apps/cli/package.json']['bin']
plugins = [manifest for path, manifest in manifests.items()
           if len(path.parts) == 3 and path.parts[0] == 'plugins']
assert plugins, 'No plugin manifests found'
for manifest in plugins:
    assert manifest['name'].removeprefix('@hyperfide/').startswith('hyperfide-'), manifest['name']
env_source = (root / 'lib/config/src/env-vars.ts').read_text()
env_names = re.findall(r'\bname:\s*"([^"]+)"', env_source)
assert env_names, 'No environment variable definitions found'
assert all(name.startswith('HYPERFIDE_') for name in env_names), env_names
runtime = (root / 'lib/config/src/runtime.ts').read_text()
assert re.search(r'HYPERFIDE_PROD_DATA_DIR_NAME\s*=\s*"\.hyperfide"', runtime)
PY

pnpm install --frozen-lockfile
pnpm typecheck
pnpm exec turbo run test --filter=./sdk/plugins --filter=./lib/config --filter=./core/server
