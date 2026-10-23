#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
output=$(mktemp -d)
trap 'rm -rf "$output"' EXIT
bash scripts/release.sh --dry-run --output "$output"
(cd "$output" && sha256sum --check SHA256SUMS)
python3 - "$output" <<'PY'
import json,re,sys,tarfile,zipfile
from pathlib import Path
out=Path(sys.argv[1])
for name,required in {'binary':'bin/hyperfide','service':'dist/control.js','platform-server':'dist/start-server.js','platform-host-daemon':'host-daemon/dist/start-host-daemon.js','platform-app':'dist/index.html'}.items():
 with tarfile.open(out/f'hyperfide-{name}-2.2.0.tar.gz') as tar:
  assert required in tar.getnames(), (name,required)
  assert all(not m.name.startswith('/') and '..' not in Path(m.name).parts for m in tar)
  if name=='platform-host-daemon':assert {'cli/bin/hyperfide-platform','cli/dist/index.js'} <= set(tar.getnames())
  if name!='binary':assert json.load(tar.extractfile('package.json'))['version']=='2.2.0'
with zipfile.ZipFile(out/'hyperfide-2.2.0.vsix') as vsix:
 assert json.loads(vsix.read('extension/package.json'))['version']=='2.2.0'
 assert 'extension.vsixmanifest' in vsix.namelist()
notes=(out/'release-notes.md').read_text()
assert '# Hyperfide 2.2.0' in notes
expected=[]
for task,body in re.findall(r'\[task\.([^]]+)\]([^\[]*)',Path('spec/hyperfide-v22/spec.kvx').read_text()):
 if re.search(r'^status\s*=\s*"done"',body,re.M):expected.append(task)
actual=re.findall(r'^- ([0-9.]+):',notes,re.M)
assert set(actual)==set(expected),(actual,expected)
covered={line.split('  ',1)[1] for line in (out/'SHA256SUMS').read_text().splitlines()}
assert {p.name for p in out.iterdir() if p.suffix in {'.gz','.vsix'}} <= covered
PY
python3 "$output/smoke.py"
bash tests/integration/78_v16_release.sh
python3 tests/hyperfide/cases/v22/identity_gate.py --changed
