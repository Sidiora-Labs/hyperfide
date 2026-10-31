#!/usr/bin/env python3
"""hyperfide-v21 5.2: the console.sandboxes inventory (observability/console.ts).

Applies every release migration to an owned throwaway PostgreSQL cluster (pattern
of v21/3_1.py), grants the runtime role exactly as deploy/hyperfide/grants.sql
does, seeds one sandbox per liveness class, and reads the join as that runtime
role: live, lost (stale heartbeat, old-boot heartbeat, ambiguous provider
outcome), quarantined (intent and credential), pending, retired and orphaned.
The orphan and QUARANTINED intent rows are written with the statements
providers/reconcile.ts uses when ownership cannot be proven, as v21/2_1.py does;
no live provider is contacted. Slice and snapshot rows are seeded with
session_replication_role=replica (as v21/3_8.py does) because their packet and
source-object parents are irrelevant to the join.
"""
import importlib.util, json, os, pathlib, signal, subprocess, sys, traceback, uuid

ROOT = pathlib.Path(__file__).resolve().parents[4]
SERVICE = ROOT / "core/control-plane"
RUNTIME = "hf_runtime"
ASSERTIONS = [
    "migration.applied",
    "join.one-row-per-sandbox",
    "join.counts",
    "live.heartbeat-fresh",
    "live.worker-attempt-runner",
    "live.worker-slice-size",
    "live.worker-snapshot-captured",
    "live.idle-worker",
    "live.intent-and-pool",
    "lost.stale-heartbeat",
    "lost.old-boot-heartbeat-ignored",
    "lost.snapshot-none-slice-released",
    "lost.provider-outcome-unknown",
    "quarantined.intent",
    "quarantined.credential",
    "pending.not-enrolled",
    "retired.destroyed",
    "orphaned.unbound-only",
    "freshness.as-of",
    "classify.boundary",
    "component.operator-reads",
    "component.limit-truncates",
    "refuse.worker-role",
    "refuse.unknown-field",
    "refuse.unbound-invocation",
    "readonly.no-writes",
]
RESULTS = {}
D = "'sha256:'||repeat('a',64)"


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def check(name, ok, detail=None):
    RESULTS[name] = bool(ok)
    if not ok:
        print("assertion failed: %s %s" % (name, json.dumps(detail, default=str)[:2500] if detail is not None else ""), file=sys.stderr, flush=True)


def u():
    return str(uuid.uuid4())


def ensure_build(base):
    stamp = subprocess.run(["node", "deploy/hyperfide/dist-stamp.mjs", "check", str(SERVICE)], cwd=ROOT, env=base, capture_output=True, text=True)
    if stamp.returncode:
        p = subprocess.run(["npm", "--prefix", str(SERVICE), "run", "build"], cwd=ROOT, env=base, capture_output=True, text=True, timeout=900)
        if p.returncode:
            raise AssertionError("service build failed: " + (p.stderr + p.stdout)[-1500:])


