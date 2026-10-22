#!/usr/bin/env bash
# Ask tools over MCP (hyperfide-v21 3.5, req 3.3): ask_raise, ask_status,
# ask_list and approvals_list called through the `hyperfide mcp` stdio
# transport against the one asks store of task 3.4; refusals arrive as
# isError with the reason; no tool answers an Ask; and the workflow's
# instruction rule for when to raise each kind reaches the pointer file's
# loop through `spec render`.
. "$(dirname "$0")/../lib.sh"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

cp -r "$FIXTURES/sample" "$TMP/proj"
cd "$TMP/proj"
git init -q . 2>/dev/null
git config user.email t@t; git config user.name t
"$CG" init >/dev/null 2>&1
"$CG" spec new demo >/dev/null
"$CG" spec add 2.1 --title "Alpha" --wave 1 --reqs 1.1 >/dev/null
cat >> spec/workflow.kvx <<'EOF'

[hierarchy]
enabled = true

[role.main]
approve = ["pr"]
EOF
git add -A >/dev/null
git commit -qm init
git branch wave/demo/1

# one MCP session: initialize, then each line a tools/call; prints the
# responses one per line
mcp() {
    { printf '%s\n' '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}'
      printf '%s\n' "$@"; } | "$CG" mcp
}
call() {   # call <id> <tool> <arguments-json>
    printf '{"jsonrpc":"2.0","id":%s,"method":"tools/call","params":{"name":"%s","arguments":%s}}' "$1" "$2" "$3"
}

# ---- the four tools are listed with schemas and the right hints; there is
#      no answering tool
mcp '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' > "$TMP/list.out"
python3 - "$TMP/list.out" <<'PY' || fail "tools/list"
import json, sys
msgs = {m["id"]: m for m in map(json.loads, open(sys.argv[1])) if "id" in m}
tools = {t["name"]: t for t in msgs[1]["result"]["tools"]}
for name in ("ask_raise", "ask_status", "ask_list", "approvals_list"):
    assert name in tools, f"missing {name}"
    assert tools[name]["description"] and "inputSchema" in tools[name], name
assert tools["ask_raise"]["inputSchema"]["required"] == ["kind", "title"]
assert tools["ask_raise"]["inputSchema"]["properties"]["kind"]["enum"] == [
    "secret", "variable", "permission", "decision", "question"]
assert tools["ask_raise"]["annotations"]["readOnlyHint"] is False
for name in ("ask_status", "ask_list", "approvals_list"):
    assert tools[name]["annotations"]["readOnlyHint"] is True, name
assert not [n for n in tools if n.startswith("ask_answer")], "an agent must not answer Asks"
PY

# ---- raise each kind through MCP, then read them back with every tool
mcp \
  "$(call 2 ask_raise '{"kind":"secret","title":"Railway token for the live case","deadline":"1h","chain":["operator","owner"],"task":"demo/2.1","attempt":"att-1","session":"s-1","sandbox":"sb-1"}')" \
  "$(call 3 ask_raise '{"kind":"variable","title":"HF_SLICE_SOURCE_CONFIG path","task":"demo/2.1"}')" \
  "$(call 4 ask_raise '{"kind":"permission","title":"Delete the orphan sandbox","task":"demo/2.1"}')" \
  "$(call 5 ask_raise '{"kind":"decision","title":"Which object store?","options":["s3","r2"],"recommend":"r2","deadline":3600,"body":"both work","task":"demo/2.1"}')" \
  "$(call 6 ask_raise '{"kind":"question","title":"Keep the old route?","options":["yes","no"],"recommend":"yes","deadline":"@1000"}')" \
  "$(call 7 ask_raise '{"kind":"opinion","title":"What colour?"}')" \
  "$(call 8 ask_raise '{"kind":"decision","title":"Which store?","options":["a","b"]}')" \
  "$(call 9 ask_raise '{"kind":"decision","title":"Which store?","options":["a","b"],"recommend":"c"}')" \
  "$(call 10 ask_raise '{"kind":"question","title":"Proceed?","recommend":"yes","deadline":"soon"}')" \
  "$(call 11 ask_raise '{"title":"no kind"}')" \
  "$(call 12 ask_list '{}')" \
  "$(call 13 ask_list '{"task":"demo/2.1"}')" \
  "$(call 14 ask_status '{"id":1}')" \
  "$(call 15 ask_status '{"task":"demo/2.1"}')" \
  "$(call 16 ask_status '{"id":999}')" \
  "$(call 17 approvals_list '{}')" \
  > "$TMP/raise.out"

