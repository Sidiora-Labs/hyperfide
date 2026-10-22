#!/usr/bin/env python3
"""Task 2.17: admission writes env_refs into the runner packet (D17).

A task names every secret variable as NAME -> secret-ref:ID on its
RunnerRemotePlan. Admission (remote.prepare in services/hyperfide
runner/bridge.ts) builds the immutable packet through runnerAdmissionPacket,
which checks each reference against the bound pool's environment profile (an
allowlist of IDs only) and writes the checked map as packet.env_refs. The
executor launches with row.plan.env_refs (task 2.8).

The profile is read from an owned throwaway PostgreSQL cluster (pattern of
tasks/29_5.py and v21/2_8.py) through the service's own query. No provider is
contacted and no secret value exists in this case.
"""
import importlib.util, json, os, pathlib, signal, subprocess, sys, traceback, uuid

ROOT = pathlib.Path(__file__).resolve().parents[4]
BRIDGE = ROOT / "services/hyperfide/dist/runner/bridge.js"
ASSERTIONS = [
    "plan.references-accepted",
    "plan.malformed-reference-refused",
    "plan.explicit-and-reference-refused",
    "admission.packet-carries-references",
    "admission.undeclared-reference-refused",
    "admission.missing-profile-refused",
    "admission.packet-without-references-unchanged",
    "admission.unprofiled-pool-without-references-admitted",
    "executor.reads-admitted-references",  # an absent packet field arrives as JSON null and means undefined
    "admission.prepare-uses-packet-builder",
]
RESULTS = {}
REFS = {"PROBE_TOKEN_A": "secret-ref:probe-a", "PROBE_TOKEN_B": "secret-ref:probe-b"}


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
import pg from './services/hyperfide/node_modules/pg/lib/index.js';
import {runnerAdmissionPacket,validateRunnerPlan,runnerCanonical} from './services/hyperfide/dist/runner/bridge.js';
import {taskEnvReferences} from './services/hyperfide/dist/runner/executor.js';
import {hash} from './services/hyperfide/dist/transport/protocol.js';
const input=JSON.parse(fs.readFileSync(0,'utf8'));
const settle=async f=>{try{return {ok:true,value:await f()};}catch(e){return {ok:false,code:e.code??String(e)};}};
const plan=input.plan?{...input.plan,environment_digest:hash(runnerCanonical(input.plan.environment))}:null;
let out;
if(input.mode==='validate')out=await settle(()=>{validateRunnerPlan(plan);return true;});
else{
 const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try{
  if(input.mode==='admit')out=await settle(async()=>{
   const admitted=await runnerAdmissionPacket(c,plan,input.binding,input.allocation,input.readiness);
   // The packet bytes admission produced before task 2.17, for the unchanged check.
   const legacy=JSON.parse(JSON.stringify({request:plan,binding:input.binding,allocation:input.allocation,source_state_digest:input.readiness.source_state_digest,workspace_digest:input.readiness.workspace_digest}));
   return {...admitted,recomputed:hash(runnerCanonical(admitted.packet)),legacy_digest:hash(runnerCanonical(legacy))};
  });
  else if(input.mode==='executor')out=await settle(()=>taskEnvReferences(c,input.organisation_id,input.pool_id,input.declared??undefined));
  else throw Error('unknown mode');
 }finally{await c.end();}
}
process.stdout.write(JSON.stringify(out));
"""


def ts(env, **request):
    p = subprocess.run(["node", "--input-type=module", "-e", TS], cwd=ROOT, env=env, input=json.dumps(request), text=True, capture_output=True, timeout=120)
    if p.returncode:
        raise AssertionError(p.stderr + p.stdout)
    return json.loads(p.stdout)


def u():
    return str(uuid.uuid4())


def plan(**extra):
    value = {"session_id": u(), "operation_id": u(), "repository_id": u(), "reservation_id": u(), "argv": ["/usr/bin/node", "job.mjs"], "cwd": ".",
             "environment": {"LANG": "C.UTF-8"}, "timeout_ms": 60000, "source_digest": "sha256:" + "1" * 64, "policy_digest": "sha256:" + "2" * 64,
             "executable_digest": "sha256:" + "3" * 64, "artifact_paths": []}
    value.update(extra)
    return value


def plan_scenario(base):
    accepted = ts(base, mode="validate", plan=plan(env_refs=REFS))
    plain = ts(base, mode="validate", plan=plan())
    check("plan.references-accepted", accepted == {"ok": True, "value": True} and plain == {"ok": True, "value": True}, [accepted, plain])
    bad = [ts(base, mode="validate", plan=plan(env_refs=refs)) for refs in
           ({"HF_TOKEN": "secret-ref:probe-a"}, {"PATH": "secret-ref:probe-a"}, {"PROBE_TOKEN_A": "raw-value"}, {"PROBE_TOKEN_A": 7}, ["secret-ref:probe-a"])]
    check("plan.malformed-reference-refused", all(r == {"ok": False, "code": "RUNNER_SECRET_REFERENCE_INVALID"} for r in bad), bad)
    both = ts(base, mode="validate", plan=plan(environment={"LANG": "C.UTF-8", "PROBE_TOKEN_A": "x"}, env_refs=REFS))
    check("plan.explicit-and-reference-refused", both == {"ok": False, "code": "RUNNER_SECRET_REFERENCE_INVALID"}, both)


def admission_scenario(t295, base):
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
        org, profile, pool, bare = (u() for _ in range(4))
        manifest = json.dumps({"profile": {"credential_references": ["probe-a", "probe-b"]}})
        cluster.sql("INSERT INTO hyperfide.organisations(id,name) VALUES('%s','admission-reference-probe')" % org)
        cluster.sql("INSERT INTO hyperfide.environment_profiles(organisation_id,id,content_digest,provider,runtime_platform,manifest) VALUES('%s','%s','sha256:%s','blaxel','linux','%s'::jsonb)"
                    % (org, profile, "a" * 64, manifest.replace("'", "''")))
        cluster.sql("INSERT INTO hyperfide.provider_pools(organisation_id,id,provider,account_key,environment_key,region,profile_id) VALUES('%s','%s','blaxel','acct','env','region','%s')" % (org, pool, profile))
        cluster.sql("INSERT INTO hyperfide.provider_pools(organisation_id,id,provider,account_key,environment_key,region,profile_id) VALUES('%s','%s','blaxel','acct','env','region',NULL)" % (org, bare))
        env = {**base, "DATABASE_URL": cluster.url(t295.SUPERUSER)}

        def admit(pool_id, **extra):
            binding = {"organisation_id": org, "run_id": u(), "session_id": u(), "pool_id": pool_id, "sandbox_id": u()}
            allocation = {"allocation_id": u(), "reservation_id": u(), "generation": "1"}
            readiness = {"source_state_digest": "sha256:" + "4" * 64, "workspace_digest": "sha256:" + "5" * 64}
            return ts(env, mode="admit", plan=plan(**extra), binding=binding, allocation=allocation, readiness=readiness)

        carried = admit(pool, env_refs=REFS)
        v = carried.get("value", {})
        packet = v.get("packet", {})
        check("admission.packet-carries-references", carried.get("ok") and packet.get("env_refs") == REFS and packet.get("request", {}).get("env_refs") == REFS and
              v.get("digest") == v.get("recomputed") and v.get("digest") != v.get("legacy_digest"), carried)
        undeclared = admit(pool, env_refs={**REFS, "PROBE_TOKEN_C": "secret-ref:probe-c"})
        check("admission.undeclared-reference-refused", undeclared == {"ok": False, "code": "RUNNER_SECRET_REFERENCE_UNDECLARED"}, undeclared)
        missing = admit(bare, env_refs=REFS)
        check("admission.missing-profile-refused", missing == {"ok": False, "code": "RUNNER_SECRET_PROFILE_UNAVAILABLE"}, missing)
        plain = admit(pool)
        pv = plain.get("value", {})
        check("admission.packet-without-references-unchanged", plain.get("ok") and "env_refs" not in pv.get("packet", {}) and "env_refs" not in pv.get("packet", {}).get("request", {}) and
              sorted(pv.get("packet", {})) == ["allocation", "binding", "request", "source_state_digest", "workspace_digest"] and pv.get("digest") == pv.get("legacy_digest"), plain)
        unprofiled = admit(bare)
        check("admission.unprofiled-pool-without-references-admitted", unprofiled.get("ok") and unprofiled["value"]["digest"] == unprofiled["value"]["legacy_digest"], unprofiled)
        # Executor (task 2.8) launches with taskEnvReferences(row.plan.env_refs) for row.plan.binding.pool_id.
        read = ts(env, mode="executor", organisation_id=org, pool_id=packet.get("binding", {}).get("pool_id"), declared=packet.get("env_refs"))
        none = ts(env, mode="executor", organisation_id=org, pool_id=pool, declared=pv.get("packet", {}).get("env_refs"))
        check("executor.reads-admitted-references", read == {"ok": True, "value": REFS} and none == {"ok": True, "value": {}}, [read, none])
    finally:
        removed = cluster.close()
    return removed


def source_scenario():
    """remote.prepare must persist the packet runnerAdmissionPacket returns, not a parallel construction."""
    text = (ROOT / "services/hyperfide/src/runner/bridge.ts").read_text()
    body = text[text.index("prepare:async(tx:PrimaryTransaction,i:InvocationContext,request:RunnerRemotePlan)"):text.index("recover:async(")]
    check("admission.prepare-uses-packet-builder", "const {packet,digest:pin}=await runnerAdmissionPacket(tx,plan,stableBinding,stableAllocation,checkedReadiness);" in body and
          body.count("JSON.stringify(packet)") == 1 and "packet=JSON.parse" not in body)


def main():
    if not BRIDGE.exists():
        print("assertion failed: build services/hyperfide (npm run build) first", file=sys.stderr)
        return 1
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
    base = os.environ.copy()
    for key in list(base):
        if key == "DATABASE_URL" or key.startswith("HYPERFIDE_") and key.endswith("_DATABASE_URL") or key.startswith("PROBE_TOKEN_"):
            del base[key]
    removed = False
    try:
        plan_scenario(base)
        source_scenario()
        removed = admission_scenario(t295, base)
    except Exception:
        traceback.print_exc(file=sys.stderr)
    for name in ASSERTIONS:
        print(json.dumps({"type": "assertion", "id": name, "expected": True, "actual": RESULTS.get(name, False)}), flush=True)
    print(json.dumps({"type": "cleanup", "resources": [{"id": "postgres-cluster", "status": "deleted" if removed else "unknown", "observed_absent": removed}],
                      "complete": bool(removed)}), flush=True)
    return 0 if removed and all(RESULTS.get(name) for name in ASSERTIONS) else 1


if __name__ == "__main__":
    raise SystemExit(main())
