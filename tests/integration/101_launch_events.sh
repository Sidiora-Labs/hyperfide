#!/usr/bin/env bash
# Native events leave the sandbox (hyperfide-v21 4.2, req 4 ac_1, D21). The real
# launch broker (build/hyperfide-native, core/native/src/hyperfide/launch.c) reads the
# launched agent's stdout; every question or approval prompt line is spooled as
# a native.question / native.approval launch event carrying the line verbatim
# and posted promptly to runner.launch.event.record, where the 4.1 classifier
# and Ask path make it an Ask row (tests/hyperfide/cases/v21/4_2.py proves that
# half against PostgreSQL). Ordinary lines never leave.
#
# No codex CLI is installed on this host, so the agent replays recorded protocol
# fixtures: Claude Code stream-json (AskUserQuestion as an assistant tool_use and
# as a can_use_tool control request, a Bash approval) and Codex app-server
# JSON-RPC (item/tool/requestUserInput, item/commandExecution/requestApproval).
# The coordinator is the tasks/12_2.py HTTPS stand-in, which verifies the runner
# request proof and the launch-event contract.
. "$(dirname "$0")/../lib.sh"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

if [ "$(id -u)" -ne 0 ]; then
    echo "SKIP: the launch broker needs root for slot uids"
    exit 77
fi
make -s -C "$ROOT" hyperfide-native >"$TMP/native.log" 2>&1 \
    || { cat "$TMP/native.log" >&2; fail "hyperfide-native build"; }

python3 -I - "$ROOT" <<'PY' || fail "native events forwarded out of the sandbox"
import hashlib, importlib.util, json, os, pathlib, signal, sqlite3, sys, traceback, time

ROOT = pathlib.Path(sys.argv[1])
spec = importlib.util.spec_from_file_location("hf_case_12_2", ROOT / "tests/hyperfide/cases/tasks/12_2.py")
t = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t)
AGENT = os.path.realpath("/bin/sh")
BASE_UID = 62900  # distinct from tasks/12_2.py (62240+) and v21/2_8.py (62880)
FAILED = []


def check(name, ok, detail=None):
    print(json.dumps({"type": "assertion", "id": "launch-events." + name, "expected": True, "actual": bool(ok)}), flush=True)
    if not ok:
        FAILED.append(name)
        print("assertion failed: %s %s" % (name, json.dumps(detail, default=str)[:2500]), file=sys.stderr, flush=True)


def line(value):
    return json.dumps(value, separators=(",", ":"))


QUESTIONS = [{"question": "Which migration strategy should the worker use for the orders table?", "header": "Migration",
              "options": [{"label": "Online copy (Recommended)", "description": "Copy rows in batches."}, {"label": "Lock and rewrite", "description": "Exclusive lock."}],
              "multiSelect": False}]
# Recorded Claude Code 2.1.x stream-json shapes.
CLAUDE_TOOL_USE = {"type": "assistant", "message": {"id": "msg_1", "role": "assistant", "content": [
    {"type": "text", "text": "I need a decision."}, {"type": "tool_use", "id": "toolu_01AskQ", "name": "AskUserQuestion", "input": {"questions": QUESTIONS}}]},
    "session_id": "native-claude"}
CLAUDE_CONTROL = {"type": "control_request", "request_id": "req-7", "request": {"subtype": "can_use_tool", "tool_name": "AskUserQuestion",
                                                                              "tool_use_id": "toolu_01AskQ", "input": {"questions": QUESTIONS}}}
CLAUDE_BASH = {"type": "control_request", "request_id": "req-8", "request": {"subtype": "can_use_tool", "tool_name": "Bash", "tool_use_id": "toolu_02Bash",
                                                                           "input": {"command": "rm -rf build/ && make release"}}}
