import {fleetReadinessDigest} from '../preparation/fleet_readiness_contract.js';
import {resolveFleetPreparationAccountingTask} from '../preparation/fleet_preparation_anchor.js';
import {readFleetSandboxOccupancy} from './fleet_sandbox_budget.js';
import {isArtifactStoreCapability} from '../artifacts/objects.js';
import {assuranceBarrier} from '../assurance/submission.js';
import {prepareManagerTestJob,retainManagerTestJob,validateManagerTestArtifacts} from '../providers/test_job_binding.js';
import {fleetBootstrapSupport,readFleetBootstrapRecipe} from '../providers/bootstrap.js';
import {readDeployment,currentPool} from '../providers/pools.js';
import {randomUUID} from 'node:crypto';
import type {Component,ComponentContext} from '../components/registry.js';
import type {InvocationContext} from '../transport/protocol.js';
import {assertInvocation} from '../transport/protocol.js';
import type {PrimaryTransaction} from '../storage/transactions.js';
import {identityTransaction} from '../identity/enrollment.js';
import {withAdmittedDecision,getFleetDelegation} from '../agents/fleet_authority.js';
import {validateDecision} from '../contracts/fleet/index.mjs';
import {isProviderIntentCapability} from '../providers/reconcile.js';
import {reserveDynamic} from './resources.js';
import {fields,object,uuid,decimal,dimensions,dispatchRecipients,applyExecutionControl,fail} from './claim.js';
import {assignFleetWorker,prepareSelectedFleetAssignment,controlFleetWorker,type FleetPacketFactory,type FleetManagerBinding} from '../runner/fleet.js';
import {issue} from '../events/instructions.js';
import type {WorkerRegistrationAuthority} from '../hierarchy/adoption.js';

