#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
if [[ ! -f core/server/dist/index.js || ! -f apps/cli/dist/index.js ]]; then
  pnpm build
fi
python3 - <<'PY'
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.request

root = Path.cwd()
with tempfile.TemporaryDirectory(prefix='hyperfide-7-8-') as temporary:
    data = Path(temporary)
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    url = f'http://127.0.0.1:{port}'
    env = {k: v for k, v in os.environ.items()
           if not k.startswith('HYPERFIDE_') and k not in ('NODE_PATH', 'NODE_OPTIONS')}
    env.update(NODE_ENV='production', HYPERFIDE_SKIP_ONBOARDING='true',
               HYPERFIDE_SERVER_BIND_HOST='127.0.0.1', HYPERFIDE_SERVER_PORT=str(port),
               HYPERFIDE_DATA_DIR=str(data), HYPERFIDE_SERVER_URL=url)
    log_path = data / 'server.log'
    with log_path.open('w') as log:
        server = subprocess.Popen(['node', str(root / 'core/server/dist/index.js')],
                                  env=env, stdout=log, stderr=log)
        try:
            deadline = time.monotonic() + 120
            while True:
                assert server.poll() is None, log_path.read_text()
                try:
                    with urllib.request.urlopen(url + '/health', timeout=2) as response:
                        if response.status == 200:
                            break
                except (OSError, TimeoutError):
                    pass
                assert time.monotonic() < deadline, log_path.read_text()
                time.sleep(0.25)
            while True:
                result = subprocess.run(
                    [str(root / 'apps/cli/bin/hyperfide-platform'), 'plugin', 'list', '--json'],
                    env=env, text=True, capture_output=True, timeout=30, check=True)
                plugins = json.loads(result.stdout)['plugins']
                plugin = next((p for p in plugins if p['id'] == 'hyperfide-environment-slices'), None)
                if plugin and plugin['status'] == 'running' and not plugin.get('error') and not plugin.get('statusDetail'):
                    break
                assert time.monotonic() < deadline, (plugin, log_path.read_text())
                time.sleep(0.25)
        finally:
            server.terminate()
            try:
                server.wait(timeout=15)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()
    logs = [log_path, *data.glob('logs/server*.log')]
    for path in logs:
        assert 'plugin hyperfide-environment-slices failed to load' not in path.read_text(), path.read_text()
print('hyperfide-environment-slices is running without a load error')
PY
