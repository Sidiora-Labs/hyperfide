#!/usr/bin/env bash
# superseded: a terminal task status. The task is closed without qualifying
# (its work belongs to superseded_by), so lint accepts it only with a reason
# and refuses a dependant on it; status and progress count it as closed but
# never done; next, ready and start never hand it out; render marks it.
. "$(dirname "$0")/../lib.sh"
repo="$(cd "$(dirname "$0")/../.." && pwd)"

cp -r "$FIXTURES/sample" "$TMP/proj"
cd "$TMP/proj"
"$CG" init >/dev/null
"$CG" spec new sup >/dev/null
"$CG" spec add 1.2 --title "Old approach" --wave 1 --reqs 1.1 >/dev/null
"$CG" spec add 2.1 --title "After" --wave 2 --requires 1.2 --reqs 1.1 >/dev/null
kvx="spec/sup/spec.kvx"

# set_key <task> <key> <value>: replace or append one key of a task section
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

# ---- lint: an unknown status is still an error; superseded needs a reason
set_key 1.2 status bogus
out="$("$CG" spec lint 2>&1)" && fail "lint accepted an unknown status: $out"
has "$out" 'unknown status "bogus"'

set_key 1.2 status superseded
out="$("$CG" spec lint 2>&1)" && fail "lint accepted superseded without a reason: $out"
hasnt "$out" "unknown status"
has "$out" "superseded without a superseded_reason"

set_key 1.2 superseded_by "2.1"
set_key 1.2 superseded_reason "Folded into 2.1."
out="$("$CG" spec lint 2>&1)" && fail "lint accepted a dependant of a superseded task: $out"
has "$out" "requires superseded task 1.2"
drop_key 2.1 requires
out="$("$CG" spec lint 2>&1)" || fail "lint rejected a valid superseded task: $out"
hasnt "$out" "error"

# ---- status counts it closed, not done and not pending
st="$("$CG" spec status --json)"
has "$st" '"tasks":3,"done":0,"implemented":0,"in_progress":0,"pending":2,"superseded":1'
out="$("$CG" spec status)"
has "$out" "tasks: 3 — 0 done, 0 implemented, 0 in progress, 2 pending, 1 superseded"

# ---- next, ready and wave skip it; start and claim refuse it
has "$("$CG" spec next --json)" '"id":"1.1"'
ready="$("$CG" spec ready)"
has "$ready" "1.1"
has "$ready" "2.1"
hasnt "$ready" "1.2"
hasnt "$("$CG" spec wave)" "1.2"
out="$("$CG" spec start 1.2 2>&1)" && fail "started a superseded task: $out"
has "$out" "superseded"
out="$("$CG" spec start 1.2 --force 2>&1)" && fail "--force started a superseded task: $out"
out="$("$CG" spec claim 1.2 --agent a 2>&1)" && fail "claimed a superseded task: $out"
has "$out" "not claimable"
grep -q '^status = "superseded"' <(sed -n '/^\[task\.1\.2\]/,/^\[/p' "$kvx") \
    || fail "a refused start rewrote the superseded status"

# ---- the rest of the feature closes it: progress measures the owned work
"$CG" spec start 1.1 >/dev/null
"$CG" spec done 1.1 >/dev/null
has "$("$CG" spec next --json)" '"id":"2.1"'
"$CG" spec start 2.1 >/dev/null
out="$("$CG" spec done 2.1 2>&1)"
hasnt "$out" "none eligible yet"
out="$("$CG" spec status)"
has "$out" "2 done"
has "$out" "1 superseded"
has "$out" "] 100%"
has "$("$CG" spec status --json)" '"done":2'
# docs closure is not held by a superseded task
hasnt "$("$CG" spec status --json)" '"status":"waiting"'

# ---- render marks it in the markdown mirror
"$CG" spec render >/dev/null
md="$(cat spec/sup/tasks.md)"
has "$md" "[~] 1.2 Old approach — **Superseded by 2.1, not qualified**"
has "$md" "[x] 1.1"

# ---- the real workflow lists it, and codify-v11 7.2 is closed by it
python3 - "$repo/spec/workflow.kvx" <<'PY' || fail "status_values.task lacks superseded"
import re, sys
src = open(sys.argv[1]).read()
sec = src.split("[status_values]", 1)[1].split("\n[", 1)[0]
m = re.search(r'^task\s*=\s*\[(.*)\]', sec, re.M)
assert m and '"superseded"' in m.group(1), sec
PY
sed -n '/^\[task\.7\.2\]/,/^\[/p' "$repo/spec/codify-v11/spec.kvx" | grep -q '^status *= *"superseded"' \
    || fail "codify-v11 7.2 is not superseded"
(cd "$repo" && "$CG" spec lint -f codify-v11 >/dev/null 2>&1) \
    || fail "codify-v11 does not lint with 7.2 superseded"
has "$(cd "$repo" && "$CG" spec status -f codify-v11 --json)" '"superseded":1'

echo "85_superseded_status ok"