export const MANAGER_ACTION_CONTRACTS={
 'fleet.install.adopt':{required:['install_operation_id','previous_adoption_id','admission_digest','receipt_digest','input_digest','handoff_id','runner_operation_id','runner_result_digest'],description:'Adopt an existing pinned install after manager or cohort recovery through the shared installer authority. Pin the exact predecessor and immutable admission/receipt or completed runner evidence; this never starts replacement execution.'},
 'fleet.install.admit':{required:['input_digest','environment_id','environment_generation','sandbox_id','boot_id','boot_generation','ttl_seconds','slot_bindings'],optional:['recovery_of'],slot_bindings:{type:'array',coverage:'Exactly registered install_specs.workers.slots entries',items:{type:'object',additional_properties:false,required:['slot','worker_slot_id'],properties:{slot:{type:'integer',minimum:0,description:'Zero-based package worker ordinal'},worker_slot_id:{type:'string',format:'uuid',description:'Exact sandbox_runners.worker_slot_id for selected sandbox/boot'}}},engine_derived_only:['uid','gid','slot_generation','runner_session_id','source','home','build','temporary','dirty','worker_root'],description:'Send selector objects ONLY. Do not copy expanded registry/receipt metadata; the engine derives identity and filesystem fields from the exact enrolled slot.'},recovery_of:{one_of:[{type:'object',additional_properties:false,required:['install_operation_id','admission_digest','runner_operation_id','runner_plan_digest','quiescence_operation_id','quiescence_receipt_digest'],install_operation_id:'current failed install_recovery[].install_operation_id; is_current_head must be true',admission_digest:'exact predecessor install_recovery[].admission_digest',runner_operation_id:'exact corresponding install_recovery_jobs[].runner_operation_id',runner_plan_digest:'exact corresponding install_recovery_jobs[].runner_plan_digest',quiescence_operation_id:'exact nonnull install_recovery_jobs[].quiescence_operation_id; must equal runner_operation_id',quiescence_receipt_digest:'exact nonnull install_recovery_jobs[].quiescence_receipt_digest',authority:'Only a signed COMPLETED/FAILED predecessor with confirmed native cleanup and retained capture may recover. Observation fields do not grant eligibility; the authority verifies signatures, current allocation, same boot/inputs and current head. UNKNOWN or CLAIMED outcomes are reconcile-only.'},{type:'object',additional_properties:false,required:['kind','install_operation_id','admission_digest','runner_operation_id','runner_plan_digest'],properties:{kind:{const:'NOT_STARTED'},install_operation_id:{type:'string',format:'uuid'},admission_digest:{type:'string',format:'sha256'},runner_operation_id:{type:'string',format:'uuid'},runner_plan_digest:{type:'string',format:'sha256'}}},{type:'object',additional_properties:false,required:['kind','install_operation_id','admission_digest','runner_operation_id','runner_plan_digest','proof_id','proof_digest'],properties:{kind:{const:'PRE_PROVIDER_REFUSAL'},install_operation_id:{type:'string',format:'uuid'},admission_digest:{type:'string',format:'sha256'},runner_operation_id:{type:'string',format:'uuid'},runner_plan_digest:{type:'string',format:'sha256'},proof_id:{type:'string',format:'uuid'},proof_digest:{type:'string',format:'sha256'}},authority:'Requires an exact retained durable pre-provider refusal proof and permanent original-request fence; timeout or UNKNOWN alone is insufficient. Not native FAILED and not NOT_STARTED.'}]},execution_identity:'Use a fresh decision.operation_id. FAILED recovery retains its native allocation epoch. NOT_STARTED or PRE_PROVIDER_REFUSAL recovery has fresh native logical=self while the coordinator global logical root is preserved. Preserve original claims, expiries and outcomes; never replay the old execution.',description:'Admit a registered pinned environment to its exact current boot. Optional recovery_of selects exactly one of signed FAILED native quiescence, expired unclaimed NOT_STARTED evidence, or a retained fenced PRE_PROVIDER_REFUSAL proof. UNKNOWN alone requires reconciliation; verified completion still gates workers.'},
 PROVISION_SANDBOX:{required:['pool_id','provider_id','profile_id','sandbox_id','preparation_digest','deadline_at','capacity','purpose'],optional:['qualification_job','preparation_task_id'],preparation_task_id:{type:'string',format:'uuid',description:'Requires protected bootstrap install template v2. CODING preparation accounting anchor only, not a worker assignment. Select a current accepted task in this delegation. Required when more than one delegated task is available; omission may resolve only the sole current accepted delegated task. TEST uses its qualification job/custody selector instead.'},qualification_job:{required:['job_id','expected_state_version','custody_id','custody_generation'],description:'Required for a generic TEST pool. Select an observed current PENDING qualification job and custody explicitly; the engine resolves its accepted TEST profile and retained source policy. CODING does not accept this selector.'},description:'Select an approved provider/profile with a configured protected bootstrap recipe matching its declared role and requested purpose; reserve exact capacity before provider effects.'},
 REUSE_SANDBOX:{required:['sandbox_id','boot_generation','pool_id','provider_id','profile_id'],optional:['preparation_task_id'],preparation_task_id:{type:'string',format:'uuid',description:'Requires the actual retained current-boot install template v2. Current accepted delegated CODING task used only to anchor PREP accounting; does not assign a worker. Ambiguous multi-task scope requires an explicit selector.'},description:'Reuse an owned exact boot; a separate actual install receipt still gates worker assignment.'},
 ASSIGN_WORKER:{required:['install_binding'],optional:['selection','assignment','claims'],one_of:[{required:['selection','install_binding'],forbidden:['assignment','claims']},{required:['assignment','install_binding','claims'],forbidden:['selection']}],preferred_input_form:'selection',selection:{required:['task_id','expected_task_generation','worker_slot','lease_ms','max_runtime_seconds','max_output_bytes','capacity','optional_context'],task_id:'Exact delegated tasks[].id chosen by manager',expected_task_generation:'Exact tasks[].generation including zero',worker_slot:'Verified zero-based READY receipt slot',lease_ms:'1000..300000',max_runtime_seconds:'1..604800',max_output_bytes:'Nonnegative safe integer',capacity:'Explicit physical account dimensions matching tasks[].capacity_policy.worker_assignment and accepted packet policy',optional_context:'Explicit array; may be empty; source_id/digest/text pins preserved'},slot_capacity_kind:'AGENT',capacity_class:'EXECUTION',test_slots_select_worker_kind:false,build_and_test_admission:'SEPARATE_JOB',description:'Bind one isolated coding-agent task attempt to its canonical assignment, installed AGENT slot UUID and existing scheduler claim. This claim reserves AGENT, CPU, memory and disk execution capacity; build_slots/test_slots permit separate jobs and do not select a TEST slot or reserve BUILD/TEST capacity here. Independent qualification uses its own TEST allocation and sandbox. Use separate decisions for concurrent workers.'},
 STEER_WORKER:{required:['task_id','attempt_id','attempt_generation','launch_id','request_id','frame_b64'],description:'Send a bounded native instruction to the exact currently owned task attempt and launch.'},
 CANCEL_ASSIGNMENT:{required:['task_id','attempt_id','attempt_generation','launch_id'],description:'Persist exact native cancellation; result custody and unconfirmed cleanup remain retained.'},
 STOP_SANDBOX:{required:['sandbox_id','boot_generation','reason'],description:'Hold admission and issue cancellation for owned active launches; no physical disappearance is inferred.'},
 DESTROY_SANDBOX:{required:['sandbox_id','boot_generation','pool_id','deadline_at','reason'],description:'Request deletion of an owned boot, including provider-reported DESTROYED with unconfirmed absence. The API performs current ownership, active-work and custody preflight inline; the caller supplies the owned sandbox/boot/pool, deadline and reason. Capacity releases only after actual provider absence proof.'},
 REPLAN:{required:['proposal'],description:'Record proposed changes for current manager; source/task definitions and criteria are unchanged until separately accepted.'},
 COORDINATE_DEPENDENCY:{required:['recipient_package_id','consumer_ids','message'],description:'Persist coordination toward a current package; notification never grants a dependency milestone.'},
} as const;
export const MANAGER_ACTIONS=Object.keys(MANAGER_ACTION_CONTRACTS);
export interface FleetEffects {
 execute(decision:unknown,invocation:InvocationContext):Promise<Record<string,unknown>>;
 describe():{actions:typeof MANAGER_ACTION_CONTRACTS};
}
function actionInput(action:string,value:unknown):Record<string,unknown>{
 if(action==='ASSIGN_WORKER')return value!==null&&typeof value==='object'&&Object.hasOwn(value,'selection')?fields(value,['selection','install_binding']):fields(value,['assignment','install_binding','claims']);
 const contract=MANAGER_ACTION_CONTRACTS[action as keyof typeof MANAGER_ACTION_CONTRACTS];
 if(!contract)fail('FLEET_ACTION_DENIED','Unsupported manager effect');
 return fields(value,contract.required,'optional' in contract?contract.optional:[]);
}

