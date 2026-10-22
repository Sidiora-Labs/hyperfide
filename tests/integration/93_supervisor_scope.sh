#!/usr/bin/env bash
# supervisor scope (hyperfide-v21 3.21, req 2.4): only an open approval or a
# blocking Ask of the current run exempts an attempt from the stall and
# wall-budget rules; rows an earlier run left open for the same task exempt
# nothing. An approval is decided once and follows its linked Ask, whose id
# the approval.request event carries. A superseded task is never done, even
# with --force, and spec next and spec ready name the dependant it holds.
. "$(dirname "$0")/../lib.sh"

command -v sqlite3 >/dev/null || { echo "SKIP: sqlite3 is required"; exit 77; }
pyjson() { python3 -c "import json,sys; d=json.load(sys.stdin); $1"; }
wait_for() {
    local t="$1"; shift
    local end=$(( $(date +%s) + t ))
    while ! eval "$@"; do
        [ "$(date +%s)" -lt "$end" ] || return 1
        sleep 0.2
    done
}
evk() { "$CG" events --kind "$1" --json -n 500; }
count() { evk "$1" | python3 -c "import json,sys; print(sum(1 for l in sys.stdin if l.strip() and $2))"; }

# A one-task feature. The worker either idles (idle-2.1), or claims the task,
# raises a blocking Ask in this run and idles until it is answered, then
# changes a file outside its touches so merge-up asks for a drift approval.
setup_repo() {
    rm -rf "$TMP/proj" "$TMP/go"
    mkdir -p "$TMP/proj/src" "$TMP/proj/lib" "$TMP/go"
    cd "$TMP/proj"
    git init -q -b main . 2>/dev/null || git init -q .
    git config user.email t@t; git config user.name t
    printf 'export function alpha(): number {\n  return 1;\n}\n' > src/a.ts
    printf 'export function beta(): number {\n  return 3;\n}\n' > lib/b.ts
    "$CG" spec new wt >/dev/null
    "$CG" spec docs off >/dev/null
    "$CG" spec start 1.1 >/dev/null
    "$CG" spec done 1.1 >/dev/null
    "$CG" spec mode parallel >/dev/null
    "$CG" spec add 2.1 --title "Alpha" --wave 1 --reqs 1.1 --symbols alpha --touches 'src/a.ts' >/dev/null
    "$CG" init >/dev/null
    printf '.codegraph/\n*.lock\n' > .gitignore
    cat >> spec/workflow.kvx <<EOF

[hierarchy]
test_gate = "true"
pr        = "manual"

$1

[agents]
driver = "custom"
cmd    = "sh $TMP/driver.sh \${PROMPT_FILE} \${TASK} \${ROOT} \${AGENT}"
max    = 1
ttl    = 600
EOF
    cat > "$TMP/driver.sh" <<EOF
#!/bin/sh
PF="\$1"; TASK="\$2"; ROOT="\$3"; AGENT="\$4"
cd "\$ROOT" || exit 9
if [ "\$CG_ROLE" = worker ]; then
    echo \$\$ > "$TMP/go/pid-\$TASK"
    if [ -f "$TMP/go/idle-\$TASK" ]; then sleep 120; exit 0; fi
    # raised before the claim: answered from the main tree, an Ask raised
    # on an in_progress task would leave this worktree's copy blocked
    "$CG" ask raise secret "Registry token?" --json > "$TMP/go/ask.json" 2>"$TMP/go/ask.err" || exit 1
    : > "$TMP/go/raised"
    # idle, as an agent waiting on a person does: no output, no tree change
    while "$CG" ask list --json | grep -q '"kind":"secret"'; do sleep 0.3; done
    "$CG" spec start "\$TASK" >/dev/null 2>&1
    printf 'export function alpha(): number {\n  return 7;\n}\n' > src/a.ts
    printf 'export function beta(): number {\n  return 8;\n}\n' > lib/b.ts
    "$CG" spec done "\$TASK" >/dev/null 2>&1
    git add -A >/dev/null
    git commit -qm "\$TASK [spec:\$CG_FEATURE/\$TASK]" >/dev/null || exit 1
    rc=0; "$CG" fleet merge-up "\$TASK" >/dev/null 2>"$TMP/go/gate.err" || rc=\$?
    echo \$rc > "$TMP/go/gated"
    [ "\$rc" -eq 4 ] || exit 1
    while "$CG" fleet approvals --json | grep -q '"subject":"wt/2.1","state":"pending"'; do sleep 0.3; done
    exec "$CG" fleet merge-up "\$TASK" >/dev/null
fi
left="\$("$CG" fleet tree -f "\$CG_FEATURE" --json | python3 -c 'import json,os,sys; w = os.environ.get("CG_WAVE"); m = [m for m in json.load(sys.stdin)["managers"] if w is None or m["wave"] == int(w)][0]; print(m["tasks"]["total"] - m["tasks"]["done"])')"
[ "\$left" -eq 0 ] || exit 0
exec "$CG" fleet land \${CG_WAVE:-} -f "\$CG_FEATURE" --no-pr >/dev/null 2>"$TMP/go/land.err"
EOF
    git add -A >/dev/null; git commit -qm base >/dev/null
}

