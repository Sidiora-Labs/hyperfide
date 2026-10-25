#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
pnpm -C platform --filter @hyperfide/desktop-contract typecheck
pnpm -C platform --filter @hyperfide/desktop-contract test
pnpm -C platform --filter @hyperfide/desktop typecheck
pnpm -C platform --filter @hyperfide/desktop test
pnpm -C platform --filter @hyperfide/desktop build
python3 - <<'PY'
from pathlib import Path
import re
root = Path('platform/apps/desktop/src')
main = (root / 'main.ts').read_text()
assert 'app.on("login"' in main
assert 'event.preventDefault()' in main
assert 'safeStorage' in main
assert '"auth-required"' in (root / 'server-probe.ts').read_text()
store = (root / 'server-credentials.ts').read_text()
assert 'encryptString' in store and 'decryptString' in store
assert 'isEncryptionAvailable' in store
for path in root.rglob('*.ts'):
    source = path.read_text()
    # Capture complete log argument expressions, including multiline calls.
    for call in re.finditer(r'(?:\bconsole|\b\w*[Ll]ogger)\.(?:log|debug|info|warn|error)\s*\(', source):
        start = call.end()
        depth, end = 1, start
        while depth and end < len(source):
            depth += (source[end] == '(') - (source[end] == ')')
            end += 1
        assert not re.search(r'password', source[start:end], re.I), f'password in log call: {path}'
assert 'Servers behind HTTP basic auth' in Path('platform/apps/desktop/README.md').read_text()
assert Path('platform/apps/desktop/dist/main.js').is_file()
assert 'data-credentials' in Path('platform/apps/desktop/dist/server-url-dialog-preload.cjs').read_text()
PY