async function binding(tx:PrimaryTransaction,i:InvocationContext,d:Record<string,unknown>):Promise<{owner:FleetManagerBinding;budget:Record<string,unknown>}>{
 if(d.actor_role!=='WAVE_MANAGER'||typeof d.delegation_id!=='string'||typeof d.manager_generation!=='string')fail('FLEET_MANAGER_REQUIRED','Provider and worker choices require a current Wave Manager');
 const delegation=await getFleetDelegation(tx,i,d as never);
 const owner:FleetManagerBinding={organisation_id:i.principal.organisation_id,run_id:i.principal.run_id,actor_id:String(d.actor_id),delegation_id:String(d.delegation_id),manager_generation:String(d.manager_generation),leader_generation:String(d.leader_generation),authority_epoch:String(d.authority_epoch),operation_id:String(d.operation_id),decision_id:String(d.decision_id),source_revision:String(d.source_revision)};
 await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['fleet-budget:'+owner.organisation_id+':'+owner.run_id+':'+owner.delegation_id]);
 const budget=delegation.budget;
 if(!Array.isArray(budget.allowed_actions)||!budget.allowed_actions.includes(d.action))fail('FLEET_ACTION_DENIED','Action is outside the manager budget envelope');
 return {owner,budget};
}
function selected(budget:Record<string,unknown>,key:string,value:unknown):void{
 if(typeof value!=='string'||!Array.isArray(budget[key])||!budget[key].includes(value))fail('FLEET_SELECTION_DENIED','Manager selected an ungranted '+key);
}
async function ownedSandbox(tx:PrimaryTransaction,b:FleetManagerBinding,sandbox:string):Promise<Record<string,unknown>>{
 const row=(await tx.query(`SELECT s.*,s.boot_generation::text AS boot_generation FROM hyperfide.sandboxes s
 WHERE s.organisation_id=$1 AND s.id=$2 AND EXISTS(SELECT 1 FROM hyperfide.fleet_effect_receipts e WHERE e.organisation_id=$1 AND e.run_id=$3
 AND e.result->>'delegation_id'=$4 AND e.result->>'sandbox_id'=s.id::text) FOR SHARE`,[b.organisation_id,uuid(sandbox,'sandbox_id'),b.run_id,b.delegation_id])).rows[0];
 if(!row)fail('FLEET_SANDBOX_SCOPE_DENIED','Sandbox has no admitted effect in this delegation');return row;
}
export function createFleetEffectsComponent(ctx:ComponentContext):Component{
 const installer=ctx.dependencies.require('fleet-install','fleet.install.v1',(v:unknown):v is {admit(decision:unknown,i:InvocationContext):Promise<Record<string,unknown>>;adopt(decision:unknown,i:InvocationContext):Promise<Record<string,unknown>>}=>!!v&&typeof (v as {admit?:unknown}).admit==='function'&&typeof (v as {adopt?:unknown}).adopt==='function');
 const workers=ctx.dependencies.require('hierarchy-worker-registration','hierarchy.worker-registration.v1',(v:unknown):v is WorkerRegistrationAuthority=>!!v&&typeof (v as WorkerRegistrationAuthority).registerAssignedWorker==='function');
 const providers=ctx.dependencies.require('8.3','provider.intents.v1',isProviderIntentCapability);
 const packets=ctx.dependencies.require('3.2','hierarchy.packets.v1',(v:unknown):v is FleetPacketFactory=>v!==null&&typeof v==='object'&&typeof (v as FleetPacketFactory).createPacketTx==='function');
 const execute: FleetEffects['execute']=async(value,i)=>{
  assertInvocation(i);
  const decision=validateDecision(value,{actions:MANAGER_ACTIONS});
  if(decision.action==='fleet.install.admit')return installer.admit(decision,i);
  if(decision.action==='fleet.install.adopt')return installer.adopt(decision,i);
  let verifiedTestArtifacts:Awaited<ReturnType<typeof validateManagerTestArtifacts>>|null=null;
  if(decision.action==='PROVISION_SANDBOX'){
   const retained=await identityTransaction({...ctx,invocation:i},async tx=>(await tx.query('SELECT 1 FROM hyperfide.fleet_effect_receipts WHERE organisation_id=$1 AND run_id=$2 AND operation_id=$3',[i.principal.organisation_id,i.principal.run_id,decision.operation_id])).rows.length>0);
   if(!retained){const input=actionInput(decision.action,decision.input);const recipe=await readFleetBootstrapRecipe(ctx.env,String(input.pool_id));if(recipe)verifiedTestArtifacts=await validateManagerTestArtifacts(i,recipe,ctx.dependencies.require('15.2','artifact.store.v1',isArtifactStoreCapability));}
  }
  return identityTransaction({...ctx,invocation:i},async(raw)=>{
   const tx=raw as PrimaryTransaction;
   if(decision.action==='PROVISION_SANDBOX')await assuranceBarrier(tx,{organisation_id:i.principal.organisation_id,run_id:i.principal.run_id},'SHARED');
   return withAdmittedDecision(tx,i,decision,decision.action,async admitted=>{
    const d=admitted as unknown as Record<string,unknown>,{owner:b,budget}=await binding(tx,i,d),scope={organisation_id:b.organisation_id,run_id:b.run_id};
    if(d.action==='PROVISION_SANDBOX'){
     const v=actionInput(String(d.action),d.input);
     selected(budget,'provider_ids',v.provider_id);selected(budget,'profile_ids',v.profile_id);
     const pool=(await tx.query('SELECT provider FROM hyperfide.provider_pools WHERE organisation_id=$1 AND id=$2 FOR SHARE',[b.organisation_id,uuid(v.pool_id,'pool_id')])).rows[0];
     if(!pool||pool.provider!==v.provider_id)fail('FLEET_PROVIDER_MISMATCH','Selected provider must own the selected pool');
     const deployment=await readDeployment(ctx.env);await currentPool(tx,deployment,String(v.pool_id));
     const support=await fleetBootstrapSupport(ctx.env,deployment,String(v.pool_id));
     if(support.status!=='CONFIGURED'||!support.supported_purposes.includes(String(v.purpose))||deployment.pools.find(p=>p.id===v.pool_id)?.profile_id!==v.profile_id||deployment.pools.find(p=>p.id===v.pool_id)?.preparation_digest!==v.preparation_digest)fail('FLEET_BOOTSTRAP_UNSUPPORTED','Selected pool lacks a matching configured native bootstrap recipe for its declared role and purpose');
     const recipe=await readFleetBootstrapRecipe(ctx.env,String(v.pool_id));
     if(!recipe)fail('FLEET_BOOTSTRAP_UNSUPPORTED','Selected pool lacks a protected bootstrap recipe');
     if(!verifiedTestArtifacts)fail('FLEET_TEST_ARTIFACT_POLICY','Protected recipe must be validated before admission');
     const testJob=await prepareManagerTestJob(tx,i,b,budget,v,recipe,verifiedTestArtifacts);
     if(support.execution_role==='TEST'&&Object.hasOwn(v,'preparation_task_id'))fail('FLEET_PREPARATION_TASK_SCOPE','TEST preparation uses its qualification job and custody task binding');
     if(Object.hasOwn(v,'preparation_task_id')&&recipe.install_template?.schema_version!==2)fail('FLEET_PREPARATION_TASK_TEMPLATE','Explicit preparation task selection requires bootstrap install template v2');
     const preparationTask=support.execution_role==='CODING'&&recipe.install_template?.schema_version===2?await resolveFleetPreparationAccountingTask(tx,i,{package_id:b.delegation_id,task_ids:budget.task_ids,...(Object.hasOwn(v,'preparation_task_id')?{preparation_task_id:v.preparation_task_id}:{})}):null;
     const occupied=(await readFleetSandboxOccupancy(tx,scope,[b.delegation_id])).get(b.delegation_id)!;
     if(!Number.isSafeInteger(budget.max_sandboxes)||occupied.occupied>=Number(budget.max_sandboxes))fail('FLEET_SANDBOX_BUDGET','Manager sandbox budget is occupied, including uncertain effects');
     const reserved=object(await reserveDynamic(tx,{...scope,pool_id:uuid(v.pool_id,'pool_id'),request_id:b.operation_id,dimensions:dimensions(v.capacity),expires_at:String(v.deadline_at)}));
     const reservations=reserved.reservations as Record<string,unknown>[];
     const prepared=object(await providers.prepareCreateTx(tx,{run_id:b.run_id,pool_id:v.pool_id,sandbox_id:v.sandbox_id,request_key:b.operation_id,deadline_at:v.deadline_at,reservation_ids:reservations.map(r=>r.id),profile_id:v.profile_id,preparation_digest:v.preparation_digest,purpose:v.purpose},i));
     const intent=object(prepared.intent);
     const qualificationJob=testJob?await retainManagerTestJob(tx,testJob,intent):null;
     return {...(qualificationJob?{qualification_job:qualificationJob}:{}),...(preparationTask?{preparation_task_id:preparationTask.task_id,preparation_task_selection:preparationTask.selection_source}:{}),kind:d.action,delegation_id:b.delegation_id,sandbox_id:v.sandbox_id,provider_intent_id:intent.id,state:intent.state,external_call_performed:false};
    }
    if(d.action==='REUSE_SANDBOX'){
     const v=actionInput(String(d.action),d.input);
     selected(budget,'provider_ids',v.provider_id);selected(budget,'profile_ids',v.profile_id);
     const s=await ownedSandbox(tx,b,String(v.sandbox_id));
     if(s.pool_id!==v.pool_id||s.boot_generation!==decimal(v.boot_generation,'boot_generation')||s.observed_state!=='RUNNING'||s.desired_state!=='RUNNING')fail('FLEET_SANDBOX_UNAVAILABLE','Reuse requires an owned current running boot');
     const retained=(await tx.query(`SELECT n.descriptor,n.descriptor_digest FROM hyperfide.provider_native_bootstraps n JOIN hyperfide.sandbox_boots boot ON boot.organisation_id=n.organisation_id AND boot.sandbox_id=n.sandbox_id AND boot.boot_generation=n.boot_generation AND boot.boot_id=n.boot_id WHERE n.organisation_id=$1 AND n.run_id=$2 AND n.sandbox_id=$3 AND n.pool_id=$4 AND n.boot_generation=$5 AND n.native_sandbox_id=$6 AND n.state='READY' ORDER BY n.id LIMIT 2 FOR SHARE OF n,boot`,[b.organisation_id,b.run_id,v.sandbox_id,v.pool_id,v.boot_generation,s.native_sandbox_id])).rows;
     const recipe=retained.length===1?retained[0]!.descriptor:null;
     if(recipe?.executor_kind==='TEST'&&Object.hasOwn(v,'preparation_task_id'))fail('FLEET_PREPARATION_TASK_SCOPE','TEST preparation uses its qualification job and custody task binding');
     if(Object.hasOwn(v,'preparation_task_id')&&recipe?.install_template?.schema_version!==2)fail('FLEET_PREPARATION_TASK_TEMPLATE','Explicit preparation task selection requires the retained current-boot install template v2');
     if(recipe?.install_template?.schema_version===2&&fleetReadinessDigest(recipe)!==retained[0]!.descriptor_digest)fail('FLEET_PREPARATION_TASK_TEMPLATE','Retained bootstrap descriptor digest differs');
     const preparationTask=recipe?.executor_kind!=='TEST'&&recipe?.install_template?.schema_version===2?await resolveFleetPreparationAccountingTask(tx,i,{package_id:b.delegation_id,task_ids:budget.task_ids,...(Object.hasOwn(v,'preparation_task_id')?{preparation_task_id:v.preparation_task_id}:{})}):null;
     return {...(preparationTask?{preparation_task_id:preparationTask.task_id,preparation_task_selection:preparationTask.selection_source}:{}),kind:d.action,delegation_id:b.delegation_id,sandbox_id:v.sandbox_id,boot_generation:v.boot_generation,ready:false,installation_required:true};
    }
    if(d.action==='ASSIGN_WORKER'){
     const raw=actionInput(String(d.action),d.input);const input=Object.hasOwn(raw,'selection')?await prepareSelectedFleetAssignment(tx,i,b,raw,ctx,packets):raw;const v=actionInput(String(d.action),input),a=object(v.assignment);
     const tasks=a.tasks as Record<string,unknown>[];
     if(!Array.isArray(tasks)||tasks.some(t=>!Array.isArray(budget.task_ids)||!budget.task_ids.includes(t.task_id)))fail('FLEET_TASK_SCOPE_DENIED','Assignment tasks must be explicitly delegated');
     const install=object(v.install_binding);await ownedSandbox(tx,b,String(install.sandbox_id));
     const current=(await tx.query(`SELECT count(*)::int AS n FROM hyperfide.attempts a JOIN hyperfide.tasks t ON t.organisation_id=a.organisation_id AND t.run_id=a.run_id AND t.id=a.task_id WHERE a.organisation_id=$1 AND a.run_id=$2 AND t.feature_package_id=$3 AND a.compute_authority='CURRENT'`,[b.organisation_id,b.run_id,b.delegation_id])).rows[0];
     if(!Number.isSafeInteger(budget.max_concurrent_workers)||Number(current?.n??0)+tasks.length>Number(budget.max_concurrent_workers))fail('FLEET_WORKER_BUDGET','Manager concurrent worker budget is occupied');
     return assignFleetWorker(tx,i,b,input,dispatchRecipients(ctx),workers);
    }
    if(d.action==='STEER_WORKER'||d.action==='CANCEL_ASSIGNMENT')return controlFleetWorker(tx,b,d.action,d.input);
    if(d.action==='STOP_SANDBOX'){
     const v=actionInput(String(d.action),d.input);const s=await ownedSandbox(tx,b,String(v.sandbox_id));
     if(s.boot_generation!==v.boot_generation)fail('FLEET_SANDBOX_STALE','Stop targets a stale boot');
     const active=(await tx.query(`SELECT a.id,a.task_id,a.generation::text,a.sandbox_boot_generation::text,t.feature_package_id FROM hyperfide.attempts a JOIN hyperfide.tasks t ON t.organisation_id=a.organisation_id AND t.run_id=a.run_id AND t.id=a.task_id WHERE a.organisation_id=$1 AND a.run_id=$2 AND a.sandbox_id=$3 AND a.compute_authority='CURRENT' FOR SHARE OF a,t`,[b.organisation_id,b.run_id,v.sandbox_id])).rows;
     if(active.some(a=>a.feature_package_id!==b.delegation_id))fail('FLEET_SANDBOX_SCOPE_DENIED','Stop cannot interrupt another delegated package');
     const commands:unknown[]=[];
     for(const attempt of active){
      const start=(await tx.query("SELECT payload FROM hyperfide.outbox_events WHERE organisation_id=$1 AND run_id=$2 AND aggregate_id=$3 AND event_type='instruction.start'",[b.organisation_id,b.run_id,attempt.id])).rows[0];
      if(start)commands.push(await issue(tx,{...scope,id:randomUUID(),attempt_id:attempt.id,attempt_generation:attempt.generation,authority_epoch:b.authority_epoch,sandbox_boot_generation:attempt.sandbox_boot_generation,kind:'CANCEL',body:{launch_id:start.payload.body.launch_id}}));
     }
     const hold=await applyExecutionControl(tx,scope,{scope_kind:'SANDBOX',scope_id:String(v.sandbox_id),mode:'STOP',operation_id:b.operation_id,reason:String(v.reason)});
     return {kind:d.action,delegation_id:b.delegation_id,sandbox_id:v.sandbox_id,hold,commands,quiescence_confirmed:false};
    }
    if(d.action==='DESTROY_SANDBOX'){
     const v=actionInput(String(d.action),d.input);const s=await ownedSandbox(tx,b,String(v.sandbox_id));
     if(s.boot_generation!==v.boot_generation||s.pool_id!==v.pool_id)fail('FLEET_SANDBOX_STALE','Destroy targets a stale boot or pool');
     const prepared=object(await providers.prepareDestroyTx(tx,{run_id:b.run_id,pool_id:v.pool_id,sandbox_id:v.sandbox_id,request_key:b.operation_id,deadline_at:v.deadline_at,reason:v.reason},i));
     const intent=object(prepared.intent);return {kind:d.action,delegation_id:b.delegation_id,sandbox_id:v.sandbox_id,provider_intent_id:intent.id,state:intent.state,external_call_performed:false};
    }
    if(d.action==='COORDINATE_DEPENDENCY'){
     const v=actionInput(String(d.action),d.input);
     const target=(await tx.query("SELECT h.state FROM hyperfide.hierarchy_packages h WHERE h.organisation_id=$1 AND h.run_id=$2 AND h.package_id=$3 FOR SHARE",[b.organisation_id,b.run_id,uuid(v.recipient_package_id,'recipient_package_id')])).rows[0];
     if(!target||['CLOSED','CANCELLED'].includes(String(target.state)))fail('FLEET_COORDINATION_TARGET','Coordination target is not a current package');
     if(!Array.isArray(v.consumer_ids)||v.consumer_ids.length!==0)fail('FLEET_COORDINATION_TARGET','Coordination is delivered through scoped manager observations; consumer_ids must be empty');
     const message=object(v.message);if(Buffer.byteLength(JSON.stringify(message))>32768)fail('FLEET_COORDINATION_TARGET','Coordination message exceeds its bounded observation size');
     return {kind:d.action,delegation_id:b.delegation_id,event_type:'fleet.manager.coordination',delivery:'SCOPED_OBSERVATION',sender_role:'WAVE_MANAGER',sender_actor_id:b.actor_id,sender_package_id:b.delegation_id,sender_generation:b.manager_generation,recipient_package_id:v.recipient_package_id,decision_id:b.decision_id,message,dependency_released:false,task_definitions_changed:false,new_work_dispatched:false};
    }
    return {kind:'REPLAN',delegation_id:b.delegation_id,proposal:object(actionInput(String(d.action),d.input).proposal),task_definitions_changed:false,new_work_dispatched:false};
   });
  });
 };
 return {apiVersion:1,capabilities:{'fleet.effects.v1':Object.freeze({execute,describe:()=>({actions:MANAGER_ACTION_CONTRACTS})})},actions:{'fleet.manager.execute':async(value,context)=>{const v=fields(value,['decision']);const i=context.invocation;if(!i)fail('AUTH_INVOCATION_REQUIRED','Authenticated manager decision required');return execute(v.decision,i);}}};
}
