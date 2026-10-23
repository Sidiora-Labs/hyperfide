#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
# Bound worker contention so child-process deadlines measure the daemon.
export VITEST_MAX_WORKERS="${VITEST_MAX_WORKERS:-2}"
result=0
pnpm -C platform exec turbo run test --filter=./apps/host-daemon --filter=./packages/host-daemon-contract --filter=./apps/server || result=$?
pnpm -C platform/packages/host-daemon-contract exec vitest run --config src/hyperfide-status.vitest.config.ts || result=$?
base=$(git merge-base HEAD hyperfide-v22 2>/dev/null || git merge-base HEAD main)
if [[ -f tests/hyperfide/cases/v22/identity_gate.py ]]; then
  python3 tests/hyperfide/cases/v22/identity_gate.py --changed "$base" || result=$?
else
  # Local identity-gate projection until task 0.7 supplies the shared gate.
  projection=$(mktemp -d)
  trap 'rm -rf "$projection"' EXIT
  cat > "$projection/identity_gate.py" <<'PY'
import argparse
import json
import re
import subprocess
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--changed', required=True)
args = parser.parse_args()
rules = json.loads(Path('platform/tools/rename/map.json').read_text())
patterns = []
for rule in rules:
    if rule['kind'] == 'path':
        continue
    boundary = rule.get('boundary', 'none')
    pattern = re.escape(rule['from'])
    if boundary in ('left', 'both'):
        pattern = r'(?<![A-Za-z0-9_])' + pattern
    if boundary in ('right', 'both'):
        pattern += r'(?![A-Za-z0-9_])'
    patterns.append(re.compile(pattern))
changed = subprocess.check_output([
    'git', 'diff', '--name-only', '--diff-filter=ACMR', '-z', args.changed, '--',
    'platform/apps/host-daemon/src/', 'platform/packages/host-daemon-contract/src/',
    'platform/apps/server/src/', 'platform/packages/server-contract/src/',
    'platform/apps/app/src/', 'platform/apps/server/test/server-move/daemon-message-fence.test.ts',
    'tests/hyperfide/cases/v22/1_2.sh',
]).decode().split('\0')
failures = []
for name in changed:
    path = Path(name)
    if not name or path.name.startswith('.env') or not path.is_file():
        continue
    for number, line in enumerate(path.read_text(errors='replace').splitlines(), 1):
        if any(pattern.search(line) for pattern in patterns):
            failures.append(f'{name}:{number}: {line}')
print('\n'.join(failures) if failures else 'Hyperfide identity gate: passed')
raise SystemExit(bool(failures))
PY
  python3 "$projection/identity_gate.py" --changed "$base" || result=$?
fi
exit "$result"
