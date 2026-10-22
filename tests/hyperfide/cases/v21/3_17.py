#!/usr/bin/env python3
"""hyperfide-v21 3.17: finding readers registered as component actions, and attributable intake triage.

On an owned throwaway PostgreSQL cluster with every release migration applied (pattern of v21/4_6.py, whose seed this
case reuses), the probe invokes the nine reader actions through the createComponent action maps of
services/hyperfide/dist/findings (routing.js, github.js, remediation.js) with authenticated invocations:
each is declared in its component manifest and admitted by the control policy, runs for an operator granted it, and
is refused without the grant, without the operator/coordinator/leader role, or by a policy that omits it. A dismissal
and a link record who triaged the issue, why and when (migration 0714), and the database refuses unattributed or
rewritten triage. A repair escalation's Ask goes through the shared deliverAsk helper and its event has the same
shape as one raised by human.ask.raise (3.2). Prints SKIP and exits 77 when no PostgreSQL server or root is available.
"""
import importlib.util, json, os, pathlib, signal, sys, traceback, uuid

ROOT = pathlib.Path(__file__).resolve().parents[4]
SERVICE = ROOT / "services/hyperfide"
READERS = {
    "18.3.json": ("findings/routing.js", ["finding.leader-queue.list", "finding.leader-queue.acknowledge", "finding.leader-queue.route"]),
    "18.2.json": ("findings/github.js", ["finding.intake.list", "finding.intake.dismiss", "finding.intake.link"]),
    "18.4.json": ("findings/remediation.js", ["finding.repair.escalation.list", "finding.repair.escalation.acknowledge", "finding.repair.escalation.route"]),
}
ACTIONS = [a for _, (_, names) in sorted(READERS.items()) for a in names]
LISTS = ["finding.leader-queue.list", "finding.intake.list", "finding.repair.escalation.list"]
ASSERTIONS = [
    "migration.applied",
    "registered.manifest",
    "registered.policy",
    "registered.read-only-lists",
    "registered.docs",
    "reachable.component-actions",
    "reachable.lists",
    "refused.without-grant",
    "refused.without-role",
    "refused.policy-without-action",
    "authority.leader-queue",
    "authority.escalation",
    "triage.dismiss-needs-reason",
    "triage.dismiss-records-actor-reason",
    "triage.dismiss-replay-keeps-attribution",
    "triage.list-shows-attribution",
    "triage.link-records-actor-reason",
    "triage.link-event-reason",
    "triage.db-refuses-unattributed",
    "triage.db-refuses-rewrite",
    "ask.escalation-raised",
    "ask.shape-matches-3.2",
]
RESULTS = {}


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def check(name, ok, detail=None):
    RESULTS[name] = bool(ok)
    if not ok:
        print("assertion failed: %s %s" % (name, json.dumps(detail, default=str)[:2000] if detail is not None else ""), file=sys.stderr, flush=True)


def u():
    return str(uuid.uuid4())


def static_checks():
    manifest_ok = True
    for name, (module, actions) in READERS.items():
        fragment = json.loads((SERVICE / "components" / name).read_text())
        manifest_ok &= fragment["module"] == module and "control" in fragment["roles"] and all(a in fragment["actions"] for a in actions)
    check("registered.manifest", manifest_ok)
    policy = json.loads((ROOT / "deploy/hyperfide/policies/control.example.json").read_text())
    check("registered.policy", all(a in policy["allowed_actions"] for a in ACTIONS), [a for a in ACTIONS if a not in policy["allowed_actions"]])
    registry = (SERVICE / "src/findings/registry.ts").read_text()
    line = next((l for l in registry.splitlines() if "const readOnly=[" in l), "")
    writes = [a for a in ACTIONS if a not in LISTS]
    check("registered.read-only-lists", all("'" + a + "'" in line for a in LISTS) and not any("'" + a + "'" in line for a in writes), line[:400])
    docs = (ROOT / "docs/hyperfide/operations.md").read_text()
    check("registered.docs", all("`" + a + "`" in docs for a in ACTIONS) and "triaged_by" in docs)


