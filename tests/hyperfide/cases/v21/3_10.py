#!/usr/bin/env python3
"""hyperfide-v21 3.10: secret references reach the launched agent (D17).

Names and references travel; values are resolved at the edge and never logged.

1. The 6.3 START schema (core/control-plane events/instructions.ts) admits the
   body runner/dispatch.ts now issues with env_refs, still admits the body
   without them, and refuses a value, a reserved name or an empty map.
2. runner/dispatch.ts checks a plan's references against the environment
   profile of the pool that owns the token's sandbox, read from an owned
   throwaway PostgreSQL cluster (pattern of v21/2_8.py and v21/3_1.py); an
   undeclared reference is refused.
3. The dispatch-built START is delivered by the tasks/12_2.py coordinator
   stand-in to build/hyperfide-native launch.start, with the values resolved
   into the invocation as a provider does; the agent sees them, a START without
   references still launches, and no ledger, event, coordinator or reply byte
   carries a value.
4. core/native/src/hyperfide/job.c: a harness compiled from the native sources includes
   job.c and runs its own capture and child-environment functions in the
   production order (capture, environment cleared as readiness does, fork,
   clearenv in the child, exec); the job child observes the resolved variable
   and invalid, undeclared-value and conflicting references are refused.

Needs root (slot uids) and PostgreSQL server binaries; otherwise SKIP, exit 77.
"""
import importlib.util, json, os, pathlib, shlex, signal, sqlite3, subprocess, sys, tempfile, traceback, uuid

ROOT = pathlib.Path(__file__).resolve().parents[4]
NATIVE = ROOT / "build/hyperfide-native"
SERVICE = ROOT / "core/control-plane"
ASSERTIONS = [
    "fixture.root",
    "schema.start-with-references-admitted",
    "schema.start-without-references-unchanged",
    "schema.value-refused",
    "schema.reserved-name-refused",
    "schema.empty-map-refused",
    "dispatch.declared-references-admitted",
    "dispatch.undeclared-reference-refused",
    "dispatch.absent-references-empty",
    "launch.start-with-references-reaches-agent",
    "launch.running-reports-names",
    "launch.start-without-references-works",
    "launch.invalid-reference-refused",
    "launch.values-never-logged",
    "job.child-observes-resolved-variable",
    "job.without-references-unchanged",
    "job.invalid-reference-refused",
    "job.unavailable-value-refused",
    "job.explicit-conflict-refused",
    "job.values-never-reported",
]
RESULTS = {}
SECRETS = {"probe-a": "alpha-" + uuid.uuid4().hex, "probe-b": "beta-" + uuid.uuid4().hex}
REFS = {"PROBE_TOKEN_A": "secret-ref:probe-a", "PROBE_TOKEN_B": "secret-ref:probe-b"}
AGENT = os.path.realpath("/bin/sh")
AGENT_ARGV = [AGENT, "-c", 'exec /usr/bin/sed -u ""']
SLOT_UIDS = {"S1": 62890, "S2": 62891}  # Distinct from tasks/12_2.py (62240+) and v21/2_8.py (62880).


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def check(name, ok, detail=None):
    RESULTS[name] = bool(ok)
    if not ok:
        print("assertion failed: %s %s" % (name, json.dumps(detail, default=str)[:2000] if detail is not None else ""), file=sys.stderr, flush=True)


def leaked(data):
    if isinstance(data, str):
        data = data.encode()
    return [ref for ref, value in SECRETS.items() if value.encode() in data]


