#!/usr/bin/env bash
# One MCP Ask surface in both modes (hyperfide-v21 3.14, req 3.3): `hyperfide
# mcp` lists ask_raise, ask_status, ask_list and approvals_list in local and
# distributed mode, no tool name twice, and no route-derived tool named ask_*
# (the 1.2-asks routes are reached only through the native names). In
# distributed mode the native tools reach the routed client: a stub HTTPS
# control service records the component and action each call lands on.
. "$(dirname "$0")/../lib.sh"

[ "$(id -u)" = 0 ] || { echo "SKIP: the distributed transport reads its CA as a root-owned protected file"; exit 77; }
command -v openssl >/dev/null || { echo "SKIP: openssl is needed for the stub control service's certificate"; exit 77; }

cp -r "$FIXTURES/sample" "$TMP/proj"
cd "$TMP/proj"
git init -q . 2>/dev/null
"$CG" init >/dev/null 2>&1

INIT='{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}'
LIST='{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
mcp() { { printf '%s\n' "$INIT"; printf '%s\n' "$@"; } | "$CG" mcp; }
call() {   # call <id> <tool> <arguments-json>
    printf '{"jsonrpc":"2.0","id":%s,"method":"tools/call","params":{"name":"%s","arguments":%s}}' "$1" "$2" "$3"
}

# ---- local mode: the native surface
mcp "$LIST" > "$TMP/local.out"

# ---- distributed mode: descriptor, an Ed25519 key, a CA and a stub service
cat > "$TMP/authority.json" <<'EOF'
{"schema_version":1,"mode":"distributed","authority_epoch":"0b0e1c2d-1111-4222-8333-444455556666"}
EOF
chmod 600 "$TMP/authority.json"
openssl genpkey -algorithm ED25519 -out "$TMP/client.key" 2>/dev/null
chmod 600 "$TMP/client.key"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=stub-ca" \
    -keyout "$TMP/ca.key" -out "$TMP/ca.pem" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=127.0.0.1" \
    -keyout "$TMP/server.key" -out "$TMP/server.csr" 2>/dev/null
printf 'subjectAltName=IP:127.0.0.1\n' > "$TMP/san.ext"
openssl x509 -req -in "$TMP/server.csr" -CA "$TMP/ca.pem" -CAkey "$TMP/ca.key" \
    -CAcreateserial -days 1 -extfile "$TMP/san.ext" -out "$TMP/server.pem" 2>/dev/null
chmod 644 "$TMP/ca.pem"

cat > "$TMP/stub.py" <<'PY'
# Stub control service: records each protocol1 invocation's decoded payload
# and answers human.ask.* the way 1.2-asks shapes its results.
import base64, http.server, json, ssl, sys
tmp = sys.argv[1]
TASK = "7a1c0f00-0000-4000-8000-000000000001"
def row(ask_id, kind, task, policy):
    return {"ask_id": ask_id, "kind": kind, "title": kind + " ask", "body": "", "options": [],
            "recommended": None, "deadline": None, "default_policy": policy, "chain": [],
            "task": task, "state": "OPEN", "answer": None, "state_version": "1"}
