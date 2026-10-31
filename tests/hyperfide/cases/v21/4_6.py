#!/usr/bin/env python3
"""hyperfide-v21 4.6: readers for the leader queue, external intake and escalated repairs.

Applies every release migration to an owned throwaway PostgreSQL cluster (pattern of v21/3_1.py), seeds one run
with findings, routes, external issues and repairs, then drives the three FindingReader objects exported from
core/control-plane/dist/findings (routing.js, github.js, remediation.js) inside real primary transactions:
each reader lists, acknowledges and routes, and a repair that exhausts its budget raises a decision Ask in
hyperfide.asks. Prints SKIP and exits 77 when no PostgreSQL server or root is available (task 1.7 contract).
"""
import importlib.util, json, os, pathlib, signal, subprocess, sys, traceback, uuid

ROOT = pathlib.Path(__file__).resolve().parents[4]
SERVICE = ROOT / "core/control-plane"
ASSERTIONS = [
    "migration.applied",
    "leader.list",
    "leader.list-excludes-closed-and-superseded",
    "leader.refuse-non-admin",
    "leader.refuse-stale-generation",
    "leader.refuse-not-in-queue",
    "leader.acknowledge",
    "leader.acknowledge-replay",
    "leader.acknowledge-event",
    "leader.list-acknowledged",
    "leader.route-requires-rationale",
    "leader.route",
    "intake.list",
    "intake.refuse-stale",
    "intake.acknowledge",
    "intake.acknowledge-replay",
    "intake.list-by-state",
    "intake.refuse-scope-mismatch",
    "intake.refuse-stale-finding",
    "intake.route",
    "intake.route-event",
    "intake.refuse-dismissed-route",
    "intake.refuse-linked-dismiss",
    "repair.escalation-needs-deadline-policy",
    "repair.escalation-needs-operator-channel",
    "repair.escalation-raises-decision-ask",
    "repair.ask-event",
    "repair.ask-delivered-to-operator",
    "repair.list",
    "repair.refuse-not-escalated",
    "repair.refuse-stale",
    "repair.acknowledge",
    "repair.acknowledge-replay-one-ask",
    "repair.acknowledge-backfills-ask",
    "repair.route",
    "repair.list-routed",
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


def ensure_build(base):
    stamp = subprocess.run(["node", "deploy/hyperfide/dist-stamp.mjs", "check", str(SERVICE)], cwd=ROOT, env=base, capture_output=True, text=True)
    if stamp.returncode:
        p = subprocess.run(["npm", "--prefix", str(SERVICE), "run", "build"], cwd=ROOT, env=base, capture_output=True, text=True, timeout=900)
        if p.returncode:
            raise AssertionError("service build failed: " + (p.stderr + p.stdout)[-1500:])


def seed(cluster, superuser, o):
    D = "'sha256:'||repeat('a',64)"
    OID = "repeat('b',40)"
    finding_rows, registry_rows = [], []
    for key in ("f_queue", "f_repair", "f_intake", "f_closed", "f_assigned", "f_backfill", "f_other"):
        owner = o["pkg_a"]
        repo = o["repo"]
        finding_rows.append(f"('{o['org']}','{o['run']}','{o[key]}','sha256:'||encode(sha256(convert_to('{o[key]}','UTF8')),'hex'),'{owner}','{repo}',{OID},'ERROR','{key}')")
        phase = "RESOLVED" if key == "f_closed" else "TRIAGED"
        registry_rows.append(f"('{o['org']}','{o['run']}','{o[key]}','{phase}','{o['task']}','{o['attempt']}','{{}}',{D},clock_timestamp(),clock_timestamp())")
    statements = [
        "BEGIN",
        f"INSERT INTO hyperfide.organisations(id,name) VALUES('{o['org']}','readers-probe')",
        f"INSERT INTO hyperfide.projects(organisation_id,id,name) VALUES('{o['org']}','{o['project']}','fixture')",
        f"INSERT INTO hyperfide.spec_revisions(organisation_id,id,project_id,source_digest,source_content,document,schema_version) VALUES('{o['org']}','{o['spec']}','{o['project']}','sha256:'||encode(sha256(convert_to('fixture','UTF8')),'hex'),'fixture','{{}}',1)",
        f"INSERT INTO hyperfide.runs(organisation_id,id,project_id,spec_revision_id,policy_digest,authority_epoch,state) VALUES('{o['org']}','{o['run']}','{o['project']}','{o['spec']}',{D},'{o['epoch']}','RUNNING')",
        f"INSERT INTO hyperfide.feature_packages(organisation_id,run_id,id,package_key,wave) VALUES('{o['org']}','{o['run']}','{o['pkg_a']}','package-a',1),('{o['org']}','{o['run']}','{o['pkg_b']}','package-b',1)",
        f"INSERT INTO hyperfide.provider_pools(organisation_id,id,provider,account_key,environment_key,region) VALUES('{o['org']}','{o['pool']}','railway','fixture','fixture','fixture')",
        f"INSERT INTO hyperfide.sandboxes(organisation_id,id,pool_id,observed_state) VALUES('{o['org']}','{o['sandbox']}','{o['pool']}','RUNNING')",
        f"INSERT INTO hyperfide.worker_slots(organisation_id,id,sandbox_id,slot_key,boot_generation,capacity_kind) VALUES('{o['org']}','{o['slot']}','{o['sandbox']}','worker',1,'AGENT')",
        f"INSERT INTO hyperfide.tasks(organisation_id,run_id,id,task_key,feature_package_id,spec_revision_id,criteria_digest,definition,wave) VALUES('{o['org']}','{o['run']}','{o['task']}','4.6','{o['pkg_a']}','{o['spec']}',{D},'{{}}',1)",
        f"INSERT INTO hyperfide.attempts(organisation_id,run_id,id,task_id,generation,authority_epoch,input_packet_digest,execution_state,compute_authority,sandbox_id,slot_id,sandbox_boot_generation,lease_expires_at) VALUES('{o['org']}','{o['run']}','{o['attempt']}','{o['task']}',1,'{o['epoch']}',{D},'RUNNING','CURRENT','{o['sandbox']}','{o['slot']}',1,clock_timestamp()+interval '30 minutes')",
        f"INSERT INTO hyperfide.agent_sessions(organisation_id,run_id,id,role,connector,account_key,native_session_id,state) VALUES('{o['org']}','{o['run']}','{o['manager']}','FEATURE_MANAGER','codex','fixture','m1','RUNNING'),('{o['org']}','{o['run']}','{o['worker']}','WORKER','codex','fixture','w1','RUNNING')",
        f"UPDATE hyperfide.feature_packages SET manager_session_id='{o['manager']}',state_version=state_version+1 WHERE organisation_id='{o['org']}' AND run_id='{o['run']}' AND id='{o['pkg_b']}'",
        f"INSERT INTO hyperfide.hierarchy_packages(organisation_id,run_id,package_id,feature_key,allocation_policy,state,owner_generation) VALUES('{o['org']}','{o['run']}','{o['pkg_b']}','package-b','FEATURE_STABLE','ACTIVE',1)",
        f"INSERT INTO hyperfide.repositories(organisation_id,id,project_id,name,url) VALUES('{o['org']}','{o['repo']}','{o['project']}','app','https://example.invalid/app'),('{o['org']}','{o['repo2']}','{o['project']}','other','https://example.invalid/other')",
        f"INSERT INTO hyperfide.source_objects(organisation_id,repository_id,object_id) VALUES('{o['org']}','{o['repo']}',{OID}),('{o['org']}','{o['repo2']}',{OID})",
        # Commits are registered above because finding updates recheck them. Observation, routing, intake and repair
        # history belong to other tasks, so the rows below are fixture anchors written with triggers and foreign keys
        # off; every write the readers make afterwards runs with both on.
        "SET LOCAL session_replication_role=replica",
        f"INSERT INTO hyperfide.run_repositories(organisation_id,run_id,repository_id,source_object_id,integration_ref) VALUES('{o['org']}','{o['run']}','{o['repo']}',{OID},'refs/heads/main'),('{o['org']}','{o['run']}','{o['repo2']}',{OID},'refs/heads/main')",
        f"INSERT INTO hyperfide.evidence(organisation_id,run_id,id,attempt_id,attempt_generation,repository_id,source_object_id,criteria_digest,manifest_digest,artifact_id,admission_state) VALUES('{o['org']}','{o['run']}','{o['evidence']}','{o['attempt']}',1,'{o['repo']}',{OID},{D},{D},'{u()}','ADMITTED')",
        "INSERT INTO hyperfide.findings(organisation_id,run_id,id,dedup_digest,owner_package_id,repository_id,source_object_id,severity,summary) VALUES" + ",".join(finding_rows),
        "INSERT INTO hyperfide.finding_registry_records(organisation_id,run_id,finding_id,phase,origin_task_id,origin_attempt_id,resolution_condition,resolution_digest,first_observed_at,last_observed_at) VALUES" + ",".join(registry_rows),
        # Leader queue: one waiting route, one on a resolved finding, one superseded by a manager assignment.
        "INSERT INTO hyperfide.finding_routes(organisation_id,run_id,id,finding_id,request_id,request_digest,generation,owner_package_id,leader_queue,reason) VALUES"
        f"('{o['org']}','{o['run']}','{o['route_queue']}','{o['f_queue']}','{u()}',{D},1,'{o['pkg_a']}',true,'manager unavailable'),"
        f"('{o['org']}','{o['run']}','{u()}','{o['f_closed']}','{u()}',{D},1,'{o['pkg_a']}',true,'manager unavailable'),"
        f"('{o['org']}','{o['run']}','{u()}','{o['f_assigned']}','{u()}',{D},1,'{o['pkg_a']}',true,'manager unavailable')",
        f"INSERT INTO hyperfide.finding_routes(organisation_id,run_id,id,finding_id,request_id,request_digest,generation,owner_package_id,owner_generation,manager_session_id,leader_queue,reason) VALUES('{o['org']}','{o['run']}','{o['route_assigned']}','{o['f_assigned']}','{u()}',{D},2,'{o['pkg_b']}',1,'{o['manager']}',false,'assigned')",
        # External intake: two issues in the run's repository, one in another repository.
        "INSERT INTO hyperfide.finding_external_intake(organisation_id,run_id,repository_id,issue_number,external_updated_at,payload) VALUES"
        f"('{o['org']}','{o['run']}','{o['repo']}',101,'2026-10-01T10:00:00Z','{{\"title\":\"crash on save\",\"state\":\"open\"}}'),"
        f"('{o['org']}','{o['run']}','{o['repo']}',102,'2026-10-02T10:00:00Z','{{\"title\":\"question about docs\",\"state\":\"open\"}}'),"
        f"('{o['org']}','{o['run']}','{o['repo2']}',7,'2026-10-03T10:00:00Z','{{\"title\":\"other repository\",\"state\":\"open\"}}')",
        # Repairs: one running on its last attempt, one escalated before Asks existed, one merely failed.
        "INSERT INTO hyperfide.finding_repairs(organisation_id,run_id,id,finding_id,request_id,request_digest,repair_task_id,resolution_digest,baseline_source_object_id,state,max_attempts,attempt_count,attempt_id,attempt_generation) VALUES"
        f"('{o['org']}','{o['run']}','{o['repair']}','{o['f_repair']}','{u()}',{D},'{o['task']}',{D},{OID},'RUNNING',1,1,'{o['attempt']}',1),"
        f"('{o['org']}','{o['run']}','{o['repair_old']}','{o['f_backfill']}','{u()}',{D},'{o['task']}',{D},{OID},'ESCALATED',2,2,NULL,NULL),"
        f"('{o['org']}','{o['run']}','{o['repair_failed']}','{o['f_other']}','{u()}',{D},'{o['task']}',{D},{OID},'FAILED',3,1,NULL,NULL)",
        "COMMIT",
    ]
    cluster.sql(";".join(statements), user=superuser)


PROBE = r"""
import {createResourceContainer} from './core/control-plane/dist/storage/runtime.js';
import {leaderQueueReader,LEADER_QUEUE_ACKNOWLEDGED} from './core/control-plane/dist/findings/routing.js';
import {externalIntakeReader,INTAKE_LINKED} from './core/control-plane/dist/findings/github.js';
import {escalatedRepairReader,failRepair,escalationAskId,ESCALATION_OPTIONS} from './core/control-plane/dist/findings/remediation.js';
import {randomUUID} from 'node:crypto';
const o=JSON.parse(process.env.HF_IDS);
const scope={organisation_id:o.org,run_id:o.run};
const principal=(role,actor)=>({credential_id:o.credential,actor_id:actor??o.operator,organisation_id:o.org,run_id:o.run,deployment_epoch:o.epoch,role,allowed_actions:[],expires_at:new Date(Date.now()+3600000).toISOString()});
const r=createResourceContainer({role:'control',env:process.env,signal:new AbortController().signal});
const out={};
const as=(role,env={},actor)=>fn=>r.gateway.withPrimaryTransaction({timeoutMs:10000},tx=>fn({tx,scope,principal:principal(role,actor),context:{env}}));
const operator=as('OPERATOR'),policed=as('OPERATOR',{HF_FINDING_ESCALATION_ASK_SECONDS:'3600'});
const step=async(name,fn)=>{try{out[name]=(await fn())??null;}catch(e){out[name]={error:String(e?.code??'ERROR'),message:String(e?.message??e)};}};
const q=(sql,params)=>r.gateway.withPrimaryTransaction({timeoutMs:10000},async tx=>(await tx.query(sql,params)).rows);
const version=async id=>(await q('SELECT state_version::text AS v FROM hyperfide.finding_registry_records WHERE organisation_id=$1 AND run_id=$2 AND finding_id=$3',[o.org,o.run,id]))[0].v;
try{
 // Leader queue.
 await step('leader.list',()=>operator(v=>leaderQueueReader.list(v,{})));
 await step('leader.non-admin',()=>as('WORKER',{},o.worker)(v=>leaderQueueReader.list(v,{})));
 await step('leader.stale',()=>operator(v=>leaderQueueReader.acknowledge(v,{route_id:o.route_queue,generation:'2'})));
 await step('leader.not-queued',()=>operator(v=>leaderQueueReader.acknowledge(v,{route_id:o.route_assigned,generation:'2'})));
 await step('leader.ack',()=>operator(v=>leaderQueueReader.acknowledge(v,{route_id:o.route_queue,generation:'1'})));
 await step('leader.ack-replay',()=>operator(v=>leaderQueueReader.acknowledge(v,{route_id:o.route_queue,generation:'1'})));
 await step('leader.ack-events',()=>q("SELECT e.payload FROM hyperfide.outbox_events e WHERE e.organisation_id=$1 AND e.run_id=$2 AND e.aggregate_id=$3 AND e.event_type=$4",[o.org,o.run,o.f_queue,LEADER_QUEUE_ACKNOWLEDGED]));
 await step('leader.list-after-ack',()=>operator(v=>leaderQueueReader.list(v,{})));
 await step('leader.list-unacknowledged',()=>operator(v=>leaderQueueReader.list(v,{unacknowledged:true})));
 await step('leader.route-no-reason',async()=>{const ev=await version(o.f_queue);return operator(v=>leaderQueueReader.route(v,{finding_id:o.f_queue,request_id:randomUUID(),expected_state_version:ev,package_id:o.pkg_b}));});
 await step('leader.route',async()=>{const ev=await version(o.f_queue);return operator(v=>leaderQueueReader.route(v,{finding_id:o.f_queue,request_id:randomUUID(),expected_state_version:ev,package_id:o.pkg_b,reason:'Leader assigns the queued finding to package b'}));});
 await step('leader.list-after-route',()=>operator(v=>leaderQueueReader.list(v,{})));
 // External intake.
 await step('intake.list',()=>operator(v=>externalIntakeReader.list(v,{})));
 const issue=(repo,n,at)=>({repository_id:repo,issue_number:n,external_updated_at:at,reason:'triaged by the 4.6 case'});
 await step('intake.stale',()=>operator(v=>externalIntakeReader.acknowledge(v,issue(o.repo,102,'2026-10-01T00:00:00Z'))));
 await step('intake.ack',()=>operator(v=>externalIntakeReader.acknowledge(v,issue(o.repo,102,'2026-10-02T10:00:00Z'))));
 await step('intake.ack-replay',()=>operator(v=>externalIntakeReader.acknowledge(v,issue(o.repo,102,'2026-10-02T10:00:00Z'))));
 await step('intake.list-triage',()=>operator(v=>externalIntakeReader.list(v,{})));
 await step('intake.list-dismissed',()=>operator(v=>externalIntakeReader.list(v,{state:'DISMISSED'})));
 await step('intake.scope',async()=>{const ev=await version(o.f_intake);return operator(v=>externalIntakeReader.route(v,{...issue(o.repo2,7,'2026-10-03T10:00:00Z'),finding_id:o.f_intake,expected_state_version:ev}));});
 await step('intake.stale-finding',()=>operator(v=>externalIntakeReader.route(v,{...issue(o.repo,101,'2026-10-01T10:00:00Z'),finding_id:o.f_intake,expected_state_version:'99'})));
 await step('intake.route-version',()=>version(o.f_intake));
 await step('intake.route',async()=>{const ev=await version(o.f_intake);return operator(v=>externalIntakeReader.route(v,{...issue(o.repo,101,'2026-10-01T10:00:00Z'),finding_id:o.f_intake,expected_state_version:ev}));});
 await step('intake.route-after-version',()=>version(o.f_intake));
 await step('intake.route-events',()=>q("SELECT payload FROM hyperfide.outbox_events WHERE organisation_id=$1 AND run_id=$2 AND aggregate_id=$3 AND event_type=$4",[o.org,o.run,o.f_intake,INTAKE_LINKED]));
 await step('intake.list-linked',()=>operator(v=>externalIntakeReader.list(v,{state:'LINKED'})));
 await step('intake.route-dismissed',async()=>{const ev=await version(o.f_intake);return operator(v=>externalIntakeReader.route(v,{...issue(o.repo,102,'2026-10-02T10:00:00Z'),finding_id:o.f_intake,expected_state_version:ev}));});
 await step('intake.dismiss-linked',()=>operator(v=>externalIntakeReader.acknowledge(v,issue(o.repo,101,'2026-10-01T10:00:00Z'))));
 // Escalated repairs.
 const fail=()=>({repair_id:o.repair,expected_state_version:'1',evidence_ids:[o.evidence],reason:'reproduction still fails after the last allowed attempt'});
 await step('repair.no-policy',()=>operator(v=>failRepair(v,fail())));
 await step('repair.no-policy-state',()=>q('SELECT state FROM hyperfide.finding_repairs WHERE organisation_id=$1 AND run_id=$2 AND id=$3',[o.org,o.run,o.repair]));
 await step('repair.no-operator-channel',()=>policed(v=>failRepair(v,fail())));
 await step('repair.no-operator-channel-asks',()=>q('SELECT count(*)::int AS n FROM hyperfide.asks WHERE organisation_id=$1',[o.org]));
 await step('repair.operator-channel',()=>q("INSERT INTO hyperfide.event_consumers(organisation_id,run_id,consumer_key,critical,state) VALUES($1,$2,'operator:asks',false,'ACTIVE') RETURNING id::text",[o.org,o.run]));
 await step('repair.fail',()=>policed(v=>failRepair(v,fail())));
 await step('repair.ask-delivery',()=>q("SELECT e.aggregate_id::text,e.aggregate_version::text,e.payload,c.consumer_key,d.state FROM hyperfide.outbox_events e JOIN hyperfide.event_deliveries d ON d.organisation_id=e.organisation_id AND d.run_id=e.run_id AND d.event_id=e.id JOIN hyperfide.event_consumers c ON c.organisation_id=d.organisation_id AND c.run_id=d.run_id AND c.id=d.consumer_id WHERE e.organisation_id=$1 AND e.run_id=$2 AND e.aggregate_type='ask' AND e.event_type='ask.raised' ORDER BY e.aggregate_id",[o.org,o.run]));
 await step('repair.ask-id',()=>escalationAskId(scope,o.repair));
 await step('repair.options',()=>[...ESCALATION_OPTIONS]);
 await step('repair.asks',()=>q("SELECT id,run_id,kind,title,options,recommended,default_policy,chain,task,attempt,raised_by,state,extract(epoch FROM deadline-raised_at)::int AS window FROM hyperfide.asks WHERE organisation_id=$1 ORDER BY raised_at",[o.org]));
 await step('repair.ask-events',()=>q('SELECT ask_id,event_type,state,actor FROM hyperfide.ask_events WHERE organisation_id=$1',[o.org]));
 await step('repair.escalated-events',()=>q("SELECT payload FROM hyperfide.outbox_events WHERE organisation_id=$1 AND run_id=$2 AND aggregate_id=$3 AND event_type='finding.repair-escalated'",[o.org,o.run,o.f_repair]));
 await step('repair.list',()=>policed(v=>escalatedRepairReader.list(v,{})));
 await step('repair.not-escalated',()=>policed(v=>escalatedRepairReader.acknowledge(v,{repair_id:o.repair_failed,expected_state_version:'1'})));
 await step('repair.stale',()=>policed(v=>escalatedRepairReader.acknowledge(v,{repair_id:o.repair,expected_state_version:'1'})));
 await step('repair.ack',()=>policed(v=>escalatedRepairReader.acknowledge(v,{repair_id:o.repair,expected_state_version:'2'})));
 await step('repair.ack-replay',()=>policed(v=>escalatedRepairReader.acknowledge(v,{repair_id:o.repair,expected_state_version:'2'})));
 await step('repair.ask-count',()=>q('SELECT count(*)::int AS n FROM hyperfide.asks WHERE organisation_id=$1 AND id=$2',[o.org,escalationAskId(scope,o.repair)]));
 await step('repair.backfill',()=>policed(v=>escalatedRepairReader.acknowledge(v,{repair_id:o.repair_old,expected_state_version:'1'})));
 await step('repair.backfill-ask',()=>q('SELECT kind,state,recommended FROM hyperfide.asks WHERE organisation_id=$1 AND id=$2',[o.org,escalationAskId(scope,o.repair_old)]));
 await step('repair.route',async()=>{const ev=await version(o.f_repair);return policed(v=>escalatedRepairReader.route(v,{repair_id:o.repair,request_id:randomUUID(),expected_state_version:ev,package_id:o.pkg_b,reason:'Escalation reassigned to package b'}));});
 await step('repair.list-after',()=>policed(v=>escalatedRepairReader.list(v,{})));
 await step('repair.route-events',()=>q("SELECT event_type,payload FROM hyperfide.finding_repair_events WHERE organisation_id=$1 AND run_id=$2 AND repair_id=$3 ORDER BY created_at",[o.org,o.run,o.repair]));
}finally{await r.close();}
console.log(JSON.stringify(out));
"""


def err(value, code):
    return isinstance(value, dict) and value.get("error") == code


def scenario(cluster, t295, base, ids):
    applied = json.loads(cluster.sql("SELECT coalesce(json_agg(version ORDER BY version),'[]') FROM hyperfide.schema_migrations WHERE version IN (18,709)", user=t295.SUPERUSER))
    check("migration.applied", applied == [18, 709], applied)
    seed(cluster, t295.SUPERUSER, ids)
    env = {**base, "DATABASE_URL": cluster.url(t295.OPERATOR), "HF_IDS": json.dumps(ids)}
    raw = t295.node(PROBE, env).strip().splitlines()[-1]
    out = json.loads(raw)
    o = ids

    items = (out.get("leader.list") or {}).get("items")
    check("leader.list", isinstance(items, list) and len(items) == 1 and items[0]["route_id"] == o["route_queue"] and items[0]["finding_id"] == o["f_queue"]
          and items[0]["acknowledged"] is False and items[0]["generation"] == "1", out.get("leader.list"))
    check("leader.list-excludes-closed-and-superseded", isinstance(items, list) and not any(i["finding_id"] in (o["f_closed"], o["f_assigned"]) for i in items), items)
    check("leader.refuse-non-admin", err(out.get("leader.non-admin"), "AUTH_DENIED"), out.get("leader.non-admin"))
    check("leader.refuse-stale-generation", err(out.get("leader.stale"), "STALE_ROUTE"), out.get("leader.stale"))
    check("leader.refuse-not-in-queue", err(out.get("leader.not-queued"), "NOT_IN_LEADER_QUEUE"), out.get("leader.not-queued"))
    ack = out.get("leader.ack") or {}
    check("leader.acknowledge", ack.get("acknowledged") is True and ack.get("replayed") is False and ack.get("acknowledged_by") == o["operator"], ack)
    replay = out.get("leader.ack-replay") or {}
    check("leader.acknowledge-replay", replay.get("replayed") is True and replay.get("acknowledged_by") == o["operator"], replay)
    events = out.get("leader.ack-events")
    check("leader.acknowledge-event", isinstance(events, list) and len(events) == 1 and events[0]["payload"]["route_id"] == o["route_queue"]
          and events[0]["payload"]["actor_role"] == "OPERATOR", events)
    after = (out.get("leader.list-after-ack") or {}).get("items") or []
    unacked = (out.get("leader.list-unacknowledged") or {}).get("items")
    check("leader.list-acknowledged", len(after) == 1 and after[0]["acknowledged"] is True and after[0]["acknowledged_by"] == o["operator"] and unacked == [], [after, unacked])
    check("leader.route-requires-rationale", err(out.get("leader.route-no-reason"), "INVALID_REQUEST"), out.get("leader.route-no-reason"))
    routed = (out.get("leader.route") or {}).get("route") or {}
    remaining = (out.get("leader.list-after-route") or {}).get("items")
    check("leader.route", routed.get("leader_queue") is False and routed.get("manager_session_id") == o["manager"] and routed.get("owner_package_id") == o["pkg_b"]
          and str(routed.get("generation")) == "2" and remaining == [], [out.get("leader.route"), remaining])

    intake = (out.get("intake.list") or {}).get("items") or []
    check("intake.list", sorted((i["repository_id"], i["issue_number"]) for i in intake) == sorted([(o["repo"], "101"), (o["repo"], "102"), (o["repo2"], "7")])
          and all(i["state"] == "NEEDS_TRIAGE" and i["title"] for i in intake), intake)
    check("intake.refuse-stale", err(out.get("intake.stale"), "STALE_INTAKE"), out.get("intake.stale"))
    check("intake.acknowledge", (out.get("intake.ack") or {}).get("state") == "DISMISSED" and out["intake.ack"].get("replayed") is False, out.get("intake.ack"))
    check("intake.acknowledge-replay", (out.get("intake.ack-replay") or {}).get("replayed") is True, out.get("intake.ack-replay"))
    triage = [i["issue_number"] for i in (out.get("intake.list-triage") or {}).get("items") or []]
    dismissed = [i["issue_number"] for i in (out.get("intake.list-dismissed") or {}).get("items") or []]
    check("intake.list-by-state", sorted(triage) == ["101", "7"] and dismissed == ["102"], [triage, dismissed])
    check("intake.refuse-scope-mismatch", err(out.get("intake.scope"), "SCOPE_MISMATCH"), out.get("intake.scope"))
    check("intake.refuse-stale-finding", err(out.get("intake.stale-finding"), "STALE_FINDING"), out.get("intake.stale-finding"))
    linked = out.get("intake.route") or {}
    linked_list = (out.get("intake.list-linked") or {}).get("items") or []
    check("intake.route", linked.get("state") == "LINKED" and linked.get("finding_id") == o["f_intake"] and linked.get("replayed") is False
          and len(linked_list) == 1 and linked_list[0]["finding_id"] == o["f_intake"] and linked_list[0]["issue_number"] == "101"
          and int(out.get("intake.route-after-version") or 0) == int(out.get("intake.route-version") or 0) + 1, [linked, linked_list])
    ievents = out.get("intake.route-events")
    check("intake.route-event", isinstance(ievents, list) and len(ievents) == 1 and ievents[0]["payload"]["issue_number"] == "101"
          and ievents[0]["payload"]["repository_id"] == o["repo"], ievents)
    check("intake.refuse-dismissed-route", err(out.get("intake.route-dismissed"), "INTAKE_DISMISSED"), out.get("intake.route-dismissed"))
    check("intake.refuse-linked-dismiss", err(out.get("intake.dismiss-linked"), "INTAKE_ALREADY_ROUTED"), out.get("intake.dismiss-linked"))

    state = out.get("repair.no-policy-state") or []
    check("repair.escalation-needs-deadline-policy", err(out.get("repair.no-policy"), "ASK_POLICY_REQUIRED") and state == [{"state": "RUNNING"}], [out.get("repair.no-policy"), state])
    ask_id = out.get("repair.ask-id")
    check("repair.escalation-needs-operator-channel", err(out.get("repair.no-operator-channel"), "ASK_OPERATOR_CONSUMER_REQUIRED")
          and out.get("repair.no-operator-channel-asks") == [{"n": 0}], [out.get("repair.no-operator-channel"), out.get("repair.no-operator-channel-asks")])
    delivery = out.get("repair.ask-delivery") or []
    payload = delivery[0]["payload"] if len(delivery) == 1 else {}
    check("repair.ask-delivered-to-operator", len(delivery) == 1 and delivery[0]["aggregate_id"] == ask_id and delivery[0]["aggregate_version"] == "1"
          and delivery[0]["consumer_key"] == "operator:asks" and delivery[0]["state"] == "PENDING" and payload.get("target") == "OPERATOR"
          and (payload.get("ask") or {}).get("kind") == "decision" and (payload.get("ask") or {}).get("ask_id") == ask_id
          and (payload.get("source") or {}).get("repair_id") == o["repair"], delivery)
    failed = out.get("repair.fail") or {}
    asks = out.get("repair.asks") or []
    first = asks[0] if asks else {}
    check("repair.escalation-raises-decision-ask", failed.get("state") == "ESCALATED" and failed.get("escalated") is True and failed.get("ask_id") == ask_id
          and len(asks) == 1 and first.get("id") == ask_id and first.get("kind") == "decision" and first.get("default_policy") == "proceed-and-flag"
          and first.get("recommended") == "HOLD" and first.get("options") == out.get("repair.options") and first.get("state") == "OPEN"
          and first.get("run_id") == o["run"] and first.get("task") == o["task"] and first.get("attempt") == o["attempt"]
          and first.get("raised_by") == o["credential"] and first.get("chain") == ["leader", "operator"] and first.get("window") == 3600
          and len(out.get("repair.escalated-events") or []) == 1, [failed, asks])
    aevents = out.get("repair.ask-events") or []
    check("repair.ask-event", aevents == [{"ask_id": ask_id, "event_type": "RAISED", "state": "OPEN", "actor": o["credential"]}], aevents)
    listed = {i["repair_id"]: i for i in (out.get("repair.list") or {}).get("items") or []}
    mine = listed.get(o["repair"], {})
    check("repair.list", sorted(listed) == sorted([o["repair"], o["repair_old"]]) and mine.get("ask_id") == ask_id and (mine.get("ask") or {}).get("state") == "OPEN"
          and mine.get("acknowledged") is False and mine.get("reason", "").startswith("reproduction still fails") and listed.get(o["repair_old"], {}).get("ask") is None, listed)
    check("repair.refuse-not-escalated", err(out.get("repair.not-escalated"), "REPAIR_NOT_ESCALATED"), out.get("repair.not-escalated"))
    check("repair.refuse-stale", err(out.get("repair.stale"), "STALE_REPAIR"), out.get("repair.stale"))
    rack = out.get("repair.ack") or {}
    check("repair.acknowledge", rack.get("acknowledged") is True and rack.get("ask_id") == ask_id and rack.get("replayed") is False, rack)
    check("repair.acknowledge-replay-one-ask", (out.get("repair.ack-replay") or {}).get("replayed") is True and out.get("repair.ask-count") == [{"n": 1}],
          [out.get("repair.ack-replay"), out.get("repair.ask-count")])
    check("repair.acknowledge-backfills-ask", (out.get("repair.backfill") or {}).get("acknowledged") is True
          and out.get("repair.backfill-ask") == [{"kind": "decision", "state": "OPEN", "recommended": "HOLD"}], [out.get("repair.backfill"), out.get("repair.backfill-ask")])
    rroute = out.get("repair.route") or {}
    check("repair.route", rroute.get("leader_queue") is False and rroute.get("replayed") is False and rroute.get("route_id"), rroute)
    final = {i["repair_id"]: i for i in (out.get("repair.list-after") or {}).get("items") or []}
    revents = [e["event_type"] for e in out.get("repair.route-events") or []]
    check("repair.list-routed", final.get(o["repair"], {}).get("route_id") == rroute.get("route_id") and final.get(o["repair"], {}).get("acknowledged") is True
          and revents == ["ESCALATED", "ESCALATION_ACKNOWLEDGED", "ESCALATION_ROUTED"], [final, revents])


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
        print("SKIP: core/control-plane/node_modules is not installed", flush=True)
        return 77
    t295 = load("hf_case_29_5", "tests/hyperfide/cases/tasks/29_5.py")
    t295.postgres_bin = lambda: servers[-1]
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    base = os.environ.copy()
    # Only the owned cluster is reachable: never let an inherited database URL redirect a probe.
    for key in list(base):
        if key == "DATABASE_URL" or key.startswith("HYPERFIDE_") and key.endswith("_DATABASE_URL") or key == "HF_FINDING_ESCALATION_ASK_SECONDS":
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
        names = ["org", "project", "spec", "run", "epoch", "pkg_a", "pkg_b", "pool", "sandbox", "slot", "task", "attempt", "manager", "worker",
                 "operator", "credential", "repo", "repo2", "evidence", "f_queue", "f_repair", "f_intake", "f_closed", "f_assigned", "f_backfill",
                 "f_other", "route_queue", "route_assigned", "repair", "repair_old", "repair_failed"]
        scenario(cluster, t295, base, {name: u() for name in names})
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
