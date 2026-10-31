#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
repo=$PWD
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
make cg
cp "$repo/cg" "$tmp/hyperfide"
# Copy the current source inventory, including edits, without caches or secrets.
python3 - "$repo" "$tmp/tree" <<'PY'
import os, shutil, subprocess, sys
from pathlib import Path
repo, dest = map(Path, sys.argv[1:])
paths = subprocess.check_output(['git', 'ls-files', '-z'], cwd=repo).split(b'\0')
paths += [b'tests/hyperfide/cases/v22/1_6.sh']
for raw in paths:
    if not raw:
        continue
    rel = Path(os.fsdecode(raw))
    if any(p == '.env' or p.startswith('.env.') for p in rel.parts):
        continue
    src, target = repo / rel, dest / rel
    if src.is_file():
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, target)
PY
cd "$tmp/tree"
start=$SECONDS
if timeout --kill-after=10s 2700s "$tmp/hyperfide" init --nested > "$tmp/init.log" 2>&1; then
  :
else
  result=$?
  cat "$tmp/init.log"
  echo "hyperfide init --nested failed: exit $result (124 means the 2700-second limit expired)" >&2
  exit 1
fi
elapsed=$((SECONDS - start))
test "$elapsed" -lt 2700
"$tmp/hyperfide" index-status --json > "$tmp/status.json"
python3 - "$tmp/status.json" "$elapsed" <<'PY'
import json, sys
s = json.load(open(sys.argv[1]))
server = [f for f in s['files'] if f['path'].startswith('core/server/')]
assert server, 'core/server is absent from the index'
symbols = sum(f['symbols'] for f in server)
assert symbols > 0, 'core/server has no indexed symbols'
assert s['file_count'] == len(s['files'])
assert s['symbol_count'] == sum(f['symbols'] for f in s['files'])
assert not any('/dist/' in '/' + f['path'] or '/.turbo/' in '/' + f['path']
               for f in s['files']), 'generated output was indexed'
print(f"init: {sys.argv[2]} seconds; {s['file_count']} files; "
      f"{s['symbol_count']} symbols; server: {len(server)} files, {symbols} symbols")
PY
echo 'ok: hyperfide-v22/1.6'
