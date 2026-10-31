#!/usr/bin/env bash
# Console verbs (hyperfide-v21 5.3, req 5 ac_2): hyperfide console
# needs|issues|sandboxes|leaders reads the 23.1-console read model over the
# signed transport, with --json (the view's object, one line per snapshot)
# and --watch; local and offline modes refuse it by name; help lists
# fleet approve and the distributed verbs console, human, task, hierarchy
# and supervisor; the route contract counts the four console actions as
# client sends. The authority is a local TLS stand-in that records what the
# client sent and answers with protocol1 envelopes; it checks the request
# shape, not signatures (the real verifier is covered by the Postgres cases).
. "$(dirname "$0")/../lib.sh"

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
unset HYPERFIDE_MODE HYPERFIDE_AUTHORITY_DESCRIPTOR HYPERFIDE_TRANSPORT_CONFIG HYPERFIDE_AUTHORITY_URL

# rc <out-var> <cmd...>: run, capture stdout+stderr, return the exit code in RC
run() { RC=0; OUT="$("$@" 2>&1)" || RC=$?; }

# ---- help: the console row, the distributed verbs, fleet approve listed
help_all="$("$CG" help)"
for verb in "fleet approve" "console needs|issues|sandboxes|leaders" "human " "task claim" "hierarchy " "supervisor "; do
    has "$help_all" "  $verb"
done
detail="$("$CG" help console)"
has "$detail" "usage: hyperfide console needs|issues|sandboxes|leaders [--json] [--watch]"
has "$detail" "--watch"
has "$detail" "23.1-console"
has "$("$CG" console --help)" "usage: hyperfide console"
for verb in human task hierarchy supervisor; do
    d="$("$CG" help "$verb")"
    has "$d" "usage: hyperfide $verb"
    has "$d" "--operation-id"
done
"$CG" help --json > "$TMP/help.json"
python3 -I - "$TMP/help.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
rows = {c["name"]: c for c in d["commands"]}
for name in ("console", "human", "task", "hierarchy", "supervisor", "fleet approve"):
    assert name in rows, name
    assert rows[name]["overview"], f"{name} is hidden from the overview"
PY

# ---- route contract: the four console actions are client sends, and the
#      server-only line 5.1 added for 23.1-console is gone
client="$(cat "$REPO/core/native/src/hyperfide/client.c")"
for action in needs issues sandboxes leaders; do
    has "$client" "{\"$action\",\"\\\"component\\\":\\\"23.1-console\\\",\\\"action\\\":\\\"console.$action\\\"\""
done
grep -q '^23.1-console' "$FIXTURES/route_contract/server_only.txt" && fail "23.1-console is still declared server-only"
python3 -I - "$REPO/core/control-plane/components/23.1-console.json" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))
assert sorted(m["actions"]) == ["console.issues", "console.leaders", "console.needs", "console.sandboxes"], m["actions"]
PY

# ---- arguments are checked in every mode, before any authority is read
mkdir -p "$TMP/proj/src"
printf 'int main(void) { return 0; }\n' > "$TMP/proj/src/a.c"
cd "$TMP/proj"
"$CG" init >/dev/null
for bad in "bogus" "" "needs --interval 0" "needs --interval 3601" "needs --limit 501" "needs --limit 07" \
           "needs --include-ended" "sandboxes --run-id not-a-uuid" "issues --since 5m" "leaders --limit"; do
    # shellcheck disable=SC2086
    run "$CG" console $bad
    [ "$RC" -eq 78 ] || fail "console $bad exited $RC, want 78"
    has "$OUT" '"code":"INVALID_ARGS"'
done

# ---- local mode refuses by name and never falls back
run "$CG" console needs --json
[ "$RC" -eq 78 ] || fail "local console exited $RC"
has "$OUT" '"code":"CONSOLE_DISTRIBUTED_ONLY"'
has "$OUT" '"local_fallback":false'

