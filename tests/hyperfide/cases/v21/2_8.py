#!/usr/bin/env python3
"""Task 2.8: secret references reach running sandboxes.

A START declares two secret references; only one value is available when the
agent launches. The executor's relaunch request (core/control-plane dist)
supplies the second, the native supervisor replaces the agent process inside
the same launch and attempt, and the new process sees both variables.

The environment profile allowlist is read from an owned throwaway PostgreSQL
cluster (pattern of tasks/29_5.py). The provider is stood in for by this file:
it resolves secret-ref IDs from a local map into the environment of
build/hyperfide-native, exactly what a provider does with env_refs. No provider
is contacted. The sandbox agent is a local /bin/sh that prints its environment
and then echoes stdin through GNU sed.
"""
import importlib.util, json, os, pathlib, signal, sqlite3, subprocess, sys, traceback, uuid

ROOT = pathlib.Path(__file__).resolve().parents[4]
NATIVE = ROOT / "build/hyperfide-native"
EXECUTOR = ROOT / "core/control-plane/dist/runner/executor.js"
ASSERTIONS = [
    "fixture.root",
    "profile.declared-references-allowed",
    "profile.undeclared-reference-refused",
    "profile.missing-profile-refused",
    "references.invalid-name-refused",
    "request.carries-references-not-values",
    "launch.declared-reference-present",
    "launch.missing-reference-reported",
    "relaunch.unavailable-value-refused",
    "relaunch.invalid-name-refused",
    "relaunch.new-reference-reaches-process",
    "relaunch.attempt-identity-preserved",
    "relaunch.receipt-validated",
    "relaunch.ack-identity-unchanged",
    "relaunch.ledger-holds-names-only",
    "relaunch.stdin-follows-new-agent",
]
RESULTS = {}
SECRETS = {"probe-a": "alpha-" + uuid.uuid4().hex, "probe-b": "beta-" + uuid.uuid4().hex}
REFS = {"PROBE_TOKEN_A": "secret-ref:probe-a", "PROBE_TOKEN_B": "secret-ref:probe-b"}
AGENT = os.path.realpath("/bin/sh")
AGENT_ARGV = [AGENT, "-c", '/usr/bin/env; exec /usr/bin/sed -u ""']
SLOT_UID = 62880  # Distinct from tasks/12_2.py (62240+) so the two probes never share a slot.


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def check(name, ok, detail=None):
    RESULTS[name] = bool(ok)
    if not ok:
        print("assertion failed: %s %s" % (name, json.dumps(detail, default=str)[:2000] if detail is not None else ""), file=sys.stderr, flush=True)


TS = r"""
import fs from 'node:fs';
import pg from './core/control-plane/node_modules/pg/lib/index.js';
import {taskEnvReferences,declaredEnvReferences,relaunchRequest,validateRelaunchReceipt} from './core/control-plane/dist/runner/executor.js';
const input=JSON.parse(fs.readFileSync(0,'utf8'));
const settle=async f=>{try{return {ok:true,value:await f()};}catch(e){return {ok:false,code:e.code??String(e)};}};
let out;
if(input.mode==='profile'){
 const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try{out=await settle(()=>taskEnvReferences(c,input.organisation_id,input.pool_id,input.declared));}finally{await c.end();}
}else if(input.mode==='declared')out=await settle(()=>declaredEnvReferences(input.declared,input.profile));
else if(input.mode==='relaunch')out=await settle(()=>relaunchRequest(input.binding,input.input,input.env_refs));
else if(input.mode==='receipt')out=await settle(()=>validateRelaunchReceipt(input.receipt,input.target,input.command_id,input.names));
else throw Error('unknown mode');
process.stdout.write(JSON.stringify(out));
"""


def ts(env, **request):
    p = subprocess.run(["node", "--input-type=module", "-e", TS], cwd=ROOT, env=env, input=json.dumps(request), text=True, capture_output=True, timeout=120)
    if p.returncode:
        raise AssertionError(p.stderr + p.stdout)
    return json.loads(p.stdout)