TS = r"""
import fs from 'node:fs';
import pg from './core/control-plane/node_modules/pg/lib/index.js';
import {instruction} from './core/control-plane/dist/events/instructions.js';
import {startInstructionBody,launchEnvReferences} from './core/control-plane/dist/runner/dispatch.js';
const input=JSON.parse(fs.readFileSync(0,'utf8'));
const settle=async f=>{try{return {ok:true,value:await f()};}catch(e){return {ok:false,code:e.code??String(e)};}};
let out;
if(input.mode==='start')out=await settle(()=>{
 const body=startInstructionBody(input.selected,input.selected.slot_id,input.env_refs);
 return instruction({...input.scope,kind:'START',body}).body;
});
else if(input.mode==='instruction')out=await settle(()=>instruction(input.value).body);
else if(input.mode==='profile'){
 const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try{out=await settle(()=>launchEnvReferences(c,input.organisation_id,input.sandbox_id,input.declared??undefined));}finally{await c.end();}
}else throw Error('unknown mode');
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


def environ(pid):
    try:
        return dict(item.split("=", 1) for item in pathlib.Path("/proc/%d/environ" % pid).read_bytes().decode().split("\0") if "=" in item)
    except OSError:
        return None


def executed(pid):
    try:
        return os.readlink("/proc/%d/exe" % pid) == os.path.realpath("/usr/bin/sed")
    except OSError:
        return False


def u():
    return str(uuid.uuid4())


def schema_scenario(base):
    scope = {"organisation_id": u(), "run_id": u(), "id": u(), "attempt_id": u(), "attempt_generation": "2", "authority_epoch": u(), "sandbox_boot_generation": "1"}
    selected = {"launch_id": u(), "slot_id": u(), "agent_session_id": u(), "connector_plan_digest": "sha256:" + "c" * 64}
    with_refs = ts(base, mode="start", scope=scope, selected=selected, env_refs=REFS)
    check("schema.start-with-references-admitted", with_refs.get("ok") and with_refs["value"].get("env_refs") == REFS and
          with_refs["value"].get("launch_id") == selected["launch_id"] and not leaked(json.dumps(with_refs)), with_refs)
    without = ts(base, mode="start", scope=scope, selected=selected, env_refs={})
    check("schema.start-without-references-unchanged", without.get("ok") and without["value"] == selected, without)
    body = dict(selected)
    value = ts(base, mode="instruction", value=dict(scope, kind="START", body=dict(body, env_refs={"PROBE_TOKEN_A": SECRETS["probe-a"]})))
    check("schema.value-refused", value == {"ok": False, "code": "INSTRUCTION_INPUT_INVALID"}, value)
    reserved = [ts(base, mode="instruction", value=dict(scope, kind="START", body=dict(body, env_refs={name: REFS["PROBE_TOKEN_A"]})))
                for name in ("PATH", "HF_TOKEN", "LD_PRELOAD")]
    check("schema.reserved-name-refused", all(r == {"ok": False, "code": "INSTRUCTION_INPUT_INVALID"} for r in reserved), reserved)
    empty = ts(base, mode="instruction", value=dict(scope, kind="START", body=dict(body, env_refs={})))
    steer = ts(base, mode="instruction", value=dict(scope, kind="CANCEL", body={"launch_id": body["launch_id"], "env_refs": REFS}))
    check("schema.empty-map-refused", empty == {"ok": False, "code": "INSTRUCTION_INPUT_INVALID"} and steer == {"ok": False, "code": "EVENT_INPUT_INVALID"}, [empty, steer])


def profile_scenario(t295, base):
    cluster = t295.Cluster()
    try:
        cluster.sql("CREATE ROLE " + t295.OPERATOR + " LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS", database="postgres")
        cluster.sql("CREATE DATABASE " + t295.DATABASE + " OWNER " + t295.OPERATOR, database="postgres")
        for attempt in range(6):
            try:
                t295.node(t295.MIGRATE, {**base, "DATABASE_URL": cluster.url(t295.OPERATOR)})
                break
            except AssertionError as error:
                if attempt == 5 or "TX_TIMEOUT" not in str(error):
                    raise
        org, profile, pool, sandbox = u(), u(), u(), u()
        manifest = json.dumps({"profile": {"credential_references": ["probe-a", "probe-b"]}})
        cluster.sql("INSERT INTO hyperfide.organisations(id,name) VALUES('%s','launch-reference-probe')" % org)
        cluster.sql("INSERT INTO hyperfide.environment_profiles(organisation_id,id,content_digest,provider,runtime_platform,manifest) VALUES('%s','%s','sha256:%s','blaxel','linux','%s'::jsonb)"
                    % (org, profile, "a" * 64, manifest.replace("'", "''")))
        cluster.sql("INSERT INTO hyperfide.provider_pools(organisation_id,id,provider,account_key,environment_key,region,profile_id) VALUES('%s','%s','blaxel','acct','env','region','%s')" % (org, pool, profile))
        cluster.sql("INSERT INTO hyperfide.sandboxes(organisation_id,id,pool_id,provider,account_key,native_sandbox_id) VALUES('%s','%s','%s','blaxel','acct','launch-reference-probe')" % (org, sandbox, pool))
        env = {**base, "DATABASE_URL": cluster.url(t295.SUPERUSER)}
        allowed = ts(env, mode="profile", organisation_id=org, sandbox_id=sandbox, declared=REFS)
        check("dispatch.declared-references-admitted", allowed == {"ok": True, "value": REFS}, allowed)
        undeclared = ts(env, mode="profile", organisation_id=org, sandbox_id=sandbox, declared={**REFS, "PROBE_TOKEN_C": "secret-ref:probe-c"})
        unknown = ts(env, mode="profile", organisation_id=org, sandbox_id=u(), declared=REFS)
        check("dispatch.undeclared-reference-refused", undeclared == {"ok": False, "code": "RUNNER_SECRET_REFERENCE_UNDECLARED"} and
              unknown == {"ok": False, "code": "RUNNER_SECRET_PROFILE_UNAVAILABLE"}, [undeclared, unknown])
        absent = ts(env, mode="profile", organisation_id=org, sandbox_id=u(), declared=None)
        check("dispatch.absent-references-empty", absent == {"ok": True, "value": {}}, absent)
    finally:
        removed = cluster.close()
    return removed


def setup_slots(p, t122):
    """tasks/12_2.py Probe.setup for two slots whose agent is GNU sed."""
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
    db = sqlite3.connect(p.slots / ".supervisor-slots.db")
    db.execute("CREATE TABLE slots(id TEXT PRIMARY KEY,uid INTEGER UNIQUE NOT NULL,gid INTEGER NOT NULL,boot_id TEXT NOT NULL,preparation TEXT NOT NULL,port INTEGER UNIQUE NOT NULL,state TEXT NOT NULL)")
    for index, (name, suid) in enumerate(SLOT_UIDS.items()):
        if p.uid_processes(suid):
            raise RuntimeError("slot uid %d is not quiescent" % suid)
        sid = t122.uid()
        db.execute("INSERT INTO slots VALUES(?,?,?,?,?,?,'READY')", (sid, suid, suid, p.ids["boot"], t122.sha(b"prep"), 41890 + index))
        root = p.slots / sid
        root.mkdir(mode=0o700)
        os.chown(root, suid, suid)
        for sub in ("worktree", "build", "home", "tmp", "sessions", "logs"):
            (root / sub).mkdir(mode=0o700)
            os.chown(root / sub, suid, suid)
        plan = {"dispatch_eligible": True, "requires_supervisor": True, "binary_digest": t122.sha(pathlib.Path(AGENT).read_bytes()), "argv": AGENT_ARGV,
                "cwd": str(root / "worktree"), "home": str(root / "home"), "temp": str(root / "tmp")}
        plan_path = t / ("plan-%s.json" % name)
        plan_path.write_bytes(t122.canonical(plan))
        os.chmod(plan_path, 0o600)
        config = t / ("runner-%s.json" % name)
        config.write_text(json.dumps({"transport_config": str(t / "transport.json"), "state_dir": str(p.state), "slot_root": str(p.slots),
                                      "connector_plan_path": str(plan_path), "organisation_id": p.ids["organisation"], "run_id": p.ids["run"],
                                      "sandbox_id": p.ids["sandbox"], "boot_id": p.ids["boot"], "boot_generation": p.generation,
                                      "consumer_id": p.ids["consumer"]}))
        os.chmod(config, 0o600)
        p.slot[name] = {"id": sid, "uid": suid, "config": str(config), "plan_digest": t122.sha(plan_path.read_bytes()), "worktree": str(root / "worktree")}
    db.commit()
    db.close()
    os.chmod(p.slots / ".supervisor-slots.db", 0o600)


def dispatched_start(p, base, slot, env_refs):
    """The START body runner/dispatch.ts issues, admitted by the 6.3 schema, then enqueued at the coordinator."""
    launch, attempt = u(), u()
    selected = {"launch_id": launch, "slot_id": p.slot[slot]["id"], "agent_session_id": u(), "connector_plan_digest": p.slot[slot]["plan_digest"]}
    scope = {"organisation_id": p.ids["organisation"], "run_id": p.ids["run"], "id": u(), "attempt_id": attempt, "attempt_generation": "2",
             "authority_epoch": p.ids["epoch"], "sandbox_boot_generation": p.generation}
    admitted = ts(base, mode="start", scope=scope, selected=selected, env_refs=env_refs)
    if not admitted.get("ok"):
        raise AssertionError("dispatch START refused by the schema: %s" % admitted)
    body = {k: v for k, v in admitted["value"].items() if k != "launch_id"}
    return launch, p.instruction("START", launch, body, attempt, held=True)


def launch_start(p, base, slot, ins, values):
    return subprocess.run([str(NATIVE), "--component", "12.2", "--action", "launch.start"], input=json.dumps({"config_path": p.slot[slot]["config"], "event_id": ins["id"]}),
                          text=True, capture_output=True, timeout=60, cwd=ROOT, env={**base, **values})


def sandbox_scenario(p, t122, base):
    setup_slots(p, t122)
    p.start_coordinator()
    replies = []

    # A malformed reference that bypassed the schema is refused by the supervisor before acceptance.
    launch_bad, attempt_bad = u(), u()
    bad = p.instruction("START", launch_bad, dict(p.start_body("S2"), env_refs={"PATH": REFS["PROBE_TOKEN_A"]}), attempt_bad, held=True)
    refused = launch_start(p, base, "S2", bad, resolve(REFS))
    replies.append(refused.stdout + refused.stderr)
    check("launch.invalid-reference-refused", "SECRET_REFERENCES_INVALID" in refused.stdout + refused.stderr and p.launch(launch_bad) is None and
          not p.uid_processes(SLOT_UIDS["S2"]), refused.stdout + refused.stderr)

    launch, start = dispatched_start(p, base, "S1", REFS)
    result = launch_start(p, base, "S1", start, resolve(REFS))
    replies.append(result.stdout + result.stderr)
    row = t122.wait_for(lambda: (p.launch(launch) or {}).get("state") == "RUNNING" and p.launch(launch), 15)
    # RUNNING is recorded once the gate is released; the environment is the agent's only after its exec.
    t122.wait_for(lambda: row and executed(row["agent_pid"]), 10)
    seen = environ(row["agent_pid"]) if row else None
    check("launch.start-with-references-reaches-agent", row and seen is not None and seen.get("PROBE_TOKEN_A") == SECRETS["probe-a"] and
          seen.get("PROBE_TOKEN_B") == SECRETS["probe-b"] and p.proc_uid(row["agent_pid"]) == SLOT_UIDS["S1"] and
          json.loads(row["body"]).get("env_refs") == REFS, {"start": result.stdout + result.stderr, "row": row})
    running = p.events(launch, "launch.running")
    refs = running[0]["data"].get("env_refs") if running else None
    check("launch.running-reports-names", refs == {"present": ["PROBE_TOKEN_A", "PROBE_TOKEN_B"], "missing": []}, refs)

    plain, start2 = dispatched_start(p, base, "S2", {})
    result2 = launch_start(p, base, "S2", start2, {})
    replies.append(result2.stdout + result2.stderr)
    row2 = t122.wait_for(lambda: (p.launch(plain) or {}).get("state") == "RUNNING" and p.launch(plain), 15)
    t122.wait_for(lambda: row2 and executed(row2["agent_pid"]), 10)
    seen2 = environ(row2["agent_pid"]) if row2 else None
    running2 = p.events(plain, "launch.running")
    check("launch.start-without-references-works", row2 and seen2 is not None and not any(k.startswith("PROBE_TOKEN_") for k in seen2) and
          "env_refs" not in json.loads(row2["body"]) and running2 and running2[0]["data"].get("env_refs") == {"present": [], "missing": []},
          {"start": result2.stdout + result2.stderr, "row": row2})

    stored = b"".join(f.read_bytes() for f in p.state.rglob("*") if f.is_file())
    coordinator = b"".join(f.read_bytes() for f in (p.tmp / "coordinator").rglob("*") if f.is_file()) + json.dumps(p.cstate()).encode()
    check("launch.values-never-logged", not leaked(stored) and not leaked(coordinator) and not leaked("".join(replies)),
          {"state": leaked(stored), "coordinator": leaked(coordinator), "replies": leaked("".join(replies))})


HARNESS = r"""
#include "job.c"
/* Drives job.c's own secret capture and child environment in production order. */
int main(int argc,char **argv){
 if(argc!=3)return 2;
 FILE *f=fopen(argv[1],"r");if(!f)return 2;static char raw[1<<20];size_t n=fread(raw,1,sizeof raw-1,f);fclose(f);raw[n]=0;
 HfJson *j=malloc(sizeof *j);if(!j||!hf_json_parse(j,raw))return 2;
 int plan=hf_json_field(j,0,"plan");EnvEntry env[64]={0};int count=0;char digest[65];
 if(plan<0||!environment(j,plan,env,&count,digest))return 2;
 JobSecretsStatus status=job_secrets_capture(j,plan,&job_secrets);
 printf("{\"status\":%d,\"names\":[",(int)status);for(int k=0;k<job_secrets.n;++k)printf("%s\"%s\"",k?",":"",job_secrets.name[k]);printf("]}\n");fflush(stdout);
 if(status!=JOB_SECRETS_OK){job_secrets_clear(&job_secrets);return 0;}
 /* readiness() clears this process's environment before the job child forks. */
 if(clearenv()||setenv("HF_READINESS_SCAN_POLICY_FILE","/dev/null",1))return 3;
 pid_t child=fork();
 if(child==0){int fd=open(argv[2],O_WRONLY|O_CREAT|O_TRUNC|O_CLOEXEC,0600);if(fd<0||dup2(fd,1)<0)_exit(125);
  if(!job_child_environment("/nonexistent-home","/tmp",env,count,&job_secrets))_exit(125);
  char *args[]={"/usr/bin/env",NULL};execve(args[0],args,environ);_exit(127);}
 int st=0;waitpid(child,&st,0);job_secrets_clear(&job_secrets);
 return WIFEXITED(st)&&WEXITSTATUS(st)==0?0:4;
}
"""


def job_scenario(base, work):
    sources = subprocess.run(["python3", "tools/repository/hyperfide-native-components.py", "--sources"], cwd=ROOT, text=True, capture_output=True, check=True).stdout.split()
    libraries = subprocess.run(["python3", "tools/repository/hyperfide-native-components.py", "--libraries"], cwd=ROOT, text=True, capture_output=True, check=True).stdout.split()
    sources = [s for s in sources if s != "core/native/src/hyperfide/job.c"]
    (work / "harness.c").write_text(HARNESS)
    binary = work / "job-harness"
    built = subprocess.run(["cc", "-std=gnu11", "-O0", "-w", "-pthread", "-Icore/native/src/hyperfide", "-Ibuild", "-o", str(binary), str(work / "harness.c"), "core/native/src/sha256.c", *sources,
                            "-lsqlite3", "-lpthread", "-lm", "-lcurl", "-lcrypto", *libraries], cwd=ROOT, text=True, capture_output=True, timeout=600)
    if built.returncode:
        raise AssertionError("job harness build failed: " + built.stderr[-3000:])

    def run(plan, values):
        path = work / ("claim-%s.json" % u())
        path.write_text(json.dumps({"plan": plan}))
        out = work / ("env-%s.txt" % u())
        p = subprocess.run([str(binary), str(path), str(out)], text=True, capture_output=True, timeout=60, env={"PATH": "/usr/bin:/bin", "UNRELATED": "inherited", **values})
        report = json.loads(p.stdout.splitlines()[0]) if p.stdout.strip() else None
        child = dict(line.split("=", 1) for line in out.read_text().splitlines() if "=" in line) if out.exists() else None
        return p.returncode, report, child, p.stdout + p.stderr

    explicit = {"BUILD_MODE": "release"}
    code, report, child, text = run({"environment": explicit, "env_refs": REFS}, resolve(REFS))
    outputs = [text]
    check("job.child-observes-resolved-variable", code == 0 and report == {"status": 0, "names": ["PROBE_TOKEN_A", "PROBE_TOKEN_B"]} and child is not None and
          child.get("PROBE_TOKEN_A") == SECRETS["probe-a"] and child.get("PROBE_TOKEN_B") == SECRETS["probe-b"] and child.get("BUILD_MODE") == "release" and
          "UNRELATED" not in child and "HF_READINESS_SCAN_POLICY_FILE" not in child and child.get("PATH") == "/usr/local/bin:/usr/bin:/bin", [code, report, sorted(child or {})])
    code, report, child, text = run({"environment": explicit}, resolve(REFS))
    outputs.append(text)
    check("job.without-references-unchanged", code == 0 and report == {"status": 0, "names": []} and child is not None and
          not any(k.startswith("PROBE_TOKEN_") for k in child) and child.get("BUILD_MODE") == "release", [code, report, sorted(child or {})])
    invalid = [run({"environment": {}, "env_refs": refs}, resolve(REFS)) for refs in
               ({"PATH": REFS["PROBE_TOKEN_A"]}, {"HF_TOKEN": REFS["PROBE_TOKEN_A"]}, {"PROBE_TOKEN_A": SECRETS["probe-a"]}, {"PROBE_TOKEN_A": 7})]
    outputs.extend(r[3] for r in invalid)
    check("job.invalid-reference-refused", all(r[0] == 0 and r[1]["status"] == 1 and r[2] is None for r in invalid), [r[:2] for r in invalid])
    code, report, child, text = run({"environment": {}, "env_refs": REFS}, resolve({"PROBE_TOKEN_A": REFS["PROBE_TOKEN_A"]}))
    outputs.append(text)
    check("job.unavailable-value-refused", code == 0 and report["status"] == 2 and child is None, [code, report])
    code, report, child, text = run({"environment": {"PROBE_TOKEN_A": "explicit"}, "env_refs": REFS}, resolve(REFS))
    outputs.append(text)
    check("job.explicit-conflict-refused", code == 0 and report["status"] == 1 and child is None, [code, report])
    check("job.values-never-reported", not leaked("".join(outputs)), leaked("".join(outputs)))


def ensure_builds(base):
    """The verify_cmd builds cg; this case also needs the service dist and the native dispatcher."""
    if not (SERVICE / "node_modules/pg").exists():
        subprocess.run(["npm", "--prefix", str(SERVICE), "ci", "--ignore-scripts"], cwd=ROOT, check=True, stdout=subprocess.DEVNULL, env=base)
    subprocess.run(["npm", "--prefix", str(SERVICE), "run", "build"], cwd=ROOT, check=True, stdout=subprocess.DEVNULL, env=base)
    subprocess.run(["make", "-s", "hyperfide-native"], cwd=ROOT, check=True, stdout=subprocess.DEVNULL, env=base)


def main():
    if os.geteuid() != 0:
        print("SKIP: task 3.10 needs root for slot uids and the native supervisor", flush=True)
        return 77
    t122 = load("hf_case_12_2", "tests/hyperfide/cases/tasks/12_2.py")
    t295 = load("hf_case_29_5", "tests/hyperfide/cases/tasks/29_5.py")
    configured = os.environ.get("HYPERFIDE_PG_BIN")
    servers = [pathlib.Path(configured)] if configured else sorted(
        (path for path in pathlib.Path("/usr/lib/postgresql").glob("*/bin") if path.parent.name.isdigit() and (path / "initdb").exists()),
        key=lambda path: int(path.parent.name))
    if not servers or not (servers[-1] / "initdb").exists():
        print("SKIP: no PostgreSQL server binaries (initdb); set HYPERFIDE_PG_BIN", flush=True)
        return 77
    t295.postgres_bin = lambda: servers[-1]
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    import ctypes
    ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0)
    base = os.environ.copy()
    for key in list(base):
        if key == "DATABASE_URL" or key.startswith("HYPERFIDE_") and key.endswith("_DATABASE_URL") or key.startswith("PROBE_TOKEN_"):
            del base[key]
    ensure_builds(base)
    check("fixture.root", NATIVE.exists())
    for scenario in (schema_scenario,):
        try:
            scenario(base)
        except Exception:
            traceback.print_exc(file=sys.stderr)
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
    complete = probe.cleanup() and not any(probe.uid_processes(suid) for suid in SLOT_UIDS.values())
    work = pathlib.Path(tempfile.mkdtemp(prefix="hf310-job-"))
    try:
        job_scenario(base, work)
    except Exception:
        traceback.print_exc(file=sys.stderr)
    finally:
        subprocess.run(["rm", "-rf", str(work)], check=False)
    work_removed = not work.exists()
    for name in ASSERTIONS:
        print(json.dumps({"type": "assertion", "id": name, "expected": True, "actual": RESULTS.get(name, False)}), flush=True)
    resources = [{"id": "postgres-cluster", "status": "deleted" if cluster_removed else "unknown", "observed_absent": cluster_removed},
                 {"id": "job-harness-dir", "status": "deleted" if work_removed else "unknown", "observed_absent": work_removed}]
    resources += [{"id": "slot-uid-%d" % suid, "status": "deleted" if complete else "unknown", "observed_absent": complete} for suid in SLOT_UIDS.values()]
    print(json.dumps({"type": "cleanup", "resources": resources, "complete": bool(complete and cluster_removed and work_removed)}), flush=True)
    return 0 if complete and cluster_removed and work_removed and all(RESULTS.get(name) for name in ASSERTIONS) else 1


if __name__ == "__main__":
    raise SystemExit(main())