python3 - "$TMP/raise.out" <<'PY' || fail "raise and read over MCP"
import json, sys
msgs = {m["id"]: m for m in map(json.loads, open(sys.argv[1])) if "id" in m}
def ok(i):
    r = msgs[i]["result"]
    assert r["isError"] is False, (i, r)
    return json.loads(r["content"][0]["text"])
def err(i, text):
    r = msgs[i]["result"]
    assert r["isError"] is True, (i, r)
    assert text in r["content"][0]["text"], (i, r)

sec, var, perm, dec, que = (ok(i) for i in (2, 3, 4, 5, 6))
assert sec["id"] == 1 and que["id"] == 5, (sec, que)
assert (sec["kind"], sec["default_policy"], sec["blocking"], sec["chain"],
        sec["task"], sec["attempt"], sec["session"], sec["sandbox"],
        sec["state"]) == ("secret", "block", True, ["operator", "owner"],
                          "demo/2.1", "att-1", "s-1", "sb-1", "open"), sec
assert sec["deadline"] > 0, sec
assert var["default_policy"] == "block" and var["blocking"], var
assert perm["options"] == ["approve", "reject"] and perm["blocking"], perm
assert (dec["default_policy"], dec["blocking"], dec["recommended"],
        dec["options"], dec["body"]) == ("proceed-and-flag", False, "r2",
                                         ["s3", "r2"], "both work"), dec
assert dec["deadline"] - dec["raised"] in range(3595, 3605), dec
assert que["deadline"] == 1000 and que["overdue"] is True, que

# refusals carry the reason and leave no row
err(7, "kind must be one of")
err(8, "recommended")
err(9, "not one of the options")
err(10, "--deadline")
err(11, "kind and title are required")

opened = ok(12)["asks"]
assert [a["id"] for a in opened] == [1, 2, 3, 4, 5], opened
assert [a["id"] for a in ok(13)["asks"]] == [1, 2, 3, 4], ok(13)

st = ok(14)["ask"]
assert st["id"] == 1 and st["state"] == "open" and st["answer"] is None, st
task = ok(15)
assert task["task"] == "demo/2.1" and task["blocked"] is True, task
assert len(task["asks"]) == 4, task
err(16, "no Ask #999")

assert ok(17) == {"approvals": []}, ok(17)
PY
# the MCP raises are the CLI's rows: one store, the same events
has "$("$CG" ask list)" "Which object store?"
[ "$("$CG" events --kind ask.raised --json -n 50 | grep -c '"kind":"ask.raised"')" = 5 ] ||
    fail "five ask.raised events: $("$CG" events --kind ask.raised --json -n 50)"

# ---- a person answers on the CLI; ask_status and ask_list follow
"$CG" ask answer 1 secret-ref:railway-1 >/dev/null
"$CG" ask answer 3 approve -m "go" >/dev/null
"$CG" ask expire >/dev/null            # Ask 5 passed @1000: proceeds on yes
mcp \
  "$(call 20 ask_status '{"id":1}')" \
  "$(call 21 ask_status '{"id":5}')" \
  "$(call 22 ask_list '{}')" \
  "$(call 23 ask_list '{"all":true}')" \
  > "$TMP/answered.out"
CG_TASK=demo/2.1 mcp "$(call 24 ask_status '{}')" >> "$TMP/answered.out"
mcp "$(call 25 ask_status '{}')" >> "$TMP/answered.out"
python3 - "$TMP/answered.out" <<'PY' || fail "answered Asks over MCP"
import json, sys
msgs = {m["id"]: m for m in map(json.loads, open(sys.argv[1])) if "id" in m}
def ok(i):
    r = msgs[i]["result"]
    assert r["isError"] is False, (i, r)
    return json.loads(r["content"][0]["text"])
a1 = ok(20)["ask"]
assert (a1["state"], a1["answer"], a1["blocking"]) == (
    "answered", "secret-ref:railway-1", False), a1
a5 = ok(21)["ask"]
assert (a5["state"], a5["answer"], a5["answered_by"],
        a5["decided_by_default"]) == ("answered", "yes", "default", True), a5
assert a5["decision"], a5
assert [a["id"] for a in ok(22)["asks"]] == [2, 4], ok(22)
assert [a["id"] for a in ok(23)["asks"]] == [5, 4, 3, 2, 1], ok(23)
t = ok(24)
assert t["task"] == "demo/2.1" and t["blocked"] is True, t   # variable #2 still open
assert [a["id"] for a in t["asks"]] == [2, 4], t
r = msgs[25]["result"]
assert r["isError"] is True and "CG_TASK" in r["content"][0]["text"], r
PY

