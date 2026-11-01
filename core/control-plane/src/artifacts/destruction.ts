import {createHash,createPublicKey,verify} from 'node:crypto';
import type {ComponentContext} from '../components/registry.js';
import {assertPrimaryTransaction} from '../storage/transactions.js';
import type {ProviderDestructionPreflight} from '../providers/pools.js';
import {isProviderIntentCapability} from '../providers/reconcile.js';
import {FoundationError,object} from '../policy/programme.js';
import {hash} from '../transport/protocol.js';
import {runnerCanonical,runnerResultSigningBytes} from '../runner/bridge.js';
import type {PrimaryTransaction} from '../storage/transactions.js';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function uuid(value:string):void{if(typeof value!=='string'||!UUID.test(value))throw new FoundationError('DESTRUCTION_SCOPE_INVALID','Canonical destruction scope is required');}
type Data=Record<string,any>;
async function readClosedWork(tx:PrimaryTransaction,input:Parameters<ProviderDestructionPreflight>[1],boot:Data):Promise<unknown|null>{
 const values=[input.organisation_id,input.sandbox_id],roots=new Set<string>(),expected=new Map<string,string>(),proofs:unknown[]=[],archives:Data[]=[];
 const attempts=(await tx.query('SELECT *,sandbox_boot_generation::text AS boot_generation,generation::text FROM hyperfide.attempts WHERE organisation_id=$1 AND sandbox_id=$2 ORDER BY id FOR SHARE',values)).rows;
 if(!attempts.length||attempts.some(a=>a.run_id!==input.run_id||a.boot_generation!==input.boot_generation||a.kind!=='IMPLEMENTATION'||!['RELEASED','REVOKED'].includes(a.compute_authority)||!['SUBMITTED','SUCCEEDED','FAILED','CANCELLED'].includes(a.execution_state)))return null;
 const sessions=(await tx.query('SELECT *,sandbox_boot_generation::text AS boot_generation FROM hyperfide.agent_sessions WHERE organisation_id=$1 AND sandbox_id=$2 ORDER BY id FOR SHARE',values)).rows;
 if(sessions.some(a=>a.run_id!==input.run_id||a.boot_generation!==input.boot_generation||!['STOPPED','FAILED'].includes(a.state)))return null;
 const workspaces=(await tx.query('SELECT *,sandbox_boot_generation::text AS boot_generation,attempt_generation::text FROM hyperfide.workspaces WHERE organisation_id=$1 AND sandbox_id=$2 ORDER BY id FOR SHARE',values)).rows;
 if(workspaces.some(w=>w.run_id!==input.run_id||w.boot_generation!==input.boot_generation||!attempts.some(a=>a.id===w.attempt_id&&a.generation===w.attempt_generation)))return null;
 const held=(await tx.query(`SELECT EXISTS(SELECT 1 FROM hyperfide.compute_leases l JOIN hyperfide.attempts a ON a.organisation_id=l.organisation_id AND a.run_id=l.run_id AND a.id=l.attempt_id WHERE a.organisation_id=$1 AND a.sandbox_id=$2 AND l.state='ACTIVE') OR EXISTS(SELECT 1 FROM hyperfide.slot_allocations WHERE organisation_id=$1 AND sandbox_id=$2 AND state='ACTIVE') OR EXISTS(SELECT 1 FROM hyperfide.resource_job_allocations WHERE organisation_id=$1 AND sandbox_id=$2 AND state='ACTIVE') OR EXISTS(SELECT 1 FROM hyperfide.identity_principals WHERE organisation_id=$1 AND sandbox_id=$2 AND role<>'RUNNER' AND state='ACTIVE') AS held`,values)).rows[0];
 if(held?.held!==false)return null;
 const slotAllocations=(await tx.query('SELECT id,run_id,attempt_id,attempt_generation::text,sandbox_boot_generation::text,slot_id,state FROM hyperfide.slot_allocations WHERE organisation_id=$1 AND sandbox_id=$2 ORDER BY id FOR SHARE',values)).rows;
 if(slotAllocations.some(v=>v.run_id!==input.run_id||v.sandbox_boot_generation!==input.boot_generation||!attempts.some(a=>a.id===v.attempt_id&&a.generation===v.attempt_generation&&a.slot_id===v.slot_id)))return null;
 const jobAllocations=(await tx.query('SELECT id,run_id,assignee_session_id,sandbox_boot_generation::text,state FROM hyperfide.resource_job_allocations WHERE organisation_id=$1 AND sandbox_id=$2 ORDER BY id FOR SHARE',values)).rows;
 if(jobAllocations.some(v=>v.run_id!==input.run_id||v.sandbox_boot_generation!==input.boot_generation||!sessions.some(s=>s.id===v.assignee_session_id)))return null;
 proofs.push({slot_allocations:slotAllocations,job_allocations:jobAllocations});
 const runnerWorkspaces=(await tx.query('SELECT *,boot_generation::text FROM hyperfide.runner_workspaces WHERE organisation_id=$1 AND sandbox_id=$2 ORDER BY slot_id FOR SHARE',values)).rows;
 if(!runnerWorkspaces.length||runnerWorkspaces.some(w=>w.run_id!==input.run_id||w.boot_generation!==input.boot_generation||w.state!=='FREE'||w.launch_id!==null||w.command_id!==null||w.process_residue!=='ABSENT'||w.credential_residue!=='ABSENT'||w.outputs_durable!==true||typeof w.residue_evidence_digest!=='string'))return null;
 const add=(id:unknown,digest?:unknown):boolean=>{if(typeof id!=='string'||!UUID.test(id)||digest!==undefined&&(typeof digest!=='string'||!/^sha256:[0-9a-f]{64}$/.test(digest)))return false;roots.add(id);if(typeof digest==='string'){if(expected.has(id)&&expected.get(id)!==digest)return false;expected.set(id,digest);}return true;};
 for(const attempt of attempts){
  const custodies=(await tx.query(`SELECT c.*,c.source_generation::text,s.manifest,s.source_artifact_id,s.evidence_artifact_id FROM hyperfide.submission_custodies c JOIN hyperfide.assurance_submissions s ON s.organisation_id=c.organisation_id AND s.run_id=c.run_id AND s.custody_id=c.id WHERE c.organisation_id=$1 AND c.run_id=$2 AND c.source_attempt_id=$3 AND c.source_generation=$4 ORDER BY c.custody_generation FOR SHARE OF c,s`,[input.organisation_id,input.run_id,attempt.id,attempt.generation])).rows;
  if(!custodies.length)return null;
  for(const custody of custodies){
   const m=custody.manifest;
   if(!object(m)||!['ACTIVE','RELEASED','SUPERSEDED'].includes(custody.authority)||m.attempt_id!==attempt.id||String(m.attempt_generation)!==attempt.generation||m.sandbox_id!==input.sandbox_id||String(m.sandbox_boot_generation)!==input.boot_generation||m.slot_id!==attempt.slot_id||m.repository_id!==custody.repository_id||m.source_object_id!==custody.source_object_id||m.source_manifest_digest!==custody.source_manifest_digest||!Array.isArray(m.evidence_artifact_ids)||!m.evidence_artifact_ids.length||m.evidence_artifact_ids.length>4096)return null;
   if(!add(custody.source_artifact_id,custody.source_manifest_digest)||!add(custody.evidence_artifact_id,custody.evidence_manifest_digest)||m.evidence_artifact_ids.some(id=>!add(id)))return null;
   const captured=(await tx.query(`SELECT * FROM hyperfide.fleet_source_archive_custodies WHERE organisation_id=$1 AND run_id=$2 AND custody_id=$3 AND custody_generation=$4 AND attempt_id=$5 AND attempt_generation=$6 AND sandbox_id=$7 AND boot_id=$8 AND boot_generation=$9 AND workspace_id=$10 ORDER BY captured_at DESC LIMIT 1 FOR SHARE`,[input.organisation_id,input.run_id,custody.id,String(custody.custody_generation),attempt.id,attempt.generation,input.sandbox_id,boot.boot_id,input.boot_generation,m.workspace_id])).rows[0];
   if(captured){
    const measured=(await tx.query(`SELECT q.publication,r.workspace_path FROM hyperfide.fleet_runtime_readiness q JOIN hyperfide.runner_registry r ON r.organisation_id=q.organisation_id AND r.run_id=q.run_id AND r.session_id=q.runner_session_id AND r.readiness_digest=q.readiness_digest WHERE q.organisation_id=$1 AND q.run_id=$2 AND q.sandbox_id=$3 AND q.boot_id=$4 AND q.boot_generation=$5 AND q.slot_id=$6 AND q.publication->>'id'=$7 FOR SHARE OF q,r`,[input.organisation_id,input.run_id,input.sandbox_id,boot.boot_id,input.boot_generation,attempt.slot_id,m.workspace_id])).rows;
    const measuredRow=measured[0],publication=measuredRow?.publication;if(!measuredRow||measured.length!==1||!object(publication)||!object(publication.readiness_input)||!object(publication.readiness_input.slot)||publication.readiness_input.slot.source!==measuredRow.workspace_path)return null;
    const binding=captured.binding,receipt=captured.capture_receipt;
    if(!object(binding)||!object(receipt)||receipt.kind!=='FLEET_SOURCE_ARCHIVE_CAPTURE_RECEIPT_V1'||receipt.source_sealed!==true||receipt.observed_process_absent!==true||runnerCanonical(receipt.binding)!==runnerCanonical(binding)||receipt.archive_digest!==captured.archive_digest||receipt.size_bytes!==String(captured.archive_size_bytes)||receipt.inventory_digest!==captured.inventory_digest||binding.custody_id!==custody.id||String(binding.custody_generation)!==String(custody.custody_generation)||binding.attempt_id!==attempt.id||String(binding.attempt_generation)!==attempt.generation||binding.sandbox_id!==input.sandbox_id||binding.boot_id!==boot.boot_id||String(binding.boot_generation)!==input.boot_generation||binding.workspace_id!==m.workspace_id||binding.slot_id!==attempt.slot_id||!add(captured.archive_artifact_id,captured.archive_artifact_digest)||!add(captured.capture_receipt_artifact_id,captured.capture_receipt_artifact_digest))return null;
    const retained=(await tx.query('SELECT artifact_id,artifact_digest FROM hyperfide.fleet_source_archive_artifacts WHERE organisation_id=$1 AND run_id=$2 AND archive_id=$3 ORDER BY artifact_id FOR SHARE',[input.organisation_id,input.run_id,captured.id])).rows;
    if(!retained.length||retained.some(v=>!add(v.artifact_id,v.artifact_digest)))return null;
    archives.push(captured);proofs.push({custody_id:custody.id,custody_generation:String(custody.custody_generation),authority:custody.authority,source_archive_id:captured.id,archive_digest:captured.archive_digest,inventory_digest:captured.inventory_digest});
   }else{
    if(!workspaces.some(w=>w.id===m.workspace_id&&w.attempt_id===attempt.id))return null;
    const checkpoints=(await tx.query(`SELECT id,artifact_id,artifact_content_digest,source_metadata_digest,source_workspace_id,source_manifest,created_at FROM hyperfide.checkpoints WHERE organisation_id=$1 AND run_id=$2 AND attempt_id=$3 AND attempt_generation=$4 AND repository_id=$5 AND source_object_id=$6 AND source_workspace_id=$7 AND registration_kind='LIVE' AND registration_operation_id IS NOT NULL ORDER BY created_at DESC LIMIT 1 FOR SHARE`,[input.organisation_id,input.run_id,attempt.id,attempt.generation,custody.repository_id,custody.source_object_id,m.workspace_id])).rows;
    const checkpoint=checkpoints[0];
    if(!checkpoint||!object(checkpoint.source_manifest)||checkpoint.source_manifest.attempt_id!==attempt.id||checkpoint.source_manifest.workspace_id!==m.workspace_id||checkpoint.source_manifest.head_commit!==custody.source_object_id||!add(checkpoint.artifact_id))return null;
    const contexts=(await tx.query('SELECT artifact_id,artifact_digest FROM hyperfide.checkpoint_context_artifacts WHERE organisation_id=$1 AND run_id=$2 AND checkpoint_id=$3 ORDER BY role FOR SHARE',[input.organisation_id,input.run_id,checkpoint.id])).rows;
    if(contexts.length!==3||contexts.some(c=>!add(c.artifact_id,c.artifact_digest)))return null;
    proofs.push({custody_id:custody.id,custody_generation:String(custody.custody_generation),authority:custody.authority,checkpoint_id:checkpoint.id,source_digest:custody.source_manifest_digest,evidence_digest:custody.evidence_manifest_digest});
   }
  }
  const launches=(await tx.query('SELECT * FROM hyperfide.native_launch_plans WHERE organisation_id=$1 AND run_id=$2 AND attempt_id=$3 AND attempt_generation=$4 ORDER BY created_at FOR SHARE',[input.organisation_id,input.run_id,attempt.id,attempt.generation])).rows;
  if(!launches.length)return null;
  for(const launch of launches){
   const commands=(await tx.query('SELECT * FROM hyperfide.runner_control_commands WHERE organisation_id=$1 AND run_id=$2 AND launch_id=$3 ORDER BY fence_sequence DESC LIMIT 1 FOR SHARE',[input.organisation_id,input.run_id,launch.launch_id])).rows;
   const c=commands[0],rw=runnerWorkspaces.find(w=>w.slot_id===launch.slot_id);
   if(!c||!rw||c.state!=='REPORTED'||!['runner.stop','runner.cancel','runner.drain'].includes(c.action)||!['STOPPED','CANCELLED','DRAINED'].includes(c.outcome)||c.termination!=='CONFIRMED'||c.cleanup_complete!==true||c.attempt_id!==attempt.id||String(c.attempt_generation)!==attempt.generation||c.sandbox_id!==input.sandbox_id||c.boot_id!==boot.boot_id||String(c.boot_generation)!==input.boot_generation||c.slot_id!==attempt.slot_id||!object(c.report)||hash(runnerCanonical(c.report))!==c.report_digest||c.report.remaining_descendants!==0||c.report.cleanup_complete!==true||!Array.isArray(c.report.cleanup_debt)||c.report.cleanup_debt.length||!Array.isArray(c.report.credential_revocation)||c.report.credential_revocation.some((v:Data)=>v.state==='UNRESOLVED')||new Date(rw.updated_at).getTime()<new Date(c.reported_at).getTime()||!sessions.some(s=>s.id===launch.agent_session_id&&s.attempt_id===attempt.id&&s.slot_id===attempt.slot_id))return null;
   const captures=(await tx.query('SELECT * FROM hyperfide.runner_output_captures WHERE organisation_id=$1 AND run_id=$2 AND command_id=$3 ORDER BY name FOR SHARE',[input.organisation_id,input.run_id,c.command_id])).rows;
   if(!Array.isArray(c.required_outputs)||!c.required_outputs.includes('launch.stdout')||!c.required_outputs.includes('launch.stderr')||c.required_outputs.some((name:string)=>!captures.some(v=>v.name===name&&v.state==='COMPLETE'))||captures.some(v=>v.state!=='COMPLETE'||!add(v.manifest_artifact_id,v.manifest_digest)))return null;
   const fleet=(await tx.query(`SELECT f.*,p.role AS executor_role,p.public_key_b64 FROM hyperfide.fleet_worker_launches f LEFT JOIN hyperfide.identity_principals p ON p.credential_id=f.executor_credential_id WHERE f.organisation_id=$1 AND f.run_id=$2 AND f.launch_id=$3 FOR SHARE OF f`,[input.organisation_id,input.run_id,launch.launch_id])).rows[0];
   const boundArchives=archives.filter(a=>a.attempt_id===attempt.id&&a.launch_id===launch.launch_id);
   if(boundArchives.length||launch.plan?.readiness?.kind==='FLEET_MANIFEST_V1'){
    if(!fleet||fleet.state!=='COMPLETED'||fleet.executor_role!=='PROVISIONER'||!object(fleet.result)||hash(runnerCanonical(fleet.result))!==fleet.result_digest||!object(fleet.result.native)||fleet.result.native.terminal_observed!==true||fleet.result.native.foreground_owner!==true||fleet.result.launch_id!==launch.launch_id||fleet.result.command_id!==launch.command_id||hash(runnerCanonical(fleet.request))!==fleet.request_digest||typeof fleet.result_signature!=='string'||typeof fleet.public_key_b64!=='string')return null;
    const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(fleet.public_key_b64,'base64url')]),format:'der',type:'spki'});
    if(!verify(null,Buffer.from(runnerCanonical(fleet.result)),key,Buffer.from(fleet.result_signature,'base64url')))return null;
    for(const ref of [fleet.result.stdout,fleet.result.stderr])if(!object(ref)||!add(ref.artifact_id,ref.digest))return null;
   }
   for(const archive of boundArchives){
    if(archive.command_id!==c.command_id||archive.binding.command_id!==c.command_id||archive.binding.report_digest!==c.report_digest||archive.binding.quiescence_receipt_digest!==c.report.receipt_digest||archive.binding.native_launch_plan_digest!==hash(runnerCanonical(launch.plan))||archive.binding.session_id!==launch.agent_session_id||archive.binding.captured_result_digest!==fleet?.result_digest||new Date(archive.captured_at).getTime()<new Date(c.reported_at).getTime())return null;
   }
   proofs.push({attempt_id:attempt.id,launch_id:launch.launch_id,command_id:c.command_id,fence_sequence:String(c.fence_sequence),report_digest:c.report_digest,residue_evidence_digest:rw.residue_evidence_digest});
  }
 }
 if(archives.some(a=>!proofs.some((p:any)=>p.launch_id===a.launch_id&&p.command_id===a.command_id)))return null;
 const remote=(await tx.query('SELECT * FROM hyperfide.provider_remote_operations WHERE organisation_id=$1 AND sandbox_id=$2 ORDER BY id FOR SHARE',values)).rows;
 if(remote.some(v=>v.run_id!==input.run_id||String(v.boot_generation)!==input.boot_generation||v.state!=='OBSERVED'||v.process_claimed&&(v.outcome?.status!=='SUCCEEDED'||v.outcome?.result?.phase!=='EXITED')))return null;
 const jobs=(await tx.query(`SELECT j.*,p.role AS executor_role,p.public_key_b64 FROM hyperfide.runner_remote_jobs j JOIN hyperfide.runner_registry r ON r.organisation_id=j.organisation_id AND r.run_id=j.run_id AND r.session_id=j.session_id LEFT JOIN hyperfide.identity_principals p ON p.credential_id=j.executor_credential_id WHERE r.organisation_id=$1 AND r.sandbox_id=$2 ORDER BY j.operation_id FOR SHARE OF j,r`,values)).rows;
 for(const job of jobs){
  const result=job.result;
  if(job.run_id!==input.run_id||job.state!=='COMPLETED'||job.executor_role!=='PROVISIONER'||!object(result)||!object(job.plan)||hash(runnerCanonical(job.plan))!==job.plan_digest||hash(runnerCanonical(result))!==job.result_digest||result.sandbox_id!==input.sandbox_id||result.boot_id!==boot.boot_id||String(result.boot_generation)!==input.boot_generation||result.cleanup_status!=='CONFIRMED'||!object(result.cleanup)||result.cleanup.complete!==true||result.cleanup.observed_process_absent!==true||typeof job.public_key_b64!=='string'||typeof job.result_signature!=='string')return null;
  const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(job.public_key_b64,'base64url')]),format:'der',type:'spki'});
  if(!verify(null,runnerResultSigningBytes(input.organisation_id,input.run_id,job.operation_id,job.plan_digest,job.result_digest),key,Buffer.from(job.result_signature,'base64url')))return null;
  for(const ref of [result.stdout,result.stderr,result.native_receipt,...(Array.isArray(result.artifacts)?result.artifacts:[])])if(!object(ref)||!add(ref.artifact_id,ref.digest))return null;
  proofs.push({operation_id:job.operation_id,plan_digest:job.plan_digest,result_digest:job.result_digest});
 }
 const unbound=sessions.filter(s=>!s.attempt_id);
 if(unbound.some(s=>s.connector!=='hyperfide-native'||!jobs.some(j=>j.session_id===s.id)))return null;
 const artifacts=(await tx.query(`WITH RECURSIVE closure(id) AS (SELECT unnest($3::uuid[]) UNION SELECT d.child_artifact_id FROM hyperfide.artifact_dependencies d JOIN closure c ON c.id=d.parent_artifact_id WHERE d.organisation_id=$1 AND d.run_id=$2) SELECT a.id,a.digest,a.size_bytes::text,a.storage_backend,a.storage_key,a.status,a.completed_at FROM hyperfide.artifacts a JOIN closure c ON c.id=a.id WHERE a.organisation_id=$1 AND a.run_id=$2 ORDER BY a.id LIMIT 100001 FOR SHARE OF a`,[input.organisation_id,input.run_id,[...roots]])).rows;
 if(artifacts.length>100000||[...roots].some(id=>!artifacts.some(a=>a.id===id))||artifacts.some(a=>a.status!=='COMPLETE'||a.storage_backend!=='s3-v1'||!a.completed_at||!a.storage_key||expected.has(a.id)&&expected.get(a.id)!==a.digest))return null;
 return {kind:'CLOSED_WORK_SANDBOX',attempts:attempts.map(a=>({id:a.id,generation:a.generation,compute_authority:a.compute_authority})),proofs,artifacts:artifacts.map(a=>({id:a.id,digest:a.digest,size_bytes:a.size_bytes}))};
}
/** Read-only custody proof. A worked boot needs a separately sealed current
 * workspace/checkpoint closure; an older checkpoint cannot prove no later edits. */