CLAUDE_ORDINARY = [
    {"type": "system", "subtype": "init", "session_id": "0b8f1c55-6c1e-4b8e-9d3a-2f1d7e1a9c01", "tools": ["AskUserQuestion", "Bash"]},
    {"type": "assistant", "message": {"content": [{"type": "text", "text": "I could call AskUserQuestion or wait for can_use_tool."}]}},
    {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "toolu_00", "content": "requestApproval can_use_tool AskUserQuestion"}]}},
]
# Recorded Codex app-server (0.16x) JSON-RPC shapes.
CODEX_INPUT = {"id": 41, "method": "item/tool/requestUserInput", "params": {"threadId": "thr_1", "turnId": "turn_1", "itemId": "call_ui_9", "questions": [
    {"id": "deploy_target", "header": "Target", "question": "Which environment should the smoke test run against?", "isOther": True, "isSecret": False,
     "options": [{"label": "staging", "description": "Shared staging."}, {"label": "production", "description": "Live traffic."}]}]}}
CODEX_APPROVAL = {"id": 42, "method": "item/commandExecution/requestApproval", "params": {"threadId": "thr_1", "turnId": "turn_1", "itemId": "call_cmd_3",
                                                                                         "command": "make deploy", "cwd": "/work", "reason": "network access"}}
CODEX_ORDINARY = [
    {"method": "item/tool/requestUserInput", "params": {"questions": []}},
    {"method": "item/completed", "params": {"item": {"type": "agentMessage", "text": "No requestApproval needed."}}},
    {"id": 43, "result": {"thread": {"id": "thr_1"}}},
]
OVERSIZE = {"type": "control_request", "request_id": "req-9", "request": {"subtype": "can_use_tool", "tool_name": "AskUserQuestion", "tool_use_id": "toolu_big",
                                                                        "input": {"questions": [{"question": "Pick one?", "header": "Big",
                                                                                                 "options": [{"label": "a", "description": "x" * 20000}]}]}}}
HUGE = '{"type":"assistant","note":"AskUserQuestion","pad":"' + "y" * 70000 + '"}'


def setup(p, name, index, connector, text, keep_running):
    suid = BASE_UID + index
    if p.uid_processes(suid):
        raise RuntimeError("slot uid %d is not quiescent" % suid)
    sid = t.uid()
    db = sqlite3.connect(p.slots / ".supervisor-slots.db")
    db.execute("CREATE TABLE IF NOT EXISTS slots(id TEXT PRIMARY KEY,uid INTEGER UNIQUE NOT NULL,gid INTEGER NOT NULL,boot_id TEXT NOT NULL,preparation TEXT NOT NULL,port INTEGER UNIQUE NOT NULL,state TEXT NOT NULL)")
    db.execute("INSERT INTO slots VALUES(?,?,?,?,?,?,'READY')", (sid, suid, suid, p.ids["boot"], t.sha(b"prep"), 41900 + index))
    db.commit()
    db.close()
    os.chmod(p.slots / ".supervisor-slots.db", 0o600)
    root = p.slots / sid
    root.mkdir(mode=0o700)
    os.chown(root, suid, suid)
    for sub in ("worktree", "build", "home", "tmp", "sessions", "logs"):
        (root / sub).mkdir(mode=0o700)
        os.chown(root / sub, suid, suid)
    fixture = root / "worktree/recorded.jsonl"
    fixture.write_text(text)
    os.chown(fixture, suid, suid)
    os.chmod(fixture, 0o600)
    script = 'cat "$1"' + ('; exec /usr/bin/sed -u ""' if keep_running else "")
    plan = {"dispatch_eligible": True, "requires_supervisor": True, "binary_digest": t.sha(pathlib.Path(AGENT).read_bytes()),
            "argv": [AGENT, "-c", script, "agent", str(fixture)], "cwd": str(root / "worktree"), "home": str(root / "home"), "temp": str(root / "tmp")}
    if connector:
        plan["connector"] = connector
    plan_path = p.tmp / ("plan-%s.json" % name)
    plan_path.write_bytes(t.canonical(plan))
    os.chmod(plan_path, 0o600)
    config = p.tmp / ("runner-%s.json" % name)
    config.write_text(json.dumps({"transport_config": str(p.tmp / "transport.json"), "state_dir": str(p.state), "slot_root": str(p.slots),
                                  "connector_plan_path": str(plan_path), "organisation_id": p.ids["organisation"], "run_id": p.ids["run"],
                                  "sandbox_id": p.ids["sandbox"], "boot_id": p.ids["boot"], "boot_generation": p.generation, "consumer_id": p.ids["consumer"]}))
    os.chmod(config, 0o600)
    p.slot[name] = {"id": sid, "uid": suid, "config": str(config), "plan_digest": t.sha(plan_path.read_bytes())}


