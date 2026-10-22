#!/usr/bin/env bash
# blocked: the waiting state (hyperfide-v21 3.3, req 3 ac_2, D4). A blocking
# Ask raised by an in_progress task blocks it with blocked_ask naming the
# Ask; a proceed-and-flag Ask does not. A blocked task is not next, not
# ready, not startable, and its dependants are not eligible; reconcile
# --repair (the stop path for stale declarations) leaves it alone; an
# expired blocking Ask still holds it; answering moves it to its next
# waiting Ask or back to in_progress. Lint requires blocked_ask on a blocked
# task and only there; render and status mark it with words distinct from
# the documentation stage's "blocked".
. "$(dirname "$0")/../lib.sh"
repo="$(cd "$(dirname "$0")/../.." && pwd)"

pyjson() { python3 -c "import json,sys; d=json.load(sys.stdin); $1"; }
raise_id() { "$CG" ask raise "$@" --json | pyjson 'print(d["id"])'; }

cp -r "$FIXTURES/sample" "$TMP/proj"
cd "$TMP/proj"
"$CG" init >/dev/null 2>&1
"$CG" spec new blk >/dev/null
"$CG" spec add 1.2 --title "Needs a port" --wave 1 --reqs 1.1 >/dev/null
"$CG" spec add 2.1 --title "Dependant" --wave 2 --requires 1.2 --reqs 1.1 >/dev/null
kvx="spec/blk/spec.kvx"

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
set_key() {
    python3 - "$kvx" "$1" "$2" "$3" <<'PY'
import re, sys
path, task, key, val = sys.argv[1:]
lines = open(path).read().split("\n")
start = lines.index("[task.%s]" % task)
end = next((i for i in range(start + 1, len(lines)) if lines[i].startswith("[")), len(lines))
line = '%s = "%s"' % (key, val)
for i in range(start + 1, end):
    if re.match(r"%s\s*=" % re.escape(key), lines[i]):
        lines[i] = line
        break
else:
    j = end
    while j > start + 1 and not lines[j - 1].strip():
        j -= 1
    lines.insert(j, line)
open(path, "w").write("\n".join(lines))
PY
}
drop_key() { sed -i "/^\[task\.$1\]/,/^\[/{/^$2[[:space:]]*=/d}" "$kvx"; }

# ---- lint: blocked is a declared status that must name its Ask
set_key 1.2 status blocked
out="$("$CG" spec lint 2>&1)" && fail "lint accepted blocked without an Ask: $out"
hasnt "$out" "unknown status"
has "$out" "blocked without a blocked_ask"
set_key 1.2 blocked_ask "port"
out="$("$CG" spec lint 2>&1)" && fail "lint accepted a non-id blocked_ask: $out"
has "$out" 'blocked_ask "port" is not an Ask id'
set_key 1.2 blocked_ask "99"
out="$("$CG" spec lint 2>&1)" && fail "lint accepted a missing Ask: $out"
has "$out" "blocked on Ask #99, which does not exist"
set_key 1.2 status pending
out="$("$CG" spec lint 2>&1)" && fail "lint accepted blocked_ask on a pending task: $out"
has "$out" "only a blocked task waits on an Ask"
drop_key 1.2 blocked_ask
"$CG" spec lint >/dev/null 2>&1 || fail "lint rejected the reset spec"

# ---- an Ask from a task that is not in_progress changes nothing
early=$(raise_id variable "Port before start" --task 1.2)
[ "$(key 1.2 status)" = "pending" ] || fail "a pending task was blocked"
"$CG" ask answer "$early" 8080 >/dev/null

# ---- a blocking Ask from an in_progress task blocks it, with its reference
"$CG" spec start 1.1 >/dev/null
"$CG" spec done 1.1 >/dev/null
"$CG" spec start 1.2 >/dev/null
[ "$(key 1.2 status)" = "in_progress" ] || fail "1.2 did not start"
flag=$(raise_id decision "Log level?" --option info --option debug --recommend info --deadline 1h --task 1.2)
[ "$(key 1.2 status)" = "in_progress" ] || fail "a proceed-and-flag Ask blocked the task"
port=$(raise_id variable "Which port?" --option 80 --option 443 --recommend 443 --task blk/1.2)
[ "$(key 1.2 status)" = "blocked" ] || fail "a blocking Ask did not block the task"
[ "$(key 1.2 blocked_ask)" = "$port" ] || fail "blocked_ask is not the raising Ask"
"$CG" spec lint >/dev/null 2>&1 || fail "lint rejected a blocked task waiting on an open Ask"
# a second blocking Ask while blocked keeps the first reference
perm=$(raise_id permission "Open the firewall" --task 1.2 --deadline @1000)
[ "$(key 1.2 blocked_ask)" = "$port" ] || fail "a second Ask replaced the first reference"
"$CG" ask expire >/dev/null

