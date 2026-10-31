#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
python3 - <<'PY_CHECK'
import base64
import json
import re
from pathlib import Path
import subprocess

root = Path("platform")
tracked_files = subprocess.check_output(
    ["git", "ls-files", "-z", "--", "platform/"]
).decode().rstrip("\0").split("\0")
removed_dirs = ['apps/web', 'apps/connect', 'apps/connect-next', 'packages/connect-client', 'packages/connect-db', 'packages/tunnel-client', 'packages/tunnel-contract', 'packages/frp-client', 'plugins/connect', 'plugins/connect-next']
# Removed workspaces can retain ignored node_modules in sandbox checkpoints.
for directory in removed_dirs:
    prefix = (root / directory).as_posix()
    assert not any(name == prefix or name.startswith(prefix + "/") for name in tracked_files), f"Removed directory remains: {directory}"
assert not any(name.startswith("plugins/") and Path(name).parts[2].endswith("-account") for name in tracked_files), "Hosted account plugin remains"
assert not any(Path(name).match("plugins/*-official.json") for name in tracked_files), "Official manifest remains"
removed_names = json.loads(base64.b64decode("WyJAYmIvd2ViIiwgIkBiYi9jb25uZWN0IiwgIkBiYi9jb25uZWN0LW5leHQiLCAiQGJiL2Nvbm5lY3QtY2xpZW50IiwgIkBiYi9jb25uZWN0LWRiIiwgIkBiYi90dW5uZWwtY2xpZW50IiwgIkBiYi90dW5uZWwtY29udHJhY3QiLCAiQGJiL2ZycC1jbGllbnQiLCAiYmItcGx1Z2luLWNvbm5lY3QiLCAiYmItcGx1Z2luLWJiLS1jb25uZWN0LW5leHQiLCAiYmItcGx1Z2luLWJiLWFjY291bnQiXQ=="))
removed_names += ["@hyperfide/" + name.split("/", 1)[1] for name in removed_names if name.startswith("@")]
removed_names += ["@hyperfide/plugin-connect", "@hyperfide/plugin-connect-next", "@hyperfide/plugin-account"]
former_domains = [base64.b64decode(value).decode() for value in (
    "Z2V0YmIuYXBw", "dmliZWNvZGV0aGlzLnNpdGU=",
)]
failures = []
for filename in tracked_files:
    path = Path(filename)
    if not path.is_file():
        continue
    try:
        source = path.read_text()
    except UnicodeDecodeError:
        continue
    for name in removed_names:
        if re.search(re.escape(name) + r"(?![A-Za-z0-9_-])", source):
            failures.append(f"{filename}: removed package reference")
    # The wave 0 identity sweep (0.7) owns this owner-maintained changelog.
    if filename != "docs/history/runtime-port.md":
        for domain in former_domains:
            if domain in source.replace("\\", "").casefold():
                failures.append(f"{filename}: former hosted domain reference")
assert not failures, "\n".join(failures)
print("Hosted component removal checks passed")
PY_CHECK
# Sandbox preparation may already have installed the frozen workspace.
if [[ ! -f node_modules/.modules.yaml ]]; then
  pnpm install --frozen-lockfile
fi
pnpm --filter @hyperfide/server build
python3 - <<'PY_SMOKE'
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

with tempfile.TemporaryDirectory(prefix="hyperfide-empty-marketplace-") as data_dir:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    env = dict(os.environ, NODE_ENV="production",
               HYPERFIDE_MARKETPLACE_URL="", HYPERFIDE_DATA_DIR=data_dir,
               HYPERFIDE_SERVER_PORT=str(port),
               HYPERFIDE_HOST_DAEMON_PORT="49162",
               HYPERFIDE_SERVER_BIND_HOST="127.0.0.1")
    log_path = Path(data_dir) / "startup.log"
    with log_path.open("w+") as log:
        process = subprocess.Popen(
            ["node", "core/server/dist/index.js"], env=env,
            stdout=log, stderr=subprocess.STDOUT,
        )
        try:
            deadline = time.monotonic() + 60
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            while True:
                if process.poll() is not None:
                    raise AssertionError(f"Server exited before ready: {process.returncode}")
                try:
                    with opener.open(f"http://127.0.0.1:{port}/health", timeout=1) as response:
                        ready = response.status == 200
                except (urllib.error.URLError, TimeoutError):
                    ready = False
                if ready:
                    # The original failure could follow the listening log.
                    time.sleep(1)
                    assert process.poll() is None, "Server exited after health became ready"
                    break
                assert time.monotonic() < deadline, "Server health timed out"
                time.sleep(0.1)
            print("Empty marketplace server smoke passed")
        except BaseException:
            log.flush()
            print(log_path.read_text())
            raise
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
PY_SMOKE
pnpm typecheck
