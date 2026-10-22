import type {Component,ComponentContext} from '../components/registry.js';
import {FoundationError} from '../policy/programme.js';
import {databaseError} from '../storage/schema.js';
import type {PrimaryTransaction} from '../storage/transactions.js';
import {writeSemanticDisposition} from '../storage/dispositions.js';
import {lockRun as lockEventRun} from '../events/outbox.js';
import {invocationOf} from '../identity/enrollment.js';
import {record,scopeOf,uuid,positive,digest,timestamp,recoveryTransaction,operationReplay,finishOperation,capability,isSupervisor,isGateway,type RecoverySupervisor,type RecoveryScope,type RecoveryTransaction,type RecoveryGateway,type RecoveryExecutionControls,inspectRecoveryHold,createRecoveryControlCapability,inspectIntegrationRecovery,isExecutionControls,derivedOperationId,recoveryReady,lockRun,inputDigest} from './control.js';

const modes=['PAUSE','DRAIN','CANCEL','STOP'] as const;
const ranks:Record<string,number>={PAUSE:2,DRAIN:1,CANCEL:4,STOP:3};
const RUN_SCOPES=['RUN','PACKAGE','ATTEMPT','SANDBOX'];
// Fleet scopes span runs, so they are recorded once and fanned out to per-run controls by the driver loop only.
// A fleet stop holds its scope: RECONCILED means every target known so far has settled, and the driver keeps
// fanning it out so a run or sandbox admitted later in that scope is stopped too.
const FLEET_SCOPES=['POOL','ORGANISATION','DEPLOYMENT'];
const TERMINAL_RUN="('STOPPED','SUCCEEDED','FAILED','CANCELLED')";
const PAGE=1000;
const NIL='00000000-0000-0000-0000-000000000000';
// A child control refused with one of these codes can never apply to its target; it does not hold the fleet stop open.
const NOT_APPLICABLE=['RECOVERY_TERMINAL_CONTROL','RECOVERY_ENCLOSING_CONTROL','RECOVERY_CONTROL_REGRESSION','RECOVERY_SCOPE_INVALID'];

type Runner=<T>(scope:RecoveryScope,body:(tx:RecoveryTransaction)=>Promise<T>)=>Promise<T>;
interface CleanupVerifier {verifyStop:(input:unknown)=>Promise<{cleanup_complete:boolean;processes_stopped:boolean;artifacts_preserved:boolean;credentials_cleared:boolean;resources_reconciled:boolean;evidence_digest:string;observed_at:string}>}
function isCleanup(v:unknown):v is CleanupVerifier{return typeof v==='object'&&v!==null&&'verifyStop' in v&&typeof (v as CleanupVerifier).verifyStop==='function';}
/** The same stop logic runs under an authenticated invocation (actions) or under the trusted driver (no invocation). */
interface StopDependencies {
 run:Runner;env:Readonly<NodeJS.ProcessEnv>;
 controls():RecoveryExecutionControls;
 supervisor():RecoverySupervisor|undefined;
 cleanup():CleanupVerifier|undefined;
}
function optional<T>(read:()=>T):T|undefined{
 try{return read();}catch(error){if(error instanceof FoundationError&&error.code==='RECOVERY_DEPENDENCY_UNAVAILABLE')return undefined;throw error;}
}
function capabilitiesOf(context:ComponentContext):Omit<StopDependencies,'run'|'env'>{
 return {controls:()=>capability(context,'5.1','scheduler.controls.v1',isExecutionControls),
  supervisor:()=>optional(()=>capability(context,'12.4','runner.supervisors.v1',isSupervisor)),
  cleanup:()=>optional(()=>capability(context,'12.4','runner.supervisors.v1',isCleanup))};
}
function invoked(context:ComponentContext):StopDependencies{
 return {...capabilitiesOf(context),env:context.env,run:(scope,body)=>recoveryTransaction(context,scope,body)};
}
/** Trusted service-side transaction with the same fences as recoveryTransaction minus the invocation principal.
 * Only the driver uses it; its authority is the durable operator request it is advancing. */
