#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
if [[ ! -f core/server/dist/index.js || ! -f apps/cli/dist/index.js ]]; then
  pnpm build
fi
python3 - <<'PY'
import json, os, shlex, signal, socket, subprocess, tempfile, time, urllib.request
from pathlib import Path

repo = Path.cwd()
with tempfile.TemporaryDirectory(prefix='hyperfide-7-11-') as tmp:
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
    wrapper = data / 'hyperfide-delayed'
    trace_log = data / 'trace-calls'
    wrapper.write_text('#!/bin/bash\nif [[ "$1" == spec && "$2" == trace ]]; then echo trace >> ' + shlex.quote(str(trace_log)) + '; sleep 3; fi\nexec ' + shlex.quote(str(repo / 'cg')) + ' "$@"\n')
    wrapper.chmod(0o755)
    env['HYPERFIDE_BIN'] = str(wrapper)
    cli_path = str(repo / 'apps/cli/bin/hyperfide-platform')
    def cli(*args, timeout=5):
        return json.loads(subprocess.check_output([cli_path, *args], env=env, text=True, timeout=timeout))
    with (data / 'server.log').open('w+') as log:
        server = subprocess.Popen(['node', str(repo / 'core/server/dist/index.js')],
                                  cwd=repo / 'platform', env=env, stdout=log,
                                  stderr=log, start_new_session=True)
        daemon = None
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
            def request(path, body=None):
                payload = None if body is None else json.dumps(body).encode()
                req = urllib.request.Request(url + path, data=payload,
                                             headers={'Content-Type': 'application/json'})
                with urllib.request.urlopen(req, timeout=10) as response:
                    return json.load(response)
            enrollment = request('/internal/hosts/enroll-key', {})
            daemon_env = dict(env, HYPERFIDE_HOST_ENROLL_KEY=enrollment['enrollKey'],
                              HYPERFIDE_HOST_ID=enrollment['hostId'])
            daemon = subprocess.Popen(['node', str(repo / 'core/host-daemon/dist/index.js')],
                                      cwd=repo / 'platform', env=daemon_env, stdout=log,
                                      stderr=log, start_new_session=True)
            for _ in range(120):
                assert daemon.poll() is None, 'host daemon exited'
                if any(h['id'] == enrollment['hostId'] and h.get('status') == 'connected'
                       for h in request('/api/v1/hosts')):
                    break
                time.sleep(.5)
            else:
                raise AssertionError('host enrollment timed out')
            request('/api/v1/projects', {'name': 'Spec qualification', 'source': {
                'hostId': enrollment['hostId'], 'type': 'local_path', 'path': str(repo)}})
            os.killpg(server.pid, signal.SIGTERM)
            server.wait(timeout=20)
            started = time.monotonic()
            server = subprocess.Popen(['node', str(repo / 'core/server/dist/index.js')],
                                      cwd=repo / 'platform', env=env, stdout=log,
                                      stderr=log, start_new_session=True)
            plugin = None
            while time.monotonic() - started < 30:
                assert server.poll() is None, 'server exited during plugin startup'
                try:
                    plugins = cli('plugin', 'list', '--json')['plugins']
                    plugin = next((p for p in plugins if p['id'] == 'hyperfide-spec'), None)
                    if plugin and plugin['status'] in ('running', 'error'):
                        break
                except subprocess.CalledProcessError:
                    pass
                time.sleep(.25)
            assert plugin and plugin['status'] == 'running', plugin
            assert not plugin.get('error'), plugin
            assert time.monotonic() - started < 30, 'plugin startup exceeded 30 seconds'
            rpc_input = data / 'rpc-input.json'
            rpc_input.write_text(json.dumps({'repository': str(repo)}))
            def features():
                return cli('plugin', 'rpc', 'call', 'hyperfide-spec', 'features',
                           '--input-file', str(rpc_input), '--json', timeout=5)
            features()
            deadline = time.monotonic() + 240
            while time.monotonic() < deadline:
                snapshot = features()
                if len(snapshot) == 18 and any(f['id'] == 'hyperfide-v22' for f in snapshot):
                    break
                time.sleep(1)
            else:
                raise AssertionError(f'full feature snapshot timed out: {snapshot}')
            assert trace_log.read_text().strip(), 'delayed trace wrapper was not invoked'
            log.flush()
            log.seek(0)
            assert 'plugin hyperfide-spec failed to load' not in log.read()
            print('7.11: spec plugin starts within 30s, serves RPC within 5s, and reads all 18 features')
        except BaseException:
            log.flush()
            log.seek(0)
            print(log.read())
            raise
        finally:
            if daemon is not None:
                if daemon.poll() is None:
                    os.killpg(daemon.pid, signal.SIGTERM)
                try:
                    daemon.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(daemon.pid, signal.SIGKILL)
                    daemon.wait()
            if server.poll() is None:
                os.killpg(server.pid, signal.SIGTERM)
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(server.pid, signal.SIGKILL)
                server.wait()
PY
