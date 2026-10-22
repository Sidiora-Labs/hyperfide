// Operator console read model (hyperfide-v21 req 5). Read-only: every row is an observation
// with its own freshness, never an authority to place, admit, resolve or delete.
import type {Component,ComponentContext} from '../components/registry.js';
import {authority,fail,integer,numbers,object} from './views.js';
import type {Principal,Session} from './views.js';
import {classifySandbox,RUNNER_HEARTBEAT_MAX_AGE_SECONDS} from '../providers/placement.js';
import type {SandboxLiveness} from '../providers/placement.js';
import {MAX_ADMISSION_ESCALATIONS} from '../agents/admission.js';
import {leaderQueueReader} from '../findings/routing.js';
import type {FindingReader} from '../findings/routing.js';
import {externalIntakeReader} from '../findings/github.js';
import {escalatedRepairReader} from '../findings/remediation.js';
import type {FindingTransaction} from '../findings/registry.js';

const CONSOLE_ROLES=['OPERATOR','COORDINATOR','LEADER','PROVISIONER'];
const DEFAULT_LIMIT=500,MAX_LIMIT=2000;

export interface ConsoleWorker {
 slot_id:string;slot_key:string;capacity_kind:string;state:string;boot_generation:string;
 attempt:{run_id:string;id:string;task_id:string;generation:string;kind:string;execution_state:string;compute_authority:string;lease_expires_at:string|null}|null;
 runner:{run_id:string;session_id:string;credential_id:string;state:string;observed_at:string;heartbeat_at:string|null}|null;
 slice:{state:'MATERIALISED'|'RELEASED'|'FAILED'|'REFUSED';run_id:string;digest:string;materialisation_id:string;mode:string;fallback_reason:string|null;included_paths:number;closure_files:number|null;verified_head:string|null;at:string}|null;
 snapshot:{state:'NO_ATTEMPT'|'NONE'|'CAPTURED';id:string|null;result_tree:string|null;files_changed:string|null;checkpoint_digest:string|null;at:string|null};
}
export interface ConsoleSandbox {
 kind:'SANDBOX'|'ORPHAN';liveness:SandboxLiveness;reasons:string[];
 sandbox_id:string|null;pool_id:string;provider:string;region:string;native_sandbox_id:string|null;
 desired_state:string|null;observed_state:string|null;boot_generation:string|null;work_admitted:boolean|null;
 heartbeat_at:string|null;heartbeat_age_seconds:number|null;
 intent:{run_id:string;id:string;kind:string;state:string;failure_code:string|null;updated_at:string}|null;
 quarantined_intents:string[];orphan:{state:string;suspected_intent_id:string|null;first_observed_at:string;last_observed_at:string}|null;
 attempts:number;workers:ConsoleWorker[];
}
export interface SandboxInventory {
 view:'console.sandboxes';scope:{organisation_id:string};as_of:string;heartbeat_max_age_seconds:number;
 counts:Record<SandboxLiveness,number>;truncated:boolean;rows:ConsoleSandbox[];authority:'PRIMARY_OBSERVATION';activity_is_qualified_progress:false;
}

const iso=(v:unknown):string|null=>v==null?null:v instanceof Date?v.toISOString():new Date(String(v)).toISOString();
const str=(v:unknown):string|null=>v==null?null:String(v);
const key=(...parts:unknown[])=>parts.map(String).join(':');
function group<R extends Record<string,unknown>>(rows:R[],k:(r:R)=>string):Map<string,R[]>{
 const m=new Map<string,R[]>();for(const r of rows){const id=k(r);(m.get(id)??m.set(id,[]).get(id)!).push(r);}return m;
}

/** console.sandboxes: one row per sandbox of the organisation joined across sandboxes,
 * worker_slots, runner_registry, identity_runner_status, attempts and provisioning_intents,
 * plus one ORPHANED row per provider resource that reconciliation found but no sandbox owns.
 * Run it inside one transaction so every join reads the same snapshot. */
