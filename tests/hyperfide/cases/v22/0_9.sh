#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../../.."

python3 - <<'CHECK'
import re
from pathlib import Path

workflow = Path('.github/workflows/platform.yml').read_text()
assert re.search(r"node-version:\s*['\"]?24['\"]?\s*$", workflow, re.M), 'Node 24 pin missing'
for event in ('push', 'pull_request'):
    block = re.search(rf'^  {event}:\n((?:^    .*\n|^\n)+)', workflow, re.M)
    assert block, f'{event} trigger missing'
    for path in ('platform/**', 'tests/hyperfide/cases/v22/**'):
        assert path in block[1], f'{event} path filter missing: {path}'
assert 'permissions:\n  contents: read\n' in workflow
assert 'uses: actions/cache@' in workflow
assert "hashFiles('platform/pnpm-lock.yaml')" in workflow
assert 'steps.pnpm-store.outputs.path' in workflow
assert 'run: bash scripts/platform-ci.sh\n' in workflow
assert not re.search(r'publish|deploy|git\s+push|contents:\s*write|packages:\s*write', workflow, re.I), 'publication step or permission found'
CHECK
bash scripts/platform-ci.sh --quick
echo 'ok: hyperfide-v22/0.9'