# ---- a task with only proceed-and-flag Asks open is not blocked
"$CG" ask answer 2 /etc/slices.json >/dev/null
CG_TASK=demo/2.1 mcp "$(call 30 ask_status '{}')" > "$TMP/unblocked.out"
python3 - "$TMP/unblocked.out" <<'PY' || fail "unblocked task"
import json, sys
msgs = {m["id"]: m for m in map(json.loads, open(sys.argv[1])) if "id" in m}
t = json.loads(msgs[30]["result"]["content"][0]["text"])
assert t["blocked"] is False and [a["id"] for a in t["asks"]] == [4], t
PY

# ---- approvals_list: a gated fleet pr waits as an approval with its
#      permission Ask; approved, it leaves the open list and shows under all
rc=0; CG_ROLE=main CG_AGENT=m "$CG" fleet pr 1 -f demo >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 4 ] || fail "the pr gate should wait for approval (rc $rc)"
mcp "$(call 40 approvals_list '{}')" "$(call 41 ask_list '{}')" > "$TMP/appr.out"
read -r apid gask < <(python3 - "$TMP/appr.out" <<'PY'
import json, sys
msgs = {m["id"]: m for m in map(json.loads, open(sys.argv[1])) if "id" in m}
ap = json.loads(msgs[40]["result"]["content"][0]["text"])["approvals"]
assert len(ap) == 1 and ap[0]["gate"] == "pr" and ap[0]["state"] == "pending", ap
asks = json.loads(msgs[41]["result"]["content"][0]["text"])["asks"]
gate = [a for a in asks if a["id"] == ap[0]["ask"]]
assert gate and gate[0]["kind"] == "permission" and gate[0]["blocking"], asks
print(ap[0]["id"], ap[0]["ask"])
PY
) || fail "approvals_list pending"
[ -n "$gask" ] || fail "approvals_list pending"
"$CG" ask answer "$gask" approve -m "ship it" >/dev/null
mcp "$(call 42 approvals_list '{}')" "$(call 43 approvals_list '{"all":true}')" \
    "$(call 44 ask_status "{\"id\":$gask}")" > "$TMP/appr2.out"
python3 - "$TMP/appr2.out" "$apid" <<'PY' || fail "approvals_list decided"
import json, sys
msgs = {m["id"]: m for m in map(json.loads, open(sys.argv[1])) if "id" in m}
apid = int(sys.argv[2])
def ok(i):
    r = msgs[i]["result"]
    assert r["isError"] is False, (i, r)
    return json.loads(r["content"][0]["text"])
assert ok(42) == {"approvals": []}, ok(42)
done = [a for a in ok(43)["approvals"] if a["id"] == apid]
assert done and done[0]["state"] == "approved" and done[0]["note"] == "ship it", done
a = ok(44)["ask"]
assert a["state"] == "answered" and a["answer"] == "approve", a
PY

# ---- the instruction rule: the workflow says when to raise each kind, and
#      spec render carries it into the pointer file's loop
wf="$ROOT/spec/workflow.kvx"
python3 - "$wf" <<'PY' || fail "the workflow's instruction rule"
import re, sys
text = open(sys.argv[1]).read()
loop = re.search(r"^\[loop\]\n(.*?)(?=^\[)", text, re.S | re.M).group(1)
step = [l for l in loop.splitlines() if "ask_raise" in l]
assert len(step) == 1, loop
for kind in ("secret", "variable", "permission", "decision", "question"):
    assert kind in step[0], (kind, step[0])
for tool in ("ask_raise", "ask_status"):
    assert tool in step[0], (tool, step[0])
asks = re.search(r"^\[asks\]\n(.*?)(?=^\[)", text, re.S | re.M).group(1)
assert "[loop]" in asks, "[asks] does not point at the rule in [loop]"
PY
mkdir -p "$TMP/render/spec"
cp "$wf" "$TMP/render/spec/workflow.kvx"
active="$(sed -n 's/^active_feature *= *"\(.*\)"/\1/p' "$wf" | head -1)"
cp -r "$ROOT/spec/$active" "$TMP/render/spec/$active"
(cd "$TMP/render" && git init -q . && "$CG" spec render >/dev/null 2>&1) ||
    fail "spec render"
for f in CLAUDE.md AGENTS.md; do
    [ -f "$TMP/render/$f" ] || fail "spec render wrote no $f"
    grep -q 'ask_raise' "$TMP/render/$f" || fail "$f loop lacks the Ask rule: $(cat "$TMP/render/$f")"
    grep -q 'question when' "$TMP/render/$f" || fail "$f loop lacks the per-kind rule"
done

echo "mcp ask OK"