PROBE = r"""
import fs from 'node:fs';
import pg from './core/control-plane/node_modules/pg/lib/index.js';
const {sandboxInventory,createComponent}=await import('./core/control-plane/dist/observability/console.js');
const {classifySandbox,RUNNER_HEARTBEAT_MAX_AGE_SECONDS}=await import('./core/control-plane/dist/providers/placement.js');
const i=JSON.parse(fs.readFileSync(0,'utf8')),out={};
const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();
const counts=async()=>(await c.query('SELECT (SELECT sum(n_tup_ins+n_tup_upd+n_tup_del) FROM pg_stat_xact_user_tables) AS w')).rows[0].w;
try{
 await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 out.inventory=await sandboxInventory(c,i.org);
 out.writes=await counts();
 await c.query('COMMIT');
 const base={observed_state:'RUNNING',desired_state:'RUNNING',enrolled:true,intent_states:[],latest_intent_state:null,credential_quarantined:false};
 out.classify={max:RUNNER_HEARTBEAT_MAX_AGE_SECONDS,at:classifySandbox({...base,heartbeat_age_seconds:90}).liveness,over:classifySandbox({...base,heartbeat_age_seconds:90.001}).liveness,
  future:classifySandbox({...base,heartbeat_age_seconds:-5}).liveness,failed:classifySandbox({...base,heartbeat_age_seconds:1,observed_state:'FAILED'}),
  missing:classifySandbox({...base,heartbeat_age_seconds:null}),fresh_quarantine:classifySandbox({...base,heartbeat_age_seconds:1,intent_states:['ACKNOWLEDGED','QUARANTINED']}).liveness};
 const component=createComponent({});
 const invoke=async(principal,payload,action='console.sandboxes')=>{
  const ctx={signal:new AbortController().signal,invocation:{principal,payload:{action,run_id:principal.run_id,...payload.envelope},signal:new AbortController().signal,guard:async()=>{}},
   resources:{gateway:{withPrimaryTransaction:async(_o,fn)=>{await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');try{const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}}}}};
  try{return{ok:await component.actions['console.sandboxes'](payload.input,ctx)};}catch(e){return{error:e.code??e.message};}
 };
 const p=role=>({organisation_id:i.org,run_id:i.run,actor_id:i.actor,credential_id:i.actor,role});
 out.actions=Object.keys(component.actions);
 out.operator=await invoke(p('OPERATOR'),{input:{run_id:i.run}});
 out.limited=await invoke(p('LEADER'),{input:{run_id:i.run,limit:2}});
 out.worker=await invoke(p('WORKER'),{input:{run_id:i.run}});
 out.unknown=await invoke(p('OPERATOR'),{input:{run_id:i.run,organisation_id:i.org}});
 out.unbound=await invoke(p('OPERATOR'),{input:{},envelope:{run_id:i.other_run}});
}finally{await c.end();}
process.stdout.write(JSON.stringify(out));
"""