def resolve(env_refs):
    """Provider stand-in: secret-ref IDs become values in the invocation environment."""
    return {name: SECRETS[ref[len("secret-ref:"):]] for name, ref in env_refs.items() if ref[len("secret-ref:"):] in SECRETS}


def invoke(request, values):
    env = {"PATH": "/usr/bin:/bin", **values}
    p = subprocess.run(request["argv"], cwd=ROOT, env=env, text=True, capture_output=True, timeout=60, stdin=subprocess.DEVNULL)
    try:
        output = json.loads(p.stdout) if p.stdout.strip() else None
    except ValueError:
        output = None
    return p.returncode, output, p.stderr


def environ(pid):
    try:
        return dict(item.split("=", 1) for item in pathlib.Path("/proc/%d/environ" % pid).read_bytes().decode().split("\0") if "=" in item)
    except OSError:
        return None


def profile_scenario(t295, base):
    """Environment profile allowlist read from an owned cluster through the executor's own query."""
    cluster = t295.Cluster()
    try:
        cluster.sql("CREATE ROLE " + t295.OPERATOR + " LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS", database="postgres")
        cluster.sql("CREATE DATABASE " + t295.DATABASE + " OWNER " + t295.OPERATOR, database="postgres")
        # tasks/29_5.py migration. The migrator caps each run at 30 s; on a loaded host a
        # rerun resumes from the versions already committed.
        for attempt in range(6):
            try:
                t295.node(t295.MIGRATE, {**base, "DATABASE_URL": cluster.url(t295.OPERATOR)})
                break
            except AssertionError as error:
                if attempt == 5 or "TX_TIMEOUT" not in str(error):
                    raise
        org, profile, pool, bare = (str(uuid.uuid4()) for _ in range(4))
        manifest = json.dumps({"profile": {"credential_references": ["probe-a", "probe-b"]}})
        cluster.sql("INSERT INTO hyperfide.organisations(id,name) VALUES('%s','secret-reference-probe')" % org)
        cluster.sql("INSERT INTO hyperfide.environment_profiles(organisation_id,id,content_digest,provider,runtime_platform,manifest) VALUES('%s','%s','sha256:%s','blaxel','linux','%s'::jsonb)"
                    % (org, profile, "a" * 64, manifest.replace("'", "''")))
        cluster.sql("INSERT INTO hyperfide.provider_pools(organisation_id,id,provider,account_key,environment_key,region,profile_id) VALUES('%s','%s','blaxel','acct','env','region','%s')" % (org, pool, profile))
        cluster.sql("INSERT INTO hyperfide.provider_pools(organisation_id,id,provider,account_key,environment_key,region,profile_id) VALUES('%s','%s','blaxel','acct','env','region',NULL)" % (org, bare))
        env = {**base, "DATABASE_URL": cluster.url(t295.SUPERUSER)}
        allowed = ts(env, mode="profile", organisation_id=org, pool_id=pool, declared=REFS)
        check("profile.declared-references-allowed", allowed == {"ok": True, "value": REFS}, allowed)
        undeclared = ts(env, mode="profile", organisation_id=org, pool_id=pool, declared={**REFS, "PROBE_TOKEN_C": "secret-ref:probe-c"})
        check("profile.undeclared-reference-refused", undeclared == {"ok": False, "code": "RUNNER_SECRET_REFERENCE_UNDECLARED"}, undeclared)
        missing = ts(env, mode="profile", organisation_id=org, pool_id=bare, declared=REFS)
        none = ts(env, mode="declared", declared={}, profile=None)
        check("profile.missing-profile-refused", missing == {"ok": False, "code": "RUNNER_SECRET_PROFILE_UNAVAILABLE"} and none == {"ok": True, "value": {}}, [missing, none])
    finally:
        removed = cluster.close()
    return removed


