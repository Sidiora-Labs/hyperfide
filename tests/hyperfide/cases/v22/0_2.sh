#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."

python3 - <<'PY'
import json
import os
from pathlib import Path

root = Path('platform')
scopes = [rule['from'] for rule in json.loads((root / 'tools/rename/map.json').read_text())
          if rule['to'] == '@hyperfide/']
failures = []
for base, dirs, files in os.walk(root):
    dirs[:] = [name for name in dirs if name != 'node_modules']
    for name in files:
        path = Path(base) / name
        # Task 0.7 owns the historical changelog's removal or replacement.
        if path == root / 'CHANGELOG.md' or name.startswith('.env') or path.is_symlink():
            continue
        data = path.read_bytes()
        if any(scope.encode() in data for scope in scopes):
            failures.append(str(path))
assert not failures, 'Former package scope remains in: ' + ', '.join(failures)
PY

pnpm -C platform install --frozen-lockfile
pnpm -C platform typecheck
pnpm -C platform exec turbo run test --filter=./packages/plugin-sdk --filter=./packages/config --filter=./apps/server
