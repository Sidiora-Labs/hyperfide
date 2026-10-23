#!/usr/bin/env python3
"""hyperfide-v21 3.15: launch references have a producer (D17).

Names and references travel; values are resolved at the edge and never stored.

1. Producer (owned throwaway PostgreSQL cluster, pattern of v21/3_10.py): a task
   whose definition declares env_refs, bound to a worker session on a sandbox
   whose pool profile allows them, is read by agents/env_refs.ts
   admissionEnvReferences (the one call admission.ts launchSelection makes);
   agents/dispatch.ts insertLaunchPlan stores them in
   hyperfide.native_launch_plans.env_refs (migration 0713) and launchPlan()
   returns them. Undeclared and malformed declarations are refused, a task
   without a declaration produces a plan without references, and the stored
   column is immutable and accepts references only. The fixture rows that the
   plan's foreign keys need (task, attempt, session, dispatch, reservation) are
   seeded with session_replication_role=replica; the code under test is the
   shipped dist.
2. START: runner/dispatch.ts re-checks the plan's references against the
   profile and issues a 6.3-admitted START carrying exactly the declared names
   and no value; a START naming an undeclared reference is refused.
3. Serve mode: build/hyperfide-native launch.serve, started with the provider-
   resolved environment, resolves references per START from that exec
   environment: a START whose reference it cannot resolve is refused with
   SECRET_REFERENCE_UNAVAILABLE and nothing is spawned, and the next START with
   resolvable references launches an agent that sees exactly its declared
   variables.

Needs root (slot uids) and PostgreSQL server binaries; otherwise SKIP, exit 77.
"""
import importlib.util, json, os, pathlib, signal, subprocess, sys, traceback, uuid

ROOT = pathlib.Path(__file__).resolve().parents[4]
NATIVE = ROOT / "build/hyperfide-native"
ASSERTIONS = [
    "fixture.root",
    "producer.selection-reads-declaration",
    "producer.plan-stores-references",
    "producer.launch-plan-returns-references",
    "producer.undeclared-declaration-refused",
    "producer.malformed-declaration-refused",
    "producer.undeclared-task-plan-empty",
    "producer.column-immutable",
    "producer.column-refuses-values",
    "start.carries-declared-names-only",
    "start.undeclared-reference-refused",
    "start.no-values-stored-or-issued",
    "serve.unresolvable-start-refused",
    "serve.resolves-per-start",
    "serve.values-never-logged",
]
RESULTS = {}
SECRETS = {"probe-a": "alpha-" + uuid.uuid4().hex, "probe-b": "beta-" + uuid.uuid4().hex}
REFS = {"PROBE_TOKEN_A": "secret-ref:probe-a", "PROBE_TOKEN_B": "secret-ref:probe-b"}
SLOT_UIDS = {"S1": 62900, "S2": 62901}  # Distinct from v21/3_10.py (62890) and tasks/12_2.py (62240+).


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


def u():
    return str(uuid.uuid4())


def sha(text):
    import hashlib
    return "sha256:" + hashlib.sha256(text.encode()).hexdigest()