export async function sandboxInventory(tx:Session,organisationId:string,options:{limit?:number}={}):Promise<SandboxInventory>{
 const limit=options.limit??DEFAULT_LIMIT,org=[organisationId];
 const asOf=iso((await tx.query('SELECT clock_timestamp() AS at')).rows[0]!.at)!;
 const sandboxes=(await tx.query(`SELECT s.id,s.pool_id,s.native_sandbox_id,s.desired_state,s.observed_state,s.boot_generation,s.work_admitted,p.provider,p.region
  FROM hyperfide.sandboxes s JOIN hyperfide.provider_pools p ON p.organisation_id=s.organisation_id AND p.id=s.pool_id
  WHERE s.organisation_id=$1 ORDER BY s.created_at,s.id LIMIT $2`,[organisationId,limit+1])).rows;
 const truncated=sandboxes.length>limit;sandboxes.length=Math.min(sandboxes.length,limit);
 const ids=sandboxes.map(s=>s.id as string),scoped=[organisationId,ids];
 // Runner credentials of the sandbox's current boot only: an older boot's heartbeat says nothing about this one.
 const credentials=(await tx.query(`SELECT ip.sandbox_id,ip.state,st.heartbeat_at,extract(epoch FROM $3::timestamptz-st.heartbeat_at)::float8 AS age
  FROM hyperfide.identity_principals ip JOIN hyperfide.sandboxes s ON s.organisation_id=ip.organisation_id AND s.id=ip.sandbox_id AND s.boot_generation=ip.boot_generation
  LEFT JOIN hyperfide.identity_runner_status st ON st.credential_id=ip.credential_id
  WHERE ip.organisation_id=$1 AND ip.sandbox_id=ANY($2::uuid[]) AND ip.role='RUNNER'`,[...scoped,asOf])).rows;
 const intents=(await tx.query(`SELECT run_id,id,sandbox_id,kind,state,failure_code,updated_at FROM hyperfide.provisioning_intents
  WHERE organisation_id=$1 AND sandbox_id=ANY($2::uuid[]) ORDER BY updated_at DESC,id`,scoped)).rows;
 const slots=(await tx.query(`SELECT w.id,w.sandbox_id,w.slot_key,w.capacity_kind,w.state,w.boot_generation FROM hyperfide.worker_slots w
  JOIN hyperfide.sandboxes s ON s.organisation_id=w.organisation_id AND s.id=w.sandbox_id AND s.boot_generation=w.boot_generation
  WHERE w.organisation_id=$1 AND w.sandbox_id=ANY($2::uuid[]) ORDER BY w.slot_key,w.id`,scoped)).rows;
 const runners=(await tx.query(`SELECT r.run_id,r.session_id,r.credential_id,r.sandbox_id,r.slot_id,r.boot_generation,r.state,r.observed_at,st.heartbeat_at
  FROM hyperfide.runner_registry r LEFT JOIN hyperfide.identity_runner_status st ON st.credential_id=r.credential_id
  WHERE r.organisation_id=$1 AND r.sandbox_id=ANY($2::uuid[]) ORDER BY (r.state='CURRENT') DESC,r.observed_at DESC`,scoped)).rows;
 const attempts=(await tx.query(`SELECT run_id,id,task_id,generation,kind,execution_state,compute_authority,lease_expires_at,sandbox_id,slot_id,sandbox_boot_generation,created_at
  FROM hyperfide.attempts WHERE organisation_id=$1 AND sandbox_id=ANY($2::uuid[]) ORDER BY (compute_authority='CURRENT') DESC,created_at DESC,generation DESC`,scoped)).rows;
 const slices=(await tx.query(`SELECT m.run_id,m.id,m.slot_id,m.sandbox_boot_generation,m.slice_digest,m.outcome,m.verified_head,m.created_at,
   (SELECT r.id FROM hyperfide.workspace_slice_materialisations r WHERE r.organisation_id=m.organisation_id AND r.run_id=m.run_id AND r.released_materialisation_id=m.id) AS released_by,
   f.mode,f.fallback_reason,coalesce(jsonb_array_length(CASE WHEN jsonb_typeof(f.manifest->'included_paths')='array' THEN f.manifest->'included_paths' END),0) AS included_paths,
   (f.manifest#>>'{closure,files}')::bigint AS closure_files
  FROM hyperfide.workspace_slice_materialisations m JOIN hyperfide.workspace_slice_manifests f ON f.organisation_id=m.organisation_id AND f.run_id=m.run_id AND f.digest=m.slice_digest
  WHERE m.organisation_id=$1 AND m.sandbox_id=ANY($2::uuid[]) AND m.outcome<>'RELEASED' ORDER BY m.created_at DESC,m.id`,scoped)).rows;
 const attemptIds=attempts.map(a=>a.id as string);
 const snapshots=attemptIds.length?(await tx.query(`SELECT run_id,attempt_id,id,result_tree,files_changed,checkpoint_digest,created_at FROM hyperfide.source_snapshots
  WHERE organisation_id=$1 AND attempt_id=ANY($2::uuid[]) ORDER BY created_at DESC,id`,[organisationId,attemptIds])).rows:[];
 const orphans=(await tx.query(`SELECT o.pool_id,o.native_sandbox_id,o.state,o.suspected_intent_id,o.first_observed_at,o.last_observed_at,p.provider,p.region
  FROM hyperfide.provider_orphans o JOIN hyperfide.provider_pools p ON p.organisation_id=o.organisation_id AND p.id=o.pool_id
  WHERE o.organisation_id=$1 AND o.state<>'DELETED' AND NOT EXISTS(SELECT 1 FROM hyperfide.sandboxes s WHERE s.organisation_id=o.organisation_id AND s.pool_id=o.pool_id AND s.native_sandbox_id=o.native_sandbox_id)
  ORDER BY o.first_observed_at,o.native_sandbox_id LIMIT $2`,[organisationId,limit+1])).rows;

 const bySandbox={credentials:group(credentials,r=>String(r.sandbox_id)),intents:group(intents,r=>String(r.sandbox_id)),slots:group(slots,r=>String(r.sandbox_id)),attempts:group(attempts,r=>String(r.sandbox_id))};
 const bySlot={runners:group(runners,r=>key(r.slot_id,r.boot_generation)),attempts:group(attempts,r=>key(r.slot_id,r.sandbox_boot_generation)),slices:group(slices,r=>key(r.slot_id,r.sandbox_boot_generation))};
 const snapshotOf=group(snapshots,r=>key(r.run_id,r.attempt_id));
 const counts:Record<SandboxLiveness,number>={LIVE:0,LOST:0,QUARANTINED:0,ORPHANED:0,PENDING:0,RETIRED:0};
 const rows:ConsoleSandbox[]=[];
 for(const s of sandboxes){
  const creds=bySandbox.credentials.get(s.id)??[],own=bySandbox.intents.get(s.id)??[];
  const beats=creds.filter(c=>c.heartbeat_at!=null),latest=beats.sort((a,b)=>Number(a.age)-Number(b.age))[0];
  const age=latest?Math.round(Number(latest.age)*1000)/1000:null;
  const workers=(bySandbox.slots.get(s.id)??[]).map((w):ConsoleWorker=>{
   const k=key(w.id,w.boot_generation),a=bySlot.attempts.get(k)?.[0],r=bySlot.runners.get(k)?.[0],m=bySlot.slices.get(k)?.[0];
   const snap=a?snapshotOf.get(key(a.run_id,a.id))?.[0]:undefined;
   return{slot_id:w.id,slot_key:w.slot_key,capacity_kind:w.capacity_kind,state:w.state,boot_generation:String(w.boot_generation),
    attempt:a?{run_id:a.run_id,id:a.id,task_id:a.task_id,generation:String(a.generation),kind:a.kind,execution_state:a.execution_state,compute_authority:a.compute_authority,lease_expires_at:iso(a.lease_expires_at)}:null,
    runner:r?{run_id:r.run_id,session_id:r.session_id,credential_id:r.credential_id,state:r.state,observed_at:iso(r.observed_at)!,heartbeat_at:iso(r.heartbeat_at)}:null,
    slice:m?{state:m.released_by?'RELEASED':m.outcome==='READY'?'MATERIALISED':m.outcome,run_id:m.run_id,digest:m.slice_digest,materialisation_id:m.id,mode:m.mode,fallback_reason:m.fallback_reason,
     included_paths:Number(m.included_paths),closure_files:m.closure_files==null?null:Number(m.closure_files),verified_head:m.verified_head,at:iso(m.created_at)!}:null,
    snapshot:!a?{state:'NO_ATTEMPT',id:null,result_tree:null,files_changed:null,checkpoint_digest:null,at:null}
     :snap?{state:'CAPTURED',id:snap.id,result_tree:snap.result_tree,files_changed:str(snap.files_changed),checkpoint_digest:snap.checkpoint_digest,at:iso(snap.created_at)}
     :{state:'NONE',id:null,result_tree:null,files_changed:null,checkpoint_digest:null,at:null}};
  });
  const verdict=classifySandbox({observed_state:s.observed_state,desired_state:s.desired_state,heartbeat_age_seconds:age,
   enrolled:creds.length>0||workers.some(w=>w.runner!==null),intent_states:own.map(i=>i.state),latest_intent_state:own[0]?.state??null,
   credential_quarantined:creds.some(c=>c.state==='QUARANTINED')});
  counts[verdict.liveness]++;
  const i=own[0];
  rows.push({kind:'SANDBOX',liveness:verdict.liveness,reasons:verdict.reasons,sandbox_id:s.id,pool_id:s.pool_id,provider:s.provider,region:s.region,native_sandbox_id:s.native_sandbox_id,
   desired_state:s.desired_state,observed_state:s.observed_state,boot_generation:String(s.boot_generation),work_admitted:s.work_admitted,
   heartbeat_at:latest?iso(latest.heartbeat_at):null,heartbeat_age_seconds:age,
   intent:i?{run_id:i.run_id,id:i.id,kind:i.kind,state:i.state,failure_code:i.failure_code,updated_at:iso(i.updated_at)!}:null,
   quarantined_intents:own.filter(x=>x.state==='QUARANTINED').map(x=>x.id),orphan:null,attempts:(bySandbox.attempts.get(s.id)??[]).length,workers});
 }
 const orphanTruncated=orphans.length>limit;orphans.length=Math.min(orphans.length,limit);
 for(const o of orphans){
  counts.ORPHANED++;
  rows.push({kind:'ORPHAN',liveness:'ORPHANED',reasons:['NO_SANDBOX_OWNS_PROVIDER_RESOURCE','ORPHAN_'+o.state],sandbox_id:null,pool_id:o.pool_id,provider:o.provider,region:o.region,native_sandbox_id:o.native_sandbox_id,
   desired_state:null,observed_state:null,boot_generation:null,work_admitted:null,heartbeat_at:null,heartbeat_age_seconds:null,intent:null,quarantined_intents:[],
   orphan:{state:o.state,suspected_intent_id:o.suspected_intent_id,first_observed_at:iso(o.first_observed_at)!,last_observed_at:iso(o.last_observed_at)!},attempts:0,workers:[]});
 }
 return numbers({view:'console.sandboxes',scope:{organisation_id:organisationId},as_of:asOf,heartbeat_max_age_seconds:RUNNER_HEARTBEAT_MAX_AGE_SECONDS,counts,
  truncated:truncated||orphanTruncated,rows,authority:'PRIMARY_OBSERVATION',activity_is_qualified_progress:false}) as SandboxInventory;
}