export function trustedRunner(gateway:RecoveryGateway,signal:AbortSignal):Runner{
 return async(scope,body)=>{
  try{return await gateway.withPrimaryTransaction({timeoutMs:10000,maxRetries:2,signal,
   guard:async tx=>{await writeSemanticDisposition(tx as PrimaryTransaction,scope);await lockEventRun(tx as PrimaryTransaction,scope,'exclusive');await recoveryReady(tx);await lockRun(tx,scope,true);}},body);}
  catch(error){if(error instanceof FoundationError)throw error;throw databaseError(error);}
 };
}
export async function publicationBlocked(tx:{query:(sql:string,values:unknown[])=>Promise<{rows:Record<string,unknown>[]}>},org:string,run:string):Promise<boolean>{
 const result=await tx.query("SELECT EXISTS(SELECT 1 FROM hyperfide.publication_operations WHERE organisation_id=$1 AND run_id=$2 AND state IN ('PENDING','RUNNING','OUTCOME_UNKNOWN')) OR EXISTS(SELECT 1 FROM hyperfide.publication_intents WHERE organisation_id=$1 AND run_id=$2 AND state IN ('PENDING','EXECUTING')) AS blocked",[org,run]);
 const integration=await inspectIntegrationRecovery(tx as Parameters<typeof inspectIntegrationRecovery>[0],{organisation_id:org,run_id:run,authority_epoch:'00000000-0000-4000-8000-000000000000'});
 return result.rows[0]?.blocked!==false||!integration.ready||integration.jobs.length>0||integration.scope_jobs.length>0||integration.preparations.length>0;
}
function drainPolicy(env:Readonly<NodeJS.ProcessEnv>):{budget:string;fallback:string}{
 const budget=env.HYPERFIDE_DRAIN_TIMEOUT_MS??'300000',fallback=env.HYPERFIDE_DRAIN_FALLBACK_MODE??'STOP';
 if(!/^[1-9][0-9]*$/.test(budget)||!Number.isSafeInteger(Number(budget))||Number(budget)>86400000||!['PAUSE','STOP'].includes(fallback))throw new FoundationError('RECOVERY_CONFIG_INVALID','Invalid trusted drain deadline/fallback');
 return {budget,fallback};
}
function controlInput(input:unknown,kinds:string[]):{value:Record<string,unknown>;scope:RecoveryScope;id:string;target:string;kind:string;mode:string}{
 const value=record(input,['scope','operation_id','scope_kind','scope_id','mode','reason']);
 const scope=scopeOf(value.scope),id=uuid(value.operation_id),target=uuid(value.scope_id),kind=String(value.scope_kind),mode=String(value.mode);
 if(!kinds.includes(kind)||!Object.hasOwn(ranks,mode)||typeof value.reason!=='string'||value.reason.length<1||value.reason.length>1024)
  throw new FoundationError('RECOVERY_INPUT_INVALID','Invalid scoped control');
 return {value,scope,id,target,kind,mode};
}
async function applyScopedControl(deps:StopDependencies,input:unknown,fleetOperationId?:string):Promise<Record<string,unknown>>{
   const {value,scope,id,target,kind,mode}=controlInput(input,RUN_SCOPES);
   if(kind==='RUN'&&target!==scope.run_id)throw new FoundationError('RECOVERY_SCOPE_INVALID','Run control must target its enclosing run');
   const {budget:drainBudget,fallback}=drainPolicy(deps.env);
   return deps.run(scope,async tx=>{
    const replay=await operationReplay(tx,scope,id,'STOP',value);if(replay)return replay;
    const enclosing=await inspectRecoveryHold(tx,scope);
    if(enclosing.some(row=>row.scope_kind==='RUN'&&Number(ranks[String(row.mode)])>Number(ranks[mode])))
     throw new FoundationError('RECOVERY_ENCLOSING_CONTROL','Enclosing run control cannot be weakened');
    const conditions:Record<string,string>={RUN:'TRUE',PACKAGE:'t.feature_package_id=$3',ATTEMPT:'a.id=$3',SANDBOX:'a.sandbox_id=$3'};
    if(kind==='PACKAGE'){
     const exists=await tx.query('SELECT id FROM hyperfide.feature_packages WHERE organisation_id=$1 AND run_id=$2 AND id=$3',[scope.organisation_id,scope.run_id,target]);
     if(!exists.rows.length)throw new FoundationError('RECOVERY_SCOPE_INVALID','Package is outside run');
    }
    // Physical processes can outlive their attempt. Task/custody disposition follows only current task ownership.
    const taskConditions:Record<string,string>={RUN:'TRUE',PACKAGE:'t.feature_package_id=$3',ATTEMPT:'EXISTS(SELECT 1 FROM hyperfide.attempts a WHERE a.organisation_id=t.organisation_id AND a.run_id=t.run_id AND a.id=t.current_attempt_id AND a.generation=t.generation AND a.id=$3)',SANDBOX:'EXISTS(SELECT 1 FROM hyperfide.attempts a WHERE a.organisation_id=t.organisation_id AND a.run_id=t.run_id AND a.id=t.current_attempt_id AND a.generation=t.generation AND a.sandbox_id=$3)'};
    const affectedTasks=await tx.query('SELECT t.id FROM hyperfide.tasks t WHERE t.organisation_id=$1 AND t.run_id=$2 AND '+taskConditions[kind]+' ORDER BY t.id FOR UPDATE OF t',kind==='RUN'?[scope.organisation_id,scope.run_id]:[scope.organisation_id,scope.run_id,target]);
    const taskIds=affectedTasks.rows.map(row=>row.id);
    const attempts=await tx.query('SELECT a.id,a.task_id,a.generation,a.sandbox_id,a.sandbox_boot_generation,a.compute_authority FROM hyperfide.attempts a JOIN hyperfide.tasks t ON t.organisation_id=a.organisation_id AND t.run_id=a.run_id AND t.id=a.task_id WHERE a.organisation_id=$1 AND a.run_id=$2 AND '+conditions[kind]+' ORDER BY a.id FOR UPDATE OF a',kind==='RUN'?[scope.organisation_id,scope.run_id]:[scope.organisation_id,scope.run_id,target]);
    if((kind==='ATTEMPT'||kind==='SANDBOX')&&!attempts.rows.length)throw new FoundationError('RECOVERY_SCOPE_INVALID','Scope has no bound attempt in this run');
    const previous=enclosing.find(row=>row.scope_kind===kind&&row.scope_id===target);
    if(previous&&Number(ranks[String(previous.mode)])>Number(ranks[mode]))throw new FoundationError('RECOVERY_CONTROL_REGRESSION','Active control cannot be weakened');
    const timing=await tx.query("SELECT clock_timestamp() AS accepted_at,clock_timestamp()+($1::bigint*interval '1 millisecond') AS deadline_at",[drainBudget]);
    const accepted=timing.rows[0]!.accepted_at,deadline=mode==='DRAIN'?timing.rows[0]!.deadline_at:null;
    const controls=await tx.query("INSERT INTO hyperfide.recovery_controls(organisation_id,run_id,scope_kind,scope_id,mode,authority_epoch,reason,accepted_at,deadline_at,fallback_mode) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(organisation_id,run_id,scope_kind,scope_id) DO UPDATE SET mode=EXCLUDED.mode,authority_epoch=EXCLUDED.authority_epoch,reason=EXCLUDED.reason,accepted_at=EXCLUDED.accepted_at,deadline_at=EXCLUDED.deadline_at,fallback_mode=EXCLUDED.fallback_mode,status='ACTIVE',generation=hyperfide.recovery_controls.generation+1,updated_at=clock_timestamp() RETURNING generation",[scope.organisation_id,scope.run_id,kind,target,mode,scope.authority_epoch,value.reason,accepted,deadline,mode==='DRAIN'?fallback:null]);
    const generation=controls.rows[0]!.generation;
    await deps.controls().applyExecutionControl(tx,scope,{scope_kind:kind as 'RUN'|'PACKAGE'|'ATTEMPT'|'SANDBOX',scope_id:target,mode:(mode==='CANCEL'?'STOP':mode) as 'PAUSE'|'DRAIN'|'STOP',operation_id:id,reason:value.reason as string,...(mode==='DRAIN'?{deadline_at:new Date(String(deadline)).toISOString(),fallback_mode:fallback as 'PAUSE'|'STOP'}:{})});

    if(kind==='RUN'){
     const state=({PAUSE:'PAUSING',DRAIN:'DRAINING',CANCEL:'CANCELLING',STOP:'STOPPING'} as Record<string,string>)[mode]!;
     const changed=await tx.query("UPDATE hyperfide.runs SET state=$3,state_version=state_version+1 WHERE organisation_id=$1 AND id=$2 AND state NOT IN ('STOPPED','SUCCEEDED','FAILED','CANCELLED') RETURNING id",[scope.organisation_id,scope.run_id,state]);
     if(!changed.rows.length)throw new FoundationError('RECOVERY_TERMINAL_CONTROL','Terminal run cannot accept new control');
    }
    const destructive=mode==='CANCEL'||mode==='STOP';
    if(destructive)for(const attempt of attempts.rows){
     await tx.query("UPDATE hyperfide.attempts SET compute_authority='REVOKED',execution_state=CASE WHEN execution_state IN ('SUCCEEDED','FAILED','CANCELLED','SUBMITTED') THEN execution_state ELSE 'CANCELLED' END,state_version=state_version+1 WHERE organisation_id=$1 AND run_id=$2 AND id=$3 AND (compute_authority='CURRENT' OR execution_state NOT IN ('SUCCEEDED','FAILED','CANCELLED','SUBMITTED'))",[scope.organisation_id,scope.run_id,attempt.id]);
     await tx.query("UPDATE hyperfide.compute_leases SET state='REVOKED',state_version=state_version+1 WHERE organisation_id=$1 AND run_id=$2 AND attempt_id=$3 AND state='ACTIVE'",[scope.organisation_id,scope.run_id,attempt.id]);
     await tx.query("UPDATE hyperfide.slot_allocations SET state='RELEASE_PENDING',state_version=state_version+1 WHERE organisation_id=$1 AND run_id=$2 AND attempt_id=$3 AND state='ACTIVE'",[scope.organisation_id,scope.run_id,attempt.id]);
     await tx.query("INSERT INTO hyperfide.recovery_resource_debts(organisation_id,run_id,operation_id,resource_kind,resource_id,sandbox_boot_generation,desired_state,detail) SELECT organisation_id,run_id,$3,'SUPERVISOR',id,$5,'STOPPED','Stop requires exact OS process identity and descendant observation' FROM hyperfide.agent_sessions WHERE organisation_id=$1 AND run_id=$2 AND attempt_id=$4 AND state NOT IN ('STOPPED','FAILED') ON CONFLICT DO NOTHING",[scope.organisation_id,scope.run_id,id,attempt.id,attempt.sandbox_boot_generation]);
    }
    if(mode==='PAUSE'||mode==='DRAIN')for(const attempt of attempts.rows){
     const sessions=await tx.query("SELECT id FROM hyperfide.agent_sessions WHERE organisation_id=$1 AND run_id=$2 AND attempt_id=$3 AND state NOT IN ('STOPPED','FAILED')",[scope.organisation_id,scope.run_id,attempt.id]);
     for(const session of sessions.rows){
      await tx.query("INSERT INTO hyperfide.recovery_resource_debts(organisation_id,run_id,operation_id,resource_kind,resource_id,sandbox_boot_generation,command_generation,desired_state,detail) VALUES($1,$2,$3,'SUPERVISOR',$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING",[scope.organisation_id,scope.run_id,id,session.id,attempt.sandbox_boot_generation,generation,mode==='PAUSE'?'QUIESCENT':'FINISHED',mode==='PAUSE'?'Verify durable checkpoint before unsupported native pause is terminated':'Observe already-admitted work; no successor dispatch']);
      if(mode==='PAUSE')await tx.query("INSERT INTO hyperfide.recovery_resource_debts(organisation_id,run_id,operation_id,resource_kind,resource_id,sandbox_boot_generation,command_generation,desired_state,detail) VALUES($1,$2,$3,'CHECKPOINT',$4,$5,$6,'DURABLE','Pause requires actual native export, immutable upload and verified checkpoint registration') ON CONFLICT DO NOTHING",[scope.organisation_id,scope.run_id,id,session.id,attempt.sandbox_boot_generation,generation]);
     }
    }
    const custodyDispositions:Record<string,unknown>[]=[];
    if(destructive){
     const custodies=await tx.query("SELECT id,task_id FROM hyperfide.submission_custodies WHERE organisation_id=$1 AND run_id=$2 AND task_id=ANY($3::uuid[]) AND authority='ACTIVE' ORDER BY id FOR UPDATE",[scope.organisation_id,scope.run_id,taskIds]);
     for(const custody of custodies.rows){
      const holds=await tx.query("SELECT EXISTS(SELECT 1 FROM hyperfide.integration_candidates c JOIN hyperfide.publication_operations p ON p.organisation_id=c.organisation_id AND p.run_id=c.run_id AND p.candidate_id=c.id WHERE c.organisation_id=$1 AND c.run_id=$2 AND c.custody_id=$3 AND p.state IN ('PENDING','RUNNING','OUTCOME_UNKNOWN')) OR EXISTS(SELECT 1 FROM hyperfide.integration_candidates c JOIN hyperfide.publication_intents p ON p.organisation_id=c.organisation_id AND p.run_id=c.run_id AND p.candidate_id=c.id WHERE c.organisation_id=$1 AND c.run_id=$2 AND c.custody_id=$3 AND p.state IN ('PENDING','EXECUTING')) AS blocked",[scope.organisation_id,scope.run_id,custody.id]);
      if(holds.rows[0]?.blocked!==false){
       await tx.query("INSERT INTO hyperfide.recovery_resource_debts(organisation_id,run_id,operation_id,resource_kind,resource_id,desired_state,observed_state,detail) VALUES($1,$2,$3,'AUTHORITY',$4,'REVOKED','FROZEN_EXTERNAL_OUTCOME_UNKNOWN','Emergency control blocks advancement; immutable issued publication must reconcile before custody disposition') ON CONFLICT DO NOTHING",[scope.organisation_id,scope.run_id,id,custody.id]);
       custodyDispositions.push({custody_id:custody.id,authority:'CONTROL_BLOCKED',disposition:'PENDING_EXTERNAL_RECONCILIATION'});
      }else{
       await tx.query("UPDATE hyperfide.submission_custodies SET authority='REVOKED',state_version=state_version+1 WHERE organisation_id=$1 AND run_id=$2 AND id=$3 AND authority='ACTIVE'",[scope.organisation_id,scope.run_id,custody.id]);
       await tx.query("UPDATE hyperfide.qualification_jobs SET state='CANCELLED',lease_generation=lease_generation+1,lease_owner=NULL,lease_expires_at=NULL,state_version=state_version+1 WHERE organisation_id=$1 AND run_id=$2 AND custody_id=$3 AND state IN ('PENDING','RUNNING')",[scope.organisation_id,scope.run_id,custody.id]);
       await tx.query("UPDATE hyperfide.integration_candidates SET state='CANCELLED',state_version=state_version+1 WHERE organisation_id=$1 AND run_id=$2 AND custody_id=$3 AND state IN ('PENDING','VERIFYING','READY')",[scope.organisation_id,scope.run_id,custody.id]);
       custodyDispositions.push({custody_id:custody.id,authority:'REVOKED',history_preserved:true});
      }
     }
     await tx.query("UPDATE hyperfide.tasks SET state=$4,state_version=state_version+1 WHERE organisation_id=$1 AND run_id=$2 AND id=ANY($3::uuid[]) AND state NOT IN ('INTEGRATED','CANCELLED')",[scope.organisation_id,scope.run_id,taskIds,mode==='CANCEL'?'CANCELLED':'BLOCKED']);
    }
    if(destructive&&kind==='RUN'){
     await tx.query("INSERT INTO hyperfide.recovery_resource_debts(organisation_id,run_id,operation_id,resource_kind,resource_id,sandbox_boot_generation,command_generation,desired_state,detail) SELECT organisation_id,run_id,$3,'SUPERVISOR',id,sandbox_boot_generation,$4,'STOPPED','Stop includes leader and manager supervision sessions' FROM hyperfide.agent_sessions WHERE organisation_id=$1 AND run_id=$2 AND state NOT IN ('STOPPED','FAILED') ON CONFLICT DO NOTHING",[scope.organisation_id,scope.run_id,id,generation]);
    }
    const result={scope,operation_id:id,scope_kind:kind,scope_id:target,mode,generation,accepted_at:accepted,drain_deadline:deadline,fallback_mode:mode==='DRAIN'?fallback:null,admission_blocked:true,compute_revoked:destructive,affected_task_ids:taskIds,
     process_stop_complete:false,cleanup_complete:false,submission_custody_preserved:!destructive,custody_dispositions:custodyDispositions,custody_history_preserved:true,unknown_external_effects:'RECONCILE',
     ...(fleetOperationId?{fleet_operation_id:fleetOperationId}:{})};
    await finishOperation(tx,scope,id,result);return result;
   });
}
const CANONICAL_UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** D14: a DEPLOYMENT stop reaches every organisation, so it needs an allow-listed operator credential.
 * Unset or empty means nobody; a malformed entry is a configuration error, never a silent widening. */