TS = r"""
import fs from 'node:fs';
import pg from './services/hyperfide/node_modules/pg/lib/index.js';
import {instruction} from './services/hyperfide/dist/events/instructions.js';
import {startInstructionBody,launchEnvReferences} from './services/hyperfide/dist/runner/dispatch.js';
import {admissionEnvReferences} from './services/hyperfide/dist/agents/env_refs.js';
import {insertLaunchPlan,launchPlan} from './services/hyperfide/dist/agents/dispatch.js';
const input=JSON.parse(fs.readFileSync(0,'utf8'));
const settle=async f=>{try{return {ok:true,value:await f()};}catch(e){return {ok:false,code:e.code??String(e)};}};
const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();
let out;
try{
 if(input.mode==='selection')out=await settle(()=>admissionEnvReferences(c,input.scope));
 else if(input.mode==='plan')out=await settle(async()=>{
  // The selection launchSelection returns: admitted fields plus its one admissionEnvReferences call.
  const env_refs=await admissionEnvReferences(c,input.scope);
  await c.query("SET session_replication_role=replica");
  let created;try{created=await insertLaunchPlan(c,input.spawn,input.scope.session_id,{...input.selection,env_refs});}finally{await c.query("SET session_replication_role=origin");}
  const row=(await c.query('SELECT * FROM hyperfide.native_launch_plans WHERE organisation_id=$1 AND run_id=$2 AND command_id=$3',[input.scope.organisation_id,input.scope.run_id,input.spawn.command_id])).rows[0];
  return {created,row_env_refs:row.env_refs,row_plan:row.plan,read:launchPlan(row)};
 });
 else if(input.mode==='start')out=await settle(async()=>{
  const refs=await launchEnvReferences(c,input.organisation_id,input.sandbox_id,input.plan.env_refs);
  return instruction({...input.scope,kind:'START',body:startInstructionBody(input.plan,input.plan.slot_id,refs)}).body;
 });
 else if(input.mode==='query')out=await settle(async()=>(await c.query(input.sql,input.values??[])).rows);
 else throw Error('unknown mode');
}finally{await c.end();}
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


class Db:
    """Owned cluster with one organisation, a pool whose profile allows probe-a and probe-b, and a sandbox."""

    def __init__(self, t295, base):
        self.t295, self.cluster = t295, t295.Cluster()
        c = self.cluster
        c.sql("CREATE ROLE " + t295.OPERATOR + " LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS", database="postgres")
        c.sql("CREATE DATABASE " + t295.DATABASE + " OWNER " + t295.OPERATOR, database="postgres")
        for attempt in range(6):
            try:
                t295.node(t295.MIGRATE, {**base, "DATABASE_URL": c.url(t295.OPERATOR)})
                break
            except AssertionError as error:
                if attempt == 5 or "TX_TIMEOUT" not in str(error):
                    raise
        self.env = {**base, "DATABASE_URL": c.url(t295.SUPERUSER)}
        self.org, self.run, profile, self.pool, self.sandbox = u(), u(), u(), u(), u()
        manifest = json.dumps({"profile": {"credential_references": ["probe-a", "probe-b"]}})
        c.sql("INSERT INTO hyperfide.organisations(id,name) VALUES('%s','launch-producer-probe')" % self.org)
        c.sql("INSERT INTO hyperfide.environment_profiles(organisation_id,id,content_digest,provider,runtime_platform,manifest) VALUES('%s','%s','sha256:%s','blaxel','linux','%s'::jsonb)"
              % (self.org, profile, "a" * 64, manifest.replace("'", "''")))
        c.sql("INSERT INTO hyperfide.provider_pools(organisation_id,id,provider,account_key,environment_key,region,profile_id) VALUES('%s','%s','blaxel','acct','env','region','%s')" % (self.org, self.pool, profile))
        c.sql("INSERT INTO hyperfide.sandboxes(organisation_id,id,pool_id,provider,account_key,native_sandbox_id) VALUES('%s','%s','%s','blaxel','acct','launch-producer-probe')" % (self.org, self.sandbox, self.pool))

    def worker(self, definition):
        """Fixture rows for one task, its attempt and its bound worker session; returns the ids."""
        ids = {k: u() for k in ("task", "attempt", "session", "slot", "package", "spec", "epoch")}
        literal = json.dumps(definition).replace("'", "''")
        self.cluster.sql("SET session_replication_role=replica;"
                         "INSERT INTO hyperfide.tasks(organisation_id,run_id,id,task_key,feature_package_id,spec_revision_id,criteria_digest,definition,wave) VALUES('%s','%s','%s','task-%s','%s','%s','%s','%s'::jsonb,1);"
                         "INSERT INTO hyperfide.attempts(organisation_id,run_id,id,task_id,generation,authority_epoch,input_packet_digest,sandbox_id,slot_id,sandbox_boot_generation) VALUES('%s','%s','%s','%s',1,'%s','%s','%s','%s',1);"
                         "INSERT INTO hyperfide.agent_sessions(organisation_id,run_id,id,role,connector,account_key,native_session_id,slot_id,sandbox_id,sandbox_boot_generation,attempt_id) VALUES('%s','%s','%s','WORKER','codex','acct','native-%s','%s','%s',1,'%s');"
                         % (self.org, self.run, ids["task"], ids["task"][:8], ids["package"], ids["spec"], sha("criteria"), literal,
                            self.org, self.run, ids["attempt"], ids["task"], ids["epoch"], sha("packet" + ids["attempt"]), self.sandbox, ids["slot"],
                            self.org, self.run, ids["session"], ids["session"][:8], ids["slot"], self.sandbox, ids["attempt"]))
        return ids

    def scope(self, ids):
        return {"organisation_id": self.org, "run_id": self.run, "session_id": ids["session"]}

    def spawn(self, ids):
        token = {"organisation_id": self.org, "run_id": self.run, "task_id": ids["task"], "attempt_id": ids["attempt"], "attempt_generation": "1",
                 "authority_epoch": ids["epoch"], "sandbox_id": self.sandbox, "slot_id": ids["slot"], "sandbox_boot_generation": "1"}
        return {"organisation_id": self.org, "run_id": self.run, "command_id": u(), "token": token,
                "packet_digest": sha("packet" + ids["attempt"]), "payload_digest": sha("payload" + ids["attempt"])}

    @staticmethod
    def selection():
        return {"reservation_id": u(), "reservation_attempt": 1, "policy_digest": sha("admission"), "run_policy_digest": sha("run"), "connector": "codex",
                "connector_version": "1.0.0", "provider": "openai", "model": "fixture-model", "auth_profile": "fixture-auth", "permission_profile": "fixture-permissions",
                "qualification_digest": sha("qualification"), "native_delegation": False}

    def close(self):
        return self.cluster.close()


def producer_scenario(db):
    env = db.env
    declared = db.worker({"title": "declares references", "env_refs": REFS})
    selection = ts(env, mode="selection", scope=db.scope(declared))
    check("producer.selection-reads-declaration", selection == {"ok": True, "value": REFS}, selection)

    spawn = db.spawn(declared)
    made = ts(env, mode="plan", scope=db.scope(declared), spawn=spawn, selection=db.selection())
    value = made.get("value") or {}
    check("producer.plan-stores-references", made.get("ok") and value["row_env_refs"] == REFS and value["row_plan"].get("env_refs") == REFS and
          value["created"].get("env_refs") == REFS, made)
    plan = value.get("read") or {}
    check("producer.launch-plan-returns-references", made.get("ok") and plan.get("env_refs") == REFS and plan == value["created"] and
          plan.get("agent_session_id") == declared["session"] and plan.get("slot_id") == declared["slot"], plan)

    undeclared = db.worker({"env_refs": dict(REFS, PROBE_TOKEN_C="secret-ref:probe-c")})
    refused = ts(env, mode="selection", scope=db.scope(undeclared))
    refused_plan = ts(env, mode="plan", scope=db.scope(undeclared), spawn=db.spawn(undeclared), selection=db.selection())
    check("producer.undeclared-declaration-refused", refused == {"ok": False, "code": "RUNNER_SECRET_REFERENCE_UNDECLARED"} and
          refused_plan == {"ok": False, "code": "RUNNER_SECRET_REFERENCE_UNDECLARED"}, [refused, refused_plan])
    malformed = [ts(env, mode="selection", scope=db.scope(db.worker({"env_refs": refs})))
                 for refs in ({"PROBE_TOKEN_A": SECRETS["probe-a"]}, {"PATH": REFS["PROBE_TOKEN_A"]}, ["secret-ref:probe-a"])]
    unbound = ts(env, mode="selection", scope={"organisation_id": db.org, "run_id": db.run, "session_id": u()})
    check("producer.malformed-declaration-refused", all(r == {"ok": False, "code": "RUNNER_SECRET_REFERENCE_INVALID"} for r in malformed) and
          unbound == {"ok": False, "code": "AGENT_LAUNCH_REFERENCES_UNBOUND"} and not leaked(json.dumps(malformed)), [malformed, unbound])

    # A task that declares nothing (flat or kvx section shape without env_refs) yields a plan without references.
    plain = db.worker({"section": {"fields": {"title": {"value": "no references"}}}})
    bare = ts(env, mode="plan", scope=db.scope(plain), spawn=db.spawn(plain), selection=db.selection())
    bare_value = bare.get("value") or {}
    check("producer.undeclared-task-plan-empty", bare.get("ok") and bare_value["row_env_refs"] == {} and "env_refs" not in bare_value["row_plan"] and
          "env_refs" not in bare_value["read"], bare)

    update = ts(env, mode="query", sql="UPDATE hyperfide.native_launch_plans SET env_refs='{}'::jsonb WHERE command_id=$1", values=[spawn["command_id"]])
    still = ts(env, mode="query", sql="SELECT env_refs FROM hyperfide.native_launch_plans WHERE command_id=$1", values=[spawn["command_id"]])
    check("producer.column-immutable", not update.get("ok") and still.get("value") == [{"env_refs": REFS}], [update, still])
    probes = ts(env, mode="query", sql="SELECT hyperfide.launch_env_refs_valid($1::jsonb) AS refs,hyperfide.launch_env_refs_valid($2::jsonb) AS plain,"
                "hyperfide.launch_env_refs_valid($3::jsonb) AS reserved,hyperfide.launch_env_refs_valid('{}'::jsonb) AS empty",
                values=[json.dumps(REFS), json.dumps({"PROBE_TOKEN_A": "plaintext-value"}), json.dumps({"LD_PRELOAD": REFS["PROBE_TOKEN_A"]})])
    check("producer.column-refuses-values", probes.get("value") == [{"refs": True, "plain": False, "reserved": False, "empty": True}], probes)
    return plan, bare_value.get("read")


def start_scenario(db, plan, bare):
    env = db.env
    scope = {"organisation_id": db.org, "run_id": db.run, "id": u(), "attempt_id": u(), "attempt_generation": "1", "authority_epoch": u(), "sandbox_boot_generation": "1"}
    issued = ts(env, mode="start", organisation_id=db.org, sandbox_id=db.sandbox, scope=scope, plan=plan)
    plain = ts(env, mode="start", organisation_id=db.org, sandbox_id=db.sandbox, scope=scope, plan=bare)
    body = issued.get("value") or {}
    check("start.carries-declared-names-only", issued.get("ok") and body.get("env_refs") == REFS and sorted(body["env_refs"]) == sorted(REFS) and
          body.get("launch_id") == plan["launch_id"] and plain.get("ok") and "env_refs" not in plain["value"], [issued, plain])
    forged = dict(plan, env_refs=dict(REFS, PROBE_TOKEN_C="secret-ref:probe-c"))
    refused = ts(env, mode="start", organisation_id=db.org, sandbox_id=db.sandbox, scope=scope, plan=forged)
    check("start.undeclared-reference-refused", refused == {"ok": False, "code": "RUNNER_SECRET_REFERENCE_UNDECLARED"}, refused)
    dump = ts(env, mode="query", sql="SELECT row_to_json(p)::text AS r FROM hyperfide.native_launch_plans p")
    check("start.no-values-stored-or-issued", dump.get("ok") and dump["value"] and not leaked(json.dumps(dump)) and not leaked(json.dumps(issued)), leaked(json.dumps(dump)))
    return body


def serve_scenario(p, t310, t122, base, db):
    t310.SLOT_UIDS = SLOT_UIDS
    t310.setup_slots(p, t122)
    p.start_coordinator()
    # The provider resolved only PROBE_TOKEN_A into the exec that starts serve.
    p.serve = subprocess.Popen([str(NATIVE), "--component", "12.2", "--action", "launch.serve"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, text=True, cwd=ROOT, env={**base, **resolve({"PROBE_TOKEN_A": REFS["PROBE_TOKEN_A"]})})
    p.serve.stdin.write(json.dumps({"config_path": p.slot["S1"]["config"], "run_seconds": 120, "poll_interval_ms": 100}))
    p.serve.stdin.close()
    p.serve.stdin = None

    def dispatched(env_refs):
        """A START issued by runner/dispatch.ts for a plan carrying env_refs, profile-checked against the DB fixture."""
        launch = u()
        plan = {"launch_id": launch, "slot_id": p.slot["S1"]["id"], "agent_session_id": u(), "connector_plan_digest": p.slot["S1"]["plan_digest"], "env_refs": env_refs}
        scope = {"organisation_id": p.ids["organisation"], "run_id": p.ids["run"], "id": u(), "attempt_id": u(), "attempt_generation": "2",
                 "authority_epoch": p.ids["epoch"], "sandbox_boot_generation": p.generation}
        issued = ts(db.env, mode="start", organisation_id=db.org, sandbox_id=db.sandbox, scope=scope, plan=plan)
        if not issued.get("ok"):
            raise AssertionError("dispatch START refused: %s" % issued)
        body = {k: v for k, v in issued["value"].items() if k != "launch_id"}
        return launch, p.instruction("START", launch, body, u(), held=False)

    bad_launch, bad = dispatched(REFS)
    outcome = t122.wait_for(lambda: (lambda rows: rows and rows[0]["state"] == "REFUSED" and rows[0])(p.ledger("SELECT state,outcome FROM instructions WHERE event=?", (bad["id"],))), 25)
    check("serve.unresolvable-start-refused", outcome and json.loads(outcome["outcome"]).get("refusal") == "SECRET_REFERENCE_UNAVAILABLE" and
          p.launch(bad_launch) is None and not p.uid_processes(SLOT_UIDS["S1"]), outcome)

    good_launch, good = dispatched({"PROBE_TOKEN_A": REFS["PROBE_TOKEN_A"]})
    row = t122.wait_for(lambda: (p.launch(good_launch) or {}).get("state") == "RUNNING" and p.launch(good_launch), 25)
    t122.wait_for(lambda: row and t310.executed(row["agent_pid"]), 10)
    seen = t310.environ(row["agent_pid"]) if row else None
    running = p.events(good_launch, "launch.running")
    check("serve.resolves-per-start", row and seen is not None and seen.get("PROBE_TOKEN_A") == SECRETS["probe-a"] and "PROBE_TOKEN_B" not in seen and
          p.proc_uid(row["agent_pid"]) == SLOT_UIDS["S1"] and running and running[0]["data"].get("env_refs") == {"present": ["PROBE_TOKEN_A"], "missing": []},
          {"row": row, "seen": sorted(seen or {}), "running": running})

    code, out, err = p.stop_serve(signal.SIGTERM)
    stored = b"".join(f.read_bytes() for f in p.state.rglob("*") if f.is_file())
    coordinator = b"".join(f.read_bytes() for f in (p.tmp / "coordinator").rglob("*") if f.is_file()) + json.dumps(p.cstate()).encode()
    check("serve.values-never-logged", not leaked(stored) and not leaked(coordinator) and not leaked((out or "") + (err or "")),
          {"state": leaked(stored), "coordinator": leaked(coordinator), "serve": leaked((out or "") + (err or ""))})


def main():
    if os.geteuid() != 0:
        print("SKIP: task 3.15 needs root for slot uids and the native supervisor", flush=True)
        return 77
    t122 = load("hf_case_12_2", "tests/hyperfide/cases/tasks/12_2.py")
    t295 = load("hf_case_29_5", "tests/hyperfide/cases/tasks/29_5.py")
    t310 = load("hf_case_v21_3_10", "tests/hyperfide/cases/v21/3_10.py")
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
    t310.ensure_builds(base)
    check("fixture.root", NATIVE.exists())
    db, cluster_removed, probe = None, False, t122.Probe()
    try:
        db = Db(t295, base)
        plan, bare = producer_scenario(db)
        start_scenario(db, plan, bare)
        serve_scenario(probe, t310, t122, base, db)
    except Exception:
        traceback.print_exc(file=sys.stderr)
    finally:
        complete = probe.cleanup() and not any(probe.uid_processes(suid) for suid in SLOT_UIDS.values())
        if db:
            cluster_removed = db.close()
    for name in ASSERTIONS:
        print(json.dumps({"type": "assertion", "id": name, "expected": True, "actual": RESULTS.get(name, False)}), flush=True)
    resources = [{"id": "postgres-cluster", "status": "deleted" if cluster_removed else "unknown", "observed_absent": cluster_removed}]
    resources += [{"id": "slot-uid-%d" % suid, "status": "deleted" if complete else "unknown", "observed_absent": complete} for suid in SLOT_UIDS.values()]
    print(json.dumps({"type": "cleanup", "resources": resources, "complete": bool(complete and cluster_removed)}), flush=True)
    return 0 if complete and cluster_removed and all(RESULTS.get(name) for name in ASSERTIONS) else 1


if __name__ == "__main__":
    raise SystemExit(main())
