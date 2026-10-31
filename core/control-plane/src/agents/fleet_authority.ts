import {readFileSync} from 'node:fs';
import type {PrimaryTransaction} from '../storage/transactions.js';
import {assertPrimaryTransaction} from '../storage/transactions.js';
import {assertInvocation} from '../transport/protocol.js';
import type {InvocationContext} from '../transport/protocol.js';
import {requireAuthority,uuid,decimal,hash,canonical} from '../hierarchy/packages.js';
import {FoundationError,object} from '../policy/programme.js';
import {validateDecision} from '../contracts/fleet/index.mjs';
export type FleetDecision=ReturnType<typeof validateDecision>;
export interface FleetActorBinding {actor_id:string;actor_role:'PRIMARY'|'WAVE_MANAGER';authority_epoch:string;leader_generation:string;delegation_id:string|null;manager_generation:string|null}
export function fleetError(code:string):never{throw new FoundationError(code,'Fleet operation refused: '+code);}
export function localProcessIdentity(pid=process.pid):{pid:number;start_time:string;kernel_boot_id:string}{
 const stat=readFileSync('/proc/'+pid+'/stat','utf8');const fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');
 return {pid,start_time:fields[19]!,kernel_boot_id:readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()};
}
export async function assertFleetActor(tx:PrimaryTransaction,i:InvocationContext,b:FleetActorBinding):Promise<{cohort_id:string;host_id:string;leader_generation:string;package_id:string|null;manager_generation:string|null}>{
 assertPrimaryTransaction(tx);assertInvocation(i);await i.guard(tx);
 if(b.actor_id!==i.principal.actor_id||b.authority_epoch!==i.principal.deployment_epoch||!['LEADER','FEATURE_MANAGER'].includes(i.principal.role)||i.principal.role!==(b.actor_role==='PRIMARY'?'LEADER':'FEATURE_MANAGER'))fleetError('FLEET_ACTOR_MISMATCH');
 const authority=await requireAuthority(tx,{organisation_id:i.principal.organisation_id,run_id:i.principal.run_id,session_id:b.actor_id,authority_epoch:b.authority_epoch,leader_generation:b.leader_generation,roles:[b.actor_role==='PRIMARY'?'LEADER':'FEATURE_MANAGER'],...(b.delegation_id?{package_id:b.delegation_id,package_generation:b.manager_generation!}:{})});
 const row=(await tx.query('SELECT c.*,s.cohort_generation AS session_cohort_generation,s.delegation_id,s.manager_generation,s.actor_role FROM hyperfide.fleet_cohorts c JOIN hyperfide.fleet_actor_sessions s ON s.organisation_id=c.organisation_id AND s.run_id=c.run_id AND s.cohort_id=c.id WHERE c.organisation_id=$1 AND c.run_id=$2 AND s.session_id=$3 FOR SHARE OF c,s',[i.principal.organisation_id,i.principal.run_id,b.actor_id])).rows[0];
 if(!row||row.authority_epoch!==b.authority_epoch||String(row.leader_generation)!==b.leader_generation||String(row.cohort_generation)!==String(row.session_cohort_generation)||row.actor_role!==b.actor_role||row.delegation_id!==b.delegation_id||String(row.manager_generation??'')!==String(b.manager_generation??''))fleetError('FLEET_COHORT_STALE');
 let identity;try{identity=localProcessIdentity(Number(row.controller_identity.pid));}catch{fleetError('FLEET_SUPERVISOR_UNAVAILABLE');}
 if(hash(identity)!==hash(row.controller_identity)||identity.kernel_boot_id!==localProcessIdentity().kernel_boot_id)fleetError('FLEET_SUPERVISOR_STALE');
 return {cohort_id:String(row.id),host_id:String(row.host_id),leader_generation:authority.leader_generation,package_id:b.delegation_id,manager_generation:b.manager_generation};
}
export async function getFleetDelegation(tx:PrimaryTransaction,i:InvocationContext,d:unknown):Promise<{package_id:string;manager_session_id:string;manager_generation:string;budget:Record<string,unknown>}>{
 const decision=validateDecision(d);await assertFleetActor(tx,i,decision);
 if(decision.actor_role!=='WAVE_MANAGER'||!decision.delegation_id)fleetError('FLEET_DELEGATION_REQUIRED');
 const r=(await tx.query('SELECT * FROM hyperfide.fleet_delegations WHERE organisation_id=$1 AND run_id=$2 AND package_id=$3 FOR SHARE',[i.principal.organisation_id,i.principal.run_id,decision.delegation_id])).rows[0];
 if(!r||r.manager_session_id!==decision.actor_id||String(r.manager_generation)!==decision.manager_generation||String(r.leader_generation)!==decision.leader_generation||!object(r.budget)||!Array.isArray(r.budget.allowed_actions)||!r.budget.allowed_actions.includes(decision.action))fleetError('FLEET_DELEGATION_STALE');
 return {package_id:String(r.package_id),manager_session_id:String(r.manager_session_id),manager_generation:String(r.manager_generation),budget:r.budget};
}
export async function withAdmittedDecision(tx:PrimaryTransaction,i:InvocationContext,value:unknown,expectedAction:string,handler:(decision:FleetDecision)=>Promise<Record<string,unknown>>):Promise<Record<string,unknown>>{
 assertPrimaryTransaction(tx);assertInvocation(i);await i.guard(tx);
 const d=validateDecision(value);if(d.action!==expectedAction||d.actor_id!==i.principal.actor_id||d.run_id!==i.principal.run_id)fleetError('FLEET_DECISION_SCOPE');
 const p=[i.principal.organisation_id,i.principal.run_id],digest=hash(d);
 await assertFleetActor(tx,i,d);
 const prior=(await tx.query('SELECT * FROM hyperfide.fleet_effect_receipts WHERE organisation_id=$1 AND run_id=$2 AND operation_id=$3',[...p,d.operation_id])).rows[0];
 if(prior){if(prior.payload_digest!==digest||prior.decision_id!==d.decision_id)fleetError('FLEET_OPERATION_CONFLICT');return {...prior.result,replayed:true};}
 const stored=(await tx.query('SELECT d.*,r.state AS reasoning_state,o.cohort_generation AS observed_cohort_generation FROM hyperfide.fleet_decisions d JOIN hyperfide.fleet_reasoning r ON r.organisation_id=d.organisation_id AND r.run_id=d.run_id AND r.id=d.reasoning_id JOIN hyperfide.fleet_observations o ON o.organisation_id=r.organisation_id AND o.run_id=r.run_id AND o.id=r.observation_id WHERE d.organisation_id=$1 AND d.run_id=$2 AND d.id=$3 FOR SHARE OF d,r',[...p,d.decision_id])).rows[0];
 if(!stored||stored.reasoning_state!=='COMPLETED'||stored.payload_digest!==digest||canonical(stored.body)!==canonical(d))fleetError('FLEET_MODEL_DECISION_REQUIRED');
 const cohort=(await tx.query('SELECT cohort_generation FROM hyperfide.fleet_cohorts WHERE organisation_id=$1 AND run_id=$2 FOR SHARE',p)).rows[0];if(String(cohort?.cohort_generation)!==String(stored.observed_cohort_generation))fleetError('FLEET_OBSERVATION_STALE');
 const current=(await tx.query('SELECT spec_revision_id::text FROM hyperfide.runs WHERE organisation_id=$1 AND id=$2 FOR SHARE',p)).rows[0];
 if(!current||current.spec_revision_id!==d.spec_revision)fleetError('FLEET_SPEC_STALE');
 const source=(await tx.query('SELECT source_object_id FROM hyperfide.run_repositories WHERE organisation_id=$1 AND run_id=$2 ORDER BY repository_id LIMIT 1',p)).rows[0];if(!source||'git:'+source.source_object_id!==d.source_revision)fleetError('FLEET_SOURCE_STALE');
 const session=(await tx.query('SELECT plan_generation::text FROM hyperfide.fleet_actor_sessions WHERE organisation_id=$1 AND run_id=$2 AND session_id=$3 FOR UPDATE',[...p,d.actor_id])).rows[0];
 if(session?.plan_generation!==d.expected_version)fleetError('FLEET_PLAN_STALE');
 if(d.actor_role==='WAVE_MANAGER')await getFleetDelegation(tx,i,d);
 const result=await handler(d);
 await tx.query('INSERT INTO hyperfide.fleet_effect_receipts(organisation_id,run_id,operation_id,decision_id,payload_digest,result) VALUES($1,$2,$3,$4,$5,$6)',[...p,d.operation_id,d.decision_id,digest,result]);
 await tx.query('UPDATE hyperfide.fleet_actor_sessions SET plan_generation=plan_generation+1,updated_at=clock_timestamp() WHERE organisation_id=$1 AND run_id=$2 AND session_id=$3',[...p,d.actor_id]);
 return {...result,replayed:false};
}
export function validateFleetBudget(value:unknown):Record<string,unknown>{
 if(!object(value)||Object.keys(value).sort().join(',')!==['allowed_actions','max_concurrent_workers','max_sandboxes','profile_ids','provider_ids','task_ids'].sort().join(','))fleetError('FLEET_BUDGET_INVALID');
 for(const k of ['allowed_actions','profile_ids','provider_ids','task_ids'])if(!Array.isArray(value[k])||value[k].length>256||value[k].some((v:unknown)=>typeof v!=='string'||!v||v.length>256)||new Set(value[k]).size!==value[k].length)fleetError('FLEET_BUDGET_INVALID');
 for(const k of ['max_sandboxes','max_concurrent_workers'])if(!Number.isSafeInteger(value[k])||Number(value[k])<1||Number(value[k])>10000)fleetError('FLEET_BUDGET_INVALID');
 for(const id of value.task_ids as string[])uuid(id);return value;
}
export function binding(value:Record<string,unknown>):FleetActorBinding{
 const actor_id=uuid(value.actor_id),authority_epoch=uuid(value.authority_epoch),leader_generation=decimal(value.leader_generation);
 if(!['PRIMARY','WAVE_MANAGER'].includes(String(value.actor_role)))fleetError('FLEET_ACTOR_MISMATCH');
 const delegation_id=value.delegation_id===null?null:uuid(value.delegation_id),manager_generation=value.manager_generation===null?null:decimal(value.manager_generation);
 if((value.actor_role==='WAVE_MANAGER')!==(delegation_id!==null&&manager_generation!==null))fleetError('FLEET_DELEGATION_REQUIRED');
 return {actor_id,actor_role:value.actor_role as FleetActorBinding['actor_role'],authority_epoch,leader_generation,delegation_id,manager_generation};
}