function deploymentOperators(env:Readonly<Record<string,string|undefined>>):string[]{
 const raw=(env.HYPERFIDE_DEPLOYMENT_OPERATORS??'').trim();
 if(!raw)return [];
 const ids=raw.split(',').map(item=>item.trim());
 if(ids.some(item=>!CANONICAL_UUID.test(item)))throw new FoundationError('RECOVERY_CONFIG_INVALID','HYPERFIDE_DEPLOYMENT_OPERATORS must be comma-separated canonical credential UUIDs');
 return ids;
}
/** Records a fleet stop on the requesting run. It changes nothing else here: the driver fans it out per run.
 * A DEPLOYMENT stop from an operator outside the allow-list is persisted as REFUSED, which the driver never fans out,
 * and the request (and any replay of it) fails with RECOVERY_DEPLOYMENT_OPERATOR_DENIED. */
async function requestFleetControl(input:unknown,context:ComponentContext):Promise<unknown>{
 const result=await recordFleetControl(input,context);
 const error=result.refused===true?result.error as {code?:unknown;message?:unknown}|undefined:undefined;
 if(error)throw new FoundationError(String(error.code),String(error.message)+' (refusal recorded as operation '+String(result.operation_id)+')');
 return result;
}
async function recordFleetControl(input:unknown,context:ComponentContext):Promise<Record<string,unknown>>{
 const {value,scope,id,target,kind,mode}=controlInput(input,FLEET_SCOPES);
 const principal=invocationOf(context).principal;
 if(principal.role!=='OPERATOR')throw new FoundationError('ROLE_DENIED','Fleet stop scopes require an operator principal');
 const allowed=kind==='DEPLOYMENT'?deploymentOperators(context.env):[];
 if(kind==='ORGANISATION'&&target!==scope.organisation_id)throw new FoundationError('RECOVERY_SCOPE_INVALID','Organisation control must target the principal organisation');
 if(kind==='DEPLOYMENT'&&(!context.env.HYPERFIDE_DEPLOYMENT_ID||target!==context.env.HYPERFIDE_DEPLOYMENT_ID))throw new FoundationError('RECOVERY_SCOPE_INVALID','Deployment control must name this deployment (HYPERFIDE_DEPLOYMENT_ID)');
 drainPolicy(context.env);
 return recoveryTransaction(context,scope,async tx=>{
  const replay=await operationReplay(tx,scope,id,'STOP',value);if(replay)return replay;
  if(kind==='DEPLOYMENT'&&!allowed.includes(principal.credential_id)){
   const refused={scope,operation_id:id,scope_kind:kind,scope_id:target,mode,fleet:true,refused:true,credential_id:principal.credential_id,
    allow_list_configured:allowed.length>0,refused_at:(await tx.query('SELECT clock_timestamp() AS at')).rows[0]!.at,
    error:{code:'RECOVERY_DEPLOYMENT_OPERATOR_DENIED',message:'Deployment stop requires an operator credential on HYPERFIDE_DEPLOYMENT_OPERATORS'}};
   await finishOperation(tx,scope,id,refused,'REFUSED');return refused;
  }
  if(kind==='POOL'&&!(await tx.query('SELECT 1 FROM hyperfide.provider_pools WHERE organisation_id=$1 AND id=$2',[scope.organisation_id,target])).rows.length)
   throw new FoundationError('RECOVERY_SCOPE_INVALID','Pool is outside the principal organisation');
  const accepted=(await tx.query('SELECT clock_timestamp() AS at')).rows[0]!.at;
  const result={scope,operation_id:id,scope_kind:kind,scope_id:target,mode,reason:value.reason,accepted_at:accepted,fleet:true,driver:'RECOVERY_STOP_DRIVER',
   fanout_complete:false,fanout:{targets:0,applied:0,not_applicable:0,pending:0,unsettled:0},stop_complete:false};
  await finishOperation(tx,scope,id,result);return result;
 });
}
async function reconcileStop(deps:StopDependencies,scope:RecoveryScope,id:string):Promise<Record<string,unknown>>{
   // External commands execute outside database transactions and retain stable command IDs.
   const plan=await deps.run(scope,async tx=>{
    const operation=await tx.query("SELECT kind,result FROM hyperfide.recovery_operations WHERE organisation_id=$1 AND run_id=$2 AND operation_id=$3",[scope.organisation_id,scope.run_id,id]);
    if(operation.rows[0]?.kind!=='STOP'&&operation.rows[0]?.kind!=='WORKER_LOSS')throw new FoundationError('RECOVERY_OPERATION_INVALID','No matching stop/loss intent');
    const intent=operation.rows[0]!.result as Record<string,unknown>;
    if(intent.mode!=='DRAIN')return {intent,drain:undefined};
    const drain=(await tx.query("SELECT generation,fallback_mode,deadline_at<=clock_timestamp() AS expired FROM hyperfide.recovery_controls WHERE organisation_id=$1 AND run_id=$2 AND scope_kind=$3 AND scope_id=$4 AND mode='DRAIN' AND status='ACTIVE' AND generation=$5 FOR UPDATE",[scope.organisation_id,scope.run_id,intent.scope_kind,intent.scope_id,intent.generation])).rows[0];
    // Only the call that applies the fallback reports it; once applied the drain is no longer ACTIVE, whoever applied it.
    return {intent,drain};
   });
   if(plan.intent.fleet===true)return {scope,operation_id:id,fleet:true,driver:'RECOVERY_STOP_DRIVER',fanout_complete:plan.intent.fanout_complete===true,fanout:plan.intent.fanout,cleanup_complete:false,stop_complete:false};
   if(plan.drain?.expired===true){
    const fallbackId=derivedOperationId(id,'drain-deadline:'+positive(String(plan.drain.generation)));
    const fallback=await applyScopedControl(deps,{scope,operation_id:fallbackId,scope_kind:plan.intent.scope_kind,scope_id:plan.intent.scope_id,mode:plan.drain.fallback_mode,reason:'Persisted drain deadline elapsed'});
    return {scope,operation_id:id,fallback_operation_id:fallbackId,fallback,drain_complete:false,cleanup_complete:false,reconcile_required:true};
   }
   // An absent trusted supervisor leaves every process debt explicitly unreachable; it never confirms or completes a stop.
   let supervisor:RecoverySupervisor|undefined,resolved=false;
   const observations:Record<string,unknown>[]=[];let observed=0;
   const note=(item:Record<string,unknown>)=>{observed++;if(observations.length<PAGE)observations.push(item);};
   // Keyset pages bound each read; the inventory itself is unbounded.
   for(let after=NIL;;){
    const debts=await deps.run(scope,async tx=>(await tx.query("SELECT id,resource_kind,resource_id,command_id,command_generation,sandbox_boot_generation,desired_state,created_at FROM hyperfide.recovery_resource_debts WHERE organisation_id=$1 AND run_id=$2 AND operation_id=$3 AND status<>'RESOLVED' AND id>$4 ORDER BY id LIMIT "+PAGE,[scope.organisation_id,scope.run_id,id,after])).rows);
    if(!debts.length)break;
    after=String(debts[debts.length-1]!.id);
    if(!resolved&&debts.some(row=>row.resource_kind==='SUPERVISOR')){supervisor=deps.supervisor();resolved=true;}
    for(const debt of debts){
     if(debt.resource_kind==='SUPERVISOR'&&!supervisor){note({debt_id:debt.id,resource_kind:debt.resource_kind,resource_id:debt.resource_id,status:'SUPERVISOR_UNAVAILABLE'});continue;}
     if(debt.resource_kind!=='SUPERVISOR'||!supervisor){note({debt_id:debt.id,resource_kind:debt.resource_kind,resource_id:debt.resource_id,status:'UNKNOWN'});continue;}
     let receipt;
     if(debt.desired_state==='QUIESCENT'){
      const ready=await deps.run(scope,async tx=>(await tx.query("SELECT count(*)::text AS count FROM hyperfide.recovery_resource_debts WHERE organisation_id=$1 AND run_id=$2 AND operation_id=$3 AND resource_kind='CHECKPOINT' AND resource_id=$4 AND status<>'RESOLVED'",[scope.organisation_id,scope.run_id,id,debt.resource_id])).rows[0]!.count==='0');
      if(!ready){note({debt_id:debt.id,status:'CHECKPOINT_REQUIRED'});continue;}
     }
     try{receipt=debt.desired_state==='FINISHED'?await supervisor.observe({scope,session_id:uuid(debt.resource_id),attempt_id:null,sandbox_id:null,boot_generation:debt.sandbox_boot_generation as string|null}):await supervisor.stop({scope,session_id:uuid(debt.resource_id),command_id:uuid(debt.command_id),generation:positive(debt.command_generation)});}
     catch{note({debt_id:debt.id,status:'UNKNOWN'});continue;}
     const at=timestamp(receipt.observed_at),evidence=digest(receipt.evidence_digest);
     if(at<Date.parse(String(debt.created_at))||at>Date.now()+1000)throw new FoundationError('RECOVERY_OBSERVATION_STALE','Supervisor receipt is outside observation interval');
     if(!['CONFIRMED_STOPPED','MATCHED_RUNNING','UNKNOWN','IDENTITY_MISMATCH'].includes(receipt.status))throw new FoundationError('RECOVERY_OBSERVATION_INVALID','Unknown supervisor observation');
     note({debt_id:debt.id,status:receipt.status});
     await deps.run(scope,async tx=>{
      if(receipt.status==='CONFIRMED_STOPPED'){
       await tx.query("UPDATE hyperfide.recovery_resource_debts SET status='RESOLVED',observed_state='STOPPED',observed_at=$4,evidence_digest=$5,resolved_at=clock_timestamp() WHERE organisation_id=$1 AND run_id=$2 AND id=$3 AND status<>'RESOLVED'",[scope.organisation_id,scope.run_id,debt.id,receipt.observed_at,evidence]);
       await tx.query("UPDATE hyperfide.agent_sessions SET state='STOPPED',state_version=state_version+1 WHERE organisation_id=$1 AND run_id=$2 AND id=$3 AND state<>'STOPPED'",[scope.organisation_id,scope.run_id,debt.resource_id]);
       if(debt.desired_state==='QUIESCENT'){
        const attempts=(await tx.query("SELECT a.id,a.task_id FROM hyperfide.agent_sessions s JOIN hyperfide.attempts a ON a.organisation_id=s.organisation_id AND a.run_id=s.run_id AND a.id=s.attempt_id WHERE s.organisation_id=$1 AND s.run_id=$2 AND s.id=$3 FOR UPDATE OF a",[scope.organisation_id,scope.run_id,debt.resource_id])).rows;
        for(const a of attempts){
         await tx.query("UPDATE hyperfide.attempts SET compute_authority='REVOKED',state_version=state_version+1 WHERE organisation_id=$1 AND run_id=$2 AND id=$3 AND compute_authority IN ('CURRENT','EXPIRED')",[scope.organisation_id,scope.run_id,a.id]);
         await tx.query("UPDATE hyperfide.compute_leases SET state='REVOKED',state_version=state_version+1 WHERE organisation_id=$1 AND run_id=$2 AND attempt_id=$3 AND state='ACTIVE'",[scope.organisation_id,scope.run_id,a.id]);
         await tx.query("UPDATE hyperfide.tasks t SET state='STALE',state_version=state_version+1 WHERE t.organisation_id=$1 AND t.run_id=$2 AND t.id=$3 AND t.current_attempt_id=$4 AND t.state NOT IN ('INTEGRATED','CANCELLED') AND NOT EXISTS(SELECT 1 FROM hyperfide.submission_custodies c WHERE c.organisation_id=t.organisation_id AND c.run_id=t.run_id AND c.task_id=t.id AND c.authority='ACTIVE')",[scope.organisation_id,scope.run_id,a.task_id,a.id]);
        }
       }
      }else await tx.query("UPDATE hyperfide.recovery_resource_debts SET observed_state=$4,observed_at=$5,evidence_digest=$6 WHERE organisation_id=$1 AND run_id=$2 AND id=$3 AND status<>'RESOLVED'",[scope.organisation_id,scope.run_id,debt.id,receipt.status,receipt.observed_at,evidence]);
     });
    }
    if(debts.length<PAGE)break;
   }
   return deps.run(scope,async tx=>{
    const unresolved=(await tx.query("SELECT id,resource_kind,resource_id,status,observed_state FROM hyperfide.recovery_resource_debts WHERE organisation_id=$1 AND run_id=$2 AND operation_id=$3 AND status<>'RESOLVED' ORDER BY id LIMIT "+PAGE,[scope.organisation_id,scope.run_id,id])).rows;
    const remaining=Number((await tx.query("SELECT count(*)::text AS count FROM hyperfide.recovery_resource_debts WHERE organisation_id=$1 AND run_id=$2 AND operation_id=$3 AND status<>'RESOLVED'",[scope.organisation_id,scope.run_id,id])).rows[0]!.count);
    const publication=await publicationBlocked(tx,scope.organisation_id,scope.run_id);
    let stable=false;
    if(remaining===0&&!publication&&plan.intent.scope_kind==='RUN'&&['PAUSE','DRAIN'].includes(String(plan.intent.mode))){
     const active=(await tx.query("SELECT EXISTS(SELECT 1 FROM hyperfide.attempts WHERE organisation_id=$1 AND run_id=$2 AND compute_authority='CURRENT' AND lease_expires_at>clock_timestamp()) OR EXISTS(SELECT 1 FROM hyperfide.qualification_jobs WHERE organisation_id=$1 AND run_id=$2 AND state='RUNNING' AND lease_expires_at>clock_timestamp()) AS present",[scope.organisation_id,scope.run_id])).rows[0]!.present;
     if(active===false){
      const target=plan.intent.mode==='PAUSE'?'PAUSED':'DRAINED';
      const changed=await tx.query("UPDATE hyperfide.runs SET state=$3,state_version=state_version+1 WHERE organisation_id=$1 AND id=$2 AND state=$4 RETURNING id",[scope.organisation_id,scope.run_id,target,plan.intent.mode==='PAUSE'?'PAUSING':'DRAINING']);
      // A repeated reconcile reports the same durable quiescence instead of a regression.
      stable=changed.rows.length===1||(await tx.query('SELECT state FROM hyperfide.runs WHERE organisation_id=$1 AND id=$2',[scope.organisation_id,scope.run_id])).rows[0]?.state===target;
     }
    }
    return {scope,operation_id:id,observations,observation_count:observed,supervisor_available:supervisor!==undefined,unreachable_resource_debt:unresolved,unreachable_resource_debt_count:remaining,quiescence_complete:stable,process_stop_complete:remaining===0,publication_reconciled:!publication,
     cleanup_complete:false,stop_complete:false,reason:remaining?'UNREACHABLE_OR_UNCONFIRMED_RESOURCES':publication?'PUBLICATION_OUTCOME_UNKNOWN':'ARTIFACT_AND_CREDENTIAL_CLEANUP_REQUIRES_QUALIFIED_RECEIPTS'};
   });
}
async function finalizeStop(deps:StopDependencies,cleanup:CleanupVerifier,scope:RecoveryScope,id:string):Promise<Record<string,unknown>>{
   const plan=await deps.run(scope,async tx=>{
    const op=await tx.query("SELECT kind,result,created_at FROM hyperfide.recovery_operations WHERE organisation_id=$1 AND run_id=$2 AND operation_id=$3",[scope.organisation_id,scope.run_id,id]);
    if(op.rows[0]?.kind!=='STOP')throw new FoundationError('RECOVERY_OPERATION_INVALID','No matching scoped stop intent');
    if((op.rows[0]!.result as Record<string,unknown>).fleet===true)throw new FoundationError('RECOVERY_OPERATION_INVALID','A fleet stop finalizes through its per-run child operations');
    return {result:op.rows[0]!.result as Record<string,unknown>,created_at:op.rows[0]!.created_at};
   });
   // Each page of supervisor commands gets its own cleanup receipt; the stop is complete only if every page is.
   const receipts:Awaited<ReturnType<CleanupVerifier['verifyStop']>>[]=[];
   for(let after=NIL;;){
    const commands=await deps.run(scope,async tx=>(await tx.query("SELECT resource_id AS session_id,command_id,command_generation AS generation FROM hyperfide.recovery_resource_debts WHERE organisation_id=$1 AND run_id=$2 AND operation_id=$3 AND resource_kind='SUPERVISOR' AND resource_id>$4 ORDER BY resource_id LIMIT "+PAGE,[scope.organisation_id,scope.run_id,id,after])).rows);
    if(commands.length||!receipts.length){
     const receipt=await cleanup.verifyStop({scope,operation_id:id,scope_kind:plan.result.scope_kind,scope_id:plan.result.scope_id,commands});
     digest(receipt.evidence_digest);const at=timestamp(receipt.observed_at);
     if(at<Date.parse(String(plan.created_at))||at>Date.now()+1000)throw new FoundationError('RECOVERY_OBSERVATION_STALE','Cleanup receipt is outside the intent interval');
     receipts.push(receipt);
    }
    if(commands.length<PAGE)break;
    after=String(commands[commands.length-1]!.session_id);
   }
   const all=(key:'cleanup_complete'|'processes_stopped'|'artifacts_preserved'|'credentials_cleared'|'resources_reconciled')=>receipts.every(r=>r[key]===true);
   const evidence=receipts.length===1?receipts[0]!.evidence_digest:inputDigest(receipts.map(r=>r.evidence_digest));
   const observedAt=receipts.map(r=>r.observed_at).sort().at(-1)!;
   return deps.run(scope,async tx=>{
    const open=await tx.query("SELECT count(*)::text AS count FROM hyperfide.recovery_resource_debts WHERE organisation_id=$1 AND run_id=$2 AND operation_id=$3 AND status<>'RESOLVED'",[scope.organisation_id,scope.run_id,id]);
    const publication=await publicationBlocked(tx,scope.organisation_id,scope.run_id);
    const complete=all('cleanup_complete')&&all('processes_stopped')&&all('artifacts_preserved')&&all('credentials_cleared')&&all('resources_reconciled')&&open.rows[0]!.count==='0'&&!publication;
    const intent=plan.result;
    if(complete&&intent.scope_kind==='RUN'&&['STOP','CANCEL'].includes(String(intent.mode))){
     await tx.query("UPDATE hyperfide.runs SET state=$3,state_version=state_version+1 WHERE organisation_id=$1 AND id=$2 AND state IN ('STOPPING','CANCELLING')",[scope.organisation_id,scope.run_id,intent.mode==='CANCEL'?'CANCELLED':'STOPPED']);
    }
    const result={...intent,process_stop_complete:all('processes_stopped'),cleanup_complete:complete,stop_complete:complete,evidence_digest:evidence,observed_at:observedAt,receipt_pages:receipts.length,publication_reconciled:!publication};
    await finishOperation(tx,scope,id,result,complete?'RECONCILED':'APPLIED');return result;
   });
}