def seed(db, t, ids):
    """Core rows with every constraint and trigger live, as the superuser."""
    o = ids
    s = o["sandbox"]
    native = {k: "native-" + k for k in s}
    stmts = [
        "BEGIN",
        f"INSERT INTO hyperfide.organisations(id,name) VALUES('{o['org']}','console-probe')",
        f"INSERT INTO hyperfide.projects(organisation_id,id,name) VALUES('{o['org']}','{o['project']}','fixture')",
        f"INSERT INTO hyperfide.spec_revisions(organisation_id,id,project_id,source_digest,source_content,document,schema_version) VALUES('{o['org']}','{o['spec']}','{o['project']}','sha256:'||encode(sha256(convert_to('fixture','UTF8')),'hex'),'fixture','{{}}',1)",
        f"INSERT INTO hyperfide.runs(organisation_id,id,project_id,spec_revision_id,policy_digest,authority_epoch,state) VALUES('{o['org']}','{o['run']}','{o['project']}','{o['spec']}',{D},'{o['epoch']}','RUNNING')",
        f"INSERT INTO hyperfide.feature_packages(organisation_id,run_id,id,package_key,wave) VALUES('{o['org']}','{o['run']}','{o['package']}','package',5)",
        f"INSERT INTO hyperfide.environment_profiles(organisation_id,id,content_digest,provider,runtime_platform,manifest) VALUES('{o['org']}','{o['profile']}',{D},'railway','linux','{{}}')",
        f"INSERT INTO hyperfide.provider_pools(organisation_id,id,provider,account_key,environment_key,region) VALUES('{o['org']}','{o['pool']}','railway','fixture','fixture','eu-west')",
        f"INSERT INTO hyperfide.provider_pool_configurations(organisation_id,pool_id,configuration_digest,document) VALUES('{o['org']}','{o['pool']}',{D},'{{}}')",
    ]
    observed = {"live": "RUNNING", "lost": "RUNNING", "unknown": "UNKNOWN", "quarantined": "RUNNING", "credential": "RUNNING", "pending": "CREATING", "retired": "DESTROYED"}
    for k, sid in s.items():
        desired = "DESTROYED" if k == "retired" else "RUNNING"
        stmts.append(f"INSERT INTO hyperfide.sandboxes(organisation_id,id,pool_id,native_sandbox_id,desired_state,observed_state) VALUES('{o['org']}','{sid}','{o['pool']}','{native[k]}','{desired}','{observed[k]}')")
    # The lost sandbox rebooted: generation 2 is current and its slot and credential belong to it.
    stmts.append(f"UPDATE hyperfide.sandboxes SET boot_generation=2,state_version=state_version+1 WHERE organisation_id='{o['org']}' AND id='{s['lost']}'")
    gen = {k: (2 if k == "lost" else 1) for k in s}
    for n, k in enumerate(["live", "lost", "quarantined", "credential"]):
        stmts.append(f"INSERT INTO hyperfide.tasks(organisation_id,run_id,id,task_key,feature_package_id,spec_revision_id,criteria_digest,definition,wave) VALUES('{o['org']}','{o['run']}','{o['task'][k]}','5.{n}','{o['package']}','{o['spec']}',{D},'{{}}',5)")
    for k in ["live", "lost", "quarantined", "credential"]:
        stmts.append(f"INSERT INTO hyperfide.worker_slots(organisation_id,id,sandbox_id,slot_key,boot_generation,capacity_kind) VALUES('{o['org']}','{o['slot'][k]}','{s[k]}','worker-a',{gen[k]},'AGENT')")
        stmts.append(f"INSERT INTO hyperfide.attempts(organisation_id,run_id,id,task_id,generation,authority_epoch,input_packet_digest,execution_state,compute_authority,sandbox_id,slot_id,sandbox_boot_generation,lease_expires_at) VALUES('{o['org']}','{o['run']}','{o['attempt'][k]}','{o['task'][k]}',1,'{o['epoch']}',{D},'RUNNING','CURRENT','{s[k]}','{o['slot'][k]}',{gen[k]},clock_timestamp()+interval '30 minutes')")
    stmts.append(f"INSERT INTO hyperfide.worker_slots(organisation_id,id,sandbox_id,slot_key,boot_generation,capacity_kind) VALUES('{o['org']}','{o['idle_slot']}','{s['live']}','worker-b',1,'BUILD')")
    # A retired slot of the lost sandbox's previous boot must not show as a current worker.
    stmts.append(f"INSERT INTO hyperfide.worker_slots(organisation_id,id,sandbox_id,slot_key,boot_generation,capacity_kind,state) VALUES('{o['org']}','{o['old_slot']}','{s['lost']}','worker-a',1,'AGENT','RETIRED')")

    def runner(cred, k, boot, state, beat):
        stmts.append(f"INSERT INTO hyperfide.identity_principals(credential_id,organisation_id,run_id,actor_id,role,public_key_b64,deployment_epoch,sandbox_id,boot_generation,boot_id,allowed_actions,expires_at,state) "
                     f"SELECT '{cred}','{o['org']}','{o['run']}','{u()}','RUNNER','{cred.replace('-', '')[:32].upper() + 'A' * 11}','{o['epoch']}','{s[k]}',{boot},boot_id,ARRAY['runner.heartbeat'],clock_timestamp()+interval '1 hour','{state}' "
                     f"FROM hyperfide.sandbox_boots WHERE organisation_id='{o['org']}' AND sandbox_id='{s[k]}' AND boot_generation={boot}")
        stmts.append(f"INSERT INTO hyperfide.identity_runner_status(credential_id,preparation_digest,inventory,heartbeat_at) VALUES('{cred}',{D},'[]',{beat})")

    fresh, stale = "clock_timestamp()-interval '5 seconds'", "clock_timestamp()-interval '10 minutes'"
    runner(o["cred"]["live"], "live", 1, "ACTIVE", fresh)
    runner(o["cred"]["lost_old"], "lost", 1, "ACTIVE", fresh)
    runner(o["cred"]["lost"], "lost", 2, "ACTIVE", stale)
    runner(o["cred"]["quarantined"], "quarantined", 1, "ACTIVE", fresh)
    runner(o["cred"]["credential"], "credential", 1, "QUARANTINED", fresh)
    for k in ["live", "lost"]:
        stmts.append(
            "INSERT INTO hyperfide.runner_registry(organisation_id,run_id,session_id,credential_id,sandbox_id,boot_generation,boot_id,slot_id,state_dir,runner_binary,workspace_path,home_path,tmp_path,"
            "runner_binary_digest,boot_preparation_digest,preparation_digest,readiness_digest,source_digest,source_object_id,source_tree_id,slot_generation,uid,gid,observation_digest) "
            f"SELECT '{o['org']}','{o['run']}','{o['session'][k]}','{o['cred'][k]}','{s[k]}',{gen[k]},boot_id,'{o['slot'][k]}','/state','/bin/runner','/work','/home/w','/tmp/w',"
            f"{D},{D},{D},{D},{D},'obj','tree',1,1000,1000,{D} FROM hyperfide.sandbox_boots WHERE organisation_id='{o['org']}' AND sandbox_id='{s[k]}' AND boot_generation={gen[k]}")

    def intent(k, kind, state, failure=None):
        iid = o["intent"][k]
        stmts.append(
            "INSERT INTO hyperfide.provisioning_intents(organisation_id,run_id,id,pool_id,sandbox_id,configuration_digest,kind,preparation_purpose,profile_id,request_key,request_digest,payload_digest,operation,state,native_sandbox_id,boot_generation,failure_code) "
            f"VALUES('{o['org']}','{o['run']}','{iid}','{o['pool']}','{s[k]}',{D},'{kind}','EXECUTION','{o['profile']}','{iid}',{D},{D},'{{}}','RECORDED','{native[k]}',1,NULL)")
        if state != "RECORDED":
            stmts.append(f"UPDATE hyperfide.provisioning_intents SET state='{state}',failure_code={'NULL' if failure is None else repr(failure)},updated_at=clock_timestamp(),state_version=state_version+1 WHERE organisation_id='{o['org']}' AND id='{iid}'")

    intent("live", "CREATE", "ACKNOWLEDGED")
    intent("lost", "CREATE", "ACKNOWLEDGED")
    intent("unknown", "CREATE", "UNKNOWN")
    # Exactly the statement reconcile.ts issues when a lost create cannot prove ownership.
    intent("quarantined", "CREATE", "QUARANTINED", "OWNERSHIP_UNVERIFIED")
    intent("credential", "CREATE", "ACKNOWLEDGED")
    intent("pending", "CREATE", "SUBMITTING")
    for name, state, native_id in [("o_quarantined", "QUARANTINED", "lost-create-1"), ("o_retained", "RETAINED", "lost-create-2"),
                                   ("o_deleted", "DELETED", "lost-create-3"), ("o_bound", "QUARANTINED", native["live"])]:
        stmts.append(f"INSERT INTO hyperfide.provider_orphans(organisation_id,pool_id,native_sandbox_id,suspected_intent_id) VALUES('{o['org']}','{o['pool']}','{native_id}','{o['intent']['quarantined']}') ON CONFLICT DO NOTHING")
        if state != "QUARANTINED":
            stmts.append(f"UPDATE hyperfide.provider_orphans SET state='{state}',ownership_evidence_digest={D} WHERE organisation_id='{o['org']}' AND pool_id='{o['pool']}' AND native_sandbox_id='{native_id}'")
    stmts.append("COMMIT")
    db.sql(";".join(stmts), user=t.SUPERUSER)

    # Slice and snapshot evidence; their packet and source-object parents are outside this join.
    manifest = json.dumps({"included_paths": ["src/a.ts", "src/b.ts", "tests/"], "closure": {"files": 7}})
    m = o["mat"]
    rows = [
        "BEGIN", "SET LOCAL session_replication_role=replica",
        f"INSERT INTO hyperfide.workspace_slice_manifests(organisation_id,run_id,digest,derivation_key,packet_digest,repository_id,commit,graph_manifest_id,graph_manifest_digest,mode,manifest,manifest_text,created_by_credential_id) "
        f"VALUES('{o['org']}','{o['run']}','sha256:'||repeat('b',64),{D},{D},'{u()}',repeat('c',40),'{u()}',{D},'SLICE','{manifest}','{{}}','{u()}')",
    ]
    for key, k, outcome, released in [("live", "live", "READY", None), ("lost", "lost", "READY", None), ("lost_release", "lost", "RELEASED", m["lost"])]:
        rows.append(f"INSERT INTO hyperfide.workspace_slice_materialisations(organisation_id,run_id,id,slice_digest,sandbox_id,slot_id,sandbox_boot_generation,outcome,released_materialisation_id,verified_head,evidence,evidence_digest,created_by_credential_id) "
                    f"VALUES('{o['org']}','{o['run']}','{m[key]}','sha256:'||repeat('b',64),'{s[k]}','{o['slot'][k]}',{gen[k]},'{outcome}',{'NULL' if released is None else repr(released)},{'repeat(' + repr('d') + ',40)' if outcome == 'READY' else 'NULL'},'{{}}',{D},'{u()}')")
    rows.append(f"INSERT INTO hyperfide.source_snapshots(organisation_id,run_id,id,task_id,attempt_id,attempt_generation,repository_id,base_commit,base_tree,result_tree,slice_digest,checkpoint_digest,checkpoint_receipt,files_changed,insertions,deletions,binary_files,created_by_credential_id) "
                f"VALUES('{o['org']}','{o['run']}','{o['snapshot']}','{o['task']['live']}','{o['attempt']['live']}',1,'{u()}',repeat('c',40),repeat('e',40),repeat('f',40),'sha256:'||repeat('b',64),{D},jsonb_build_object('checkpoint_digest',{D}),3,10,2,0,'{u()}')")
    rows.append("COMMIT")
    db.sql(";".join(rows), user=t.SUPERUSER)