PROBE = r"""
import fs from 'node:fs';
import {createResourceContainer} from './services/hyperfide/dist/storage/runtime.js';
import {createComponent as routing} from './services/hyperfide/dist/findings/routing.js';
import {createComponent as github} from './services/hyperfide/dist/findings/github.js';
import {createComponent as remediation,escalationAskId} from './services/hyperfide/dist/findings/remediation.js';
import {createAskComponent} from './services/hyperfide/dist/policy/human_interface.js';
import {enqueue,resolveOperatorConsumer} from './services/hyperfide/dist/events/outbox.js';
import {authenticatedInvocation} from './services/hyperfide/dist/transport/protocol.js';
import {validatePolicy,assertAdmission} from './services/hyperfide/dist/policy/programme.js';
import {randomUUID} from 'node:crypto';
const o=JSON.parse(process.env.HF_IDS),ACTIONS=JSON.parse(process.env.HF_ACTIONS);
const controller=new AbortController();
const r=createResourceContainer({role:'control',env:process.env,signal:controller.signal});
const startup={role:'control',signal:controller.signal,env:{},resources:r};
const actions={...routing(startup).actions,...github(startup).actions,...remediation(startup).actions};
const asks=createAskComponent(startup).actions;
const out={};
const dependencies={require:(id,name,guard)=>{const v={'4.2':{'storage.transactions.v1':r.gateway},'6.1':{'events.outbox.v1':{enqueue,resolveOperatorConsumer}}}[id]?.[name];if(!guard(v))throw Error('missing '+id+'/'+name);return v;}};
// One authenticated invocation of one action, as the transport hands it to a component after verifying the request.
const invoke=(action,input,{role='OPERATOR',grant=[action],actor=o.operator,env={}}={})=>{
 const invocation=authenticatedInvocation({principal:{credential_id:o.credential,organisation_id:o.org,run_id:o.run,actor_id:actor,role,deployment_epoch:o.epoch,allowed_actions:grant,expires_at:new Date(Date.now()+3600000).toISOString()},
  operation:{idempotency_key:randomUUID(),operation_id:randomUUID(),payload_digest:'sha256:'+'0'.repeat(64)},payload:{action,run_id:o.run},signal:controller.signal,
  guard:async()=>{},identityGuard:async()=>{},continuationGuard:async()=>{}});
 const fn=action.startsWith('human.ask.')?asks[action]:actions[action];
 return fn(input,{...startup,env,policy:{programme_id:o.run},dependencies,invocation});
};
const step=async(name,fn)=>{try{out[name]=(await fn())??null;}catch(e){out[name]={error:String(e?.code??'ERROR'),message:String(e?.message??e)};}};
const q=(sql,params)=>r.gateway.withPrimaryTransaction({timeoutMs:10000},async tx=>(await tx.query(sql,params)).rows);
const version=async id=>(await q('SELECT state_version::text AS v FROM hyperfide.finding_registry_records WHERE organisation_id=$1 AND run_id=$2 AND finding_id=$3',[o.org,o.run,id]))[0].v;
try{
 out.exported=ACTIONS.filter(a=>typeof actions[a]!=='function');
 const policy=JSON.parse(fs.readFileSync('deploy/hyperfide/policies/control.example.json','utf8'));
 out.policy_admits=[];out.policy_refuses=[];
 for(const a of ACTIONS){
  try{assertAdmission(validatePolicy(policy,policy.spec_revision,'control'),'control',a);out.policy_admits.push(a);}catch(e){}
  const without={...policy,allowed_actions:policy.allowed_actions.filter(x=>x!==a)};
  try{assertAdmission(validatePolicy(without,without.spec_revision,'control'),'control',a);}catch(e){if(e.code==='ACTION_DENIED')out.policy_refuses.push(a);}
 }
 out.no_grant={};for(const a of ACTIONS){await step('tmp',()=>invoke(a,{},{grant:['finding.inspect']}));out.no_grant[a]=out.tmp;}
 out.no_role={};for(const a of ['finding.leader-queue.list','finding.intake.list','finding.repair.escalation.list']){await step('tmp',()=>invoke(a,{},{role:'WORKER',actor:o.worker}));out.no_role[a]=out.tmp;}
 await step('no_role.manager',()=>invoke('finding.intake.list',{},{role:'FEATURE_MANAGER',actor:o.manager}));
 await step('no_role.dismiss',()=>invoke('finding.intake.dismiss',{repository_id:o.repo,issue_number:102,external_updated_at:'2026-10-02T10:00:00Z',reason:'not ours'},{role:'WORKER',actor:o.worker}));
 delete out.tmp;
 for(const a of ['finding.leader-queue.list','finding.intake.list'])await step('list.'+a,()=>invoke(a,{}));
 // Leader queue through its registered acknowledge and route.
 await step('leader.ack',()=>invoke('finding.leader-queue.acknowledge',{route_id:o.route_queue,generation:'1'}));
 await step('leader.route',async()=>{const ev=await version(o.f_queue);return invoke('finding.leader-queue.route',{finding_id:o.f_queue,request_id:randomUUID(),expected_state_version:ev,package_id:o.pkg_b,reason:'Leader assigns the queued finding to package b'});});
 // Intake triage.
 const issue=(repo,n,at)=>({repository_id:repo,issue_number:n,external_updated_at:at});
 await step('dismiss.no-reason',()=>invoke('finding.intake.dismiss',issue(o.repo,102,'2026-10-02T10:00:00Z')));
 await step('dismiss.blank-reason',()=>invoke('finding.intake.dismiss',{...issue(o.repo,102,'2026-10-02T10:00:00Z'),reason:'  '}));
 await step('dismiss',()=>invoke('finding.intake.dismiss',{...issue(o.repo,102,'2026-10-02T10:00:00Z'),reason:'A documentation question, not a defect'}));
 await step('dismiss.replay',()=>invoke('finding.intake.dismiss',{...issue(o.repo,102,'2026-10-02T10:00:00Z'),reason:'a different reason'},{actor:o.manager}));
 await step('dismiss.row',()=>q('SELECT state,triaged_by::text,triage_reason,triaged_at IS NOT NULL AS stamped FROM hyperfide.finding_external_intake WHERE organisation_id=$1 AND run_id=$2 AND repository_id=$3 AND issue_number=102',[o.org,o.run,o.repo]));
 await step('list.dismissed',()=>invoke('finding.intake.list',{state:'DISMISSED'}));
 await step('link',async()=>{const ev=await version(o.f_intake);return invoke('finding.intake.link',{...issue(o.repo,101,'2026-10-01T10:00:00Z'),finding_id:o.f_intake,expected_state_version:ev,reason:'Same crash the finding reproduces'});});
 await step('link.row',()=>q('SELECT state,finding_id::text,triaged_by::text,triage_reason,triaged_at IS NOT NULL AS stamped FROM hyperfide.finding_external_intake WHERE organisation_id=$1 AND run_id=$2 AND repository_id=$3 AND issue_number=101',[o.org,o.run,o.repo]));
 await step('link.events',()=>q("SELECT payload FROM hyperfide.outbox_events WHERE organisation_id=$1 AND run_id=$2 AND aggregate_id=$3 AND event_type='finding.intake.linked'",[o.org,o.run,o.f_intake]));
 // Escalation through the registered repair actions, then a 3.2 Ask raised by human.ask.raise for comparison.
 await step('channel',()=>q("INSERT INTO hyperfide.event_consumers(organisation_id,run_id,consumer_key,critical,state) VALUES($1,$2,'operator:asks',false,'ACTIVE') RETURNING id::text",[o.org,o.run]));
 const policed={env:{HF_FINDING_ESCALATION_ASK_SECONDS:'3600'}};
 await step('escalate',()=>invoke('finding.repair.fail',{repair_id:o.repair,expected_state_version:'1',evidence_ids:[o.evidence],reason:'reproduction still fails after the last allowed attempt'},policed));
 await step('escalation.list',()=>invoke('finding.repair.escalation.list',{},policed));
 await step('escalation.no-role',()=>invoke('finding.repair.escalation.acknowledge',{repair_id:o.repair,expected_state_version:'2'},{...policed,role:'FEATURE_MANAGER',actor:o.manager}));
 await step('escalation.ack',()=>invoke('finding.repair.escalation.acknowledge',{repair_id:o.repair,expected_state_version:'2'},policed));
 await step('escalation.route',async()=>{const ev=await version(o.f_repair);return invoke('finding.repair.escalation.route',{repair_id:o.repair,request_id:randomUUID(),expected_state_version:ev,package_id:o.pkg_b,reason:'Escalation reassigned to package b'},policed);});
 await step('raise32',()=>invoke('human.ask.raise',{idempotency_key:'case-3-17',kind:'decision',title:'Comparison Ask',body:'raised through human.ask.raise',options:['HOLD','RETRY'],recommended:'HOLD',deadline_seconds:null,chain:null,task_id:null}));
 out.escalation_ask_id=escalationAskId({organisation_id:o.org,run_id:o.run},o.repair);
 await step('ask.events',()=>q("SELECT aggregate_id::text,aggregate_version::text,payload FROM hyperfide.outbox_events WHERE organisation_id=$1 AND run_id=$2 AND aggregate_type='ask' AND event_type='ask.raised'",[o.org,o.run]));
}finally{controller.abort();await r.close();}
console.log(JSON.stringify(out));
"""


