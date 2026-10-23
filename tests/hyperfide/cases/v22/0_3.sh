#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
python3 - <<'PY'
import re, subprocess
from pathlib import Path
roots = ['platform/packages/config', 'platform/apps/cli', 'platform/apps/server/src',
         'platform/apps/host-daemon/src', 'platform/packages/scripts',
         'platform/packages/host-daemon-contract', 'platform/packages/server-contract',
         'platform/apps/app/src', 'platform/apps/desktop/src', 'platform/apps/mobile',
         'platform/package.json', 'platform/.env.example']
paths = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', *roots], text=True).splitlines()
old_prefix = ''.join(map(chr, [66, 66, 95]))
old_directory = ''.join(map(chr, [46, 98, 98]))
violations = []
for name in paths:
    path = Path(name)
    if not path.is_file() or (path.name.startswith('.env') and path.name != '.env.example'):
        continue
    try:
        text = path.read_text()
    except UnicodeError:
        continue
    if old_prefix in text or re.search(r"[~/\"'`]" + re.escape(old_directory) + r"(?=[/\\\"'`]|-dev|$)", text):
        violations.append(name)
assert not violations, 'Stale identity in: ' + ', '.join(violations)
PY
pnpm -C platform exec turbo run test --filter=./packages/config --filter=./apps/host-daemon --filter=./apps/cli
pnpm -C platform exec turbo run build --filter=./apps/cli
node platform/apps/cli/bin/hyperfide-platform --help