# ---- negative: a stale approval and a stale blocking Ask, both open for the
#      same task but from an earlier run, do not hold an idle attempt
setup_repo '[role.main]
agent = "chief-{feature}"

[role.worker]
stall   = "1s"
retries = 0'
: > "$TMP/go/idle-2.1"
db="$(graph_db)" || fail "no graph.db"
sqlite3 "$db" "INSERT INTO fleet_approvals(run,gate,subject,state,requested,requested_by) VALUES('stale-run','drift','wt/2.1','pending',strftime('%s','now'),'w-old')" \
    || fail "seed the stale approval"
CG_RUN=stale-run CG_TASK=wt/2.1 "$CG" ask raise secret "Old token?" >/dev/null || fail "seed the stale Ask"
"$CG" ask list --json | pyjson '
a = [x for x in d["asks"] if x["title"] == "Old token?"][0]
assert a["blocking"] and a["task"] == "wt/2.1", a
' || fail "the stale Ask is not open and blocking: $("$CG" ask list --json)"
rc=0; out="$(timeout 120 "$CG" fleet up --foreground -n 1 2>&1)" || rc=$?
[ "$rc" -eq 1 ] || fail "a stalled run exits 1, got $rc: $out"
has "$out" "nudged"
has "$out" "stalled — no progress for"
[ "$(count supervisor.wait 'True')" = 0 ] || fail "a row from another run held the attempt: $(evk supervisor.wait)"

# ---- positive: this run's own blocking Ask holds the attempt past the stall
#      window and the wall budget
setup_repo '[role.worker]
stall   = "2s"
wall    = "25s"
retries = 0
approve = ["drift"]'
db="$(graph_db)" || fail "no graph.db"
sqlite3 "$db" "INSERT INTO fleet_approvals(run,gate,subject,state,requested,requested_by) VALUES('stale-run','drift','wt/9.9','pending',strftime('%s','now'),'w-old')" \
    || fail "seed an unrelated stale approval"
( timeout 150 "$CG" fleet up --foreground -n 1 > "$TMP/run.out" 2>&1; echo $? > "$TMP/run.rc" ) &
wait_for 60 '[ -f "$TMP/go/raised" ]' || fail "the worker never raised its Ask: $(cat "$TMP/run.out") $(cat "$TMP/go/ask.err" 2>/dev/null)"
ask="$(pyjson 'print(d["id"])' < "$TMP/go/ask.json")"
pid="$(cat "$TMP/go/pid-2.1")"
wait_for 15 '[ "$(count supervisor.wait "json.loads(l)[\"payload\"][\"action\"] == \"wait\"")" = 1 ]' \
    || fail "the supervisor did not hold the attempt on its own Ask: $(cat "$TMP/run.out")"
sleep 27     # past several stall windows and the whole wall budget
kill -0 "$pid" 2>/dev/null || fail "the waiting worker was killed: $(cat "$TMP/run.out")"
[ "$(count supervisor.stall 'True')" = 0 ] || fail "a waiting worker was nudged or stopped: $(evk supervisor.stall)"
[ "$(count supervisor.budget 'True')" = 0 ] || fail "a waiting worker spent its wall budget: $(evk supervisor.budget)"
"$CG" ask answer "$ask" secret-ref:registry >/dev/null || fail "answer the Ask"

# the drift gate: its approval.request carries the Ask the gate raised
wait_for 60 '[ -f "$TMP/go/gated" ]' || fail "the worker never reached the gate: $(cat "$TMP/run.out")"
[ "$(cat "$TMP/go/gated")" = 4 ] || fail "merge-up should wait for approval (4), got $(cat "$TMP/go/gated"): $(cat "$TMP/go/gate.err")"
appr="$("$CG" fleet approvals --json | pyjson '
a = [x for x in d["approvals"] if x["subject"] == "wt/2.1"][0]
assert a["ask"], a
print(a["id"], a["ask"])')" || fail "the approval has no linked Ask: $("$CG" fleet approvals --json)"
set -- $appr; id="$1"; apask="$2"
evk approval.request | python3 -c "
import json,sys
ev=[json.loads(l) for l in sys.stdin if l.strip()]
p=[e['payload'] for e in ev if e['payload']['id']==$id]
assert p and p[0]['ask_id']==$apask, ev
" || fail "approval.request does not carry ask id $apask: $(evk approval.request)"
# answering the Ask decides the approval; the Ask is the single truth
"$CG" ask answer "$apask" approve >/dev/null || fail "answer the gate's Ask"
"$CG" fleet approvals --all --json | pyjson "
a = [x for x in d['approvals'] if x['id'] == $id][0]
assert a['state'] in ('approved', 'used'), a
" || fail "the Ask's answer did not decide the approval"
rc=0; err="$("$CG" fleet approve "$id" --reject 2>&1)" || rc=$?
[ "$rc" -eq 1 ] || fail "a second decide was accepted: $err"
has "$err" "decided once"
rc=0; err="$("$CG" fleet approve "$id" 2>&1)" || rc=$?
[ "$rc" -eq 1 ] || fail "a repeated approve was accepted: $err"
"$CG" ask list --all --json | pyjson "
a = [x for x in d['asks'] if x['id'] == $apask][0]
assert a['answer'] == 'approve', a
" || fail "a second decide rewrote the Ask"
[ "$(evk approval.decided | grep -c "\"id\":$id,")" = 1 ] || fail "the approval was decided twice: $(evk approval.decided)"
wait_for 90 '[ -f "$TMP/run.rc" ]' || fail "the run did not finish after the answers: $(cat "$TMP/run.out") $(evk supervisor.wait) $(evk supervisor.budget) $("$CG" fleet approvals --all --json)"
out="$(cat "$TMP/run.out")"
[ "$(cat "$TMP/run.rc")" = 0 ] || fail "the run should complete, rc $(cat "$TMP/run.rc"): $out"
has "$out" "[fleet] wt complete"

