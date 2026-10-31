#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
python3 - <<'PY'
import re, subprocess
from pathlib import Path
roots = ['lib/config', 'apps/cli', 'core/server/src',
         'core/host-daemon/src', 'tools/scripts',
         'contracts/host-daemon', 'contracts/server',
         'apps/web/src', 'apps/desktop/src', 'apps/mobile',
         'package.json', '.env.example']
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
pnpm exec turbo run test --filter=./packages/config --filter=./apps/host-daemon --filter=./apps/cli
pnpm exec turbo run build --filter=./apps/cli
node apps/cli/bin/hyperfide-platform --help
