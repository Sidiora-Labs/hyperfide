#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
python3 - <<'PY_CHECK'
import base64
import json
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
assert not any(name.startswith("platform/plugins/") and Path(name).parts[2].endswith("-account") for name in tracked_files), "Hosted account plugin remains"
assert not any(Path(name).match("platform/plugins/*-official.json") for name in tracked_files), "Official manifest remains"
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
        if name in source:
            failures.append(f"{filename}: removed package reference")
    # The wave 0 identity sweep (0.7) owns this owner-maintained changelog.
    if filename != "platform/CHANGELOG.md":
        for domain in former_domains:
            if domain in source.replace("\\", "").casefold():
                failures.append(f"{filename}: former hosted domain reference")
assert not failures, "\n".join(failures)
print("Hosted component removal checks passed")
PY_CHECK
pnpm -C platform install --frozen-lockfile
pnpm -C platform typecheck