// Needs, Issues and Leaders (req 5.1): one row shape for every panel, so the editor and cg render them alike.
// freshness.observed_at is the newest durable change behind the row and age_seconds is measured against the view's
// as_of (the database clock of the same transaction); references name every entity a human may open from the row.
export interface ConsoleFreshness {observed_at:string;age_seconds:number;source:string;stale?:boolean}
export interface ConsoleRow {
 kind:'ASK'|'HUMAN_INTENT'|'ADMISSION_ESCALATION'|'LEADER_QUEUE'|'EXTERNAL_INTAKE'|'ESCALATED_REPAIR'|'DRIFT'|'LEADER';
 id:string;state:string;title:string;since:string;freshness:ConsoleFreshness;
 references:Record<string,string|null>;detail:Record<string,unknown>;
}
export interface ConsoleSection {rows:ConsoleRow[];truncated:boolean}
export interface ConsolePanel<S extends string> {
 view:string;scope:{organisation_id:string;run_id:string};as_of:string;counts:Record<S,number>;sections:Record<S,ConsoleSection>;
 authority:'PRIMARY_OBSERVATION';activity_is_qualified_progress:false;
}
export type NeedsPanel=ConsolePanel<'asks'|'human_intents'|'admission_escalations'>;
export type IssuesPanel=ConsolePanel<'leader_queue'|'external_intake'|'escalated_repairs'|'drift'>;
export interface LeadersPanel {
 view:'console.leaders';scope:{organisation_id:string;run_id:string};as_of:string;max_observation_age_seconds:number;
 primary_leader:{session_id:string;generation:string;authority_epoch:string}|null;counts:{leaders:number;feature_managers:number;stale:number};
 truncated:boolean;rows:ConsoleRow[];authority:'PRIMARY_OBSERVATION';activity_is_qualified_progress:false;
}
export interface PanelOptions {limit?:number;max_observation_age_seconds?:number;include_ended?:boolean}
/** The console caller as a finding principal, so the 4.6 readers apply their own leader-or-operator authority. */
export interface ConsoleFindingCaller {principal:Principal;context:ComponentContext}