def scenario(cluster, t, ids, base):
    applied = cluster.sql("SELECT count(*) FROM hyperfide.schema_migrations WHERE version IN (8,12,14,45,710)")
    check("migration.applied", applied == "5", applied)
    p = subprocess.run(["node", "--input-type=module", "-e", PROBE], cwd=ROOT, env={**base, "DATABASE_URL": cluster.url(RUNTIME)},
                       input=json.dumps({"org": ids["org"], "run": ids["run"], "other_run": u(), "actor": u()}), text=True, capture_output=True, timeout=300)
    if p.returncode:
        raise AssertionError("probe failed: " + (p.stderr + p.stdout)[-2500:])
    out = json.loads(p.stdout)
    inv = out["inventory"]
    s = ids["sandbox"]
    by = {r["sandbox_id"]: r for r in inv["rows"] if r["kind"] == "SANDBOX"}
    orphans = [r for r in inv["rows"] if r["kind"] == "ORPHAN"]
    check("join.one-row-per-sandbox", sorted(by) == sorted(s.values()) and len(inv["rows"]) == len(s) + 2 and not inv["truncated"], inv["rows"])
    check("join.counts", inv["counts"] == {"LIVE": 1, "LOST": 2, "QUARANTINED": 2, "ORPHANED": 2, "PENDING": 1, "RETIRED": 1}, inv["counts"])

    live = by.get(s["live"], {})
    check("live.heartbeat-fresh", live.get("liveness") == "LIVE" and live.get("reasons") == ["HEARTBEAT_FRESH"] and live.get("heartbeat_at")
          and 0 <= live.get("heartbeat_age_seconds", -1) < 90, live)
    workers = {w["slot_key"]: w for w in live.get("workers", [])}
    a = workers.get("worker-a", {})
    check("live.worker-attempt-runner", a.get("slot_id") == ids["slot"]["live"] and a.get("attempt", {}).get("id") == ids["attempt"]["live"]
          and a["attempt"]["compute_authority"] == "CURRENT" and a["attempt"]["execution_state"] == "RUNNING" and a["attempt"]["lease_expires_at"]
          and a.get("runner", {}).get("session_id") == ids["session"]["live"] and a["runner"]["state"] == "CURRENT" and a["runner"]["heartbeat_at"] == live.get("heartbeat_at")
          and live.get("attempts") == 1, a)
    sl = a.get("slice") or {}
    check("live.worker-slice-size", sl.get("state") == "MATERIALISED" and sl.get("included_paths") == 3 and sl.get("closure_files") == 7 and sl.get("mode") == "SLICE"
          and sl.get("materialisation_id") == ids["mat"]["live"] and sl.get("verified_head") == "d" * 40, sl)
    sn = a.get("snapshot") or {}
    check("live.worker-snapshot-captured", sn.get("state") == "CAPTURED" and sn.get("id") == ids["snapshot"] and sn.get("result_tree") == "f" * 40 and sn.get("files_changed") == "3", sn)
    b = workers.get("worker-b", {})
    check("live.idle-worker", b.get("capacity_kind") == "BUILD" and b.get("attempt") is None and b.get("runner") is None and b.get("slice") is None
          and b.get("snapshot", {}).get("state") == "NO_ATTEMPT" and len(workers) == 2, b)
    check("live.intent-and-pool", live.get("intent", {}).get("id") == ids["intent"]["live"] and live["intent"]["state"] == "ACKNOWLEDGED" and live["intent"]["updated_at"]
          and live.get("pool_id") == ids["pool"] and live.get("provider") == "railway" and live.get("region") == "eu-west" and live.get("native_sandbox_id") == "native-live"
          and live.get("quarantined_intents") == [] and live.get("work_admitted") is False, live)

    lost = by.get(s["lost"], {})
    check("lost.stale-heartbeat", lost.get("liveness") == "LOST" and lost.get("reasons") == ["HEARTBEAT_STALE"] and lost.get("heartbeat_age_seconds", 0) > 500, lost)
    check("lost.old-boot-heartbeat-ignored", lost.get("boot_generation") == "2" and [w["slot_id"] for w in lost.get("workers", [])] == [ids["slot"]["lost"]]
          and lost["workers"][0]["boot_generation"] == "2", lost)
    lw = (lost.get("workers") or [{}])[0]
    check("lost.snapshot-none-slice-released", lw.get("snapshot", {}).get("state") == "NONE" and lw.get("attempt", {}).get("id") == ids["attempt"]["lost"]
          and (lw.get("slice") or {}).get("state") == "RELEASED", lw)
    unk = by.get(s["unknown"], {})
    check("lost.provider-outcome-unknown", unk.get("liveness") == "LOST" and unk.get("reasons") == ["PROVIDER_OUTCOME_UNKNOWN"] and unk.get("heartbeat_at") is None
          and unk.get("intent", {}).get("state") == "UNKNOWN", unk)

    qi = by.get(s["quarantined"], {})
    check("quarantined.intent", qi.get("liveness") == "QUARANTINED" and qi.get("reasons") == ["PROVISIONING_INTENT_QUARANTINED"]
          and qi.get("quarantined_intents") == [ids["intent"]["quarantined"]] and qi.get("intent", {}).get("failure_code") == "OWNERSHIP_UNVERIFIED"
          and qi.get("heartbeat_age_seconds") is not None and qi["heartbeat_age_seconds"] < 90, qi)
    qc = by.get(s["credential"], {})
    check("quarantined.credential", qc.get("liveness") == "QUARANTINED" and qc.get("reasons") == ["RUNNER_CREDENTIAL_QUARANTINED"], qc)
    pe = by.get(s["pending"], {})
    check("pending.not-enrolled", pe.get("liveness") == "PENDING" and pe.get("reasons") == ["NOT_YET_ENROLLED"] and pe.get("workers") == [] and pe.get("intent", {}).get("state") == "SUBMITTING", pe)
    re_ = by.get(s["retired"], {})
    check("retired.destroyed", re_.get("liveness") == "RETIRED" and re_.get("desired_state") == "DESTROYED" and re_.get("intent") is None, re_)
    check("orphaned.unbound-only", sorted((r["native_sandbox_id"], r["orphan"]["state"]) for r in orphans) == [("lost-create-1", "QUARANTINED"), ("lost-create-2", "RETAINED")]
          and all(r["liveness"] == "ORPHANED" and r["sandbox_id"] is None and r["orphan"]["suspected_intent_id"] == ids["intent"]["quarantined"]
                  and r["orphan"]["first_observed_at"] and r["orphan"]["last_observed_at"] for r in orphans), orphans)
    check("freshness.as-of", inv.get("as_of") and inv.get("heartbeat_max_age_seconds") == 90 and inv.get("view") == "console.sandboxes"
          and inv.get("authority") == "PRIMARY_OBSERVATION" and inv.get("activity_is_qualified_progress") is False and inv.get("scope") == {"organisation_id": ids["org"]}, inv.get("as_of"))
    c = out["classify"]
    check("classify.boundary", c["max"] == 90 and c["at"] == "LIVE" and c["over"] == "LOST" and c["future"] == "LOST" and c["fresh_quarantine"] == "QUARANTINED"
          and c["failed"] == {"liveness": "LOST", "reasons": ["OBSERVED_FAILED"]} and c["missing"] == {"liveness": "LOST", "reasons": ["HEARTBEAT_MISSING"]}, c)

    op = out["operator"].get("ok") or {}
    check("component.operator-reads", "console.sandboxes" in out["actions"] and op.get("counts") == inv["counts"] and len(op.get("rows", [])) == len(inv["rows"]), out["operator"])
    lim = out["limited"].get("ok") or {}
    check("component.limit-truncates", lim.get("truncated") is True and len([r for r in lim.get("rows", []) if r["kind"] == "SANDBOX"]) == 2
          and len([r for r in lim.get("rows", []) if r["kind"] == "ORPHAN"]) == 2, out["limited"])
    check("refuse.worker-role", out["worker"] == {"error": "CONSOLE_FORBIDDEN"}, out["worker"])
    check("refuse.unknown-field", out["unknown"] == {"error": "OBSERVABILITY_INPUT_INVALID"}, out["unknown"])
    check("refuse.unbound-invocation", out["unbound"] == {"error": "AUTHENTICATION_REQUIRED"}, out["unbound"])
    check("readonly.no-writes", str(out["writes"]) in ("0", "None"), out["writes"])


