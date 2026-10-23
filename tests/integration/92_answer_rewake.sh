#!/usr/bin/env bash
# answers reach the agent (hyperfide-v21 task 4.4): a -p worker that raises
# a blocking Ask and exits with no edits since is parked on its lease, and
# answering the Ask re-wakes it on the same attempt with the answer in its
# prompt; a worker that edited after raising is not re-woken; an interrupt
# gives a parked lease back
. "$(dirname "$0")/../lib.sh"

pyev() { python3 -c "import json,sys; ev=[json.loads(l) for l in sys.stdin if l.strip()]; $1"; }

# wait_for <file> <text> [seconds]: the background run printed text
wait_for() {
    local i
    for i in $(seq 1 $(( ${3:-60} * 10 ))); do
        grep -qF "$2" "$1" 2>/dev/null && return 0
        sleep 0.1
    done
    cat "$1" >&2 || true
    fail "timed out waiting for: $2"
}

ask_id() {
    "$CG" ask list --all --task "drv/$1" --json | python3 -c '
import json,sys
a=json.load(sys.stdin)["asks"]
assert len(a)==1, a
print(a[0]["id"])'
}

STUB="$TMP/stub"
mkdir -p "$STUB"
cat > "$STUB/agent.sh" <<'EOF'
#!/bin/sh
# a scripted -p agent speaking Claude stream-json; 2.x and 3.x raise a
# blocking Ask on their first wake, 2.2 then edits anyway
PF="$1"; TASK="$2"; ROOT="$3"; AGENT="$4"
[ -s "$PF" ] || exit 9
cd "$ROOT" || exit 9
j() { printf '%s\n' "$1"; }
n=$(ls "$STUB_DIR" | grep -c "^wake-$TASK-" || true)
n=$((n + 1))
printf '%s\n' "$CG_ATTEMPT $CG_FENCE" > "$STUB_DIR/wake-$TASK-$n"
cp "$PF" "$STUB_DIR/prompt-$TASK-$n"
j '{"type":"system","subtype":"init","session_id":"sess-'"$AGENT-$n"'","model":"m-test","tools":["Bash","Edit"]}'
finish() {
    : > "out-$TASK.txt"
    j '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"e1","name":"Edit","input":{"file_path":"out-'"$TASK"'.txt","old_string":"","new_string":"x"}}]}}'
    "$CG" spec done "$TASK" >/dev/null 2>&1 || exit 7
    j '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.001,"num_turns":1,"duration_ms":5,"session_id":"sess-'"$AGENT"'","result":"done","usage":{"input_tokens":10,"output_tokens":5}}'
    exit 0
}
case "$TASK" in 2.*|3.*) ;; *) finish ;; esac
grep -q '^## Answers to your Asks' "$PF" && finish
j '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"r1","name":"Bash","input":{"command":"hyperfide ask raise variable \"Which endpoint for '"$TASK"'?\""}}]}}'
"$CG" ask raise variable "Which endpoint for $TASK?" >/dev/null || exit 8
if [ "$TASK" = 2.2 ]; then
    : > "scratch-$TASK.txt"
    j '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"e2","name":"Write","input":{"file_path":"scratch-'"$TASK"'.txt","content":""}}]}}'
fi
j '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.001,"num_turns":1,"duration_ms":5,"session_id":"sess-'"$AGENT"'","result":"blocked on an Ask","usage":{"input_tokens":10,"output_tokens":5}}'
exit 0
EOF
chmod +x "$STUB/agent.sh"

mkdir -p "$TMP/drv"
cd "$TMP/drv"
git init -q -b main . 2>/dev/null || git init -q .
git config user.email t@t; git config user.name t
"$CG" spec new drv >/dev/null
"$CG" spec docs off >/dev/null
"$CG" spec mode parallel >/dev/null
for t in 2.1 2.2; do
    "$CG" spec add $t --title "Task $t" --wave 1 --touches "out-$t.txt" \
          --verify "test -f out-$t.txt" >/dev/null
done
"$CG" init >/dev/null
cat >> spec/workflow.kvx <<EOF

[agents]
driver = "custom"
cmd    = "CG=$CG STUB_DIR=$STUB $STUB/agent.sh \${PROMPT_FILE} \${TASK} \${ROOT} \${AGENT}"
max    = 2
ttl    = 120
EOF

