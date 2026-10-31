#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
step() {
  local name="$1"; shift
  local start=$SECONDS rc=0
  "$@" || rc=$?
  echo "$name: $((SECONDS-start))s exit=$rc"
  return "$rc"
}
step typecheck pnpm -C plugins/machine-railway typecheck
step tests pnpm -C plugins/machine-railway test
step bundled-plugins pnpm exec turbo run build --filter=@hyperfide/bundled-plugins
step server-rpc python3 - <<'PY'
import json, os, signal, socket, subprocess, tempfile, time, urllib.request
from pathlib import Path

repo = Path.cwd()
with tempfile.TemporaryDirectory(prefix='hyperfide-7-20-') as tmp:
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
            # Railway is an optional official plugin, so a clean server needs an explicit install.
            for name, args in [
                ('install-railway', ['install', 'builtin:machine-railway', '--yes', '--json']),
                ('enable-railway', ['enable', 'hyperfide-machine-railway', '--json']),
            ]:
                started = time.monotonic()
                result = subprocess.run(
                    [str(repo / 'apps/cli/bin/hyperfide-platform'), 'plugin', *args],
                    env=env, text=True, capture_output=True, timeout=120)
                print(f'{name}: {time.monotonic()-started:.3f}s exit={result.returncode}', flush=True)
                assert result.returncode == 0, result.stderr or result.stdout
            # Health can be ready while bundled plugins are still starting.
            for _ in range(90):
                assert server.poll() is None, 'server exited during plugin startup'
                result = subprocess.check_output(
                    [str(repo / 'apps/cli/bin/hyperfide-platform'), 'plugin', 'list', '--json'],
                    env=env, text=True, timeout=30)
                plugins = json.loads(result)['plugins']
                plugin = next((p for p in plugins if p['id'] == 'hyperfide-machine-railway'), None)
                if plugin and plugin['status'] in ('running', 'error') and not any(
                        p['enabled'] and p['status'] == 'starting' for p in plugins):
                    break
                time.sleep(.5)
            assert plugin is not None, [p['id'] for p in plugins]
            assert plugin['status'] == 'running', plugin
            assert not plugin.get('error'), plugin
            started = time.monotonic()
            result = subprocess.run(
                [str(repo / 'apps/cli/bin/hyperfide-platform'), 'plugin', 'rpc', 'call',
                 'hyperfide-machine-railway', 'railwayStatus', '--json'],
                env=env, text=True, capture_output=True, timeout=10)
            elapsed = time.monotonic() - started
            print(f'railwayStatus: {elapsed:.3f}s exit={result.returncode}', flush=True)
            assert result.returncode == 0, result.stderr
            payload = json.loads(result.stdout)
            assert payload.get('result', payload)['configured'] is False, payload
            assert elapsed < 1, f'railwayStatus took {elapsed:.3f}s (limit 1s)'
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
echo "ok: 7.20"
