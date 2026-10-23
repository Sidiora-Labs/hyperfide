#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
repo=$PWD
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
for target in platform-install platform-build platform-test; do
  make -n "$target" > "$tmp/$target"
  grep -q 'pnpm -C platform' "$tmp/$target"
done
python3 - "$repo" "$tmp" <<'PY'
import json, sys
from pathlib import Path
repo, tmp = map(Path, sys.argv[1:])
c = json.loads((repo / 'deploy/hyperfide/sandbox/fleet.json').read_text())
c['repo'] = str(repo)
(tmp / 'fleet.json').write_text(json.dumps(c))
(tmp / 'preamble.md').write_text('Hyperfide qualification preamble marker\n')
steps = [s[0] for s in c['base']['steps']]
assert steps.index('service') < steps.index('platform') < steps.index('platform-build') < steps.index('index')
commands = {name: (cmd, timeout) for name, cmd, timeout in c['base']['steps']}
assert 'pnpm@9.15.0' in commands['platform'][0]
assert 'pnpm install --frozen-lockfile' in commands['platform'][0]
assert commands['platform'][1] == commands['platform-build'][1] == 5400
assert 'build_failed' in commands['platform-build'][0] and '/work/logs/pnpm-build.log' in commands['platform-build'][0]
assert 'pnpm --version' in c['probe']
assert 'platform/pnpm-lock.yaml' in c['prepare']
assert 'platform/pnpm-workspace.yaml' in c['prepare']
assert c['prepare'].index('pnpm install --frozen-lockfile') < c['prepare'].index('pnpm install --no-frozen-lockfile')
PY
HF_FLEET_CONFIG="$tmp/fleet.json" HF_PACKET_PREAMBLE="$tmp/preamble.md" \
  python3 deploy/hyperfide/sandbox/gen-jobs.py --codex hyperfide-v22 0.8 --base HEAD
python3 - "$tmp" <<'PY'
import json, sys
from pathlib import Path
root = Path(sys.argv[1])
j = json.loads((root / 'state/jobs/v22-0.8.json').read_text())
assert j['kind'] == 'codex' and j['feature'] == 'hyperfide-v22' and j['task'] == '0.8'
p = Path(j['packet']).read_text()
assert '[spec:hyperfide-v22/0.8]' in p and 'Hyperfide qualification preamble marker' in p
PY
echo 'ok: hyperfide-v22/0.8'