# ---- status, next, ready, start: waiting, not eligible, not startable
st="$("$CG" spec status --json)"
has "$st" '"in_progress":0,"pending":1,"superseded":0,"blocked":1'
has "$st" "\"waiting\":[{\"id\":\"1.2\",\"ask\":\"$port\"}]"
out="$("$CG" spec status)"
has "$out" "1 blocked on asks"
has "$out" "waiting: 1.2 on Ask #$port"
hasnt "$out" "documentation: blocked"
hasnt "$out" "documentation blocked"
nx="$("$CG" spec next --json)"
has "$nx" '"next":null'
has "$nx" "\"waiting\":[{\"id\":\"1.2\",\"ask\":\"$port\"}]"
has "$("$CG" spec next)" "waiting: 1.2 on Ask #$port"
ready="$("$CG" spec ready)"
hasnt "$ready" "1.2"
hasnt "$ready" "2.1"
out="$("$CG" spec start 2.1 2>&1)" && fail "started a dependant of a blocked task: $out"
out="$("$CG" spec start 1.2 2>&1)" && fail "started a blocked task: $out"
has "$out" "blocked on Ask #$port"
[ "$(key 1.2 status)" = "blocked" ] || fail "a refused start rewrote blocked"

# ---- stop preserves it: reconcile --repair resets stale work, never a wait
"$CG" spec mode parallel >/dev/null
rc="$("$CG" spec reconcile --repair --json)"
has "$rc" '"stale":[]'
[ "$(key 1.2 status)" = "blocked" ] && [ "$(key 1.2 blocked_ask)" = "$port" ] ||
    fail "reconcile --repair did not preserve the blocked task"
"$CG" spec mode standard >/dev/null

# ---- render marks it, distinct from the documentation stage
"$CG" spec render >/dev/null
has "$(cat spec/blk/tasks.md)" "[?] 1.2 Needs a port — **Waiting on Ask #$port**"

# ---- answering moves to the next waiting Ask (the expired one still holds)
"$CG" ask answer "$port" 443 >/dev/null
[ "$(key 1.2 status)" = "blocked" ] || fail "answer released a task with another waiting Ask"
[ "$(key 1.2 blocked_ask)" = "$perm" ] || fail "blocked_ask did not move to the expired blocking Ask"
"$CG" spec lint >/dev/null 2>&1 || fail "lint rejected a wait on an expired blocking Ask"
# answering an Ask the task does not name changes nothing
"$CG" ask answer "$flag" debug >/dev/null
[ "$(key 1.2 blocked_ask)" = "$perm" ] || fail "an unrelated answer moved the reference"
# ... then the last answer returns it to in_progress
"$CG" ask answer "$perm" approve >/dev/null
[ "$(key 1.2 status)" = "in_progress" ] || fail "the last answer did not return the task to in_progress"
[ "$(key 1.2 blocked_ask)" = "" ] || fail "blocked_ask outlived the wait"
"$CG" spec lint >/dev/null 2>&1 || fail "lint rejected the resumed task"
has "$("$CG" spec status --json)" '"in_progress":1,"pending":1,"superseded":0,"blocked":0'
# a stale reference to an answered Ask is a lint error
set_key 1.2 status blocked
set_key 1.2 blocked_ask "$port"
out="$("$CG" spec lint 2>&1)" && fail "lint accepted a wait on an answered Ask: $out"
has "$out" "blocked on Ask #$port, which is answered"
set_key 1.2 status in_progress
set_key 1.2 blocked_ask ""
"$CG" spec done 1.2 >/dev/null
has "$("$CG" spec next --json)" '"id":"2.1"'

# ---- the real workflow declares it, and the real feature lints
python3 - "$repo/spec/workflow.kvx" <<'PY' || fail "status_values.task lacks blocked"
import re, sys
src = open(sys.argv[1]).read()
sec = src.split("[status_values]", 1)[1].split("\n[", 1)[0]
m = re.search(r'^task\s*=\s*\[(.*)\]', sec, re.M)
assert m and '"blocked"' in m.group(1), sec
PY

echo "86_blocked_status ok"
