#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."

python3 - <<'PY'
import json
import re
import subprocess
import sqlite3
import shutil
import tempfile
import time
from pathlib import Path

# Derive the pre-existing leaf task set from the source of truth, independently
# of trace. A warm graph is required, so complete a refresh before timing reads.
source = Path('spec/hyperfide-v22/spec.kvx').read_text()
blocks = re.findall(r'^\[task\.([^]]+)\]\n(.*?)(?=^\[|\Z)', source, re.M | re.S)
expected = {task for task, body in blocks if re.search(r'^wave\s*=', body, re.M)}
assert expected
subprocess.run(['./cg', 'sync', '--json'], check=True, capture_output=True)
results = []
for extra, limit in [(['--no-sync'], 2), ([], 5)]:
    elapsed = None
    for attempt in range(3):
        started = time.monotonic()
        run = subprocess.run(['./cg', 'spec', 'trace', '-f', 'hyperfide-v22', '--json', *extra],
                             check=True, capture_output=True, text=True, timeout=30)
        sample = time.monotonic() - started
        elapsed = sample if elapsed is None else min(elapsed, sample)
    mode = '--no-sync' if extra else 'default sync'
    print(f'spec trace {mode}: {elapsed:.3f}s (limit {limit}s)', flush=True)
    data = json.loads(run.stdout)
    assert data['feature'] == 'hyperfide-v22' and data['graph'] is True, data
    tasks = data['tasks']
    assert {task['id'] for task in tasks} == expected
    assert len(tasks) == len(expected)
    for task in tasks:
        assert set(task) == {'id', 'title', 'status', 'wave', 'graph',
                             'symbols', 'touches', 'commits', 'memories'}, task
    assert elapsed < limit, (mode, elapsed, limit)
    results.append(data)
assert results[0] == results[1], 'sync changed trace evidence on a warm graph'

# Batch memory ranking must preserve the per-task limit and superseded order,
# even when timestamps tie and a similarly named feature has its own memories.
binary = str(Path('cg').resolve())
with tempfile.TemporaryDirectory() as directory:
    project = Path(directory) / 'project'
    shutil.copytree('tests/fixtures/specrepo', project)
    subprocess.run([binary, 'init'], cwd=project, check=True, capture_output=True)
    with sqlite3.connect(project / '.codegraph/graph.db') as db:
        for task in ['demo/1.1', 'demo/1.2', 'demo-other/1.1']:
            for i in range(15):
                db.execute('INSERT INTO memories(created,type,task,body,source) VALUES(1,?,?,?,?)',
                           ('decision', task, f'{task} memory {i}', 'test'))
        db.execute('INSERT INTO memory_superseded(id,by_id,at) VALUES(15,14,1)')
        db.execute('INSERT INTO git_commits(hash,subject) VALUES(?,?)',
                   ('trace-test', 'historical change [spec:demo/2.1]'))
        db.execute('INSERT INTO git_churn(hash,path) VALUES(?,?)',
                   ('trace-test', 'src/historical.ts'))
        db.execute("UPDATE extraction_health SET status='partial',extraction_version=NULL")
        db.execute("UPDATE meta SET value='1' WHERE key LIKE 'last_index_at:%'")
        indexed_at = db.execute("SELECT key,value FROM meta WHERE key LIKE 'last_index_at:%'").fetchall()
    data = json.loads(subprocess.check_output(
        [binary, 'spec', 'trace', '--json', '--no-sync'], cwd=project))
    for task in data['tasks']:
        memories = task['memories']
        if task['id'] == '1.1':
            assert [m['id'] for m in memories] == list(range(14, 4, -1)), memories
        elif task['id'] == '1.2':
            assert [m['id'] for m in memories] == list(range(30, 20, -1)), memories
        else:
            assert memories == [], memories
        if task['id'] == '2.1':
            assert task['touches'] == [{'pattern': 'src/*.ts', 'changed': True}], task
    synced = json.loads(subprocess.check_output(
        [binary, 'spec', 'trace', '--json'], cwd=project))
    assert synced == data
    with sqlite3.connect(project / '.codegraph/graph.db') as db:
        assert db.execute("SELECT key,value FROM meta WHERE key LIKE 'last_index_at:%'").fetchall() == indexed_at, \
            'unchanged parser diagnostics caused another index pass'
    (project / 'src').mkdir(exist_ok=True)
    (project / 'src/new.ts').write_text('export function checkMode() { return true; }\n')
    refreshed = json.loads(subprocess.check_output(
        [binary, 'spec', 'trace', '--json'], cwd=project))
    checked = next(task for task in refreshed['tasks'] if task['id'] == '2.1')
    assert checked['symbols'][0]['found'] is True, 'new source file was not indexed'
PY

export CG="$PWD/cg"
bash tests/integration/07_trace.sh
bash tests/integration/08_memory.sh
# The callers section sets the legacy CG_BUSY_TIMEOUT_MS alias; under `spec done` the canonical
# HYPERFIDE_BUSY_TIMEOUT_MS is already exported, and the binary refuses conflicting aliases (exit 78).
env -u HYPERFIDE_BUSY_TIMEOUT_MS -u CG_BUSY_TIMEOUT_MS bash tests/integration/25_syncgate.sh callers
echo 'ok: 7.12'
