#!/usr/bin/env python3
"""hyperfide-v21 5.1: the Needs, Issues and Leaders read model (observability/console.ts).

Applies every release migration to an owned throwaway PostgreSQL cluster (pattern of v21/3_2.py and
v21/5_2.py), grants the runtime role exactly as deploy/hyperfide/grants.sql does, seeds one run with rows
for every section and a decoy for each filter, and reads console.needs, console.issues and console.leaders
as that runtime role. Asks are raised, answered and expired through their real head triggers (0709, 0711);
human-intent state, admission escalation, finding, routing, intake, repair and observation rows belong to
other tasks and are written as fixture anchors with session_replication_role=replica (as v21/4_6.py does).
Every row is checked for its freshness and references. Prints SKIP and exits 77 without a PostgreSQL
server, root or the service's node_modules (task 1.7 contract).
"""
import hashlib, importlib.util, json, os, pathlib, signal, subprocess, sys, traceback, uuid

ROOT = pathlib.Path(__file__).resolve().parents[4]
SERVICE = ROOT / "services/hyperfide"
RUNTIME = "hf_runtime"
ASSERTIONS = [
    "migration.applied",
    "needs.asks-waiting-only",
    "needs.ask-order-and-deadline",
    "needs.ask-blocking-holds-task",
    "needs.ask-expired-blocking-overdue",
    "needs.ask-org-scoped",
    "needs.ask-references",
    "needs.intents-pending-only",
    "needs.intent-current-leader",
    "needs.intent-stale-target",
    "needs.escalations-open-only",
    "needs.escalation-references",
    "needs.counts",
    "issues.leader-queue",
    "issues.external-intake",
    "issues.escalated-repairs",
    "issues.drift-not-running",
    "issues.drift-still-running",
    "issues.drift-stale",
    "issues.drift-excludes-agreeing",
    "issues.counts",
    "leaders.default-live-only",
    "leaders.primary-first",
    "leaders.carrying",
    "leaders.stale-launch",
    "leaders.include-ended",
    "freshness.every-row",
    "references.every-row",
    "component.actions",
    "component.operator-reads",
    "component.leader-reads-issues",
    "component.limit-truncates",
    "refuse.stale-leader-issues",
    "refuse.worker-role",
    "refuse.provisioner-needs",
    "component.provisioner-leaders",
    "refuse.unknown-field",
    "refuse.bad-include-ended",
    "refuse.unbound-invocation",
    "readonly.no-writes",
]
RESULTS = {}
D = "'sha256:'||repeat('a',64)"
OID = "repeat('b',40)"


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


def escalation_ask_id(org, run, repair):
    # Same derivation as findings/remediation.ts escalationAskId: one decision Ask per escalated repair.
    h = hashlib.sha256(("repair-escalation:%s:%s:%s" % (org, run, repair)).encode()).hexdigest()
    return h[0:8] + "-" + h[8:12] + "-8" + h[13:16] + "-" + format((int(h[16], 16) & 3) | 8, "x") + h[17:20] + "-" + h[20:32]


def ensure_build(base):
    stamp = subprocess.run(["node", "deploy/hyperfide/dist-stamp.mjs", "check", str(SERVICE)], cwd=ROOT, env=base, capture_output=True, text=True)
    if stamp.returncode:
        p = subprocess.run(["npm", "--prefix", str(SERVICE), "run", "build"], cwd=ROOT, env=base, capture_output=True, text=True, timeout=900)
        if p.returncode:
            raise AssertionError("service build failed: " + (p.stderr + p.stdout)[-1500:])


PROBE = r"""
import fs from 'node:fs';
import pg from './services/hyperfide/node_modules/pg/lib/index.js';
const {needsPanel,issuesPanel,leadersPanel,createComponent,OBSERVATION_MAX_AGE_SECONDS}=await import('./services/hyperfide/dist/observability/console.js');
const i=JSON.parse(fs.readFileSync(0,'utf8')),out={};
const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();
const writes=async()=>(await c.query('SELECT coalesce(sum(n_tup_ins+n_tup_upd+n_tup_del),0)::text AS w FROM pg_stat_xact_user_tables')).rows[0].w;
const p=(role,actor=i.actor)=>({organisation_id:i.org,run_id:i.run,actor_id:actor,credential_id:i.credential,role,deployment_epoch:i.epoch});
try{
 await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 out.needs=await needsPanel(c,p('OPERATOR'));
 out.issues=await issuesPanel(c,{principal:p('OPERATOR'),context:{env:{}}});
 out.leaders=await leadersPanel(c,p('OPERATOR'));
 out.leaders_all=await leadersPanel(c,p('OPERATOR'),{include_ended:true});
 out.writes=await writes();
 await c.query('COMMIT');
 out.max_age=OBSERVATION_MAX_AGE_SECONDS;
 const component=createComponent({env:{}});
 out.actions=Object.keys(component.actions).sort();
 // Read only for every caller but the leader: the 4.6 readers lock the leader row FOR SHARE to authorise it.
 const invoke=async(action,principal,input,{envelope={},readOnly=true}={})=>{
  const ctx={env:{},signal:new AbortController().signal,invocation:{principal,payload:{action,run_id:principal.run_id,...envelope},signal:new AbortController().signal,guard:async()=>{}},
   resources:{gateway:{withPrimaryTransaction:async(_o,fn)=>{await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ'+(readOnly?' READ ONLY':''));try{const r=await fn(c);const w=await writes();await c.query('COMMIT');return {r,w};}catch(e){await c.query('ROLLBACK');throw e;}}}}};
  try{const {r,w}=await component.actions[action](input,ctx);return {ok:r,writes:w};}catch(e){return {error:e.code??e.message};}
 };
 out.op_needs=await invoke('console.needs',p('OPERATOR'),{run_id:i.run});
 out.op_issues=await invoke('console.issues',p('OPERATOR'),{});
 out.op_leaders=await invoke('console.leaders',p('OPERATOR'),{include_ended:true,max_observation_age_seconds:60});
 out.leader_issues=await invoke('console.issues',p('LEADER',i.leader),{},{readOnly:false});
 out.stale_leader_issues=await invoke('console.issues',p('LEADER',i.old_leader),{},{readOnly:false});
 out.limited=await invoke('console.needs',p('COORDINATOR'),{limit:1});
 out.worker=await invoke('console.leaders',p('WORKER'),{});
 out.prov_needs=await invoke('console.needs',p('PROVISIONER'),{});
 out.prov_leaders=await invoke('console.leaders',p('PROVISIONER'),{});
 out.unknown=await invoke('console.issues',p('OPERATOR'),{organisation_id:i.org});
 out.bad_ended=await invoke('console.leaders',p('OPERATOR'),{include_ended:'yes'});
 out.ended_on_needs=await invoke('console.needs',p('OPERATOR'),{include_ended:true});
 out.unbound=await invoke('console.needs',p('OPERATOR'),{},{envelope:{run_id:i.other_run}});
}finally{await c.end();}
process.stdout.write(JSON.stringify(out));
"""