def setup_slot(p, t122):
    """tasks/12_2.py Probe.setup for one slot whose agent prints its environment."""
    t = p.tmp
    p.openssl("req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes", "-keyout", str(t / "tls.key"), "-out", str(t / "ca.pem"),
              "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-days", "1")
    os.chmod(t / "tls.key", 0o600)
    os.chmod(t / "ca.pem", 0o644)
    p.openssl("genpkey", "-algorithm", "Ed25519", "-out", str(t / "runner.key"))
    os.chmod(t / "runner.key", 0o600)
    p.openssl("pkey", "-in", str(t / "runner.key"), "-pubout", "-out", str(t / "runner.pub"))
    import socket
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        p.port = s.getsockname()[1]
    p.origin = "https://localhost:%d" % p.port
    p.control_token = t122.uid()
    (t / "coordinator").mkdir(mode=0o700)
    (t / "coordinator/coordinator.json").write_text(json.dumps({
        "port": p.port, "cert": str(t / "ca.pem"), "key": str(t / "tls.key"), "runner_public_key": str(t / "runner.pub"),
        "origin": p.origin, "credential_id": p.ids["credential"], "organisation_id": p.ids["organisation"], "run_id": p.ids["run"],
        "sandbox_id": p.ids["sandbox"], "boot_id": p.ids["boot"], "boot_generation": p.generation, "consumer_id": p.ids["consumer"],
        "authority_epoch": p.ids["epoch"], "control_token": p.control_token}))
    (t / "transport.json").write_text(json.dumps({"origin": p.origin, "ca_file": str(t / "ca.pem"), "key_path": str(t / "runner.key"),
                                                  "credential_id": p.ids["credential"], "timeout_ms": 2000}))
    os.chmod(t / "transport.json", 0o600)
    if p.uid_processes(SLOT_UID):
        raise RuntimeError("slot uid %d is not quiescent" % SLOT_UID)
    db = sqlite3.connect(p.slots / ".supervisor-slots.db")
    db.execute("CREATE TABLE slots(id TEXT PRIMARY KEY,uid INTEGER UNIQUE NOT NULL,gid INTEGER NOT NULL,boot_id TEXT NOT NULL,preparation TEXT NOT NULL,port INTEGER UNIQUE NOT NULL,state TEXT NOT NULL)")
    sid = t122.uid()
    db.execute("INSERT INTO slots VALUES(?,?,?,?,?,?,'READY')", (sid, SLOT_UID, SLOT_UID, p.ids["boot"], t122.sha(b"prep"), 41880))
    db.commit()
    db.close()
    os.chmod(p.slots / ".supervisor-slots.db", 0o600)
    root = p.slots / sid
    root.mkdir(mode=0o700)
    os.chown(root, SLOT_UID, SLOT_UID)
    for sub in ("worktree", "build", "home", "tmp", "sessions", "logs"):
        (root / sub).mkdir(mode=0o700)
        os.chown(root / sub, SLOT_UID, SLOT_UID)
    plan = {"dispatch_eligible": True, "requires_supervisor": True, "binary_digest": t122.sha(pathlib.Path(AGENT).read_bytes()), "argv": AGENT_ARGV,
            "cwd": str(root / "worktree"), "home": str(root / "home"), "temp": str(root / "tmp")}
    plan_path = t / "plan-S1.json"
    plan_path.write_bytes(t122.canonical(plan))
    os.chmod(plan_path, 0o600)
    config = t / "runner-S1.json"
    config.write_text(json.dumps({"transport_config": str(t / "transport.json"), "state_dir": str(p.state), "slot_root": str(p.slots),
                                  "connector_plan_path": str(plan_path), "organisation_id": p.ids["organisation"], "run_id": p.ids["run"],
                                  "sandbox_id": p.ids["sandbox"], "boot_id": p.ids["boot"], "boot_generation": p.generation,
                                  "consumer_id": p.ids["consumer"]}))
    os.chmod(config, 0o600)
    p.slot["S1"] = {"id": sid, "uid": SLOT_UID, "config": str(config), "plan_digest": t122.sha(plan_path.read_bytes()), "worktree": str(root / "worktree")}


