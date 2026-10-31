#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
if [[ ! -f core/server/dist/index.js || ! -f tools/bundled-plugins/dist/hyperfide-dispatch/dist/server.js ]]; then
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
with tempfile.TemporaryDirectory(prefix='hyperfide-dispatch-') as temporary:
    data = Path(temporary)
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    url = f'http://127.0.0.1:{port}'
    env = dict(os.environ, NODE_ENV='production', HYPERFIDE_SKIP_ONBOARDING='true',
               HYPERFIDE_SERVER_BIND_HOST='127.0.0.1', HYPERFIDE_SERVER_PORT=str(port),
               HYPERFIDE_DATA_DIR=str(data), HYPERFIDE_SERVER_URL=url)
    log_path = data / 'server.log'
    with log_path.open('w') as log:
        server = subprocess.Popen(['node', 'core/server/dist/index.js'],
                                  cwd=root, env=env, stdout=log, stderr=log)
        try:
            for _ in range(240):
                if server.poll() is not None:
                    raise AssertionError('Server exited: ' + log_path.read_text())
                try:
                    with urllib.request.urlopen(url + '/health', timeout=1) as response:
                        if response.status == 200:
                            break
                except Exception:
                    pass
                time.sleep(.25)
            else:
                raise AssertionError('Server health timed out: ' + log_path.read_text())

            def cli(*args):
                result = subprocess.run(['node', 'apps/cli/dist/index.js', *args],
                                        env=env, text=True, capture_output=True, timeout=60)
                assert result.returncode == 0, result.stdout + result.stderr + log_path.read_text()
                return json.loads(result.stdout)

            for _ in range(120):
                plugins = cli('plugin', 'list', '--json')['plugins']
                plugin = next((p for p in plugins if p['id'] == 'hyperfide-dispatch'), None)
                if plugin and plugin['status'] != 'starting':
                    break
                time.sleep(.5)
            assert plugin is not None, plugins
            assert plugin['enabled'] and plugin['status'] == 'running', plugin
            assert not plugin.get('statusDetail') and not plugin.get('error'), plugin
            methods = cli('plugin', 'rpc', 'list', 'hyperfide-dispatch', '--json')
            names = {method['method'] for method in methods}
            assert {'fleetLedger', 'fleetAction', 'imageBuilds', 'imageBuildStart', 'imageBuildCancel'} <= names, methods
            ledger = cli('plugin', 'rpc', 'call', 'hyperfide-dispatch', 'fleetLedger', '--json')
            assert 'machines' in ledger and 'budget' in ledger, ledger
            assert 'plugin hyperfide-dispatch failed to load' not in log_path.read_text()
        finally:
            server.terminate()
            try:
                server.wait(timeout=20)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()
print('7.9: bundled dispatch plugin is running and serves fleet and image-builder RPC')
PY
bash tests/hyperfide/cases/v22/5_4.sh
