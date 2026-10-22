import type {ComponentContext} from '../components/registry.js';
import {FoundationError,object} from '../policy/programme.js';
import type {PrimaryTransaction} from '../storage/transactions.js';
import {invocationOf} from '../identity/enrollment.js';
import {record,scopeOf,uuid,recoveryTransaction,operationReplay,finishOperation,capability,derivedOperationId} from './control.js';

// hyperfide-v21 3.16. A fleet stop (POOL, ORGANISATION, DEPLOYMENT) holds its scope until it is released (3.11).
// The hold has two readers: the stop driver keeps fanning a held stop out, and admission refuses new work in a held
// scope up front. Release is the only way to lift a hold. It does not resume what the stop already stopped: per-run
// controls stay as they are and are lifted run by run (recovery.control.resume).

type Query={query:(sql:string,values?:unknown[])=>Promise<{rows:Record<string,unknown>[]}>};
// Held means recorded and not refused (REFUSED rows never fan out) and not released.
const HELD="o.kind='STOP' AND o.state IN ('APPLIED','RECONCILED') AND o.result->>'fleet'='true' AND COALESCE(o.result->>'released','false')<>'true'";
export const HELD_FLEET_STOP=HELD;

export interface HeldStop {organisation_id:string;run_id:string;operation_id:string;scope_kind:string;scope_id:string;mode:string}
/** Every held fleet stop that covers this run (and, when given, the sandbox's pool). */
export async function heldStopsFor(tx:Query,target:{organisation_id:string;run_id:string;sandbox_id?:string|null}):Promise<HeldStop[]>{
 const rows=await tx.query(`SELECT o.organisation_id,o.run_id,o.operation_id,o.result->>'scope_kind' AS scope_kind,o.result->>'scope_id' AS scope_id,o.result->>'mode' AS mode
  FROM hyperfide.recovery_operations o WHERE ${HELD} AND (
   o.result->>'scope_kind'='DEPLOYMENT'
   OR (o.result->>'scope_kind'='ORGANISATION' AND o.organisation_id=$1 AND o.result->>'scope_id'=$1::text)
   OR (o.result->>'scope_kind'='POOL' AND o.organisation_id=$1 AND $2::uuid IS NOT NULL AND o.result->>'scope_id'=(SELECT s.pool_id::text FROM hyperfide.sandboxes s WHERE s.organisation_id=$1 AND s.id=$2::uuid)))
  ORDER BY o.created_at,o.operation_id LIMIT 16`,[target.organisation_id,target.sandbox_id??null]);
 return rows.rows as unknown as HeldStop[];
}
/** Admission refuses a run or sandbox under a held fleet stop instead of admitting it for the driver to stop later. */
export async function assertScopeNotHeld(tx:Query,target:{organisation_id:string;run_id:string;sandbox_id?:string|null}):Promise<void>{
 const held=await heldStopsFor(tx,target);
 if(held.length){
  const first=held[0]!;
  throw new FoundationError('ADMISSION_SCOPE_HELD','Admission refused: '+first.scope_kind+' '+first.scope_id+' is held by fleet '+first.mode+' '+first.operation_id+' until it is released (recovery.stop.release)');
 }
}

interface ReleaseOutbox {enqueue(tx:PrimaryTransaction,value:unknown,options?:{consumer_ids:readonly string[]}):Promise<{event:{id:string};replayed:boolean;obligations:number}>}
const isOutbox=(value:unknown):value is ReleaseOutbox=>object(value)&&typeof value.enqueue==='function';
// Who may lift a hold: the same authority that may place it, except that a run leader may lift a POOL stop.
const RELEASERS:Record<string,string[]>={POOL:['OPERATOR','LEADER'],ORGANISATION:['OPERATOR'],DEPLOYMENT:['OPERATOR']};

/** recovery.stop.release: records the release on the caller's run under its own operation id, marks the held stop
 * RELEASED (result.hold='RELEASED', released_by, reason) and emits recovery.stop.released to the caller run's standing
 * consumers. A refused release is recorded as REFUSED and fails, replay included, like a refused DEPLOYMENT stop. */