def transport(p):
    d = p.tmp
    p.openssl("req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes", "-keyout", str(d / "tls.key"), "-out", str(d / "ca.pem"),
              "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-days", "1")
    os.chmod(d / "tls.key", 0o600)
    os.chmod(d / "ca.pem", 0o644)
    p.openssl("genpkey", "-algorithm", "Ed25519", "-out", str(d / "runner.key"))
    os.chmod(d / "runner.key", 0o600)
    p.openssl("pkey", "-in", str(d / "runner.key"), "-pubout", "-out", str(d / "runner.pub"))
    import socket
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        p.port = s.getsockname()[1]
    p.origin = "https://localhost:%d" % p.port
    p.control_token = t.uid()
    (d / "coordinator").mkdir(mode=0o700)
    (d / "coordinator/coordinator.json").write_text(json.dumps({
        "port": p.port, "cert": str(d / "ca.pem"), "key": str(d / "tls.key"), "runner_public_key": str(d / "runner.pub"),
        "origin": p.origin, "credential_id": p.ids["credential"], "organisation_id": p.ids["organisation"], "run_id": p.ids["run"],
        "sandbox_id": p.ids["sandbox"], "boot_id": p.ids["boot"], "boot_generation": p.generation, "consumer_id": p.ids["consumer"],
        "authority_epoch": p.ids["epoch"], "control_token": p.control_token}))
    (d / "transport.json").write_text(json.dumps({"origin": p.origin, "ca_file": str(d / "ca.pem"), "key_path": str(d / "runner.key"),
                                                  "credential_id": p.ids["credential"], "timeout_ms": 2000}))
    os.chmod(d / "transport.json", 0o600)


def start(p, name):
    attempt, launch, session = t.uid(), t.uid(), t.uid()
    ins = p.instruction("START", launch, p.start_body(name, session), attempt, held=True)
    code, out, err = p.native("launch.start", {"config_path": p.slot[name]["config"], "event_id": ins["id"]}, timeout=60)
    return {"launch": launch, "session": session, "command": ins["id"], "attempt": attempt, "code": code, "out": out, "err": err}


def native_events(p, launch):
    return [e for e in p.events(launch) if e["kind"].startswith("native.")]


def delivered(p, events):
    seen = p.cstate()["events"]
    return all(e["event_id"] in seen and seen[e["event_id"]] == e for e in events)