# ---- the run parks 2.1, refuses to re-wake 2.2, and waits for the answer
h="$("$CG" events --head)"
"$CG" spec run -n 2 > "$TMP/run.out" 2>&1 &
run=$!
wait_for "$TMP/run.out" "task 2.1 blocked on an Ask with no edits since — parked until it is answered"
wait_for "$TMP/run.out" "task 2.2 blocked after its edit(s) — not re-woken, lease released"
sleep 0.5
kill -0 "$run" 2>/dev/null || { cat "$TMP/run.out" >&2; fail "the run must wait for the parked task"; }
[ ! -e "$STUB/wake-2.1-2" ] || fail "2.1 re-woken before its answer"
st="$("$CG" spec status 2.1 --json 2>/dev/null || true)"
has "$st" '"blocked"'

a1="$(ask_id 2.1)"
a2="$(ask_id 2.2)"
"$CG" ask answer "$a1" "https://api.example.test/v2" >/dev/null
"$CG" ask answer "$a2" "https://api.example.test/v3" >/dev/null
wait "$run" || true
out="$(cat "$TMP/run.out")"
has "$out" "[run] task 2.1 exit 0 → status blocked"
has "$out" "task 2.1 answered → re-woken (agent"
has "$out" "[run] task 2.1 exit 0 → status done"
has "$out" "[run] task 2.2 exit 0 → status blocked"
hasnt "$out" "task 2.2 answered → re-woken"
[ ! -e "$STUB/wake-2.2-2" ] || fail "2.2 edited while blocked and must not be re-woken"

# the second wake is the same fenced attempt, its prompt carries the answer
[ "$(cat "$STUB/wake-2.1-1")" = "$(cat "$STUB/wake-2.1-2")" ] \
    || fail "re-wake changed the attempt: $(cat "$STUB/wake-2.1-1") vs $(cat "$STUB/wake-2.1-2")"
p1="$(cat "$STUB/prompt-2.1-1")"
p2="$(cat "$STUB/prompt-2.1-2")"
hasnt "$p1" "## Answers to your Asks"
has "$p2" "## Answers to your Asks"
has "$p2" "- Ask $a1 (variable): Which endpoint for 2.1?"
has "$p2" "Answer: https://api.example.test/v2"
hasnt "$p2" "https://api.example.test/v3"
# both wakes in one log, the first not truncated by the second
[ "$(grep -c '"subtype":"init"' .codegraph/agents/drv-2.1.log)" -eq 2 ] \
    || fail "the re-woken agent must append to its log"

out="$("$CG" events --since "$h" --json -n 1000)"
echo "$out" | A1="$a1" pyev '
import os
a1 = int(os.environ["A1"])
k = lambda kind, subj: [e for e in ev if e["kind"] == kind and e["subject"] == subj]
park = k("orch.park", "drv/2.1")
assert [e["payload"]["outcome"] for e in park] == ["parked"], park
park2 = k("orch.park", "drv/2.2")
assert [e["payload"]["outcome"] for e in park2] == ["edited-while-blocked"], park2
assert len(k("orch.rewake", "drv/2.1")) == 1 and not k("orch.rewake", "drv/2.2"), ev
d = [e for e in ev if e["kind"] == "agent.answer.delivered"]
assert len(d) == 1 and d[0]["payload"]["asks"] == [a1] and d[0]["payload"]["via"] == "prompt", d
spawns = k("orch.spawn", "drv/2.1")
assert len(spawns) == 1, spawns   # the re-wake is not a new claim
' || fail "park, re-wake and delivery events"

# ---- an interrupt gives a parked lease back
"$CG" spec add 3.1 --title "Task 3.1" --wave 2 --touches "out-3.1.txt" \
      --verify "test -f out-3.1.txt" >/dev/null
"$CG" spec run -n 1 > "$TMP/run2.out" 2>&1 &
run=$!
wait_for "$TMP/run2.out" "task 3.1 blocked on an Ask with no edits since — parked"
kill -INT "$run"
rc=0; wait "$run" || rc=$?
[ "$rc" -eq 130 ] || { cat "$TMP/run2.out" >&2; fail "interrupted run rc $rc"; }
has "$(cat "$TMP/run2.out")" "leases released"
leases="$("$CG" spec status --json 2>/dev/null || true)"
hasnt "$leases" '"agent":"run-1","task":"3.1"'

echo "92_answer_rewake OK"
