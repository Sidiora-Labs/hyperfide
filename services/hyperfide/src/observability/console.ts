// Operator console read model (hyperfide-v21 req 5). Read-only: every row is an observation
// with its own freshness, never an authority to place, admit, resolve or delete.
import type {Component,ComponentContext} from '../components/registry.js';
import {authority,fail,integer,numbers,object} from './views.js';
import type {Principal,Session} from './views.js';
import {classifySandbox,RUNNER_HEARTBEAT_MAX_AGE_SECONDS} from '../providers/placement.js';
import type {SandboxLiveness} from '../providers/placement.js';

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

function consoleReader(p:Principal):void{
 if(!CONSOLE_ROLES.includes(p.role))fail('CONSOLE_FORBIDDEN','The console is for operators, coordinators, leaders and the provisioner');
}

export function createComponent(_startup:ComponentContext):Component{return{apiVersion:1,actions:{
 'console.sandboxes':(input,ctx)=>authority(ctx,'console.sandboxes',(tx,p)=>{
  const i=object(input??{},['run_id','limit']);consoleReader(p);
  return sandboxInventory(tx,p.organisation_id,{limit:i.limit===undefined?DEFAULT_LIMIT:integer(i.limit,1,MAX_LIMIT)});
 }),
}};}
