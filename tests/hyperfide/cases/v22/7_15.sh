#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
root=$PWD
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
run() {
  local label=$1 start=$SECONDS rc=0
  shift
  "$@" >"/tmp/hyperfide-7_15-$label.log" 2>&1 || rc=$?
  echo "$label: $((SECONDS-start))s exit $rc"
  return "$rc"
}
run build make cg
mkdir "$work/repo"
cp -R tests/fixtures/specrepo/. "$work/repo/"
cd "$work/repo"
git init -q -b main
git config user.email fixture@hyperfide.invalid
git config user.name Hyperfide
git add .
git commit -qm fixture
run init "$root/cg" init
db=$(echo "$work/repo"/.*/graph.db)
# Reopen a graph with the pre-fix schema to exercise additive migration.
run old-schema sqlite3 "$db" 'DROP INDEX idx_sem_route_registration;
DROP INDEX idx_sem_route_handler;
DROP INDEX idx_sem_route_symbol;
DROP INDEX idx_sem_route_child;
DROP INDEX idx_sem_route_registration_composed;
DROP INDEX idx_sem_edge_source_id;
DROP INDEX idx_sem_edge_target_id;
DROP INDEX idx_sem_edge_source_file_id;
DROP INDEX idx_sem_edge_target_file_id;'
run migrate "$root/cg" index --full
run fixture python3 - "$db" "$root/src/sem_routes.c" <<'PY'
import ast, pathlib, re, sqlite3, subprocess, sys
p=pathlib.Path('.')
d=sqlite3.connect(sys.argv[1])
branch=d.execute('SELECT id FROM branches LIMIT 1').fetchone()[0]
for i in range(2000):
    name=f'fixture_{i}.c'
    (p/name).write_text(f'int fixture_{i}(void) {{ return {i}; }}\n')
    d.execute('INSERT INTO files(id,branch_id,path,lang) VALUES(?,?,?,?)', (100000+i,branch,name,'c'))
    d.execute('INSERT INTO symbols(id,file_id,name,kind,line) VALUES(?,?,?,?,1)', (100000+i,100000+i,f'fixture_{i}','function'))
    d.execute("INSERT INTO symbol_fts(rowid,name,kind,path,sig,words) VALUES(?,?,'function',?,'',?)", (100000+i,f'fixture_{i}',name,f'fixture {i}'))
d.executemany("INSERT INTO semantic_edges(branch_id,source_file_id,target_file_id,source_id,target_id,kind) VALUES(?,?,?,?,?,'call')", ((branch,100000+i%2000,100000+(i+1)%2000,100000+i%2000,100000+(i+1)%2000) for i in range(200000)))
for i in range(50):
    d.execute("INSERT INTO symbols(id,file_id,name,kind,line) VALUES(?,?,?,'route',1)",(200000+i,100000+i,f'GET /fixture/{i}'))
    d.execute("INSERT INTO symbol_fts(rowid,name,kind,path,sig,words) VALUES(?,?,'route',?,'',?)",(200000+i,f'GET /fixture/{i}',f'fixture_{i}.c',f'fixture {i}'))
    d.execute("INSERT INTO semantic_route_facts(route_symbol_id,branch_id,registration_file_id,framework,method,pattern,status,registration_line) VALUES(?,?,?,'express','GET',?,'resolved',1)",(200000+i,branch,100000+i,f'/fixture/{i}'))
d.commit()
# Extract the production SQL so a later query regression cannot evade the check.
source=pathlib.Path(sys.argv[2]).read_text().split('int sem_routes_purge_file(',1)[1].split('static long exact_symbol',1)[0]
strings=[]
for group in re.findall(r'"(?:[^"\\]|\\.)*"(?:\s*"(?:[^"\\]|\\.)*")*',source):
    sql=''.join(ast.literal_eval(s) for s in re.findall(r'"(?:[^"\\]|\\.)*"',group))
    if sql.startswith(('SELECT ', 'INSERT ', 'DELETE ', 'UPDATE ')):
        strings.append(sql)
assert len(strings)==9, strings
for sql in strings:
    plan=subprocess.check_output(['sqlite3',sys.argv[1],'EXPLAIN QUERY PLAN '+sql.replace('?1','100000')],text=True)
    assert not re.search(r'SCAN (?:semantic_edges|semantic_route_facts|r\b)',plan), (sql,plan)
    # SQLite labels even a scalar FTS rowid lookup SCAN; INDEX 0:= is the
    # constrained lookup, whereas INDEX 0: is a full virtual-table scan.
    for line in plan.splitlines():
        if 'SCAN symbol_fts' in line:
            assert 'INDEX 0:=' in line,(sql,plan)
    assert 'SCAN semantic_route_compositions' not in plan,(sql,plan)
d.close()
PY
run index timeout 10 "$root/cg" index --full
run cleanup python3 - "$db" <<'PY'
import sqlite3, sys
d=sqlite3.connect(sys.argv[1])
assert d.execute('SELECT count(*) FROM semantic_route_facts').fetchone() == (0,)
assert d.execute("SELECT count(*) FROM symbols WHERE kind='route'").fetchone() == (0,)
assert d.execute("SELECT count(*) FROM symbol_fts WHERE name LIKE 'GET /fixture/%'").fetchone() == (0,)
PY
cd "$root"
run routes env CG="$root/cg" bash tests/integration/68_sem_routes.sh
run route-contract env CG="$root/cg" bash tests/integration/83_route_contract.sh