# ---- superseded: terminal under --force, and a dependant names its cause
rm -rf "$TMP/sp"; mkdir -p "$TMP/sp"; cd "$TMP/sp"
git init -q -b main . 2>/dev/null || git init -q .
git config user.email t@t; git config user.name t
"$CG" init >/dev/null 2>&1
"$CG" spec new sp >/dev/null
"$CG" spec docs off >/dev/null
"$CG" spec start 1.1 >/dev/null
"$CG" spec done 1.1 >/dev/null
"$CG" spec add 2.1 --title "Old" --wave 1 --reqs 1.1 >/dev/null
"$CG" spec add 2.2 --title "New" --wave 1 --reqs 1.1 >/dev/null
"$CG" spec add 2.3 --title "Uses old" --wave 2 --reqs 1.1 --requires 2.1 >/dev/null 2>&1 || \
    "$CG" spec add 2.3 --title "Uses old" --wave 2 --reqs 1.1 >/dev/null
python3 - spec/sp/spec.kvx <<'EOF'
import re, sys
p = sys.argv[1]
s = open(p).read()
def edit(s, tid, fn):
    head, sep, rest = s.partition('[task.%s]\n' % tid)
    body, nxt, tail = rest.partition('\n[')
    return head + sep + fn(body) + nxt + tail
s = edit(s, '2.1', lambda b: re.sub(r'^status = "[^"]*"$', 'status = "superseded"', b, flags=re.M)
         + '\nsuperseded_by = "2.2"\nsuperseded_reason = "2.2 carries this work"')
s = edit(s, '2.3', lambda b: re.sub(r'^requires = .*$', '', b, flags=re.M) + '\nrequires = ["2.1"]')
open(p, 'w').write(s)
EOF
grep -q '^status = "superseded"' <(sed -n '/^\[task.2.1\]/,/^\[/p' spec/sp/spec.kvx) || fail "fixture: 2.1 not superseded"
rc=0; err="$("$CG" spec done 2.1 --force 2>&1)" || rc=$?
[ "$rc" -eq 1 ] || fail "--force closed a superseded task: $err"
has "$err" "superseded"
has "$err" "--force included"
grep -q '^status = "superseded"' <(sed -n '/^\[task.2.1\]/,/^\[/p' spec/sp/spec.kvx) || fail "--force changed a superseded status"
out="$("$CG" spec next)"
has "$out" "held: 2.3 requires 2.1, which is superseded by 2.2"
"$CG" spec next --json | pyjson '
h = d["held_by_superseded"]
assert h == [{"id": "2.3", "requires": "2.1", "superseded_by": "2.2"}], h
' || fail "spec next --json does not name the hold: $("$CG" spec next --json)"
out="$("$CG" spec ready)"
has "$out" "held: 2.3 requires 2.1, which is superseded by 2.2"
hasnt "$out" "  2.3 "
"$CG" spec ready --json | pyjson '
assert [t["id"] for t in d["tasks"]] == ["2.2"], d["tasks"]
assert d["held_by_superseded"][0]["id"] == "2.3", d
' || fail "spec ready --json: $("$CG" spec ready --json)"
# negative: requiring the successor clears the hold
python3 - spec/sp/spec.kvx <<'EOF'
import sys
p = sys.argv[1]
s = open(p).read().replace('requires = ["2.1"]', 'requires = ["2.2"]')
open(p, 'w').write(s)
EOF
hasnt "$("$CG" spec next)" "held:"
"$CG" spec ready --json | pyjson 'assert d["held_by_superseded"] == [], d' || fail "a hold outlived the fix"

echo "supervisor scope OK"