def scenario(p):
    transport(p)
    claude_text = "".join(line(v) + "\n" for v in [CLAUDE_ORDINARY[0], CLAUDE_TOOL_USE, CLAUDE_ORDINARY[1], CLAUDE_CONTROL, CLAUDE_ORDINARY[2], CLAUDE_BASH])
    codex_text = "".join(line(v) + "\r\n" for v in [CODEX_ORDINARY[2], CODEX_INPUT, CODEX_ORDINARY[0], CODEX_APPROVAL, CODEX_ORDINARY[1]])
    # No planned connector: the line shape decides; the last line has no newline and is judged when the stream ends.
    mixed_text = line(OVERSIZE) + "\n" + HUGE + "\n" + line(CODEX_APPROVAL) + "\n" + line(CLAUDE_BASH)
    setup(p, "claude", 0, "claude", claude_text, True)
    setup(p, "codex", 1, "codex", codex_text, True)
    setup(p, "mixed", 2, None, mixed_text, False)
    p.start_coordinator()
    started = time.monotonic()
    claude, codex, mixed = start(p, "claude"), start(p, "codex"), start(p, "mixed")
    check("launch.started", all(r["code"] == 0 for r in (claude, codex, mixed)), [claude, codex, mixed])

    got = t.wait_for(lambda: len(native_events(p, claude["launch"])) >= 3 and native_events(p, claude["launch"]), 15) or []
    want = [("native.question", "QUESTION", CLAUDE_TOOL_USE), ("native.question", "QUESTION", CLAUDE_CONTROL), ("native.approval", "APPROVAL_PROMPT", CLAUDE_BASH)]
    shape = [(e["kind"], e["data"].get("signal"), e["data"].get("event")) for e in got]
    check("claude.prompts-forwarded-verbatim", shape == want, shape)
    check("claude.attributed-to-launch", all(e["launch_id"] == claude["launch"] and e["command_id"] == claude["command"] and e["data"]["connector"] == "claude" and
                                             e["data"]["agent_session_id"] == claude["session"] for e in got), got)
    raw = p.stdout(claude["launch"]).decode().splitlines()
    check("claude.ordinary-lines-stay", len(got) == 3 and len(raw) == 6, {"events": len(got), "stdout_lines": len(raw)})

    got = t.wait_for(lambda: len(native_events(p, codex["launch"])) >= 2 and native_events(p, codex["launch"]), 15) or []
    shape = [(e["kind"], e["data"].get("signal"), e["data"].get("event"), e["data"].get("connector")) for e in got]
    check("codex.prompts-forwarded-verbatim", shape == [("native.question", "QUESTION", CODEX_INPUT, "codex"), ("native.approval", "APPROVAL_PROMPT", CODEX_APPROVAL, "codex")], shape)
    check("codex.attributed-to-launch", all(e["command_id"] == codex["command"] and e["data"]["agent_session_id"] == codex["session"] for e in got), got)

    got = t.wait_for(lambda: p.events(mixed["launch"], "launch.terminal") and native_events(p, mixed["launch"]), 15) or []
    kinds = [(e["kind"], e["data"].get("connector"), e["data"].get("signal")) for e in got]
    check("mixed.connector-inferred-and-trailing-line-judged", kinds == [("native.oversize", "claude", "QUESTION"), ("native.oversize", "claude", None),
                                                                         ("native.approval", "codex", "APPROVAL_PROMPT"), ("native.approval", "claude", "APPROVAL_PROMPT")], kinds)
    if len(got) == 4:
        big = line(OVERSIZE).encode()
        check("oversize.reported-by-digest", got[0]["data"] == {"connector": "claude", "agent_session_id": mixed["session"], "signal": "QUESTION", "bytes": str(len(big)),
                                                                 "complete": True, "digest": "sha256:" + hashlib.sha256(big).hexdigest()} and
              got[1]["data"]["complete"] is False and got[1]["data"]["digest"] is None and "event" not in got[1]["data"], got[:2])
        check("mixed.events-verbatim", got[2]["data"]["event"] == CODEX_APPROVAL and got[3]["data"]["event"] == CLAUDE_BASH, got[2:])

    everything = native_events(p, claude["launch"]) + native_events(p, codex["launch"]) + native_events(p, mixed["launch"])
    # A prompt is posted at once, not on the 30 s refresh cadence of a running launch.
    ok = t.wait_for(lambda: delivered(p, everything), 20)
    elapsed = time.monotonic() - started
    check("coordinator.received-promptly", ok and elapsed < 28 and len(everything) == 9, {"elapsed": elapsed, "events": len(everything)})
    state = p.cstate()
    check("coordinator.contract-held", not state["event_rejects"] and state["event_conflicts"] == 0 and state["proof_rejects"] == 0,
          {k: state[k] for k in ("event_rejects", "event_conflicts", "proof_rejects")})


probe = t.Probe()
try:
    scenario(probe)
except Exception:
    traceback.print_exc(file=sys.stderr)
    FAILED.append("scenario")
complete = probe.cleanup() and not any(probe.uid_processes(BASE_UID + k) for k in range(3))
print(json.dumps({"type": "cleanup", "complete": bool(complete)}), flush=True)
sys.exit(0 if complete and not FAILED else 1)
PY
echo "PASS: native events leave the sandbox (recorded Claude and Codex fixtures)"
