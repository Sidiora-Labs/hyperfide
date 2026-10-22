#!/usr/bin/env bash
# supervisor waits (hyperfide-v21 2.5, req 2.4): a worker that waits on a
# person with an open fleet approval is neither nudged nor stopped by the
# stall or wall-budget rules, and resumes once the approval is answered; a
# worker that idles without one is nudged and stopped, and its escalation
# reaches the main agent the workflow configures, not a fixed name.
# Until hyperfide-v21 3.4 lands, "waits on a person" means a pending
# fleet approval; 3.4 extends this to an open Ask.
. "$(dirname "$0")/../lib.sh"

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

# A one-task feature whose worker, in "ask" mode, makes a change outside its
# touches, so its merge-up raises a drift approval (approve = ["drift"]);
# it then stays alive and idle until a person answers, and merges up again.
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
    "$CG" spec start "\$TASK" >/dev/null 2>&1
    printf 'export function alpha(): number {\n  return 7;\n}\n' > src/a.ts
    printf 'export function beta(): number {\n  return 8;\n}\n' > lib/b.ts
    "$CG" spec done "\$TASK" >/dev/null 2>&1
    git add -A >/dev/null
    git commit -qm "\$TASK [spec:\$CG_FEATURE/\$TASK]" >/dev/null || exit 1
    rc=0; "$CG" fleet merge-up "\$TASK" >/dev/null 2>"$TMP/go/ask.err" || rc=\$?
    echo \$rc > "$TMP/go/asked"
    [ "\$rc" -eq 4 ] || exit 1
    # idle, as an agent waiting on a person does: no output, no tree change
    while "$CG" fleet approvals --json | grep -q '"state":"pending"'; do sleep 0.3; done
    : > "$TMP/go/answered"
    exec "$CG" fleet merge-up "\$TASK" >/dev/null
fi
left="\$("$CG" fleet tree -f "\$CG_FEATURE" --json | python3 -c 'import json,os,sys; w = os.environ.get("CG_WAVE"); m = [m for m in json.load(sys.stdin)["managers"] if w is None or m["wave"] == int(w)][0]; print(m["tasks"]["total"] - m["tasks"]["done"])')"
[ "\$left" -eq 0 ] || exit 0
exec "$CG" fleet land \${CG_WAVE:-} -f "\$CG_FEATURE" --no-pr >/dev/null 2>"$TMP/go/land.err"
EOF
    git add -A >/dev/null; git commit -qm base >/dev/null
}

# ---- positive: an open approval holds the attempt past the stall window
#      and the wall budget; answered, the worker resumes and the run ends
setup_repo '[role.worker]
stall   = "3s"
wall    = "20s"
retries = 0
approve = ["drift"]'
( timeout 120 "$CG" fleet up --foreground -n 1 > "$TMP/run.out" 2>&1; echo $? > "$TMP/run.rc" ) &
wait_for 60 '[ -f "$TMP/go/asked" ]' || fail "the worker never asked: $(cat "$TMP/run.out")"
[ "$(cat "$TMP/go/asked")" = 4 ] || fail "merge-up should wait for approval (4), got $(cat "$TMP/go/asked"): $(cat "$TMP/go/ask.err")"
pid="$(cat "$TMP/go/pid-2.1")"
wait_for 10 '[ "$(count supervisor.wait "json.loads(l)[\"payload\"][\"action\"] == \"wait\"")" = 1 ]' \
    || fail "the supervisor did not record the wait"
# well past two stall windows and the whole wall budget
sleep 24
kill -0 "$pid" 2>/dev/null || fail "the waiting worker was killed"
[ ! -f "$TMP/run.rc" ] || fail "the run ended while the worker waited: $(cat "$TMP/run.out")"
[ "$(count supervisor.stall 'True')" = 0 ] || fail "a waiting worker was nudged or stopped: $(evk supervisor.stall)"
[ "$(count supervisor.budget 'True')" = 0 ] || fail "a waiting worker spent its wall budget: $(evk supervisor.budget)"
[ ! -f "$TMP/go/answered" ] || fail "the worker went on before the answer"
id="$("$CG" fleet approvals --json | pyjson 'print(d["approvals"][0]["id"])')"
"$CG" fleet approve "$id" >/dev/null || fail "approve"
wait_for 90 '[ -f "$TMP/run.rc" ]' || fail "the run did not finish after the answer: $(cat "$TMP/run.out")"
out="$(cat "$TMP/run.out")"
[ "$(cat "$TMP/run.rc")" = 0 ] || fail "the run should complete, rc $(cat "$TMP/run.rc"): $out"
has "$out" "[fleet] wt complete — 2/2 task(s) qualified"
[ -f "$TMP/go/answered" ] || fail "the worker did not resume"
[ "$(count supervisor.wait 'json.loads(l)["payload"]["action"] == "resume"')" = 1 ] || fail "no resume recorded"
[ "$(count supervisor.stall 'True')" = 0 ] || fail "nudged or stopped after the answer: $(evk supervisor.stall)"
[ "$(count supervisor.budget 'True')" = 0 ] || fail "the wait counted against the wall budget: $(evk supervisor.budget)"
"$CG" fleet approvals --all --json | pyjson '
a = d["approvals"][0]
assert a["gate"] == "drift" and a["subject"] == "wt/2.1" and a["state"] == "used", a
' || fail "the approval was not consumed by the resumed merge-up"

# ---- negative: idle with nothing open is a stall — nudged, stopped, and
#      escalated past the manager to the configured main agent
setup_repo '[role.main]
agent = "chief-{feature}"

[role.worker]
stall   = "1s"
retries = 0
approve = ["drift"]'
: > "$TMP/go/idle-2.1"
rc=0; out="$(timeout 120 "$CG" fleet up --foreground -n 1 2>&1)" || rc=$?
[ "$rc" -eq 1 ] || fail "a blocked run exits 1, got $rc: $out"
has "$out" "nudged"
has "$out" "stalled — no progress for"
has "$out" "2.1 blocked — escalated to main (chief-wt)"
[ "$(count supervisor.wait 'True')" = 0 ] || fail "nothing was open, yet the worker was held"
[ "$(count supervisor.blocked 'json.loads(l)["payload"]["agent"] == "chief-wt"')" = 1 ] || fail "escalation to the configured main: $(evk supervisor.blocked)"
steer="$(evk agent.steer)"
has "$steer" '"subject":"chief-wt"'
hasnt "$steer" '"subject":"gideon"'

echo "supervisor wait OK"