def seed(db, t, o):
    su = t.SUPERUSER
    core = [
        "BEGIN",
        f"INSERT INTO hyperfide.organisations(id,name) VALUES('{o['org']}','console-needs-probe')",
        f"INSERT INTO hyperfide.projects(organisation_id,id,name) VALUES('{o['org']}','{o['project']}','fixture')",
        f"INSERT INTO hyperfide.spec_revisions(organisation_id,id,project_id,source_digest,source_content,document,schema_version) VALUES('{o['org']}','{o['spec']}','{o['project']}','sha256:'||encode(sha256(convert_to('fixture','UTF8')),'hex'),'fixture','{{}}',1)",
        f"INSERT INTO hyperfide.runs(organisation_id,id,project_id,spec_revision_id,policy_digest,authority_epoch,state) VALUES('{o['org']}','{o['run']}','{o['project']}','{o['spec']}',{D},'{o['epoch']}','RUNNING'),"
        f"('{o['org']}','{o['other_run']}','{o['project']}','{o['spec']}',{D},'{u()}','RUNNING')",
        f"INSERT INTO hyperfide.feature_packages(organisation_id,run_id,id,package_key,wave) VALUES('{o['org']}','{o['run']}','{o['pkg_a']}','package-a',5),('{o['org']}','{o['run']}','{o['pkg_b']}','package-b',5)",
        f"INSERT INTO hyperfide.provider_pools(organisation_id,id,provider,account_key,environment_key,region) VALUES('{o['org']}','{o['pool']}','railway','fixture','fixture','eu-west')",
        f"INSERT INTO hyperfide.sandboxes(organisation_id,id,pool_id,observed_state) VALUES('{o['org']}','{o['sandbox']}','{o['pool']}','RUNNING')",
        f"INSERT INTO hyperfide.worker_slots(organisation_id,id,sandbox_id,slot_key,boot_generation,capacity_kind) VALUES('{o['org']}','{o['slot']}','{o['sandbox']}','worker-a',1,'AGENT')",
        f"INSERT INTO hyperfide.tasks(organisation_id,run_id,id,task_key,feature_package_id,spec_revision_id,criteria_digest,definition,wave) VALUES"
        f"('{o['org']}','{o['run']}','{o['task']}','5.1','{o['pkg_a']}','{o['spec']}',{D},'{{}}',5),('{o['org']}','{o['run']}','{o['task_b']}','5.9','{o['pkg_b']}','{o['spec']}',{D},'{{}}',5)",
        f"INSERT INTO hyperfide.attempts(organisation_id,run_id,id,task_id,generation,authority_epoch,input_packet_digest,execution_state,compute_authority,sandbox_id,slot_id,sandbox_boot_generation,lease_expires_at) VALUES"
        f"('{o['org']}','{o['run']}','{o['attempt']}','{o['task']}',1,'{o['epoch']}',{D},'RUNNING','CURRENT','{o['sandbox']}','{o['slot']}',1,clock_timestamp()+interval '30 minutes')",
        # Sessions: the primary leader, its replaced predecessor, two feature managers and two workers.
        f"INSERT INTO hyperfide.agent_sessions(organisation_id,run_id,id,role,connector,account_key,native_session_id,state,created_at) VALUES"
        f"('{o['org']}','{o['run']}','{o['old_leader']}','LEADER','claude','fixture','lead-0','STOPPED',clock_timestamp()-interval '2 hours'),"
        f"('{o['org']}','{o['run']}','{o['leader']}','LEADER','claude','fixture','lead-1','RUNNING',clock_timestamp()-interval '1 hour')",
        f"INSERT INTO hyperfide.agent_sessions(organisation_id,run_id,id,role,parent_session_id,connector,account_key,native_session_id,state) VALUES"
        f"('{o['org']}','{o['run']}','{o['fm1']}','FEATURE_MANAGER','{o['leader']}','codex','fixture','fm-1','RUNNING'),"
        f"('{o['org']}','{o['run']}','{o['fm2']}','FEATURE_MANAGER','{o['leader']}','codex','fixture','fm-2','REGISTERED')",
        f"INSERT INTO hyperfide.agent_sessions(organisation_id,run_id,id,role,parent_session_id,connector,account_key,native_session_id,state,attempt_id,sandbox_id,slot_id,sandbox_boot_generation) VALUES"
        f"('{o['org']}','{o['run']}','{o['worker']}','WORKER','{o['fm1']}','codex','fixture','w-1','RUNNING','{o['attempt']}','{o['sandbox']}','{o['slot']}',1)",
        f"INSERT INTO hyperfide.agent_sessions(organisation_id,run_id,id,role,parent_session_id,connector,account_key,native_session_id,state) VALUES"
        f"('{o['org']}','{o['run']}','{o['worker2']}','WORKER','{o['fm1']}','codex','fixture','w-2','STOPPED')",
        f"UPDATE hyperfide.feature_packages SET manager_session_id='{o['fm1']}',state_version=state_version+1 WHERE organisation_id='{o['org']}' AND run_id='{o['run']}' AND id='{o['pkg_a']}'",
        f"INSERT INTO hyperfide.hierarchy_leaders(organisation_id,run_id,authority_epoch,leader_session_id,generation) VALUES('{o['org']}','{o['run']}','{o['epoch']}','{o['leader']}',2)",
        f"INSERT INTO hyperfide.repositories(organisation_id,id,project_id,name,url) VALUES('{o['org']}','{o['repo']}','{o['project']}','app','https://example.invalid/app')",
        f"INSERT INTO hyperfide.source_objects(organisation_id,repository_id,object_id) VALUES('{o['org']}','{o['repo']}',{OID})",
        "COMMIT",
    ]
    db.sql(";".join(core), user=su)

    # Anchors owned by other tasks: task state, human-intent projection, admission, findings and observations.
    findings, registry = [], []
    for key in ("f_queue", "f_closed", "f_repair", "f_repair_old", "f_failed"):
        findings.append(f"('{o['org']}','{o['run']}','{o[key]}','sha256:'||encode(sha256(convert_to('{o[key]}','UTF8')),'hex'),'{o['pkg_a']}','{o['repo']}',{OID},'ERROR','summary of {key}')")
        registry.append(f"('{o['org']}','{o['run']}','{o[key]}','{'RESOLVED' if key == 'f_closed' else 'TRIAGED'}','{o['task']}','{o['attempt']}','{{}}',{D},clock_timestamp(),clock_timestamp())")

    def intent(root, cmd, target, consumer, state, delivery):
        result = json.dumps({"state": state, "root_event_id": root, "current_event_id": root, "target_session_id": target, "target_consumer_id": consumer,
                             "leader_generation": "2", "authority_epoch": o["epoch"]})
        payload = json.dumps({"schema_version": 1, "request_id": cmd, "kind": "DIRECTION", "payload": {"text": "ship wave 5"}, "source_actor_id": o["human"],
                              "source_role": "OPERATOR", "target": "PRIMARY_LEADER", "target_session_id": target, "target_consumer_id": consumer, "package_id": o["pkg_a"]})
        rows = [f"INSERT INTO hyperfide.outbox_events(organisation_id,run_id,id,aggregate_type,aggregate_id,aggregate_version,event_type,payload,created_at) VALUES('{o['org']}','{o['run']}','{root}','human_command','{cmd}',1,'leader.intent.requested','{payload}',clock_timestamp()-interval '20 minutes')",
                f"INSERT INTO hyperfide.command_inbox(organisation_id,run_id,id,principal_scope,operation,idempotency_key,request_digest,state,result) VALUES('{o['org']}','{o['run']}','{u()}','human_intent','human.intent.state','{root}',{D},'COMPLETED','{result}')"]
        ack = "clock_timestamp()-interval '5 minutes'" if delivery == "ACKNOWLEDGED" else "NULL"
        rows.append(f"INSERT INTO hyperfide.event_deliveries(organisation_id,run_id,event_id,consumer_id,state,acknowledged_at) VALUES('{o['org']}','{o['run']}','{root}','{consumer}','{delivery}',{ack})")
        return rows

    anchors = [
        "BEGIN", "SET LOCAL session_replication_role=replica",
        f"UPDATE hyperfide.tasks SET state='RUNNING',current_attempt_id='{o['attempt']}' WHERE organisation_id='{o['org']}' AND run_id='{o['run']}' AND id='{o['task']}'",
        f"UPDATE hyperfide.tasks SET state='RUNNING' WHERE organisation_id='{o['org']}' AND run_id='{o['run']}' AND id='{o['task_b']}'",
        f"INSERT INTO hyperfide.event_consumers(organisation_id,run_id,id,consumer_key,state) VALUES('{o['org']}','{o['run']}','{o['consumer']}','leader:human_intent:2','ACTIVE'),('{o['org']}','{o['run']}','{o['old_consumer']}','leader:human_intent:1','STOPPED')",
        *intent(o["intent"], o["cmd"], o["leader"], o["consumer"], "PENDING", "ACKNOWLEDGED"),
        *intent(o["intent_stale"], o["cmd_stale"], o["old_leader"], o["old_consumer"], "PENDING", "PENDING"),
        *intent(o["intent_done"], o["cmd_done"], o["leader"], o["consumer"], "LEADER_REPORTED_COMPLETE", "ACKNOWLEDGED"),
        # Admission: the worker's launch escalated twice (one resolved), a second reservation's escalation was closed.
        f"INSERT INTO hyperfide.agent_admission_accounts(organisation_id,run_id,quota_key,policy_digest,max_concurrent,active) VALUES('{o['org']}','{o['run']}','codex:fixture',{D},4,1)",
        f"INSERT INTO hyperfide.agent_admission_reservations(organisation_id,run_id,id,quota_key,session_id,payload_digest,policy_digest,state,attempt_count,reason) VALUES"
        f"('{o['org']}','{o['run']}','{o['reservation']}','codex:fixture','{o['worker']}',{D},{D},'ESCALATED',3,'AUTH_EXPIRED'),"
        f"('{o['org']}','{o['run']}','{o['reservation2']}','codex:fixture','{o['worker2']}',{D},{D},'RELEASED',1,NULL)",
        f"INSERT INTO hyperfide.agent_admission_escalations(organisation_id,run_id,id,reservation_id,session_id,sequence,reason,attempt_count,condition_digest,diagnostic_refs,raised_by_operation_id,state,resolution,created_at,resolved_at) VALUES"
        f"('{o['org']}','{o['run']}','{u()}','{o['reservation']}','{o['worker']}',1,'RATE_LIMIT',1,NULL,'[]','{u()}','RESOLVED','{{}}',clock_timestamp()-interval '1 hour',clock_timestamp()-interval '50 minutes'),"
        f"('{o['org']}','{o['run']}','{o['escalation']}','{o['reservation']}','{o['worker']}',2,'AUTH_EXPIRED',3,{D},'[\"log:auth\"]','{o['operation']}','OPEN',NULL,clock_timestamp()-interval '3 minutes',NULL),"
        f"('{o['org']}','{o['run']}','{u()}','{o['reservation2']}','{o['worker2']}',1,'QUOTA_LIMIT',1,NULL,'[]','{u()}','CLOSED','{{}}',clock_timestamp()-interval '1 hour',clock_timestamp()-interval '55 minutes')",
        f"INSERT INTO hyperfide.run_repositories(organisation_id,run_id,repository_id,source_object_id,integration_ref) VALUES('{o['org']}','{o['run']}','{o['repo']}',{OID},'refs/heads/main')",
        "INSERT INTO hyperfide.findings(organisation_id,run_id,id,dedup_digest,owner_package_id,repository_id,source_object_id,severity,summary) VALUES" + ",".join(findings),
        "INSERT INTO hyperfide.finding_registry_records(organisation_id,run_id,finding_id,phase,origin_task_id,origin_attempt_id,resolution_condition,resolution_digest,first_observed_at,last_observed_at) VALUES" + ",".join(registry),
        "INSERT INTO hyperfide.finding_routes(organisation_id,run_id,id,finding_id,request_id,request_digest,generation,owner_package_id,leader_queue,reason,created_at) VALUES"
        f"('{o['org']}','{o['run']}','{o['route']}','{o['f_queue']}','{u()}',{D},1,'{o['pkg_a']}',true,'manager unavailable',clock_timestamp()-interval '30 minutes'),"
        f"('{o['org']}','{o['run']}','{u()}','{o['f_closed']}','{u()}',{D},1,'{o['pkg_a']}',true,'manager unavailable',clock_timestamp()-interval '30 minutes')",
        "INSERT INTO hyperfide.finding_external_intake(organisation_id,run_id,repository_id,issue_number,external_updated_at,payload,state) VALUES"
        f"('{o['org']}','{o['run']}','{o['repo']}',101,'2026-10-01T10:00:00Z','{{\"title\":\"crash on save\",\"state\":\"open\"}}','NEEDS_TRIAGE'),"
        f"('{o['org']}','{o['run']}','{o['repo']}',102,'2026-10-02T10:00:00Z','{{\"title\":\"question about docs\",\"state\":\"open\"}}','DISMISSED')",
        "INSERT INTO hyperfide.finding_repairs(organisation_id,run_id,id,finding_id,request_id,request_digest,repair_task_id,resolution_digest,baseline_source_object_id,state,max_attempts,attempt_count) VALUES"
        f"('{o['org']}','{o['run']}','{o['repair']}','{o['f_repair']}','{u()}',{D},'{o['task_b']}',{D},{OID},'ESCALATED',2,2),"
        f"('{o['org']}','{o['run']}','{o['repair_old']}','{o['f_repair_old']}','{u()}',{D},'{o['task_b']}',{D},{OID},'ESCALATED',1,1),"
        f"('{o['org']}','{o['run']}','{u()}','{o['f_failed']}','{u()}',{D},'{o['task_b']}',{D},{OID},'FAILED',3,1)",
        f"INSERT INTO hyperfide.finding_repair_events(organisation_id,run_id,repair_id,actor_id,event_type,payload,actor_role,credential_id) VALUES('{o['org']}','{o['run']}','{o['repair']}','{o['human']}','ESCALATED','{{\"reason\":\"still failing\"}}','FEATURE_MANAGER','{o['credential']}')",
        # Observations: one per drift reason, plus agreeing ones that must not appear.
        "INSERT INTO hyperfide.observability_observations(organisation_id,run_id,entity_type,entity_id,observer_actor_id,entity_generation,producer_sequence,observed_state,observed_at,source_digest,observer_priority) VALUES"
        f"('{o['org']}','{o['run']}','ATTEMPT','{o['attempt']}','{o['human']}',1,1,'FAILED',clock_timestamp()-interval '2 seconds',{D},1),"
        f"('{o['org']}','{o['run']}','SESSION','{o['worker2']}','{o['human']}',1,1,'RUNNING',clock_timestamp()-interval '2 seconds',{D},1),"
        f"('{o['org']}','{o['run']}','SANDBOX','{o['sandbox']}','{o['human']}',1,1,'RUNNING',clock_timestamp()-interval '10 minutes',{D},1),"
        f"('{o['org']}','{o['run']}','SESSION','{o['fm1']}','{o['human']}',1,1,'RUNNING',clock_timestamp()-interval '1 second',{D},1),"
        f"('{o['org']}','{o['run']}','SESSION','{o['leader']}','{o['human']}',1,1,'RUNNING',clock_timestamp()-interval '1 second',{D},1),"
        f"('{o['org']}','{o['run']}','SESSION','{o['old_leader']}','{o['human']}',1,1,'STOPPED',clock_timestamp()-interval '1 hour',{D},1)",
        f"INSERT INTO hyperfide.supervisor_launches(organisation_id,run_id,id,session_id,profile_id,profile_digest,request_digest,host_id,placement,reservations,state,observed_at,created_at) VALUES"
        f"('{o['org']}','{o['run']}','{o['launch']}','{o['fm2']}','codex',{D},{D},'host-1','{{}}','[]','RUNNING',clock_timestamp()-interval '10 minutes',clock_timestamp()-interval '11 minutes')",
        "COMMIT",
    ]
    db.sql(";".join(anchors), user=su)

    # Asks go through their own head triggers: raised OPEN, then answered or expired as the lifecycle allows.
    def ask(aid, kind, policy, title, run=True, task=None, attempt=None, session=None, options="[]", recommended="NULL", deadline="NULL", raised="clock_timestamp()"):
        return (f"INSERT INTO hyperfide.asks(organisation_id,id,run_id,kind,title,options,recommended,deadline,default_policy,task,attempt,session,raised_by,raised_at) VALUES("
                f"'{o['org']}','{aid}',{repr(o['run']) if run is True else 'NULL' if run is None else repr(run)},'{kind}','{title}','{options}',{recommended},{deadline},'{policy}',"
                f"{'NULL' if task is None else repr(task)},{'NULL' if attempt is None else repr(attempt)},{'NULL' if session is None else repr(session)},'{o['credential']}',{raised})")
    past = "clock_timestamp()-interval '2 hours'"
    asks = [
        "BEGIN",
        ask(o["ask_block"], "variable", "block", "Which region hosts the mirror?", task=o["task"], attempt=o["attempt"], session=o["worker"]),
        ask(o["ask_decision"], "decision", "proceed-and-flag", "Split the wave?", session=o["leader"], options='["yes","no"]', recommended="'no'", deadline="clock_timestamp()+interval '1 hour'"),
        ask(o["ask_expired_block"], "permission", "block", "May the worker delete the cache?", options='["allow","deny"]', recommended="'deny'", deadline="clock_timestamp()-interval '1 hour'", raised=past),
        ask(o["ask_expired_flag"], "decision", "proceed-and-flag", "Retry flaky suite?", options='["retry","skip"]', recommended="'retry'", deadline="clock_timestamp()-interval '1 hour'", raised=past),
        ask(o["ask_answered"], "question", "block", "Which branch?"),
        ask(o["ask_org"], "secret", "block", "Railway token for the fleet", run=None),
        ask(o["ask_other_run"], "question", "block", "Other run question", run=o["other_run"]),
        ask(escalation_ask_id(o["org"], o["run"], o["repair"]), "decision", "proceed-and-flag", "Repair escalated", task=o["task_b"],
            options='["HOLD","RETRY","REASSIGN","ACCEPT_EXCEPTION"]', recommended="'HOLD'", deadline="clock_timestamp()+interval '2 hours'"),
        f"UPDATE hyperfide.asks SET state='EXPIRED',expired_at=clock_timestamp(),state_version=state_version+1 WHERE organisation_id='{o['org']}' AND id='{o['ask_expired_block']}'",
        f"UPDATE hyperfide.asks SET state='EXPIRED',expired_at=clock_timestamp(),answer=recommended,decided_by_default=true,state_version=state_version+1 WHERE organisation_id='{o['org']}' AND id='{o['ask_expired_flag']}'",
        f"UPDATE hyperfide.asks SET state='ANSWERED',answer='main',answered_by='{o['credential']}',answered_at=clock_timestamp(),state_version=state_version+1 WHERE organisation_id='{o['org']}' AND id='{o['ask_answered']}'",
        "COMMIT",
    ]
    db.sql(";".join(asks), user=su)