// fleet.views.snapshot's default observation age: an observation older than this no longer proves the state it reports.
export const OBSERVATION_MAX_AGE_SECONDS=15;
const READER_MAX=200;
const HUMAN_ROLES=['OPERATOR','COORDINATOR','LEADER'];
const WAITING_ASK="(a.state='OPEN' OR (a.state='EXPIRED' AND a.default_policy='block'))";
const PENDING_INTENT="c.principal_scope='human_intent' AND c.operation='human.intent.state' AND c.state='COMPLETED' AND c.result->>'state'='PENDING'";

async function clock(tx:Session):Promise<string>{return iso((await tx.query('SELECT clock_timestamp() AS at')).rows[0]!.at)!;}
function fresh(asOf:string,at:unknown,source:string,maxAge?:number):ConsoleFreshness{
 const observed=iso(at)!,age=Math.round(Date.parse(asOf)-Date.parse(observed))/1000;
 return maxAge===undefined?{observed_at:observed,age_seconds:age,source}:{observed_at:observed,age_seconds:age,source,stale:age>maxAge};
}
const refs=(r:Record<string,unknown>)=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k,v==null?null:String(v)])) as Record<string,string|null>;
function page<T>(rows:T[],limit:number):{rows:T[];truncated:boolean}{return {rows:rows.slice(0,limit),truncated:rows.length>limit};}
const scopeOf=(p:Principal)=>({organisation_id:p.organisation_id,run_id:p.run_id});

/** Asks a human still owes: OPEN, plus a blocking Ask past its deadline (it expired unanswered and still holds its task). */
export async function openAsks(tx:Session,p:Principal,limit:number,asOf:string):Promise<ConsoleSection>{
 const q=await tx.query(`SELECT a.*,t.task_key,t.state AS task_state,coalesce(t.blocked_ask=a.id,false) AS holds_task,
   (SELECT max(e.recorded_at) FROM hyperfide.ask_events e WHERE e.organisation_id=a.organisation_id AND e.ask_id=a.id) AS changed_at,
   extract(epoch FROM a.deadline-$3::timestamptz)::float8 AS to_deadline
  FROM hyperfide.asks a LEFT JOIN hyperfide.tasks t ON t.organisation_id=a.organisation_id AND t.run_id=a.run_id AND t.id=a.task
  WHERE a.organisation_id=$1 AND (a.run_id=$2 OR a.run_id IS NULL) AND ${WAITING_ASK}
  ORDER BY a.deadline NULLS LAST,a.raised_at,a.id LIMIT $4`,[p.organisation_id,p.run_id,asOf,limit+1]);
 return page(q.rows.map((a):ConsoleRow=>({kind:'ASK',id:a.id,state:a.state,title:a.title,since:iso(a.raised_at)!,freshness:fresh(asOf,a.changed_at??a.raised_at,'hyperfide.asks'),
  references:refs({ask_id:a.id,run_id:a.run_id,task_id:a.task,task_key:a.task_key,attempt_id:a.attempt,session_id:a.session,sandbox_id:a.sandbox,raised_by:a.raised_by}),
  detail:{ask_kind:a.kind,body:a.body,options:a.options,recommended:a.recommended,default_policy:a.default_policy,chain:a.chain,deadline:iso(a.deadline),
   seconds_to_deadline:a.to_deadline==null?null:Math.round(Number(a.to_deadline)*1000)/1000,overdue:a.to_deadline!=null&&Number(a.to_deadline)<=0,
   blocking:a.default_policy==='block',holds_task:a.holds_task,task_state:a.task_state??null,state_version:String(a.state_version)}})),limit);
}