# ---- distributed and offline without an attached transport
cat > "$TMP/authority.json" <<'EOF'
{"schema_version":1,"mode":"distributed","authority_epoch":"0b0e1c2d-1111-4222-8333-444455556666"}
EOF
chmod 600 "$TMP/authority.json"
export HYPERFIDE_AUTHORITY_DESCRIPTOR="$TMP/authority.json"
run "$CG" console sandboxes --json
[ "$RC" -eq 78 ] || fail "console without transport exited $RC"
has "$OUT" '"code":"TRANSPORT_CONFIG_REQUIRED"'
run env HYPERFIDE_MODE=offline "$CG" console needs
[ "$RC" -eq 78 ] || fail "offline console exited $RC"
has "$OUT" '"code":"OFFLINE_AUTHORITY_UNAVAILABLE"'

# ---- a TLS stand-in for the control service
command -v openssl >/dev/null || { echo "SKIP: openssl is required for the TLS stand-in"; exit 77; }
cat > "$TMP/san.cnf" <<'EOF'
[req]
distinguished_name=dn
x509_extensions=ext
prompt=no
[dn]
CN=127.0.0.1
[ext]
subjectAltName=IP:127.0.0.1
basicConstraints=critical,CA:TRUE
EOF
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -keyout "$TMP/tls.key" -out "$TMP/tls.crt" \
    -config "$TMP/san.cnf" >/dev/null 2>&1 || fail "cannot make the stand-in certificate"
openssl genpkey -algorithm ed25519 -out "$TMP/client.pem" >/dev/null 2>&1 || fail "cannot make an ed25519 key"
chmod 600 "$TMP/client.pem" "$TMP/tls.key"

RUN_ID=7c9e6679-7425-40de-944b-e07fc1f90ae7
FORBIDDEN_RUN=11111111-2222-4333-8444-555555555555
CREDENTIAL=3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d
cat > "$TMP/server.py" <<'PY'
import base64, http.server, json, ssl, sys
cert, key, log, portfile, forbidden = sys.argv[1:6]
RESULTS = {
 "console.needs": {"view": "console.needs", "as_of": "2026-10-22T12:00:00Z", "counts": {"asks": 1, "human_intents": 0, "admission_escalations": 0},
                   "sections": {"asks": {"rows": [{"kind": "ASK", "id": "ask-1", "state": "OPEN", "title": "Which region?"}]},
                                "human_intents": {"rows": []}, "admission_escalations": {"rows": []}}},
 "console.issues": {"view": "console.issues", "as_of": "2026-10-22T12:00:00Z", "counts": {"leader_queue": 0, "external_intake": 0, "escalated_repairs": 1},
                    "sections": {"escalated_repairs": {"rows": [{"kind": "REPAIR", "id": "rep-1", "state": "ESCALATED", "title": "lease lost twice"}]}}},
 "console.sandboxes": {"view": "console.sandboxes", "as_of": "2026-10-22T12:00:00Z", "heartbeat_max_age_seconds": 90, "counts": {"LIVE": 1},
                       "rows": [{"kind": "SANDBOX", "sandbox_id": "0f0e0d0c-0b0a-4908-8706-050403020100", "native_sandbox_id": "sbx-live",
                                 "liveness": "LIVE", "provider": "railway", "pool_id": "pool-a", "heartbeat_age_seconds": 4, "workers": []}],
                       "truncated": False},
 "console.leaders": {"view": "console.leaders", "as_of": "2026-10-22T12:00:00Z", "max_observation_age_seconds": 300,
                     "counts": {"leaders": 1, "feature_managers": 0, "stale": 0},
                     "rows": [{"kind": "LEADER", "id": "lead-1", "state": "ACTIVE", "title": "Primary leader claude/s1"}]},
}
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, code, obj):
        body = json.dumps(obj, separators=(",", ":")).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_POST(self):
        env = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        raw = env["payload_b64"]; payload = json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)))
        with open(log, "a") as f:
            f.write(json.dumps({"path": self.path, "credential": self.headers.get("HF-Credential-Id"),
                                "signed": bool(self.headers.get("HF-Request-Signature")), "envelope": env, "payload": payload}) + "\n")
        op = env["operation_id"]
        if payload["run_id"] == forbidden:
            return self.send(403, {"protocol_version": 1, "ok": False, "error": {"code": "CONSOLE_FORBIDDEN", "message": "The console is for operators"}})
        if payload.get("component") != "23.1-console" or payload.get("action") not in RESULTS:
            return self.send(404, {"protocol_version": 1, "ok": False, "error": {"code": "ACTION_UNKNOWN", "message": "no such action"}})
        self.send(200, {"protocol_version": 1, "operation_id": op, "ok": True, "id": op, "result": RESULTS[payload["action"]]})
s = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain(cert, key)
s.socket = ctx.wrap_socket(s.socket, server_side=True)
open(portfile, "w").write(str(s.server_address[1]))
s.serve_forever()
PY
python3 -I "$TMP/server.py" "$TMP/tls.crt" "$TMP/tls.key" "$TMP/requests.log" "$TMP/port" "$FORBIDDEN_RUN" &
SERVER=$!
trap 'kill $SERVER 2>/dev/null; rm -rf "$TMP"' EXIT
for _ in $(seq 100); do [ -s "$TMP/port" ] && break; sleep 0.1; done
[ -s "$TMP/port" ] || fail "the TLS stand-in did not start"
ORIGIN="https://127.0.0.1:$(cat "$TMP/port")"

transport() {   # transport <file> [run_id]
    python3 -I - "$1" "$ORIGIN" "$TMP/tls.crt" "$TMP/client.pem" "$CREDENTIAL" "${2:-}" <<'PY'
import json, os, sys
path, origin, ca, key, cred, run = sys.argv[1:7]
c = {"origin": origin, "ca_file": ca, "key_path": key, "credential_id": cred, "timeout_ms": 5000}
if run: c["run_id"] = run
open(path, "w").write(json.dumps(c)); os.chmod(path, 0o600)
PY
}
transport "$TMP/transport.json" "$RUN_ID"
transport "$TMP/norun.json"
export HYPERFIDE_TRANSPORT_CONFIG="$TMP/transport.json"
last() { tail -n 1 "$TMP/requests.log"; }

# ---- each view: --json is the view's object on one line, sent as a fresh
#      read of 23.1-console for the configured run
for view in needs issues sandboxes leaders; do
    run "$CG" console "$view" --json
    [ "$RC" -eq 0 ] || { printf '%s\n' "$OUT" >&2; [ "$view" = needs ] && grep -q UNQUALIFIED <<<"$OUT" && { echo "SKIP: libcurl/OpenSSL runtime not qualified"; exit 77; }; fail "console $view exited $RC"; }
    [ "$(printf '%s\n' "$OUT" | wc -l)" -eq 1 ] || fail "console $view --json printed more than one line"
    python3 -I - "$view" "$OUT" "$(last)" "$RUN_ID" "$CREDENTIAL" <<'PY'
import json, sys, uuid
view, out, req, run, cred = sys.argv[1:6]
o = json.loads(out); r = json.loads(req)
assert o["view"] == "console." + view and "as_of" in o, o
assert "protocol_version" not in o and "ok" not in o, "the envelope leaked into --json"
p = r["payload"]
assert r["path"] == "/v1/invoke" and r["signed"] and r["credential"] == cred, r
assert p == {"run_id": run, "component": "23.1-console", "action": "console." + view, "input": {},
             "expected_version": None, "authority": None}, p
e = r["envelope"]
ids = {e["operation_id"], e["idempotency_key"], e["correlation_id"]}
assert len(ids) == 3 and all(str(uuid.UUID(i)) == i for i in ids), e
PY
done
# the shape extensions/vscode/sandboxes.js (6.4) reads: view, rows, as_of
run "$CG" console sandboxes --json
python3 -I -c 'import json,sys; o=json.loads(sys.argv[1]); assert o["view"]=="console.sandboxes" and o["rows"][0]["liveness"]=="LIVE" and o["heartbeat_max_age_seconds"]==90' "$OUT"