def sandbox_scenario(p, t122, base):
    setup_slot(p, t122)
    p.start_coordinator()
    attempt, launch, session = t122.uid(), t122.uid(), t122.uid()
    start = p.instruction("START", launch, dict(p.start_body("S1", session), env_refs=REFS), attempt, held=True)
    # Only reference A resolves at launch; B is supplied later.
    first = resolve({"PROBE_TOKEN_A": REFS["PROBE_TOKEN_A"]})
    result = subprocess.run([str(NATIVE), "--component", "12.2", "--action", "launch.start"], input=json.dumps({"config_path": p.slot["S1"]["config"], "event_id": start["id"]}),
                            text=True, capture_output=True, timeout=60, cwd=ROOT, env={**base, **first})
    row = t122.wait_for(lambda: (p.launch(launch) or {}).get("state") == "RUNNING" and p.launch(launch), 15)
    t122.wait_for(lambda: b"PROBE_TOKEN_A=" in p.stdout(launch), 10)
    agent0 = row["agent_pid"] if row else None
    seen0 = environ(agent0) if agent0 else None
    out0 = p.stdout(launch).decode(errors="replace")
    check("launch.declared-reference-present", row and seen0 is not None and seen0.get("PROBE_TOKEN_A") == SECRETS["probe-a"] and "PROBE_TOKEN_B" not in seen0 and
          ("PROBE_TOKEN_A=" + SECRETS["probe-a"]) in out0 and "PROBE_TOKEN_B" not in out0, {"start": result.stdout + result.stderr, "row": row, "stdout": out0})
    running = p.events(launch, "launch.running")
    refs = running[0]["data"].get("env_refs") if running else None
    check("launch.missing-reference-reported", refs == {"present": ["PROBE_TOKEN_A"], "missing": ["PROBE_TOKEN_B"]}, refs)

    # The executor builds the relaunch request; the provider stand-in resolves it.
    binding = {"organisation_id": p.ids["organisation"], "run_id": p.ids["run"], "session_id": session, "pool_id": t122.uid(), "sandbox_id": p.ids["sandbox"],
               "external_sandbox_id": "local-probe", "boot_generation": p.generation, "boot_preparation_digest": t122.sha(b"prep"),
               "workspace_path": p.slot["S1"]["worktree"], "state_dir": str(p.state), "launch_id": launch, "attempt_id": attempt,
               "attempt_generation": start["attempt_generation"], "boot_id": p.ids["boot"], "runner_binary": str(NATIVE)}
    command = t122.uid()
    supplied = {"PROBE_TOKEN_B": REFS["PROBE_TOKEN_B"]}
    built = ts(base, mode="relaunch", binding=binding, input={"operation_id": t122.uid(), "command_id": command}, env_refs=supplied)
    request = built.get("value", {})
    target = json.loads(t122.unb64(request["argv"][-1])) if built.get("ok") else {}
    empty = ts(base, mode="relaunch", binding=binding, input={"operation_id": t122.uid(), "command_id": command}, env_refs={})
    check("request.carries-references-not-values", built.get("ok") and request["env_refs"] == supplied and request["argv"][1:5] == ["--component", "12.2", "--action", "launch.relaunch"] and
          target.get("env_refs") == supplied and target.get("launch_id") == launch and target.get("attempt_id") == attempt and
          all(v not in json.dumps(request) for v in SECRETS.values()) and empty == {"ok": False, "code": "RUNNER_SECRET_REFERENCE_INVALID"}, [built, empty])

    bad = ts(base, mode="declared", declared={"HF_TOKEN": REFS["PROBE_TOKEN_A"]}, profile=["probe-a"])
    path = ts(base, mode="declared", declared={"PATH": REFS["PROBE_TOKEN_A"]}, profile=["probe-a"])
    raw = ts(base, mode="declared", declared={"PROBE_TOKEN_A": SECRETS["probe-a"]}, profile=["probe-a"])
    check("references.invalid-name-refused", all(r == {"ok": False, "code": "RUNNER_SECRET_REFERENCE_INVALID"} for r in (bad, path, raw)), [bad, path, raw])

    code, out, err = invoke(request, {})
    check("relaunch.unavailable-value-refused", code != 0 and "SECRET_REFERENCE_UNAVAILABLE" in (err + json.dumps(out)) and p.launch(launch)["agent_pid"] == agent0 and
          p.alive(agent0, row["agent_start"]), [code, out, err])
    forged = dict(target, env_refs={"PATH": REFS["PROBE_TOKEN_B"]})
    code, out, err = invoke({"argv": request["argv"][:-1] + [t122.b64(json.dumps(forged).encode())]}, {"PATH": SECRETS["probe-b"]})
    check("relaunch.invalid-name-refused", code != 0 and "INVALID_RELAUNCH" in (err + json.dumps(out)) and p.launch(launch)["agent_pid"] == agent0, [code, out, err])

    code, out, err = invoke(request, resolve(supplied))
    receipt = (out or {}).get("result", {}) if code == 0 else {}
    after = p.launch(launch) or {}
    agent1 = after.get("agent_pid")
    t122.wait_for(lambda: p.stdout(launch).count(b"PROBE_TOKEN_A=") >= 2, 10)
    seen1 = environ(agent1) if agent1 else None
    out1 = p.stdout(launch).decode(errors="replace")[len(out0):]
    check("relaunch.new-reference-reaches-process", seen1 is not None and seen1.get("PROBE_TOKEN_B") == SECRETS["probe-b"] and seen1.get("PROBE_TOKEN_A") == SECRETS["probe-a"] and
          ("PROBE_TOKEN_B=" + SECRETS["probe-b"]) in out1 and p.proc_uid(agent1) == SLOT_UID and not p.alive(agent0, row["agent_start"]), {"code": code, "out": out, "err": err, "stdout": out1})
    check("relaunch.attempt-identity-preserved", receipt.get("relaunched") is True and receipt.get("launch_id") == launch and receipt.get("attempt_id") == attempt and
          receipt.get("attempt_generation") == start["attempt_generation"] and after.get("id") == launch and after.get("command") == start["id"] and
          after.get("state") == "RUNNING" and agent1 != agent0 and after.get("broker_pid") == row["broker_pid"] and
          len(p.ledger("SELECT id FROM launches")) == 1 and p.uid_processes(SLOT_UID) == [agent1], {"receipt": receipt, "after": after})
    target_identity = {"launch_id": launch, "attempt_id": attempt, "attempt_generation": start["attempt_generation"], "sandbox_id": p.ids["sandbox"],
                       "boot_id": p.ids["boot"], "boot_generation": p.generation, "uid": SLOT_UID}
    good = ts(base, mode="receipt", receipt=receipt, target=target_identity, command_id=command, names=["PROBE_TOKEN_B"])
    moved = ts(base, mode="receipt", receipt=dict(receipt, attempt_id=t122.uid()), target=target_identity, command_id=command, names=["PROBE_TOKEN_B"])
    check("relaunch.receipt-validated", good.get("ok") is True and sorted(receipt.get("env_ref_names", [])) == ["PROBE_TOKEN_A", "PROBE_TOKEN_B"] and
          moved == {"ok": False, "code": "RUNNER_RELAUNCH_ATTEMPT_CHANGED"}, [good, moved, receipt])

    relaunched = p.events(launch, "launch.relaunched")
    data = relaunched[0]["data"] if relaunched else {}
    t122.wait_for(lambda: (start["id"] + ":2") in p.cstate()["acks"], 15)
    state = p.cstate()
    acks = sorted(k for k in state["acks"] if k.startswith(start["id"] + ":"))
    check("relaunch.ack-identity-unchanged", acks == [start["id"] + ":1", start["id"] + ":2"] and state["acks"][start["id"] + ":2"]["observed_process"]["pid"] == agent0 and
          state["ack_conflicts"] == 0 and not state["ack_rejects"], {"acks": acks, "conflicts": state["ack_conflicts"]})

    # A STEER after the relaunch goes to the new agent's stdin.
    steer = p.instruction("STEER", launch, p.steer_body(b"after-relaunch\n"), attempt)
    code_s, out_s, _ = p.native("launch.instruction", {"config_path": p.slot["S1"]["config"], "event_id": steer["id"]})
    delivered = t122.wait_for(lambda: p.stdout(launch).endswith(b"after-relaunch\n"), 10)
    check("relaunch.stdin-follows-new-agent", delivered and p.alive(agent1), [code_s, out_s])

    ledger = b"".join(f.read_bytes() for f in p.state.iterdir() if f.name.startswith("launches.db"))
    coordinator = (p.tmp / "coordinator/state.json").read_bytes() if (p.tmp / "coordinator/state.json").exists() else b""
    coordinator += json.dumps(p.cstate()).encode()
    check("relaunch.ledger-holds-names-only", data.get("command_id") == command and data.get("attempt_id") == attempt and
          data.get("env_refs") == {"present": ["PROBE_TOKEN_A", "PROBE_TOKEN_B"], "missing": []} and data.get("agent", {}).get("pid") == agent1 and
          data.get("previous_agent", {}).get("pid") == agent0 and all(v.encode() not in ledger + coordinator for v in SECRETS.values()), data)