/** Programme intent a human submitted that the primary leader has not reported complete (policy/human_interface.ts). */
export async function pendingHumanIntents(tx:Session,p:Principal,limit:number,asOf:string):Promise<ConsoleSection>{
 const q=await tx.query(`SELECT c.idempotency_key AS root_event_id,c.result,c.created_at,r.aggregate_id AS command_id,r.payload AS root,r.created_at AS requested_at,
   cur.created_at AS current_at,cur.event_type AS current_event_type,d.state AS delivery_state,d.acknowledged_at,h.leader_session_id AS current_leader
  FROM hyperfide.command_inbox c
  LEFT JOIN hyperfide.outbox_events r ON r.organisation_id=c.organisation_id AND r.run_id=c.run_id AND r.id::text=c.idempotency_key
  LEFT JOIN hyperfide.outbox_events cur ON cur.organisation_id=c.organisation_id AND cur.run_id=c.run_id AND cur.id::text=c.result->>'current_event_id'
  LEFT JOIN hyperfide.event_deliveries d ON d.organisation_id=c.organisation_id AND d.run_id=c.run_id AND d.event_id=cur.id AND d.consumer_id::text=c.result->>'target_consumer_id'
  LEFT JOIN hyperfide.hierarchy_leaders h ON h.organisation_id=c.organisation_id AND h.run_id=c.run_id
  WHERE c.organisation_id=$1 AND c.run_id=$2 AND ${PENDING_INTENT}
  ORDER BY c.created_at,c.id LIMIT $3`,[p.organisation_id,p.run_id,limit+1]);
 return page(q.rows.map((c):ConsoleRow=>{
  const s=c.result as Record<string,unknown>,root=(c.root??{}) as Record<string,unknown>;
  return {kind:'HUMAN_INTENT',id:c.root_event_id,state:'PENDING',title:String(root.kind??'INTENT')+' '+String(root.request_id??c.root_event_id),
   since:iso(c.requested_at??c.created_at)!,freshness:fresh(asOf,c.acknowledged_at??c.current_at??c.created_at,c.acknowledged_at?'hyperfide.event_deliveries':'hyperfide.outbox_events'),
   references:refs({root_event_id:c.root_event_id,current_event_id:s.current_event_id,command_id:c.command_id,target_session_id:s.target_session_id,
    target_consumer_id:s.target_consumer_id,source_actor_id:root.source_actor_id,package_id:root.package_id}),
   detail:{intent_kind:root.kind??null,request_id:root.request_id??null,source_role:root.source_role??null,intent:root.payload??null,leader_generation:s.leader_generation??null,
    current_event_type:c.current_event_type??null,delivery_state:c.delivery_state??null,
    // Delivered to a leader that has since been replaced: the new leader must adopt it (human.intent.adopt).
    target_is_current_leader:c.current_leader!=null&&c.current_leader===s.target_session_id}};
 }),limit);
}

/** Open admission escalations: an agent launch that needs a human to change a condition before it may retry. */
export async function admissionEscalations(tx:Session,p:Principal,limit:number,asOf:string):Promise<ConsoleSection>{
 const q=await tx.query(`SELECT e.*,r.quota_key,r.state AS reservation_state,r.retry_after,s.role AS session_role,s.state AS session_state,s.attempt_id,s.sandbox_id,a.task_id,t.task_key,
   (SELECT count(*) FROM hyperfide.agent_admission_escalations x WHERE x.organisation_id=e.organisation_id AND x.run_id=e.run_id AND x.reservation_id=e.reservation_id AND x.state='RESOLVED')::int AS resolved
  FROM hyperfide.agent_admission_escalations e
  JOIN hyperfide.agent_admission_reservations r ON r.organisation_id=e.organisation_id AND r.run_id=e.run_id AND r.id=e.reservation_id
  JOIN hyperfide.agent_sessions s ON s.organisation_id=e.organisation_id AND s.run_id=e.run_id AND s.id=e.session_id
  LEFT JOIN hyperfide.attempts a ON a.organisation_id=s.organisation_id AND a.run_id=s.run_id AND a.id=s.attempt_id
  LEFT JOIN hyperfide.tasks t ON t.organisation_id=a.organisation_id AND t.run_id=a.run_id AND t.id=a.task_id
  WHERE e.organisation_id=$1 AND e.run_id=$2 AND e.state='OPEN' ORDER BY e.created_at,e.id LIMIT $3`,[p.organisation_id,p.run_id,limit+1]);
 return page(q.rows.map((e):ConsoleRow=>({kind:'ADMISSION_ESCALATION',id:e.id,state:e.state,title:String(e.session_role)+' admission escalated: '+String(e.reason),
  since:iso(e.created_at)!,freshness:fresh(asOf,e.created_at,'hyperfide.agent_admission_escalations'),
  references:refs({escalation_id:e.id,reservation_id:e.reservation_id,session_id:e.session_id,attempt_id:e.attempt_id,task_id:e.task_id,task_key:e.task_key,sandbox_id:e.sandbox_id,raised_by_operation_id:e.raised_by_operation_id}),
  detail:{reason:e.reason,sequence:e.sequence,attempt_count:e.attempt_count,quota_key:e.quota_key,reservation_state:e.reservation_state,retry_after:iso(e.retry_after),
   condition_digest:e.condition_digest,diagnostic_refs:e.diagnostic_refs,session_state:e.session_state,remaining_resolutions:Math.max(0,MAX_ADMISSION_ESCALATIONS-Number(e.resolved))}})),limit);
}

export async function needsPanel(tx:Session,p:Principal,options:PanelOptions={}):Promise<NeedsPanel>{
 const limit=options.limit??DEFAULT_LIMIT,asOf=await clock(tx);
 const sections={asks:await openAsks(tx,p,limit,asOf),human_intents:await pendingHumanIntents(tx,p,limit,asOf),admission_escalations:await admissionEscalations(tx,p,limit,asOf)};
 return {view:'console.needs',scope:scopeOf(p),as_of:asOf,counts:{asks:sections.asks.rows.length,human_intents:sections.human_intents.rows.length,admission_escalations:sections.admission_escalations.rows.length},
  sections,authority:'PRIMARY_OBSERVATION',activity_is_qualified_progress:false};
}