# ---- every read mints new operation identities
ops="$(python3 -I -c 'import json,sys; print(len({json.loads(l)["envelope"]["operation_id"] for l in open(sys.argv[1])}))' "$TMP/requests.log")"
reqs="$(wc -l < "$TMP/requests.log")"
[ "$ops" -eq "$reqs" ] || fail "operation identities reused: $ops distinct of $reqs"

# ---- options reach the action input
"$CG" console needs --json --limit 7 >/dev/null
has "$(last)" '"input": {"limit": 7}'
"$CG" console leaders --json --include-ended --limit 3 >/dev/null
has "$(last)" '"input": {"limit": 3, "include_ended": true}'
OTHER=9a8b7c6d-5e4f-4321-8fed-cba987654321
"$CG" console issues --json --run-id "$OTHER" >/dev/null
has "$(last)" "\"run_id\": \"$OTHER\""

# ---- text view: freshness, counts and one line per row
text="$("$CG" console needs)"
has "$text" "console.needs as of 2026-10-22T12:00:00Z"
has "$text" "counts: asks=1 human_intents=0 admission_escalations=0"
has "$text" "asks:"
has "$text" "ASK ask-1 OPEN  Which region?"
has "$text" "human_intents:"
has "$text" "(no rows)"
text="$("$CG" console sandboxes)"
has "$text" "SANDBOX 0f0e0d0c-0b0a-4908-8706-050403020100 LIVE  sbx-live"
hasnt "$text" '"view"'

# ---- no run: refused unless --run-id names one
run env HYPERFIDE_TRANSPORT_CONFIG="$TMP/norun.json" "$CG" console needs --json
[ "$RC" -eq 78 ] || fail "console without a run exited $RC"
has "$OUT" '"code":"RUN_ID_REQUIRED"'
HYPERFIDE_TRANSPORT_CONFIG="$TMP/norun.json" "$CG" console needs --json --run-id "$OTHER" >/dev/null
has "$(last)" "\"run_id\": \"$OTHER\""

# ---- a refusal from the authority: nothing on stdout, the error on stderr
RC=0; "$CG" console leaders --json --run-id "$FORBIDDEN_RUN" >"$TMP/o" 2>"$TMP/e" || RC=$?
[ "$RC" -eq 1 ] || fail "forbidden console exited $RC"
[ ! -s "$TMP/o" ] || fail "a refused read printed to stdout: $(cat "$TMP/o")"
has "$(cat "$TMP/e")" '"code":"CONSOLE_FORBIDDEN"'

# ---- --watch: one JSON snapshot per interval until interrupted
before="$(wc -l < "$TMP/requests.log")"
RC=0; timeout 3.5 "$CG" console sandboxes --json --watch --interval 1 >"$TMP/watch" 2>"$TMP/watch.err" || RC=$?
[ "$RC" -eq 124 ] || fail "watch ended by itself with $RC: $(cat "$TMP/watch.err")"
python3 -I - "$TMP/watch" <<'PY'
import json, sys
lines = open(sys.argv[1]).read().splitlines()
assert len(lines) >= 2, f"only {len(lines)} snapshot(s) in 3.5 s at a 1 s interval"
for l in lines:
    assert json.loads(l)["view"] == "console.sandboxes", l
PY
after="$(wc -l < "$TMP/requests.log")"
[ $((after - before)) -ge 2 ] || fail "watch did not read again"
# text watch separates snapshots
RC=0; timeout 2.5 "$CG" console leaders --watch --interval 1 >"$TMP/watch" 2>&1 || RC=$?
[ "$RC" -eq 124 ] || fail "text watch ended with $RC"
has "$(cat "$TMP/watch")" $'\n--\n'
# a refusal ends the watch with the refusal, it does not spin
RC=0; timeout 10 "$CG" console leaders --json --watch --interval 1 --run-id "$FORBIDDEN_RUN" >/dev/null 2>"$TMP/e" || RC=$?
[ "$RC" -eq 1 ] || fail "refused watch exited $RC"
has "$(cat "$TMP/e")" '"code":"CONSOLE_FORBIDDEN"'

echo "PASS: 98_console_verbs"