def fixture_root(libc, euid=None):
    """The probe reaps the agents it launches: it runs as root and is the child
    subreaper, read back from the kernel rather than assumed."""
    import ctypes
    euid = os.geteuid() if euid is None else euid
    set_rc = libc.prctl(36, 1, 0, 0, 0)  # PR_SET_CHILD_SUBREAPER
    reaper = ctypes.c_int(0)
    get_rc = libc.prctl(37, ctypes.byref(reaper), 0, 0, 0)  # PR_GET_CHILD_SUBREAPER
    detail = {"euid": euid, "set": set_rc, "get": get_rc, "subreaper": reaper.value}
    return euid == 0 and set_rc == 0 and get_rc == 0 and reaper.value == 1, detail


def main():
    if os.geteuid() != 0:
        print("SKIP: task 2.8 sandbox probe needs root for slot uids and the native supervisor", flush=True)
        return 77
    if not EXECUTOR.exists() or not NATIVE.exists():
        print("assertion failed: build core/control-plane (npm run build) and build/hyperfide-native first", file=sys.stderr)
        return 1
    t122 = load("hf_case_12_2", "tests/hyperfide/cases/tasks/12_2.py")
    t295 = load("hf_case_29_5", "tests/hyperfide/cases/tasks/29_5.py")
    configured = os.environ.get("HYPERFIDE_PG_BIN")
    # A client-only package can leave a newer version directory without server binaries.
    servers = [pathlib.Path(configured)] if configured else sorted(
        (path for path in pathlib.Path("/usr/lib/postgresql").glob("*/bin") if path.parent.name.isdigit() and (path / "initdb").exists()),
        key=lambda path: int(path.parent.name))
    if not servers or not (servers[-1] / "initdb").exists():
        print("SKIP: no PostgreSQL server binaries (initdb); set HYPERFIDE_PG_BIN", flush=True)
        return 77
    t295.postgres_bin = lambda: servers[-1]
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    import ctypes
    check("fixture.root", *fixture_root(ctypes.CDLL(None, use_errno=True)))
    base = os.environ.copy()
    for key in list(base):
        if key == "DATABASE_URL" or key.startswith("HYPERFIDE_") and key.endswith("_DATABASE_URL") or key.startswith("PROBE_TOKEN_"):
            del base[key]
    cluster_removed = False
    try:
        cluster_removed = profile_scenario(t295, base)
    except Exception:
        traceback.print_exc(file=sys.stderr)
    probe = t122.Probe()
    try:
        sandbox_scenario(probe, t122, base)
    except Exception:
        traceback.print_exc(file=sys.stderr)
    complete = probe.cleanup() and not probe.uid_processes(SLOT_UID)
    for name in ASSERTIONS:
        print(json.dumps({"type": "assertion", "id": name, "expected": True, "actual": RESULTS.get(name, False)}), flush=True)
    print(json.dumps({"type": "cleanup", "resources": [{"id": "postgres-cluster", "status": "deleted" if cluster_removed else "unknown", "observed_absent": cluster_removed},
                                                       {"id": "slot-uid-%d" % SLOT_UID, "status": "deleted" if complete else "unknown", "observed_absent": complete}],
                      "complete": bool(complete and cluster_removed)}), flush=True)
    return 0 if complete and cluster_removed and all(RESULTS.get(name) for name in ASSERTIONS) else 1


if __name__ == "__main__":
    raise SystemExit(main())