export interface StopDriverReport {
 started_at:string;finished_at:string;fleet_operations:number;children_applied:number;children_not_applicable:number;
 fleet_completed:number;operations_reconciled:number;operations_finalized:number;errors:{operation_id:string;code:string}[];
}
export interface StopDriverOptions {
 gateway:RecoveryGateway;signal:AbortSignal;env:Readonly<NodeJS.ProcessEnv>;intervalMs:number;
 controls():RecoveryExecutionControls;supervisor():RecoverySupervisor|undefined;cleanup():CleanupVerifier|undefined;
 batch?:number;
}
export interface StopDriver {pass():Promise<StopDriverReport>;start():void;close():Promise<void>;status():Record<string,unknown>}
interface OperationRow {organisation_id:string;run_id:string;operation_id:string;authority_epoch:string;state?:string;result:Record<string,unknown>}
const errorCode=(error:unknown)=>error instanceof FoundationError?error.code:'RECOVERY_DRIVER_FAILED';
/** Advances every open stop in the deployment without waiting for reconcile calls: fans fleet stops out
 * to per-run controls, reconciles open debts page by page, and finalizes when a cleanup verifier exists. */
export function createStopDriver(options:StopDriverOptions):StopDriver{
 const controller=new AbortController();
 const abort=()=>controller.abort();options.signal.addEventListener('abort',abort,{once:true});
 const signal=controller.signal,batch=options.batch??256;
 const deps:StopDependencies={run:trustedRunner(options.gateway,signal),env:options.env,controls:options.controls,supervisor:options.supervisor,cleanup:options.cleanup};
 // Deployment-wide reads that precede any run-scoped write; they take no run fence.
 const scan=<T>(body:(tx:RecoveryTransaction)=>Promise<T>)=>options.gateway.withPrimaryTransaction({timeoutMs:10000,maxRetries:2,signal},async tx=>{await recoveryReady(tx);return body(tx);});
 const scopeOfRow=(row:{organisation_id:string;run_id:string;authority_epoch:string}):RecoveryScope=>({organisation_id:row.organisation_id,run_id:row.run_id,authority_epoch:row.authority_epoch});
 async function page(sql:string,key:[string,string,string],values:unknown[]):Promise<OperationRow[]>{
  return scan(async tx=>(await tx.query(sql,[...key,...values,batch])).rows as OperationRow[]);
 }
 async function fanOut(fleet:OperationRow,report:StopDriverReport):Promise<void>{
  const intent=fleet.result,kind=String(intent.scope_kind),fleetScope=scopeOfRow(fleet);
  const counts={targets:0,applied:0,not_applicable:0,pending:0,unsettled:0};
  const targetSql={
   ORGANISATION:`SELECT organisation_id,id AS run_id,authority_epoch,NULL::uuid AS sandbox_id FROM hyperfide.runs WHERE (organisation_id,id,$3::uuid)>($1::uuid,$2::uuid,$3::uuid) AND organisation_id=$4 AND state NOT IN ${TERMINAL_RUN} ORDER BY organisation_id,id LIMIT $5`,
   DEPLOYMENT:`SELECT organisation_id,id AS run_id,authority_epoch,NULL::uuid AS sandbox_id FROM hyperfide.runs WHERE (organisation_id,id,$3::uuid)>($1::uuid,$2::uuid,$3::uuid) AND state NOT IN ${TERMINAL_RUN} ORDER BY organisation_id,id LIMIT $4`,
   POOL:`SELECT DISTINCT a.organisation_id,a.run_id,r.authority_epoch,a.sandbox_id FROM hyperfide.attempts a JOIN hyperfide.sandboxes s ON s.organisation_id=a.organisation_id AND s.id=a.sandbox_id JOIN hyperfide.runs r ON r.organisation_id=a.organisation_id AND r.id=a.run_id WHERE (a.organisation_id,a.run_id,a.sandbox_id)>($1::uuid,$2::uuid,$3::uuid) AND s.organisation_id=$4 AND s.pool_id=$5 AND r.state NOT IN ${TERMINAL_RUN} ORDER BY a.organisation_id,a.run_id,a.sandbox_id LIMIT $6`
  }[kind];
  if(!targetSql)throw new FoundationError('RECOVERY_OPERATION_INVALID','Unknown fleet scope');
  const filters=kind==='ORGANISATION'?[fleet.organisation_id]:kind==='POOL'?[fleet.organisation_id,intent.scope_id]:[];
  for(let key:[string,string,string]=[NIL,NIL,NIL];;){
   const targets=await scan(async tx=>(await tx.query(targetSql,[...key,...filters,batch])).rows as {organisation_id:string;run_id:string;authority_epoch:string;sandbox_id:string|null}[]);
   for(const target of targets){
    counts.targets++;
    const scope=scopeOfRow(target),childId=derivedOperationId(fleet.operation_id,target.organisation_id+':'+target.run_id+':'+(target.sandbox_id??''));
    const child=await scan(async tx=>(await tx.query("SELECT o.state,(SELECT count(*) FROM hyperfide.recovery_resource_debts d WHERE d.organisation_id=o.organisation_id AND d.run_id=o.run_id AND d.operation_id=o.operation_id AND d.status<>'RESOLVED')::int AS open FROM hyperfide.recovery_operations o WHERE o.organisation_id=$1 AND o.run_id=$2 AND o.operation_id=$3",[target.organisation_id,target.run_id,childId])).rows[0]);
    if(child){counts.applied++;if(child.open>0||child.state==='PENDING')counts.unsettled++;continue;}
    try{
     await applyScopedControl(deps,{scope,operation_id:childId,scope_kind:target.sandbox_id?'SANDBOX':'RUN',scope_id:target.sandbox_id??target.run_id,mode:intent.mode,reason:('Fleet '+kind+' '+String(intent.mode)+' '+fleet.operation_id+': '+String(intent.reason)).slice(0,1024)},fleet.operation_id);
     counts.applied++;counts.unsettled++;report.children_applied++;
    }catch(error){
     if(NOT_APPLICABLE.includes(errorCode(error))){counts.not_applicable++;report.children_not_applicable++;}
     else{counts.pending++;report.errors.push({operation_id:childId,code:errorCode(error)});}
    }
   }
   if(targets.length<batch)break;
   const last=targets[targets.length-1]!;key=[last.organisation_id,last.run_id,last.sandbox_id??NIL];
  }
  const complete=counts.pending===0&&counts.unsettled===0;
  // A held stop that saw nothing new is not rewritten, so holding costs reads only (jsonb reorders keys: compare by name).
  const unchanged=fleet.state===(complete?'RECONCILED':'APPLIED')&&intent.fanout_complete===complete&&intent.scope_held===true&&Object.entries(counts).every(([name,value])=>(intent.fanout as Record<string,unknown>|undefined)?.[name]===value);
  if(!unchanged)await deps.run(fleetScope,async tx=>{
   await finishOperation(tx,fleetScope,fleet.operation_id,{...intent,fanout:counts,fanout_complete:complete,stop_complete:complete,scope_held:true},complete?'RECONCILED':'APPLIED');
  });
  if(complete&&fleet.state!=='RECONCILED')report.fleet_completed++;
 }
 async function pass():Promise<StopDriverReport>{
  const report:StopDriverReport={started_at:new Date().toISOString(),finished_at:'',fleet_operations:0,children_applied:0,children_not_applicable:0,fleet_completed:0,operations_reconciled:0,operations_finalized:0,errors:[]};
  const base="SELECT o.organisation_id,o.run_id,o.operation_id,r.authority_epoch,o.result FROM hyperfide.recovery_operations o JOIN hyperfide.runs r ON r.organisation_id=o.organisation_id AND r.id=o.run_id WHERE (o.organisation_id,o.run_id,o.operation_id)>($1::uuid,$2::uuid,$3::uuid) AND o.kind='STOP' AND o.state='APPLIED' AND ";
  // Settled fleet stops stay in the scan: they hold their scope against runs and sandboxes admitted later.
  const fleetBase="SELECT o.organisation_id,o.run_id,o.operation_id,r.authority_epoch,o.state,o.result FROM hyperfide.recovery_operations o JOIN hyperfide.runs r ON r.organisation_id=o.organisation_id AND r.id=o.run_id WHERE (o.organisation_id,o.run_id,o.operation_id)>($1::uuid,$2::uuid,$3::uuid) AND o.kind='STOP' AND o.state IN ('APPLIED','RECONCILED') AND ";
  for(let key:[string,string,string]=[NIL,NIL,NIL];;){
   const fleets=await page(fleetBase+"o.result->>'fleet'='true' ORDER BY 1,2,3 LIMIT $4",key,[]);
   for(const fleet of fleets){
    if(signal.aborted)return report;
    report.fleet_operations++;
    try{await fanOut(fleet,report);}catch(error){report.errors.push({operation_id:fleet.operation_id,code:errorCode(error)});}
   }
   if(fleets.length<batch)break;
   const last=fleets[fleets.length-1]!;key=[last.organisation_id,last.run_id,last.operation_id];
  }
  const cleanup=deps.cleanup();
  const open="EXISTS(SELECT 1 FROM hyperfide.recovery_resource_debts d WHERE d.organisation_id=o.organisation_id AND d.run_id=o.run_id AND d.operation_id=o.operation_id AND d.status<>'RESOLVED')";
  const pending="COALESCE(o.result->>'fleet','false')<>'true' AND ("+open+
   " OR (o.result->>'mode' IN ('PAUSE','DRAIN') AND o.result->>'scope_kind'='RUN' AND r.state IN ('PAUSING','DRAINING'))"+
   " OR (o.result->>'mode'='DRAIN' AND EXISTS(SELECT 1 FROM hyperfide.recovery_controls c WHERE c.organisation_id=o.organisation_id AND c.run_id=o.run_id AND c.scope_kind=o.result->>'scope_kind' AND c.scope_id::text=o.result->>'scope_id' AND c.mode='DRAIN' AND c.status='ACTIVE' AND c.deadline_at<=clock_timestamp()))"+
   " OR ($4::boolean AND o.result->>'mode' IN ('STOP','CANCEL')))";
  for(let key:[string,string,string]=[NIL,NIL,NIL];;){
   const operations=await scan(async tx=>(await tx.query(base+pending+" ORDER BY 1,2,3 LIMIT $5",[...key,cleanup!==undefined,batch])).rows as OperationRow[]);
   for(const operation of operations){
    if(signal.aborted)return report;
    const scope=scopeOfRow(operation);
    try{
     const reconciled=await reconcileStop(deps,scope,operation.operation_id);report.operations_reconciled++;
     if(cleanup&&['STOP','CANCEL'].includes(String(operation.result.mode))&&reconciled.unreachable_resource_debt_count===0){
      const finalized=await finalizeStop(deps,cleanup,scope,operation.operation_id);
      if(finalized.stop_complete===true)report.operations_finalized++;
     }
    }catch(error){report.errors.push({operation_id:operation.operation_id,code:errorCode(error)});}
   }
   if(operations.length<batch)break;
   const last=operations[operations.length-1]!;key=[last.organisation_id,last.run_id,last.operation_id];
  }
  report.errors=report.errors.slice(0,64);report.finished_at=new Date().toISOString();
  return report;
 }
 let loop:Promise<void>|undefined,last:StopDriverReport|undefined,lastError:string|undefined,passes=0;
 const sleep=(ms:number)=>new Promise<void>(resolve=>{if(signal.aborted)return resolve();const t=setTimeout(done,ms);function done(){clearTimeout(t);signal.removeEventListener('abort',done);resolve();}signal.addEventListener('abort',done,{once:true});});
 return {
  pass,
  start(){
   if(loop||signal.aborted)return;
   loop=(async()=>{while(!signal.aborted){
    try{last=await pass();lastError=undefined;}catch(error){lastError=errorCode(error);}
    passes++;await sleep(options.intervalMs);
   }})();
  },
  async close(){controller.abort();options.signal.removeEventListener('abort',abort);await loop;},
  status(){return {running:loop!==undefined&&!signal.aborted,interval_ms:options.intervalMs,passes,last_pass:last??null,last_error:lastError??null};}
 };
}
function driverInterval(env:Readonly<NodeJS.ProcessEnv>):number{
 const value=env.HYPERFIDE_STOP_DRIVER_INTERVAL_MS??'5000';
 if(!/^(0|[1-9][0-9]*)$/.test(value)||Number(value)>3600000)throw new FoundationError('RECOVERY_CONFIG_INVALID','HYPERFIDE_STOP_DRIVER_INTERVAL_MS must be 0 (disabled) to 3600000');
 return Number(value);
}
export function createComponent(startup:ComponentContext):Component{
 const interval=driverInterval(startup.env);
 let driver:StopDriver|undefined;
 if(interval>0){
  const gateway=capability(startup,'4.2','storage.transactions.v1',isGateway);
  driver=createStopDriver({gateway,signal:startup.signal,env:startup.env,intervalMs:interval,...capabilitiesOf(startup)});
  driver.start();
 }
 return {apiVersion:1,capabilities:{'recovery.controls.v1':createRecoveryControlCapability()},close:()=>driver?.close(),actions:{
  'recovery.stop.describe':(input)=>{record(input,[]);return {api_version:1,modes:[...modes],scopes:[...RUN_SCOPES,...FLEET_SCOPES],scope_precedence:'RUN_ENCLOSES_PACKAGE_ATTEMPT_SANDBOX',fleet_scopes:'FANNED_OUT_PER_RUN_BY_DRIVER',fleet_scope_held:true,external_stop_requires:'TRUSTED_IDENTITY_BOUND_SUPERVISOR',unreachable_means:'DEBT',
   driver:driver?driver.status():{running:false,interval_ms:0}};},
  'recovery.stop.request':(input,context)=>{
   const kind=typeof input==='object'&&input!==null?(input as Record<string,unknown>).scope_kind:undefined;
   return FLEET_SCOPES.includes(String(kind))?requestFleetControl(input,context):applyScopedControl(invoked(context),input);
  },
  'recovery.stop.finalize':async(input,context)=>{
   const value=record(input,['scope','operation_id']);const scope=scopeOf(value.scope),id=uuid(value.operation_id);
   return finalizeStop(invoked(context),capability(context,'12.4','runner.supervisors.v1',isCleanup),scope,id);
  },
  'recovery.stop.reconcile':async(input,context)=>{
   const value=record(input,['scope','operation_id']);
   return reconcileStop(invoked(context),scopeOf(value.scope),uuid(value.operation_id));
  }
 }};
}
