#!/usr/bin/env bash
# The task file is current before every commit (hyperfide-v21 5.7, req 6
# ac_4). `cg commit` reconciles the claimed task's spec.kvx with its claim
# receipt (the task's latest attempt) before it snapshots: a pending status
# under a running receipt is refreshed to in_progress, the task's evidence
# key points at the receipt, and a status that disagrees with the receipt is
# refused with no snapshot taken. The integrator refuses a candidate whose
# spec status does not match its contributors' qualification.
. "$(dirname "$0")/../lib.sh"
repo="$(cd "$(dirname "$0")/../.." && pwd)"
export CG_AGENT=w57

cp -r "$FIXTURES/sample" "$TMP/proj"
cd "$TMP/proj"
"$CG" init >/dev/null 2>&1
"$CG" spec new syn >/dev/null
"$CG" spec add 2.1 --title "Claimed work" --wave 1 --reqs 1.1 >/dev/null
"$CG" spec add 3.1 --title "Plain start" --wave 1 --reqs 1.1 >/dev/null
kvx="spec/syn/spec.kvx"

key() {   # key <task> <key>: the task's scalar value, "" when absent
    python3 - "$kvx" "$1" "$2" <<'PY'
import re, sys
path, task, key = sys.argv[1:]
lines = open(path).read().split("\n")
start = lines.index("[task.%s]" % task)
for line in lines[start + 1:]:
    if line.startswith("["):
        break
    m = re.match(r'%s\s*=\s*"(.*)"' % re.escape(key), line)
    if m:
        print(m.group(1)); break
PY
}
set_status() { sed -i "/^\[task\.$1\]/,/^\[/{s/^status = \".*\"/status = \"$2\"/}" "$kvx"; }
head_id() { "$CG" log -n 1 | head -1; }
receipt() {
    sqlite3 .codegraph/graph.db \
        "SELECT attempt_id||' '||state FROM attempts WHERE task='syn/$1' ORDER BY fence DESC LIMIT 1"
}

# ---- no claim, no receipt: a plain start commits untouched
"$CG" spec start 3.1 >/dev/null
"$CG" commit -m "plain start" >/dev/null || fail "commit without a receipt refused"
[ -z "$(key 3.1 evidence)" ] || fail "a task without a receipt got an evidence pointer"
[ "$(key 3.1 status)" = in_progress ] || fail "plain start status changed"
"$CG" spec release 3.1 --force >/dev/null 2>&1 || true
set_status 3.1 pending

# ---- a claimed task: the commit points the task file at its receipt
"$CG" spec claim 2.1 --agent w57 >/dev/null
read -r attempt state <<<"$(receipt 2.1)"
[ "$state" = running ] || fail "claim did not record a running receipt ($state)"
# a claim leases without starting: the declaration still says pending, and
# the first commit under the running receipt brings it to in_progress
[ "$(key 2.1 status)" = pending ] || fail "claim changed the declaration"
"$CG" commit -m "claimed work" >/dev/null || fail "claimed commit refused"
[ "$(key 2.1 status)" = in_progress ] ||
    fail "pending under a running receipt not refreshed: $(key 2.1 status)"
[ "$(key 2.1 evidence)" = "attempt:$attempt" ] ||
    fail "evidence pointer not refreshed: '$(key 2.1 evidence)'"
# the refreshed file is inside the snapshot, not only on disk
out="$("$CG" status)"
has "$out" "working tree clean"

# ---- a merge took another branch's copy: pending under a running receipt
# is refreshed to in_progress before the snapshot
set_status 2.1 pending
sed -i "/^\[task\.2\.1\]/,/^\[/{/^evidence = /d}" "$kvx"
echo "merged work" >notes.txt
"$CG" commit -m "after a merge" >/dev/null || fail "refreshable commit refused"
[ "$(key 2.1 status)" = in_progress ] ||
    fail "pending was not refreshed to in_progress: $(key 2.1 status)"
[ "$(key 2.1 evidence)" = "attempt:$attempt" ] || fail "evidence not restored"
has "$("$CG" status)" "working tree clean"
has "$("$CG" log -n 1)" "after a merge"

# ---- a hand-written done under a running receipt is refused, no snapshot
set_status 2.1 done
before="$(head_id)"
out="$("$CG" commit -m "false done" 2>&1)" && fail "false done was snapshotted: $out"
has "$out" "is still running"
has "$out" "hyperfide spec done 2.1"
[ "$(head_id)" = "$before" ] || fail "a refused commit moved the head"
[ "$(key 2.1 status)" = done ] || fail "refusal rewrote the status"
set_status 2.1 implemented
out="$("$CG" commit -m "false implemented" 2>&1)" &&
    fail "hand-written implemented was snapshotted: $out"
has "$out" "is still running"

