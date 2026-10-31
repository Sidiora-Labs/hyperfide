#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
step() {
  local label="$1" started=$SECONDS result=0
  shift
  "$@" || result=$?
  echo "7.17: $label seconds=$((SECONDS-started)) exit=$result"
  return "$result"
}
step server-typecheck pnpm --filter @hyperfide/server typecheck
step version-tests pnpm --filter @hyperfide/server test src/services/system/app-version.test.ts
step server-build pnpm --filter @hyperfide/server build
step endpoint python3 - <<'PYTHON'
import json, os, signal, socket, subprocess, tempfile, time, urllib.request
from pathlib import Path

repo = Path.cwd()
with tempfile.TemporaryDirectory(prefix='hyperfide-7-17-') as tmp:
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
            started = time.monotonic()
            with urllib.request.urlopen(url + '/api/v1/system/version', timeout=1) as response:
                assert response.status == 200
                version = json.load(response)
            elapsed = time.monotonic() - started
            assert elapsed < 1, elapsed
            assert version['latestVersion'] is None, version
            assert version['upgradeCommand'] is None, version
            assert version['updateAvailable'] is False, version
            print(f'7.17: version endpoint seconds={elapsed:.3f} exit=0')
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
PYTHON
echo 'ok: 7.17'