export const readArtifactDestructionPreflight:ProviderDestructionPreflight=async(tx,input)=>{
 assertPrimaryTransaction(tx);
 uuid(input.organisation_id);uuid(input.run_id);uuid(input.sandbox_id);uuid(input.operation_id);
 if(typeof input.boot_generation!=='string'||!/^[1-9][0-9]{0,18}$/.test(input.boot_generation)||BigInt(input.boot_generation)>9223372036854775807n)
  throw new FoundationError('DESTRUCTION_SCOPE_INVALID','Canonical current boot is required');
 const result=await tx.query<{id:string;pool_id:string;native_sandbox_id:string|null;boot_generation:string;work_admitted:boolean;boot_id:string;authority_epoch:string}>(
  'SELECT s.id,s.pool_id,s.native_sandbox_id,s.boot_generation::text,s.work_admitted,b.boot_id,r.authority_epoch FROM hyperfide.sandboxes s JOIN hyperfide.sandbox_boots b ON b.organisation_id=s.organisation_id AND b.sandbox_id=s.id AND b.boot_generation=s.boot_generation JOIN hyperfide.runs r ON r.organisation_id=s.organisation_id AND r.id=$2 WHERE s.organisation_id=$1 AND s.id=$3 AND s.boot_generation=$4 FOR UPDATE OF s FOR SHARE OF b,r',
  [input.organisation_id,input.run_id,input.sandbox_id,input.boot_generation]);
 const row=result.rows[0];if(!row||!row.native_sandbox_id)return null;
 const history=await tx.query<{worked:boolean}>(
  'SELECT EXISTS(SELECT 1 FROM hyperfide.attempts WHERE organisation_id=$1 AND sandbox_id=$2) OR EXISTS(SELECT 1 FROM hyperfide.workspaces WHERE organisation_id=$1 AND sandbox_id=$2) OR EXISTS(SELECT 1 FROM hyperfide.agent_sessions WHERE organisation_id=$1 AND sandbox_id=$2) OR EXISTS(SELECT 1 FROM hyperfide.provider_remote_operations WHERE organisation_id=$1 AND sandbox_id=$2) AS worked',
  [input.organisation_id,input.sandbox_id]);
 const closed=history.rows[0]?.worked===false&&!row.work_admitted?null:await readClosedWork(tx,input,row);
 if((history.rows[0]?.worked!==false||row.work_admitted)&&!closed)return null;
 const clock=await tx.query<{observed_at:Date}>('SELECT clock_timestamp() AS observed_at');
 const observed=clock.rows[0]?.observed_at;if(!(observed instanceof Date)||!Number.isFinite(observed.getTime()))throw new FoundationError('DESTRUCTION_PRIMARY_CLOCK_INVALID','Current primary clock is unavailable');
 const binding={schema_version:1,kind:closed?'CLOSED_WORK_SANDBOX':'NEVER_WORKED_SANDBOX',organisation_id:input.organisation_id,run_id:input.run_id,sandbox_id:input.sandbox_id,boot_generation:input.boot_generation,boot_id:row.boot_id,native_sandbox_id:row.native_sandbox_id,pool_id:row.pool_id,authority_epoch:row.authority_epoch,operation_id:input.operation_id,...(closed?{closure:closed}:{work_admitted:false,historical_attempts:false,historical_workspaces:false,historical_sessions:false,historical_remote_operations:false})};
 return {evidence_digest:'sha256:'+createHash('sha256').update(JSON.stringify(binding)).digest('hex'),observed_at:observed.toISOString()};
};
export function registerArtifactDestructionPreflight(context:ComponentContext):void{
 const provider=context.dependencies.require('8.3','provider.intents.v1',isProviderIntentCapability);
 const release=provider.registerDestructionPreflight(readArtifactDestructionPreflight);
 if(context.signal.aborted)release();else context.signal.addEventListener('abort',release,{once:true});
}
