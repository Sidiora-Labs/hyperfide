#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
if [[ ! -f core/server/dist/index.js || ! -f apps/cli/dist/index.js ]]; then
  pnpm build
fi
python3 - <<'PY'
import json, os, signal, socket, subprocess, tempfile, time, urllib.request
from pathlib import Path

repo = Path.cwd()
with tempfile.TemporaryDirectory(prefix='hyperfide-7-7-') as tmp:
    data = Path(tmp)
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    url = f'http://127.0.0.1:{port}'
    env = {k: v for k, v in os.environ.items()
           if not k.startswith('HYPERFIDE_') and k not in ('NODE_PATH', 'NODE_OPTIONS')}
    env.update(NODE_ENV='production', HYPERFIDE_SKIP_ONBOARDING='true',
               HYPERFIDE_SERVER_BIND_HOST='127.0.0.1', HYPERFIDE_SERVER_PORT=str(port),
               HYPERFIDE_DATA_DIR=str(data), HYPERFIDE_SERVER_URL=url)
    with (data / 'server.log').open('w+') as log:
        server = subprocess.Popen(['node', str(repo / 'core/server/dist/index.js')],
                                  cwd=repo / 'platform', env=env, stdout=log,
                                  stderr=log, start_new_session=True)
        try:
            for _ in range(180):
                if server.poll() is not None:
                    raise RuntimeError(f'server exited: {server.returncode}')
                try:
                    with urllib.request.urlopen(url + '/health', timeout=2) as response:
                        assert response.status == 200
                    break
                except (OSError, TimeoutError):
                    time.sleep(.5)
            else:
                raise RuntimeError('server health timed out')
            # Health can be ready while bundled plugins are still starting.
            for _ in range(90):
                assert server.poll() is None, 'server exited during plugin startup'
                result = subprocess.check_output(
                    [str(repo / 'apps/cli/bin/hyperfide-platform'), 'plugin', 'list', '--json'],
                    env=env, text=True, timeout=30)
                plugins = json.loads(result)['plugins']
                plugin = next((p for p in plugins if p['id'] == 'hyperfide-qualify'), None)
                if plugin and plugin['status'] in ('running', 'error'):
                    break
                time.sleep(.5)
            assert plugin is not None, plugins
            assert plugin['status'] == 'running', plugin
            assert not plugin.get('error'), plugin
            log.flush()
            log.seek(0)
            assert 'plugin hyperfide-qualify failed to load' not in log.read()
            print('7.7: production qualify plugin is running')
        except BaseException:
            log.flush()
            log.seek(0)
            print(log.read())
            raise
        finally:
            if server.poll() is None:
                os.killpg(server.pid, signal.SIGTERM)
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(server.pid, signal.SIGKILL)
                server.wait()
PY