def every_row(panels, fn):
    rows = []
    for panel in panels:
        if "sections" in panel:
            for section in panel["sections"].values():
                rows.extend(section["rows"])
        else:
            rows.extend(panel["rows"])
    return rows and all(fn(r) for r in rows), [r for r in rows if not fn(r)][:3]


def scenario(cluster, t, ids, base):
    o = ids
    applied = cluster.sql("SELECT count(*) FROM hyperfide.schema_migrations WHERE version IN (13,18,23,134,709,711)")
    check("migration.applied", applied == "6", applied)
    seed(cluster, t, ids)
    p = subprocess.run(["node", "--input-type=module", "-e", PROBE], cwd=ROOT, env={**base, "DATABASE_URL": cluster.url(RUNTIME)},
                       input=json.dumps(ids), text=True, capture_output=True, timeout=300)
    if p.returncode:
        raise AssertionError("probe failed: " + (p.stderr + p.stdout)[-2500:])
    out = json.loads(p.stdout)
    needs, issues, leaders, leaders_all = out["needs"], out["issues"], out["leaders"], out["leaders_all"]

    asks = needs["sections"]["asks"]["rows"]
    by = {r["id"]: r for r in asks}
    repair_ask = escalation_ask_id(o["org"], o["run"], o["repair"])
    check("needs.asks-waiting-only", sorted(by) == sorted([o["ask_block"], o["ask_decision"], o["ask_expired_block"], o["ask_org"], repair_ask])
          and not needs["sections"]["asks"]["truncated"], sorted(by))
    # Most urgent first: the overdue expired permission, then the nearest deadlines, then Asks with none.
    check("needs.ask-order-and-deadline", [r["id"] for r in asks[:3]] == [o["ask_expired_block"], o["ask_decision"], repair_ask]
          and 3500 < by[o["ask_decision"]]["detail"]["seconds_to_deadline"] <= 3600 and by[o["ask_decision"]]["detail"]["overdue"] is False
          and by[o["ask_block"]]["detail"]["seconds_to_deadline"] is None, [r["id"] for r in asks])
    b = by.get(o["ask_block"], {})
    check("needs.ask-blocking-holds-task", b.get("state") == "OPEN" and b["detail"]["blocking"] is True and b["detail"]["holds_task"] is True
          and b["detail"]["task_state"] == "BLOCKED" and b["detail"]["ask_kind"] == "variable", b)
    e = by.get(o["ask_expired_block"], {})
    check("needs.ask-expired-blocking-overdue", e.get("state") == "EXPIRED" and e["detail"]["overdue"] is True and e["detail"]["seconds_to_deadline"] < -3500
          and e["detail"]["recommended"] == "deny" and e["detail"]["state_version"] == "2" and e["since"] < e["freshness"]["observed_at"], e)
    g = by.get(o["ask_org"], {})
    check("needs.ask-org-scoped", g.get("references", {}).get("run_id") is None and g["detail"]["ask_kind"] == "secret", g)
    check("needs.ask-references", b.get("references") == {"ask_id": o["ask_block"], "run_id": o["run"], "task_id": o["task"], "task_key": "5.1", "attempt_id": o["attempt"],
                                                          "session_id": o["worker"], "sandbox_id": None, "raised_by": o["credential"]}
          and by[repair_ask]["references"]["task_key"] == "5.9", b.get("references"))

    intents = {r["id"]: r for r in needs["sections"]["human_intents"]["rows"]}
    check("needs.intents-pending-only", sorted(intents) == sorted([o["intent"], o["intent_stale"]]), sorted(intents))
    cur = intents.get(o["intent"], {})
    check("needs.intent-current-leader", cur.get("state") == "PENDING" and cur["detail"]["target_is_current_leader"] is True and cur["detail"]["delivery_state"] == "ACKNOWLEDGED"
          and cur["detail"]["intent_kind"] == "DIRECTION" and cur["detail"]["intent"] == {"text": "ship wave 5"} and cur["freshness"]["source"] == "hyperfide.event_deliveries"
          and 290 < cur["freshness"]["age_seconds"] < 400 and 1190 < (cur["freshness"]["age_seconds"] + (cur["freshness"]["observed_at"] > cur["since"]) * 900) and
          cur["references"]["command_id"] == o["cmd"] and cur["references"]["target_session_id"] == o["leader"] and cur["references"]["package_id"] == o["pkg_a"]
          and cur["references"]["source_actor_id"] == o["human"], cur)
    st = intents.get(o["intent_stale"], {})
    check("needs.intent-stale-target", st.get("detail", {}).get("target_is_current_leader") is False and st["detail"]["delivery_state"] == "PENDING"
          and st["freshness"]["source"] == "hyperfide.outbox_events" and 1190 < st["freshness"]["age_seconds"] < 1400 and st["references"]["target_session_id"] == o["old_leader"], st)

    esc = needs["sections"]["admission_escalations"]["rows"]
    check("needs.escalations-open-only", [r["id"] for r in esc] == [o["escalation"]], esc)
    x = esc[0] if esc else {}
    check("needs.escalation-references", x.get("references") == {"escalation_id": o["escalation"], "reservation_id": o["reservation"], "session_id": o["worker"], "attempt_id": o["attempt"],
                                                                 "task_id": o["task"], "task_key": "5.1", "sandbox_id": o["sandbox"], "raised_by_operation_id": o["operation"]}
          and x["detail"]["reason"] == "AUTH_EXPIRED" and x["detail"]["remaining_resolutions"] == 2 and x["detail"]["sequence"] == 2 and x["detail"]["diagnostic_refs"] == ["log:auth"]
          and x["detail"]["reservation_state"] == "ESCALATED" and 170 < x["freshness"]["age_seconds"] < 300, x)
    check("needs.counts", needs["counts"] == {"asks": 5, "human_intents": 2, "admission_escalations": 1} and needs["view"] == "console.needs"
          and needs["scope"] == {"organisation_id": o["org"], "run_id": o["run"]} and needs["authority"] == "PRIMARY_OBSERVATION", needs["counts"])

    s = issues["sections"]
    q = s["leader_queue"]["rows"]
    check("issues.leader-queue", [r["id"] for r in q] == [o["route"]] and q[0]["state"] == "WAITING" and q[0]["title"] == "summary of f_queue"
          and q[0]["references"]["finding_id"] == o["f_queue"] and q[0]["references"]["owner_package_id"] == o["pkg_a"] and q[0]["references"]["repository_id"] == o["repo"]
          and q[0]["freshness"]["source"] == "hyperfide.finding_routes" and 1700 < q[0]["freshness"]["age_seconds"] < 1900 and q[0]["detail"]["severity"] == "ERROR", q)
    n = s["external_intake"]["rows"]
    check("issues.external-intake", [r["id"] for r in n] == [o["repo"] + "#101"] and n[0]["state"] == "NEEDS_TRIAGE" and n[0]["title"] == "crash on save"
          and n[0]["references"] == {"repository_id": o["repo"], "repository": "app", "issue_number": "101", "finding_id": None}
          and n[0]["freshness"]["observed_at"] == "2026-10-01T10:00:00.000Z" and n[0]["freshness"]["source"] == "github", n)
    r = {x["id"]: x for x in s["escalated_repairs"]["rows"]}
    rep, old = r.get(o["repair"], {}), r.get(o["repair_old"], {})
    check("issues.escalated-repairs", sorted(r) == sorted([o["repair"], o["repair_old"]]) and rep.get("state") == "ESCALATED" and rep["references"]["ask_id"] == repair_ask
          and rep["references"]["task_id"] == o["task_b"] and rep["detail"]["ask"]["state"] == "OPEN" and rep["detail"]["reason"] == "still failing" and rep["title"] == "summary of f_repair"
          and old.get("detail", {}).get("ask") is None and old["references"]["ask_id"] == escalation_ask_id(o["org"], o["run"], o["repair_old"]), r)
    drift = {x["id"]: x for x in s["drift"]["rows"]}
    a = drift.get("ATTEMPT:" + o["attempt"], {})
    check("issues.drift-not-running", a.get("state") == "OBSERVED_NOT_RUNNING" and a["detail"]["desired_state"] == "RUNNING" and a["detail"]["observed_state"] == "FAILED"
          and a["references"]["attempt_id"] == o["attempt"] and a["freshness"]["stale"] is False, a)
    w = drift.get("SESSION:" + o["worker2"], {})
    check("issues.drift-still-running", w.get("state") == "OBSERVED_STILL_RUNNING" and w["detail"]["desired_state"] == "STOPPED" and w["references"]["session_id"] == o["worker2"], w)
    sb = drift.get("SANDBOX:" + o["sandbox"], {})
    check("issues.drift-stale", sb.get("state") == "OBSERVATION_STALE" and sb["freshness"]["stale"] is True and sb["freshness"]["age_seconds"] > 590
          and sb["references"]["sandbox_id"] == o["sandbox"], sb)
    check("issues.drift-excludes-agreeing", len(drift) == 3, sorted(drift))
    check("issues.counts", issues["counts"] == {"leader_queue": 1, "external_intake": 1, "escalated_repairs": 2, "drift": 3} and issues["view"] == "console.issues", issues["counts"])

    lr = leaders["rows"]
    check("leaders.default-live-only", sorted(x["id"] for x in lr) == sorted([o["leader"], o["fm1"], o["fm2"]]) and not leaders["truncated"], [x["id"] for x in lr])
    check("leaders.primary-first", lr and lr[0]["id"] == o["leader"] and lr[0]["detail"]["primary"] is True and lr[0]["detail"]["leader_generation"] == "2"
          and leaders["primary_leader"] == {"session_id": o["leader"], "generation": "2", "authority_epoch": o["epoch"]}
          and lr[0]["detail"]["open_asks"] == 1 and lr[0]["detail"]["pending_human_intents"] == 1 and lr[0]["freshness"]["stale"] is False
          and lr[0]["freshness"]["source"] == "hyperfide.observability_observations", lr[:1])
    fm1 = next((x for x in lr if x["id"] == o["fm1"]), {})
    check("leaders.carrying", fm1.get("detail", {}).get("packages") == [{"package_id": o["pkg_a"], "package_key": "package-a", "wave": 5, "revision": "1"}]
          and fm1["detail"]["children"] == [{"role": "WORKER", "state": "RUNNING", "count": 1}, {"role": "WORKER", "state": "STOPPED", "count": 1}]
          and fm1["references"]["parent_session_id"] == o["leader"] and fm1["title"] == "Feature manager codex/fm-1" and fm1["detail"]["observation"]["observed_state"] == "RUNNING", fm1)
    fm2 = next((x for x in lr if x["id"] == o["fm2"]), {})
    check("leaders.stale-launch", fm2.get("freshness", {}).get("stale") is True and fm2["freshness"]["source"] == "hyperfide.supervisor_launches"
          and fm2["references"]["launch_id"] == o["launch"] and fm2["detail"]["launch"]["host_id"] == "host-1" and fm2["detail"]["observation"] is None
          and leaders["counts"] == {"leaders": 1, "feature_managers": 2, "stale": 1} and leaders["max_observation_age_seconds"] == 15, [fm2, leaders["counts"]])
    ended = {x["id"]: x for x in leaders_all["rows"]}
    check("leaders.include-ended", sorted(ended) == sorted([o["leader"], o["fm1"], o["fm2"], o["old_leader"]]) and ended[o["old_leader"]]["state"] == "STOPPED"
          and ended[o["old_leader"]]["detail"]["primary"] is False and ended[o["old_leader"]]["freshness"]["stale"] is False
          and ended[o["old_leader"]]["freshness"]["age_seconds"] > 3500 and leaders_all["counts"]["leaders"] == 2, sorted(ended))

    panels = [needs, issues, leaders_all]
    ok, bad = every_row(panels, lambda r: r["since"] and r["freshness"]["observed_at"] and isinstance(r["freshness"]["age_seconds"], (int, float))
                        and r["freshness"]["age_seconds"] >= 0 and r["freshness"]["source"])
    check("freshness.every-row", ok and all(p_["as_of"] for p_ in panels), bad)
    ok, bad = every_row(panels, lambda r: r["references"] and any(v for v in r["references"].values()) and r["id"] and r["kind"] and r["title"])
    check("references.every-row", ok, bad)

    check("component.actions", out["actions"] == ["console.issues", "console.leaders", "console.needs", "console.sandboxes"], out["actions"])
    on, oi, ol = (out[k].get("ok") or {} for k in ("op_needs", "op_issues", "op_leaders"))
    check("component.operator-reads", on.get("counts") == needs["counts"] and oi.get("counts") == issues["counts"] and len(ol.get("rows", [])) == 4
          and ol.get("max_observation_age_seconds") == 60 and ol.get("counts", {}).get("stale") == 1,
          [out["op_needs"].get("error"), out["op_issues"].get("error"), out["op_leaders"].get("error"), ol.get("counts"), [(x["id"], x["freshness"]) for x in ol.get("rows", [])]])
    li = out["leader_issues"].get("ok") or {}
    check("component.leader-reads-issues", li.get("counts") == issues["counts"], out["leader_issues"])
    lim = out["limited"].get("ok") or {}
    check("component.limit-truncates", lim.get("sections", {}).get("asks", {}).get("truncated") is True and len(lim["sections"]["asks"]["rows"]) == 1
          and lim["sections"]["asks"]["rows"][0]["id"] == o["ask_expired_block"] and lim["sections"]["human_intents"]["truncated"] is True
          and lim["sections"]["admission_escalations"]["truncated"] is False, out["limited"])
    check("refuse.stale-leader-issues", out["stale_leader_issues"] == {"error": "AUTH_DENIED"}, out["stale_leader_issues"])
    check("refuse.worker-role", out["worker"] == {"error": "CONSOLE_FORBIDDEN"}, out["worker"])
    check("refuse.provisioner-needs", out["prov_needs"] == {"error": "CONSOLE_FORBIDDEN"}, out["prov_needs"])
    check("component.provisioner-leaders", len((out["prov_leaders"].get("ok") or {}).get("rows", [])) == 3, out["prov_leaders"])
    check("refuse.unknown-field", out["unknown"] == {"error": "OBSERVABILITY_INPUT_INVALID"} and out["ended_on_needs"] == {"error": "OBSERVABILITY_INPUT_INVALID"}, [out["unknown"], out["ended_on_needs"]])
    check("refuse.bad-include-ended", out["bad_ended"] == {"error": "OBSERVABILITY_INPUT_INVALID"}, out["bad_ended"])
    check("refuse.unbound-invocation", out["unbound"] == {"error": "AUTHENTICATION_REQUIRED"}, out["unbound"])
    reads = [out[k].get("writes") for k in ("op_needs", "op_issues", "op_leaders", "leader_issues", "limited", "prov_leaders")]
    check("readonly.no-writes", out["writes"] == "0" and reads == ["0"] * 6, [out["writes"], reads])


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
        names = ["org", "project", "spec", "run", "other_run", "epoch", "pkg_a", "pkg_b", "pool", "sandbox", "slot", "task", "task_b", "attempt",
                 "leader", "old_leader", "fm1", "fm2", "worker", "worker2", "repo", "human", "credential", "actor", "consumer", "old_consumer",
                 "intent", "intent_stale", "intent_done", "cmd", "cmd_stale", "cmd_done", "reservation", "reservation2", "escalation", "operation",
                 "f_queue", "f_closed", "f_repair", "f_repair_old", "f_failed", "route", "repair", "repair_old", "launch",
                 "ask_block", "ask_decision", "ask_expired_block", "ask_expired_flag", "ask_answered", "ask_org", "ask_other_run"]
        scenario(cluster, t295, {name: u() for name in names}, base)
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
