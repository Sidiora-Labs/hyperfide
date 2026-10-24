#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
run() {
  local label=$1 start=$SECONDS rc=0
  shift
  "$@" || rc=$?
  echo "$label: $((SECONDS-start))s exit $rc"
  return "$rc"
}
run build make -j4 cg
run contention-equivalence python3 - "$PWD" "$work" <<'PY'
import os, pathlib, shlex, sqlite3, subprocess, sys, threading, time
root, work = map(pathlib.Path, sys.argv[1:])
def step(label, args, **kwargs):
    start=time.monotonic()
    p=subprocess.run(args, **kwargs)
    print(f'{label}: {time.monotonic()-start:.3f}s exit {p.returncode}', flush=True)
    p.check_returncode()
    return p
# Build an actual unchunked reference from the same implementation, disabling
# only the checkpoint owner. No environment switch can disable production bounds.
source=(root/'src/progress.c').read_text()
assert source.count('chunk_owner = cg;') == 1
(work/'reference.c').write_text(source.replace('chunk_owner = cg;', 'chunk_owner = NULL;'))
step('reference-object', ['cc','-O2','-std=gnu11','-pthread','-I'+str(root/'src'),
     '-I'+str(root/'vendor/tree-sitter/lib/include'),'-c',str(work/'reference.c'),'-o',str(work/'reference.o')])
commands=subprocess.check_output(['make','-n','-W','build/progress.o','hyperfide'],text=True)
link=next(shlex.split(line) for line in commands.splitlines() if ' -o hyperfide ' in line)
link[link.index('build/progress.o')]=str(work/'reference.o')
link[link.index('-o')+1]=str(work/'reference')
step('reference-link',link)
repo=work/'repo'; repo.mkdir()
step('git-init',['git','init','-q','-b','main',str(repo)])
step('init',[str(root/'cg'),'init'],cwd=repo,stdout=subprocess.DEVNULL)
# Repeated names make resolution do real candidate ranking, while routes also
# exercise synthetic symbols and facts. Increase size if this machine is faster.
def fixture(count):
    for i in range(count):
        (repo/f'unit_{i:05}.js').write_text(
            '\n'.join(f'function handler{j}() {{ return handler{(j+1)%24}(); }}' for j in range(24))+
            f'\napp.get("/unit/{i}", handler0);\n')
fixture(900)
db=next(repo.glob('.*/graph.db'))
base=work/'seed.db'
with sqlite3.connect(db) as d, sqlite3.connect(base) as b: d.backup(b)
def counts():
    with sqlite3.connect(db) as d:
        return {t:d.execute('SELECT count(*) FROM '+t).fetchone()[0]
                for t in ('files','symbols','semantic_edges','semantic_route_facts')}
def restore():
    with sqlite3.connect(base) as b, sqlite3.connect(db) as d: b.backup(d)
def index(probe):
    started=time.monotonic()
    waits=[]; errors=[]; phases={}; stop=threading.Event()
    def prober():
        with sqlite3.connect(db,timeout=5) as d:
            while not stop.is_set():
                start=time.monotonic()
                try: d.execute('BEGIN IMMEDIATE'); d.execute('ROLLBACK')
                except Exception as e:
                    errors.append(str(e))
                    print(f'probe failure at {time.monotonic()-started:.3f}s: {e}',flush=True)
                waits.append(time.monotonic()-start)
                stop.wait(1)
    t=threading.Thread(target=prober)
    if probe: t.start()
    start=time.monotonic()
    p=subprocess.Popen([str(root/'cg' if probe else work/'reference'),'index','--full'],
        cwd=repo,env={**os.environ,'HYPERFIDE_PROGRESS':'plain'},stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    def stderr():
        for line in p.stderr:
            if 'resolving references' in line: phases.setdefault('resolve',time.monotonic())
            if 'finishing' in line: phases.setdefault('finish',time.monotonic())
    reader=threading.Thread(target=stderr); reader.start()
    out=p.stdout.read(); rc=p.wait(); reader.join(); stop.set()
    if probe: t.join()
    print(f'{"chunked" if probe else "reference"}-index: {time.monotonic()-start:.3f}s exit {rc}',flush=True)
    assert rc==0,(rc,out)
    if probe:
        elapsed=phases['finish']-phases['resolve']
        print(f'resolve+semantic: {elapsed:.3f}s; probes={len(waits)} max-wait={max(waits):.3f}s',flush=True)
        assert elapsed>20,elapsed
        assert len(waits)>20 and not errors,errors
        assert max(waits)<5,waits
    return counts()
chunked=index(True)
assert all(chunked[t]>0 for t in chunked),chunked
restore()
reference=index(False)
assert reference==chunked,(reference,chunked)
print('matching graph counts:',chunked,flush=True)
# Exercise failed publication and recovery separately from the costly fixture.
repo=work/'recovery'; repo.mkdir()
step('recovery-git',['git','init','-q','-b','main',str(repo)])
step('recovery-init',[str(root/'cg'),'init'],cwd=repo,stdout=subprocess.DEVNULL)
db=next(repo.glob('.*/graph.db'))
with sqlite3.connect(db) as d:
    before=d.execute("SELECT key,value FROM meta WHERE key LIKE 'semantic_generation:%'").fetchall()
(repo/'route.js').write_text('function handler() { return 1; }\napp.get("/recovery", handler);\n')
start=time.monotonic()
failed=subprocess.run([str(root/'cg'),'index','--full'],cwd=repo,
     env={**os.environ,'HYPERFIDE_SEM_FAIL_BEFORE_PUBLISH':'1'},stdout=subprocess.DEVNULL)
print(f'abandon: {time.monotonic()-start:.3f}s exit {failed.returncode}',flush=True)
assert failed.returncode != 0
with sqlite3.connect(db) as d:
    assert d.execute("SELECT count(*) FROM meta WHERE key LIKE '%index_pending_resolve%' AND value='1'").fetchone()[0]
    assert d.execute('SELECT count(*) FROM semantic_change_debt').fetchone()[0]>0
    assert d.execute("SELECT key,value FROM meta WHERE key LIKE 'semantic_generation:%'").fetchall()==before
    assert d.execute("SELECT pending_version FROM extraction_health WHERE path='route.js'").fetchone()[0] is not None
step('recover',[str(root/'cg'),'index','--full'],cwd=repo,stdout=subprocess.DEVNULL)
recovered=counts()
step('recovery-reference',[str(work/'reference'),'index','--full'],cwd=repo,stdout=subprocess.DEVNULL)
assert counts()==recovered,(counts(),recovered)
with sqlite3.connect(db) as d:
    assert d.execute('SELECT count(*) FROM semantic_change_debt').fetchone()[0]==0
    assert d.execute("SELECT pending_version FROM extraction_health WHERE path='route.js'").fetchone()[0] is None
    assert not d.execute("SELECT 1 FROM meta WHERE key LIKE '%index_pending_resolve%' AND value='1'").fetchone()

PY
printf 'ok: 7.18\n'