def main():
    configured = os.environ.get("HYPERFIDE_PG_BIN")
    servers = [pathlib.Path(configured)] if configured else sorted(
        (path for path in pathlib.Path("/usr/lib/postgresql").glob("*/bin") if path.parent.name.isdigit() and (path / "initdb").exists()),
        key=lambda path: int(path.parent.name))
    if not servers or not (servers[-1] / "initdb").exists():
        print("SKIP: no PostgreSQL server binaries (initdb); set HYPERFIDE_PG_BIN", flush=True)
        return 77
    if os.geteuid() != 0:
        print("SKIP: the owned cluster runs initdb through runuser postgres, which needs root", flush=True)
        return 77
    t295 = load("hf_case_29_5", "tests/hyperfide/cases/tasks/29_5.py")
    t295.postgres_bin = lambda: servers[-1]
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    base = os.environ.copy()
    # Only the owned cluster is reachable: never let an inherited database URL redirect a probe.
    for key in list(base):
        if key == "DATABASE_URL" or key.startswith("HYPERFIDE_") and key.endswith("_DATABASE_URL"):
            del base[key]
    removed, cluster = False, None
    try:
        ensure_build(base)
        cluster = t295.Cluster()
        cluster.sql("CREATE ROLE " + t295.OPERATOR + " LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS", database="postgres")
        cluster.sql("CREATE DATABASE " + t295.DATABASE + " OWNER " + t295.OPERATOR, database="postgres")
        for attempt in range(6):
            try:
                t295.node(t295.MIGRATE, {**base, "DATABASE_URL": cluster.url(t295.OPERATOR)})
                break
            except AssertionError as error:
                if attempt == 5 or "TX_TIMEOUT" not in str(error):
                    raise
        cluster.sql("CREATE ROLE " + RUNTIME + " LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT")
        t295.applied(cluster.grants(t295.OPERATOR, RUNTIME))
        kinds = ["live", "lost", "unknown", "quarantined", "credential", "pending", "retired"]
        workers = ["live", "lost", "quarantined", "credential"]
        ids = {name: u() for name in ["org", "project", "spec", "run", "package", "profile", "pool", "epoch", "idle_slot", "old_slot", "snapshot"]}
        ids.update(sandbox={k: u() for k in kinds}, intent={k: u() for k in kinds}, task={k: u() for k in workers}, slot={k: u() for k in workers},
                   attempt={k: u() for k in workers}, session={k: u() for k in workers}, cred={k: u() for k in workers + ["lost_old"]},
                   mat={k: u() for k in ["live", "lost", "lost_release"]})
        seed(cluster, t295, ids)
        scenario(cluster, t295, ids, base)
    except Exception:
        traceback.print_exc(file=sys.stderr)
    finally:
        try:
            removed = cluster.close() if cluster else False
        except Exception as error:
            print("cleanup failed: " + str(error), file=sys.stderr)
    for name in ASSERTIONS:
        print(json.dumps({"type": "assertion", "id": name, "expected": True, "actual": RESULTS.get(name, False)}), flush=True)
    print(json.dumps({"type": "cleanup", "resources": [{"id": "postgres-cluster", "status": "deleted" if removed else "unknown", "observed_absent": removed}],
                      "complete": bool(removed)}), flush=True)
    return 0 if removed and all(RESULTS.get(name) for name in ASSERTIONS) else 1


if __name__ == "__main__":
    raise SystemExit(main())