async function findingsOf(tx:Session,p:Principal,ids:unknown[]):Promise<Map<string,Record<string,any>>>{
 const list=[...new Set(ids.filter(Boolean).map(String))];
 if(!list.length)return new Map();
 const q=await tx.query(`SELECT f.id,f.summary,f.severity,f.repository_id,f.owner_package_id,g.phase FROM hyperfide.findings f
  LEFT JOIN hyperfide.finding_registry_records g ON g.organisation_id=f.organisation_id AND g.run_id=f.run_id AND g.finding_id=f.id
  WHERE f.organisation_id=$1 AND f.run_id=$2 AND f.id=ANY($3::uuid[])`,[p.organisation_id,p.run_id,list]);
 return new Map(q.rows.map(r=>[String(r.id),r]));
}
async function readerItems(reader:FindingReader,value:FindingTransaction,limit:number):Promise<{items:Record<string,any>[];truncated:boolean}>{
 const r=await reader.list(value,{limit:Math.min(limit,READER_MAX)}) as {items:Record<string,any>[];truncated:boolean};
 return {items:r.items,truncated:r.truncated};
}

/** Desired state disagrees with the newest authenticated observation, or a live entity's observation is too old to say. */
export async function observationDrift(tx:Session,p:Principal,limit:number,asOf:string,maxAge:number):Promise<ConsoleSection>{
 const q=await tx.query(`WITH d AS (
   SELECT o.*,coalesce(a.execution_state,s.state,x.desired_state) AS desired,
    CASE WHEN a.execution_state='RUNNING' OR s.state='RUNNING' OR x.desired_state='RUNNING' THEN 'LIVE'
     WHEN a.execution_state IN ('SUCCEEDED','FAILED','CANCELLED') OR s.state IN ('STOPPED','FAILED') OR x.desired_state IN ('STOPPED','DESTROYED') THEN 'ENDED' END AS expected,
    extract(epoch FROM $3::timestamptz-o.observed_at)::float8 AS age
   FROM hyperfide.observability_observations o
   LEFT JOIN hyperfide.attempts a ON o.entity_type='ATTEMPT' AND a.organisation_id=o.organisation_id AND a.run_id=o.run_id AND a.id=o.entity_id
   LEFT JOIN hyperfide.agent_sessions s ON o.entity_type='SESSION' AND s.organisation_id=o.organisation_id AND s.run_id=o.run_id AND s.id=o.entity_id
   LEFT JOIN hyperfide.sandboxes x ON o.entity_type='SANDBOX' AND x.organisation_id=o.organisation_id AND x.id=o.entity_id
   WHERE o.organisation_id=$1 AND o.run_id=$2)
  SELECT *,CASE WHEN expected='LIVE' AND observed_state IN ('STOPPED','FAILED','UNREACHABLE') THEN 'OBSERVED_NOT_RUNNING'
    WHEN expected='ENDED' AND observed_state='RUNNING' THEN 'OBSERVED_STILL_RUNNING' ELSE 'OBSERVATION_STALE' END AS reason
  FROM d WHERE (expected='LIVE' AND (observed_state IN ('STOPPED','FAILED','UNREACHABLE') OR age>$4)) OR (expected='ENDED' AND observed_state='RUNNING')
  ORDER BY observed_at,entity_type,entity_id LIMIT $5`,[p.organisation_id,p.run_id,asOf,maxAge,limit+1]);
 return page(q.rows.map((o):ConsoleRow=>({kind:'DRIFT',id:o.entity_type+':'+o.entity_id,state:o.reason,title:o.entity_type+' desired '+String(o.desired)+', observed '+o.observed_state,
  since:iso(o.observed_at)!,freshness:fresh(asOf,o.observed_at,'hyperfide.observability_observations',maxAge),
  references:refs({entity_type:o.entity_type,[String(o.entity_type).toLowerCase()+'_id']:o.entity_id,observer_actor_id:o.observer_actor_id,source_artifact_id:o.source_artifact_id}),
  detail:{desired_state:o.desired,observed_state:o.observed_state,entity_generation:String(o.entity_generation),observer_priority:o.observer_priority,source_digest:o.source_digest,received_at:iso(o.received_at)}})),limit);
}