# ---- the receipt completes through the lifecycle: the file must follow it
set_status 2.1 in_progress
"$CG" spec mode prod >/dev/null
"$CG" spec implemented 2.1 --agent w57 >/dev/null
read -r a2 state <<<"$(receipt 2.1)"
[ "$state" = completed ] || fail "implemented did not complete the receipt ($state)"
[ "$(key 2.1 status)" = implemented ] || fail "lifecycle did not write implemented"
"$CG" commit -m "implemented" >/dev/null || fail "agreeing implemented commit refused"
# reopened by hand while the receipt says completed: the file is behind
set_status 2.1 in_progress
before="$(head_id)"
out="$("$CG" commit -m "stale reopen" 2>&1)" && fail "stale reopen was snapshotted: $out"
has "$out" "completed"
has "$out" "behind the receipt"
[ "$(head_id)" = "$before" ] || fail "a refused commit moved the head"
set_status 2.1 implemented
"$CG" commit -m "back in line" >/dev/null || fail "restored status refused"

# ---- the integrator: a candidate whose spec disagrees with qualification
# The 5.7 section of candidates.ts runs as written (type-stripped) with the
# module's fail/values stood in; the candidate tree is read from directories
# in place of the imported Git objects (candidateFile in production).
src="$repo/services/hyperfide/src/integration/candidates.ts"
grep -q 'requireSpecStatusMatchesQualification(db,s,candidateFile(p.r.path,p.head),contributors.map(c=>c.task_id))' "$src" ||
    fail "candidate build does not call the spec status check"
command -v node >/dev/null || { echo "SKIP: node is not installed"; exit 77; }
{
cat <<'TS'
import {readFileSync} from 'node:fs';
type DB={query(text:string,values?:unknown[]):Promise<{rows:any[]}>};
type Scope={organisation_id:string;run_id:string};
function fail(code:string,message:string):never{const e:any=new Error(message);e.code=code;throw e;}
function values(s:Scope):string[]{return [s.organisation_id,s.run_id];}
async function git(_dir:string,_args:string[]):Promise<string>{throw new Error('git is not used here');}
TS
sed -n '/^\/\/ ---- hyperfide-v21 5.7/,$p' "$src"
cat <<'TS'
const [bad,good,none]=process.argv.slice(2);
const tree=(dir:string)=>async(file:string)=>{try{return readFileSync(dir+'/'+file,'utf8');}catch{return undefined;}};
const s={organisation_id:'o',run_id:'r'};
const seen:unknown[][]=[];
const db=(outcome:string):DB=>({query:async(_t,v)=>{seen.push(v??[]);return {rows:[{task_key:'2.1',qualification_outcome:outcome,sections:[{name:'meta',fields:{feature:{value:'syn'}}}]}]};}});
const refused=async(p:Promise<void>)=>{try{await p;return '';}catch(e:any){return e.code+' '+e.message;}};
const out:string[]=[];
out.push('bad '+await refused(requireSpecStatusMatchesQualification(db('PASS'),s,tree(bad),['t1'])));
out.push('good '+await refused(requireSpecStatusMatchesQualification(db('PASS'),s,tree(good),['t1'])));
out.push('failed-done '+await refused(requireSpecStatusMatchesQualification(db('FAIL'),s,tree(good),['t1'])));
out.push('elsewhere '+await refused(requireSpecStatusMatchesQualification(db('PASS'),s,tree(none),['t1'])));
out.push('ids '+JSON.stringify(seen[0]));
out.push('agrees '+[specStatusAgrees('done','PASS'),specStatusAgrees('in_progress','PASS'),specStatusAgrees(undefined,'PASS'),specStatusAgrees('pending','FAIL')].join(','));
console.log(out.join('\n'));
TS
} >"$TMP/sync.mts"

for t in bad good none; do mkdir -p "$TMP/cand/$t"; done
mkdir -p "$TMP/cand/bad/spec/syn" "$TMP/cand/good/spec/syn"
printf '[meta]\nfeature = "syn"\n\n[task.2.1]\ntitle = "x"\nstatus = "in_progress"\n\n[task.2.2]\nstatus = "done"\n' \
    >"$TMP/cand/bad/spec/syn/spec.kvx"
sed 's/status = "in_progress"/status = "implemented"/' "$TMP/cand/bad/spec/syn/spec.kvx" \
    >"$TMP/cand/good/spec/syn/spec.kvx"

out="$(node --no-warnings --experimental-strip-types "$TMP/sync.mts" \
    "$TMP/cand/bad" "$TMP/cand/good" "$TMP/cand/none")" ||
    fail "integrator check did not run: $out"
has "$out" "bad INTEGRATION_SPEC_STATUS_MISMATCH Candidate spec/syn/spec.kvx disagrees with qualification: 2.1: in_progress (PASS)"
printf '%s\n' "$out" | grep -qx 'good ' || fail "a matching candidate was refused: $out"
has "$out" "failed-done INTEGRATION_SPEC_STATUS_MISMATCH"
has "$out" "2.1: implemented (FAIL)"
printf '%s\n' "$out" | grep -qx 'elsewhere ' || fail "a tree without the spec was judged: $out"
has "$out" 'ids ["o","r",["t1"]]'
has "$out" "agrees true,false,false,true"

echo "ok 94_commit_spec_sync"
