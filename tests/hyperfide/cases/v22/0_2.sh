#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."

python3 - <<'PY'
import json
import os
import subprocess
from pathlib import Path

root = Path('platform')
scopes = [rule['from'] for rule in json.loads((root / 'tools/rename/map.json').read_text())
          if rule['to'] == '@hyperfide/']
failures = []
tracked = subprocess.check_output(['git', 'ls-files', '-z', '--', 'platform/'])
for entry in tracked.split(b'\0'):
    if not entry:
        continue
    path = Path(os.fsdecode(entry))
    # Task 0.7 owns the historical changelog's removal or replacement.
    if (path == root / 'CHANGELOG.md' or path.name.startswith('.env')
            or 'node_modules' in path.parts or path.is_symlink()):
        continue
    data = path.read_bytes()
    if any(scope.encode() in data for scope in scopes):
        failures.append(str(path))
assert not failures, 'Former package scope remains in: ' + ', '.join(failures)
PY

pnpm -C platform install --frozen-lockfile
pnpm -C platform typecheck
pnpm -C platform exec turbo run test --filter=./packages/plugin-sdk --filter=./packages/config --filter=./apps/server