export async function issuesPanel(tx:Session,caller:ConsoleFindingCaller,options:PanelOptions={}):Promise<IssuesPanel>{
 const p=caller.principal,limit=options.limit??DEFAULT_LIMIT,maxAge=options.max_observation_age_seconds??OBSERVATION_MAX_AGE_SECONDS,asOf=await clock(tx);
 // The readers authorise a LEADER against the leader of its own authority epoch; operators and coordinators need none.
 const value={tx,scope:scopeOf(p),principal:{...p,deployment_epoch:p.deployment_epoch??'',allowed_actions:[],expires_at:asOf},context:caller.context} as unknown as FindingTransaction;
 const queue=await readerItems(leaderQueueReader,value,limit),intake=await readerItems(externalIntakeReader,value,limit),repairs=await readerItems(escalatedRepairReader,value,limit);
 const f=await findingsOf(tx,p,[...queue.items.map(i=>i.finding_id),...intake.items.map(i=>i.finding_id),...repairs.items.map(i=>i.finding_id)]);
 const repoIds=[...new Set(intake.items.map(i=>String(i.repository_id)))];
 const repos=new Map(repoIds.length?(await tx.query('SELECT id,name FROM hyperfide.repositories WHERE organisation_id=$1 AND id=ANY($2::uuid[])',[p.organisation_id,repoIds])).rows.map(r=>[String(r.id),r.name]):[]);
 const sections={
  leader_queue:{truncated:queue.truncated,rows:queue.items.map((i):ConsoleRow=>{const g=f.get(String(i.finding_id));return {kind:'LEADER_QUEUE',id:i.route_id,state:i.acknowledged?'ACKNOWLEDGED':'WAITING',
   title:g?.summary??'Finding '+String(i.finding_id),since:iso(i.created_at)!,freshness:fresh(asOf,i.acknowledged_at??i.created_at,i.acknowledged_at?'hyperfide.outbox_events':'hyperfide.finding_routes'),
   references:refs({route_id:i.route_id,finding_id:i.finding_id,owner_package_id:i.owner_package_id,repository_id:g?.repository_id,acknowledged_by:i.acknowledged_by}),
   detail:{...i,created_at:iso(i.created_at),acknowledged_at:iso(i.acknowledged_at),severity:g?.severity??null}};})},
  external_intake:{truncated:intake.truncated,rows:intake.items.map((i):ConsoleRow=>({kind:'EXTERNAL_INTAKE',id:String(i.repository_id)+'#'+String(i.issue_number),state:i.state,
   title:i.title??'Issue '+String(i.issue_number),since:iso(i.external_updated_at)!,freshness:fresh(asOf,i.external_updated_at,'github'),
   references:refs({repository_id:i.repository_id,repository:repos.get(String(i.repository_id)),issue_number:i.issue_number,finding_id:i.finding_id}),
   detail:{...i,external_updated_at:iso(i.external_updated_at)}}))},
  escalated_repairs:{truncated:repairs.truncated,rows:repairs.items.map((i):ConsoleRow=>{const g=f.get(String(i.finding_id));return {kind:'ESCALATED_REPAIR',id:i.repair_id,
   state:i.route_id?'ROUTED':i.acknowledged?'ACKNOWLEDGED':'ESCALATED',title:g?.summary??'Repair of finding '+String(i.finding_id),since:iso(i.updated_at)!,
   freshness:fresh(asOf,i.updated_at,'hyperfide.finding_repairs'),
   references:refs({repair_id:i.repair_id,finding_id:i.finding_id,task_id:i.repair_task_id,ask_id:i.ask_id,route_id:i.route_id,repository_id:g?.repository_id}),
   detail:{...i,updated_at:iso(i.updated_at),ask:i.ask?{...i.ask,deadline:iso(i.ask.deadline)}:null,severity:g?.severity??null}};})},
  drift:await observationDrift(tx,p,limit,asOf,maxAge),
 };
 return {view:'console.issues',scope:scopeOf(p),as_of:asOf,
  counts:{leader_queue:sections.leader_queue.rows.length,external_intake:sections.external_intake.rows.length,escalated_repairs:sections.escalated_repairs.rows.length,drift:sections.drift.rows.length},
  sections,authority:'PRIMARY_OBSERVATION',activity_is_qualified_progress:false};
}