export async function releaseFleetStop(input:unknown,context:ComponentContext,deploymentOperators:(env:Readonly<Record<string,string|undefined>>)=>string[]):Promise<Record<string,unknown>>{
 const value=record(input,['scope','operation_id','stop_operation_id','reason']);
 const scope=scopeOf(value.scope),id=uuid(value.operation_id),stopId=uuid(value.stop_operation_id);
 if(typeof value.reason!=='string'||value.reason.length<1||value.reason.length>1024)throw new FoundationError('RECOVERY_INPUT_INVALID','A release needs a reason of 1 to 1024 characters');
 const principal=invocationOf(context).principal;
 const result:Record<string,unknown>=await recoveryTransaction(context,scope,async (tx):Promise<Record<string,unknown>>=>{
  const replay=await operationReplay(tx,scope,id,'STOP',value);if(replay)return replay;
  const found=await tx.query("SELECT o.organisation_id,o.run_id,o.state,o.result FROM hyperfide.recovery_operations o WHERE o.operation_id=$1 AND o.kind='STOP' AND o.result->>'fleet'='true' AND o.state IN ('APPLIED','RECONCILED') AND (o.organisation_id=$2 OR o.result->>'scope_kind'='DEPLOYMENT') FOR UPDATE",[stopId,scope.organisation_id]);
  if(found.rows.length!==1)throw new FoundationError('RECOVERY_OPERATION_INVALID','No held fleet stop with that operation id is visible to this principal');
  const stop=found.rows[0]!,intent=stop.result as Record<string,unknown>,kind=String(intent.scope_kind);
  const at=(await tx.query('SELECT clock_timestamp() AS at')).rows[0]!.at;
  const actor={credential_id:principal.credential_id,actor_id:principal.actor_id,role:principal.role,organisation_id:principal.organisation_id,run_id:principal.run_id};
  const base={scope,operation_id:id,release:true,stop_operation_id:stopId,stop_scope_kind:kind,stop_scope_id:intent.scope_id,reason:value.reason};
  const denial=!RELEASERS[kind]?.includes(principal.role)?{code:'RECOVERY_RELEASE_ROLE_DENIED',message:'Role '+principal.role+' cannot release a '+kind+' stop'}
   :kind==='DEPLOYMENT'&&!deploymentOperators(context.env).includes(principal.credential_id)?{code:'RECOVERY_DEPLOYMENT_OPERATOR_DENIED',message:'Releasing a deployment stop requires an operator credential on HYPERFIDE_DEPLOYMENT_OPERATORS'}:null;
  if(denial){
   const refused={...base,refused:true,refused_by:actor,refused_at:at,error:denial};
   await finishOperation(tx,scope,id,refused,'REFUSED');return refused;
  }
  if(intent.released===true){
   const already={...base,released:true,already_released:true,released_by:intent.released_by,released_at:intent.released_at,release_operation_id:intent.release_operation_id};
   await finishOperation(tx,scope,id,already,'RECONCILED');return already;
  }
  const stopScope={organisation_id:String(stop.organisation_id),run_id:String(stop.run_id)};
  await tx.query('UPDATE hyperfide.recovery_operations SET result=$4::jsonb,updated_at=clock_timestamp() WHERE organisation_id=$1 AND run_id=$2 AND operation_id=$3',
   [stopScope.organisation_id,stopScope.run_id,stopId,JSON.stringify({...intent,hold:'RELEASED',released:true,scope_held:false,released_by:actor,released_at:at,release_reason:value.reason,release_operation_id:id})]);
  const outbox=capability(context,'6.1','events.outbox.v1',isOutbox);
  const event=await outbox.enqueue(tx as unknown as PrimaryTransaction,{organisation_id:scope.organisation_id,run_id:scope.run_id,id:derivedOperationId(id,'recovery.stop.released'),
   aggregate_type:'recovery_stop',aggregate_id:stopId,aggregate_version:'1',event_type:'recovery.stop.released',
   payload:{schema_version:1,stop_operation_id:stopId,stop_organisation_id:stopScope.organisation_id,stop_run_id:stopScope.run_id,scope_kind:kind,scope_id:intent.scope_id,mode:intent.mode,release_operation_id:id,released_by:actor,reason:value.reason}});
  const released={...base,released:true,already_released:false,released_by:actor,released_at:at,event_id:event.event.id,event_obligations:event.obligations,
   per_run_controls:'UNCHANGED_RESUME_PER_RUN'};
  await finishOperation(tx,scope,id,released,'RECONCILED');return released;
 });
 const error=result.refused===true?result.error as {code?:unknown;message?:unknown}|undefined:undefined;
 if(error)throw new FoundationError(String(error.code),String(error.message)+' (refusal recorded as operation '+String(result.operation_id)+')');
 return result;
}