ROWS = [row("aaaaaaaa-0000-4000-8000-000000000001", "permission", TASK, "block"),
        row("aaaaaaaa-0000-4000-8000-000000000002", "decision", None, "proceed-and-flag")]
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        envelope = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        payload = json.loads(base64.urlsafe_b64decode(envelope["payload_b64"] + "=="))
        with open(tmp + "/requests.jsonl", "a") as f:
            f.write(json.dumps({"path": self.path, "payload": payload,
                                "credential": self.headers.get("HF-Credential-Id")}) + "\n")
        action = payload["action"]
        if action == "human.ask.raise":
            i = payload["input"]
            result = {"status": "RAISED", "ask": dict(row("bbbbbbbb-0000-4000-8000-000000000003", i["kind"], i["task_id"], "block"),
                                                       title=i["title"], options=i["options"], recommended=i["recommended"])}
        elif action == "human.ask.list":
            result = {"asks": ROWS, "truncated": False, "scope": "RUN", "authority": "NONE"}
        else:
            result = {"unexpected": action}
        op = envelope["operation_id"]
        body = json.dumps({"protocol_version": 1, "ok": True, "id": op, "operation_id": op, "result": result}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(tmp + "/server.pem", tmp + "/server.key")
server.socket = context.wrap_socket(server.socket, server_side=True)
open(tmp + "/port.tmp", "w").write(str(server.server_address[1]))
__import__("os").rename(tmp + "/port.tmp", tmp + "/port")
server.serve_forever()
PY
python3 -I "$TMP/stub.py" "$TMP" & STUB=$!
trap 'kill "$STUB" 2>/dev/null; rm -rf "$TMP"' EXIT
for _ in $(seq 100); do [ -f "$TMP/port" ] && break; sleep 0.1; done
[ -f "$TMP/port" ] || fail "stub control service did not start"
RUN=5e1f0000-0000-4000-8000-0000000000aa
cat > "$TMP/transport.json" <<EOF
{"origin":"https://127.0.0.1:$(cat "$TMP/port")","ca_file":"$TMP/ca.pem","key_path":"$TMP/client.key","credential_id":"c0ffee00-0000-4000-8000-000000000001","run_id":"$RUN","timeout_ms":5000}
EOF
chmod 600 "$TMP/transport.json"
export HYPERFIDE_AUTHORITY_DESCRIPTOR="$TMP/authority.json" HYPERFIDE_TRANSPORT_CONFIG="$TMP/transport.json"
unset HYPERFIDE_MODE HYPERFIDE_MCP_TOOL_POLICY_FILE CG_TASK

mcp "$LIST" > "$TMP/dist.out"
python3 - "$TMP/local.out" "$TMP/dist.out" <<'PY' || fail "tool names"
import json, sys
ASK = ("ask_raise", "ask_status", "ask_list", "approvals_list")
def tools(path):
    msgs = {m["id"]: m for m in map(json.loads, open(path)) if "id" in m}
    return msgs[1]["result"]["tools"]
local, dist = tools(sys.argv[1]), tools(sys.argv[2])
for mode, ts in (("local", local), ("distributed", dist)):
    names = [t["name"] for t in ts]
    dup = sorted({n for n in names if names.count(n) > 1})
    assert not dup, (mode, "names listed twice", dup)
    for n in ASK:
        assert n in names, (mode, "missing", n)
    assert not [n for n in names if n in ("ask_answer", "ask_expire")], (mode, names)
# route-derived tools: everything distributed lists besides the native Ask
# tools and the raw authority tool; none takes an ask_ name
routed = [t["name"] for t in dist if t["name"] not in ASK + ("authority_invoke",)]
assert len(routed) >= 50, ("route-derived tools missing", routed)
assert not [n for n in routed if n.startswith("ask_")], routed
# the same surface: the native Ask tools carry the local schema and hints
by = lambda ts: {t["name"]: t for t in ts}
for n in ASK:
    for key in ("description", "inputSchema", "annotations", "title"):
        assert by(local)[n][key] == by(dist)[n][key], (n, key)
print("local=%d distributed=%d routed=%d" % (len(local), len(dist), len(routed)))
PY

# ---- the native tools reach the routed client
mcp "$(call 2 ask_raise '{"kind":"decision","title":"Which store?","options":["s3","r2"],"recommend":"r2","deadline":"1h","chain":["leader"]}')" \
    "$(call 3 ask_list '{}')" \
    "$(call 4 ask_list '{"all":true,"task":"7a1c0f00-0000-4000-8000-000000000001"}')" \
    "$(call 5 ask_status '{"id":"aaaaaaaa-0000-4000-8000-000000000002"}')" \
    "$(call 6 ask_status '{"task":"7a1c0f00-0000-4000-8000-000000000001"}')" \
    "$(call 7 approvals_list '{}')" \
    "$(call 8 ask_status '{"id":"aaaaaaaa-0000-4000-8000-0000000000ff"}')" \
    "$(call 9 ask_raise '{"kind":"question","title":"Local task id?","task":"demo/2.1"}')" \
    "$(call 10 ask_raise '{"title":"no kind"}')" \
    "$(call 11 ask_status '{"id":3}')" \
    "$(call 12 ask_answer '{"run_id":"5e1f0000-0000-4000-8000-0000000000aa","input":{},"operation_id":"5e1f0000-0000-4000-8000-0000000000a1","idempotency_key":"5e1f0000-0000-4000-8000-0000000000a2","correlation_id":"5e1f0000-0000-4000-8000-0000000000a3"}')" \
    "$(call 13 ask_raise '{"kind":"secret","title":"Token","operation_id":"not-a-uuid"}')" \
    > "$TMP/calls.out"
python3 - "$TMP/calls.out" "$TMP/requests.jsonl" "$RUN" <<'PY' || fail "routed Ask calls"
import json, sys
msgs = {m["id"]: m for m in map(json.loads, open(sys.argv[1])) if "id" in m}
reqs = [json.loads(l) for l in open(sys.argv[2])]
run = sys.argv[3]
def ok(i):
    r = msgs[i]["result"]
    assert r["isError"] is False, (i, r)
    return json.loads(r["content"][0]["text"])
def err(i, text):
    r = msgs[i].get("result")
    assert r and r["isError"] is True and text in r["content"][0]["text"], (i, msgs[i])
# seven calls reached the service, each on component 1.2-asks with the enrolled run
assert len(reqs) == 7, [r["payload"]["action"] for r in reqs]
assert all(r["path"] == "/v1/invoke" and r["payload"]["component"] == "1.2-asks"
           and r["payload"]["run_id"] == run for r in reqs), reqs
actions = [r["payload"]["action"] for r in reqs]
assert actions == ["human.ask.raise"] + ["human.ask.list"] * 6, actions
raise_input = reqs[0]["payload"]["input"]
assert {k: raise_input[k] for k in ("kind", "title", "body", "options", "recommended", "deadline_seconds", "chain", "task_id")} == {
    "kind": "decision", "title": "Which store?", "body": "", "options": ["s3", "r2"], "recommended": "r2",
    "deadline_seconds": 3600, "chain": ["leader"], "task_id": None}, raise_input
assert raise_input["idempotency_key"], raise_input
assert [r["payload"]["input"]["state"] for r in reqs[1:]] == ["OPEN", None, None, "OPEN", "OPEN", None], reqs
a = ok(2)
assert a["kind"] == "decision" and a["title"] == "Which store?" and a["ask_id"], a
assert [x["ask_id"][-1] for x in ok(3)["asks"]] == ["1", "2"], ok(3)
assert [x["kind"] for x in ok(4)["asks"]] == ["permission"], ok(4)
assert ok(5)["ask"]["kind"] == "decision", ok(5)
st = ok(6)
assert st["blocked"] is True and [x["kind"] for x in st["asks"]] == ["permission"], st
assert [x["kind"] for x in ok(7)["approvals"]] == ["permission"], ok(7)
err(8, "no Ask aaaaaaaa-0000-4000-8000-0000000000ff")
# refusals before the network: a local task id, no kind, an integer id, a bad identity
err(9, "task UUID")
err(10, "kind and title are required")
err(11, "ask_id UUID")
err(13, "canonical UUIDs")
# the route-derived ask_answer no longer exists: only a person answers
e = msgs[12].get("error")
assert e and "Unsupported distributed tool mapping" in e["message"], msgs[12]
PY

# ---- a trusted tool policy names the native tools; a route-derived Ask name is unknown
printf '{"schema_version":1,"allowed_tools":["ask_raise","ask_status"]}' > "$TMP/policy.json"
chmod 600 "$TMP/policy.json"
HYPERFIDE_MCP_TOOL_POLICY_FILE="$TMP/policy.json" mcp "$LIST" > "$TMP/policy.out"
python3 - "$TMP/policy.out" <<'PY' || fail "policy-narrowed list"
import json, sys
msgs = {m["id"]: m for m in map(json.loads, open(sys.argv[1])) if "id" in m}
assert sorted(t["name"] for t in msgs[1]["result"]["tools"]) == ["ask_raise", "ask_status"], msgs[1]
PY
printf '{"schema_version":1,"allowed_tools":["ask_answer"]}' > "$TMP/policy.json"
out="$(HYPERFIDE_MCP_TOOL_POLICY_FILE="$TMP/policy.json" mcp "$LIST" 2>&1)" && fail "a policy naming ask_answer was accepted"
has "$out" "MCP_TOOL_POLICY_INVALID"

echo "mcp route names OK"