/** The primary leader and every feature manager of the run, from agent_sessions, with what each is carrying. */
export async function leadersPanel(tx:Session,p:Principal,options:PanelOptions={}):Promise<LeadersPanel>{
 const limit=options.limit??DEFAULT_LIMIT,maxAge=options.max_observation_age_seconds??OBSERVATION_MAX_AGE_SECONDS,asOf=await clock(tx),scope=[p.organisation_id,p.run_id];
 const primary=(await tx.query('SELECT leader_session_id,generation,authority_epoch FROM hyperfide.hierarchy_leaders WHERE organisation_id=$1 AND run_id=$2',scope)).rows[0];
 const sessions=(await tx.query(`SELECT s.* FROM hyperfide.agent_sessions s WHERE s.organisation_id=$1 AND s.run_id=$2 AND s.role IN ('LEADER','FEATURE_MANAGER')
  AND ($3::boolean OR s.state IN ('REGISTERED','RUNNING','DISCONNECTED') OR s.id IS NOT DISTINCT FROM $4::uuid)
  ORDER BY (s.id IS NOT DISTINCT FROM $4::uuid) DESC,s.role,s.created_at,s.id LIMIT $5`,[...scope,options.include_ended===true,primary?.leader_session_id??null,limit+1])).rows;
 const shown=sessions.slice(0,limit),scoped=[...scope,shown.map(s=>s.id as string)];
 const packages=group((await tx.query('SELECT id,package_key,wave,revision,manager_session_id FROM hyperfide.feature_packages WHERE organisation_id=$1 AND run_id=$2 AND manager_session_id=ANY($3::uuid[]) ORDER BY wave,package_key,revision',scoped)).rows,r=>String(r.manager_session_id));
 const children=group((await tx.query('SELECT parent_session_id,role,state,count(*)::int AS n FROM hyperfide.agent_sessions WHERE organisation_id=$1 AND run_id=$2 AND parent_session_id=ANY($3::uuid[]) GROUP BY 1,2,3 ORDER BY 1,2,3',scoped)).rows,r=>String(r.parent_session_id));
 const asks=new Map((await tx.query(`SELECT a.session,count(*)::int AS n FROM hyperfide.asks a WHERE a.organisation_id=$1 AND a.run_id=$2 AND a.session=ANY($3::uuid[]) AND ${WAITING_ASK} GROUP BY a.session`,scoped)).rows.map(r=>[String(r.session),r.n]));
 const intents=new Map((await tx.query(`SELECT c.result->>'target_session_id' AS target,count(*)::int AS n FROM hyperfide.command_inbox c WHERE c.organisation_id=$1 AND c.run_id=$2 AND ${PENDING_INTENT} AND c.result->>'target_session_id'=ANY($3::text[]) GROUP BY 1`,scoped)).rows.map(r=>[String(r.target),r.n]));
 const observed=new Map((await tx.query("SELECT entity_id,observed_state,observed_at,received_at,activity_bytes FROM hyperfide.observability_observations WHERE organisation_id=$1 AND run_id=$2 AND entity_type='SESSION' AND entity_id=ANY($3::uuid[])",scoped)).rows.map(r=>[String(r.entity_id),r]));
 const launches=new Map((await tx.query('SELECT DISTINCT ON (session_id) session_id,id,state,host_id,observed_at,created_at FROM hyperfide.supervisor_launches WHERE organisation_id=$1 AND run_id=$2 AND session_id=ANY($3::uuid[]) ORDER BY session_id,created_at DESC,id',scoped)).rows.map(r=>[String(r.session_id),r]));
 let stale=0;
 const rows=shown.map((s):ConsoleRow=>{
  const o=observed.get(s.id),l=launches.get(s.id),isPrimary=primary?.leader_session_id===s.id;
  const newest=([[o?.observed_at,'hyperfide.observability_observations'],[l?.observed_at,'hyperfide.supervisor_launches']] as [unknown,string][])
   .filter(c=>c[0]!=null).sort((a,b)=>Date.parse(iso(b[0])!)-Date.parse(iso(a[0])!))[0];
  // A session nothing has observed yet is dated by its registration, so it turns stale once that is older than the bound;
  // an ended session is expected to fall silent, so only live sessions can be stale.
  const freshness=fresh(asOf,newest?.[0]??s.created_at,newest?.[1]??'hyperfide.agent_sessions',maxAge);
  if(s.state==='STOPPED'||s.state==='FAILED')freshness.stale=false;
  if(freshness.stale)stale++;
  return {kind:'LEADER',id:s.id,state:s.state,title:(isPrimary?'Primary leader':s.role==='LEADER'?'Leader':'Feature manager')+' '+s.connector+'/'+s.native_session_id,
   since:iso(s.created_at)!,freshness,
   references:refs({session_id:s.id,parent_session_id:s.parent_session_id,attempt_id:s.attempt_id,sandbox_id:s.sandbox_id,slot_id:s.slot_id,launch_id:l?.id,native_session_id:s.native_session_id}),
   detail:{role:s.role,primary:isPrimary,leader_generation:isPrimary?String(primary!.generation):null,connector:s.connector,account_key:s.account_key,
    sandbox_boot_generation:str(s.sandbox_boot_generation),state_version:String(s.state_version),
    observation:o?{observed_state:o.observed_state,observed_at:iso(o.observed_at),received_at:iso(o.received_at),activity_bytes:String(o.activity_bytes)}:null,
    launch:l?{state:l.state,host_id:l.host_id,observed_at:iso(l.observed_at)}:null,
    packages:(packages.get(s.id)??[]).map(k=>({package_id:k.id,package_key:k.package_key,wave:k.wave,revision:String(k.revision)})),
    children:(children.get(s.id)??[]).map(c=>({role:c.role,state:c.state,count:c.n})),open_asks:asks.get(s.id)??0,pending_human_intents:intents.get(s.id)??0}};
 });
 return {view:'console.leaders',scope:scopeOf(p),as_of:asOf,max_observation_age_seconds:maxAge,
  primary_leader:primary?{session_id:primary.leader_session_id,generation:String(primary.generation),authority_epoch:primary.authority_epoch}:null,
  counts:{leaders:rows.filter(r=>r.detail.role==='LEADER').length,feature_managers:rows.filter(r=>r.detail.role==='FEATURE_MANAGER').length,stale},
  truncated:sessions.length>limit,rows,authority:'PRIMARY_OBSERVATION',activity_is_qualified_progress:false};
}

function consoleReader(p:Principal,roles=CONSOLE_ROLES):void{
 if(!roles.includes(p.role))fail('CONSOLE_FORBIDDEN',roles===CONSOLE_ROLES?'The console is for operators, coordinators, leaders and the provisioner':'Needs and Issues are for operators, coordinators and the leader');
}
function panelOptions(input:unknown,extra:string[]=[]):PanelOptions{
 const i=object(input??{},['run_id','limit','max_observation_age_seconds',...extra]);
 if(i.include_ended!==undefined&&typeof i.include_ended!=='boolean')fail('OBSERVABILITY_INPUT_INVALID','include_ended must be a boolean');
 return {limit:i.limit===undefined?DEFAULT_LIMIT:integer(i.limit,1,MAX_LIMIT),
  max_observation_age_seconds:i.max_observation_age_seconds===undefined?OBSERVATION_MAX_AGE_SECONDS:integer(i.max_observation_age_seconds,1,3600),
  include_ended:i.include_ended===true};
}

export function createComponent(startup:ComponentContext):Component{
 const actions:Component['actions']={
  'console.sandboxes':(input,ctx)=>authority(ctx,'console.sandboxes',(tx,p)=>{
   const i=object(input??{},['run_id','limit']);consoleReader(p);
   return sandboxInventory(tx,p.organisation_id,{limit:i.limit===undefined?DEFAULT_LIMIT:integer(i.limit,1,MAX_LIMIT)});
  }),
  'console.needs':(input,ctx)=>authority(ctx,'console.needs',async(tx,p)=>{const o=panelOptions(input);consoleReader(p,HUMAN_ROLES);return numbers(await needsPanel(tx,p,o));}),
  'console.issues':(input,ctx)=>authority(ctx,'console.issues',async(tx,p)=>{const o=panelOptions(input);consoleReader(p,HUMAN_ROLES);return numbers(await issuesPanel(tx,{principal:p,context:ctx??startup},o));}),
  'console.leaders':(input,ctx)=>authority(ctx,'console.leaders',async(tx,p)=>{const o=panelOptions(input,['include_ended']);consoleReader(p);return numbers(await leadersPanel(tx,p,o));}),
  // Registration point for further console views (5.4 adds console.metrics here): one entry, behind authority() and consoleReader().
 };
 return {apiVersion:1,actions};
}