def err(value, code):
    return isinstance(value, dict) and value.get("error") == code


def scenario(cluster, t295, t46, base, ids):
    applied = json.loads(cluster.sql("SELECT coalesce(json_agg(version ORDER BY version),'[]') FROM hyperfide.schema_migrations WHERE version IN (18,709,714)", user=t295.SUPERUSER))
    check("migration.applied", applied == [18, 709, 714], applied)
    t46.seed(cluster, t295.SUPERUSER, ids)
    env = {**base, "DATABASE_URL": cluster.url(t295.OPERATOR), "HF_IDS": json.dumps(ids), "HF_ACTIONS": json.dumps(ACTIONS)}
    out = json.loads(t295.node(PROBE, env).strip().splitlines()[-1])
    o = ids

    check("reachable.component-actions", out.get("exported") == [], out.get("exported"))
    check("registered.policy", RESULTS.get("registered.policy") and sorted(out.get("policy_admits") or []) == sorted(ACTIONS), out.get("policy_admits"))
    check("refused.policy-without-action", sorted(out.get("policy_refuses") or []) == sorted(ACTIONS), out.get("policy_refuses"))
    no_grant = out.get("no_grant") or {}
    check("refused.without-grant", sorted(no_grant) == sorted(ACTIONS) and all(err(v, "AUTH_DENIED") for v in no_grant.values()), no_grant)
    no_role = out.get("no_role") or {}
    check("refused.without-role", len(no_role) == 3 and all(err(v, "AUTH_DENIED") for v in no_role.values())
          and err(out.get("no_role.manager"), "AUTH_DENIED") and err(out.get("no_role.dismiss"), "AUTH_DENIED"), [no_role, out.get("no_role.manager"), out.get("no_role.dismiss")])
    queue = (out.get("list.finding.leader-queue.list") or {}).get("items")
    intake = (out.get("list.finding.intake.list") or {}).get("items")
    escal = (out.get("escalation.list") or {}).get("items")
    check("reachable.lists", isinstance(queue, list) and len(queue) == 1 and isinstance(intake, list) and len(intake) == 3
          and isinstance(escal, list) and any(i["repair_id"] == o["repair"] for i in escal), [out.get("list.finding.leader-queue.list"), out.get("list.finding.intake.list"), out.get("escalation.list")])
    ack, routed = out.get("leader.ack") or {}, (out.get("leader.route") or {}).get("route") or {}
    check("authority.leader-queue", ack.get("acknowledged") is True and ack.get("acknowledged_by") == o["operator"]
          and routed.get("owner_package_id") == o["pkg_b"] and routed.get("leader_queue") is False, [out.get("leader.ack"), out.get("leader.route")])
    eack, eroute = out.get("escalation.ack") or {}, out.get("escalation.route") or {}
    check("authority.escalation", err(out.get("escalation.no-role"), "AUTH_DENIED") and eack.get("acknowledged") is True
          and eack.get("ask_id") == out.get("escalation_ask_id") and eroute.get("route_id") and eroute.get("leader_queue") is False,
          [out.get("escalation.no-role"), eack, eroute])

    check("triage.dismiss-needs-reason", err(out.get("dismiss.no-reason"), "INVALID_REQUEST") and err(out.get("dismiss.blank-reason"), "INVALID_REQUEST"),
          [out.get("dismiss.no-reason"), out.get("dismiss.blank-reason")])
    d = out.get("dismiss") or {}
    row = (out.get("dismiss.row") or [{}])[0]
    check("triage.dismiss-records-actor-reason", d.get("state") == "DISMISSED" and d.get("replayed") is False and d.get("triaged_by") == o["operator"]
          and d.get("triage_reason") == "A documentation question, not a defect" and d.get("triaged_at")
          and row == {"state": "DISMISSED", "triaged_by": o["operator"], "triage_reason": "A documentation question, not a defect", "stamped": True}, [d, row])
    rp = out.get("dismiss.replay") or {}
    check("triage.dismiss-replay-keeps-attribution", rp.get("replayed") is True and rp.get("triaged_by") == o["operator"]
          and rp.get("triage_reason") == "A documentation question, not a defect" and rp.get("triaged_at") == d.get("triaged_at"), rp)
    listed = (out.get("list.dismissed") or {}).get("items") or []
    check("triage.list-shows-attribution", len(listed) == 1 and listed[0]["triaged_by"] == o["operator"]
          and listed[0]["triage_reason"] == "A documentation question, not a defect" and listed[0]["triaged_at"], listed)
    link, lrow = out.get("link") or {}, (out.get("link.row") or [{}])[0]
    check("triage.link-records-actor-reason", link.get("state") == "LINKED" and link.get("triaged_by") == o["operator"]
          and lrow == {"state": "LINKED", "finding_id": o["f_intake"], "triaged_by": o["operator"], "triage_reason": "Same crash the finding reproduces", "stamped": True}, [link, lrow])
    events = out.get("link.events") or []
    check("triage.link-event-reason", len(events) == 1 and events[0]["payload"].get("reason") == "Same crash the finding reproduces"
          and events[0]["payload"].get("actor_id") == o["operator"], events)
    def refused(statement):
        try:
            cluster.sql(statement, user=t295.SUPERUSER)
            return ""
        except AssertionError as error:
            return str(error)
    where = f"organisation_id='{o['org']}' AND run_id='{o['run']}'"
    unattributed = refused(f"UPDATE hyperfide.finding_external_intake SET state='DISMISSED' WHERE {where} AND repository_id='{o['repo2']}' AND issue_number=7")
    still = cluster.sql(f"SELECT state||':'||coalesce(triaged_by::text,'-') FROM hyperfide.finding_external_intake WHERE {where} AND repository_id='{o['repo2']}' AND issue_number=7", user=t295.SUPERUSER)
    check("triage.db-refuses-unattributed", "leaves triage only with who triaged" in unattributed and still == "NEEDS_TRIAGE:-", [unattributed, still])
    rewrite = refused(f"UPDATE hyperfide.finding_external_intake SET triage_reason='rewritten' WHERE {where} AND repository_id='{o['repo']}' AND issue_number=102")
    check("triage.db-refuses-rewrite", "immutable once recorded" in rewrite, rewrite)

    esc = out.get("escalate") or {}
    raised = out.get("raise32") or {}
    by_id = {e["aggregate_id"]: e for e in out.get("ask.events") or []}
    mine, theirs = by_id.get(out.get("escalation_ask_id")), by_id.get((raised.get("ask") or {}).get("ask_id"))
    check("ask.escalation-raised", esc.get("escalated") is True and esc.get("ask_id") == out.get("escalation_ask_id") and mine is not None
          and mine["payload"]["source"] == {"repair_id": o["repair"], "finding_id": o["f_repair"]}, [esc, list(by_id)])
    shape = lambda e: (sorted(k for k in e["payload"] if k != "source"), sorted(e["payload"]["ask"]), e["payload"]["schema_version"], e["payload"]["target"], e["aggregate_version"])
    check("ask.shape-matches-3.2", raised.get("status") == "RAISED" and mine is not None and theirs is not None and shape(mine) == shape(theirs)
          and mine["payload"]["ask"]["kind"] == theirs["payload"]["ask"]["kind"] == "decision"
          and mine["payload"]["actor_id"] == theirs["payload"]["actor_id"] == o["operator"], [raised, mine, theirs])


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
    if not (SERVICE / "node_modules").exists():
        print("SKIP: services/hyperfide/node_modules is not installed", flush=True)
        return 77
    t295 = load("hf_case_29_5", "tests/hyperfide/cases/tasks/29_5.py")
    t46 = load("hf_case_4_6", "tests/hyperfide/cases/v21/4_6.py")
    t295.postgres_bin = lambda: servers[-1]
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    base = os.environ.copy()
    # Only the owned cluster is reachable: never let an inherited database URL redirect a probe.
    for key in list(base):
        if key == "DATABASE_URL" or key.startswith("HYPERFIDE_") and key.endswith("_DATABASE_URL") or key == "HF_FINDING_ESCALATION_ASK_SECONDS":
            del base[key]
    removed, cluster = False, None
    try:
        static_checks()
        t46.ensure_build(base)
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
        names = ["org", "project", "spec", "run", "epoch", "pkg_a", "pkg_b", "pool", "sandbox", "slot", "task", "attempt", "manager", "worker",
                 "operator", "credential", "repo", "repo2", "evidence", "f_queue", "f_repair", "f_intake", "f_closed", "f_assigned", "f_backfill",
                 "f_other", "route_queue", "route_assigned", "repair", "repair_old", "repair_failed"]
        scenario(cluster, t295, t46, base, {name: u() for name in names})
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
