import {randomUUID} from 'node:crypto';
import type {Component,ComponentContext} from '../components/registry.js';
import {exactAgentObject,agentString,agentDigest,agentTransaction,agentError} from './sessions.js';
import {isAgentAdmissionCapability} from './admission.js';
import type {AgentAdmissionCapability,AdmissionPlanSelection} from './admission.js';
import {requireRunnerDispatch} from '../runner/dispatch.js';
import type {RunnerLaunchPlan,RunnerSpawnInput} from '../runner/dispatch.js';
import {assertInvocation} from '../transport/protocol.js';
import {storedEnvReferences} from './env_refs.js';
import type {InvocationContext} from '../transport/protocol.js';
import {assertPrimaryTransaction} from '../storage/transactions.js';
import type {PrimaryTransaction} from '../storage/transactions.js';
import {object} from '../policy/programme.js';
import {deriveFleetConnectorPlan} from '../runner/fleet_connector_plan.js';
import {readRunnerBinding,readRunnerReadiness,runnerCanonical} from '../runner/bridge.js';
import {assertCurrentCompute} from '../scheduler/leases.js';
import {hash} from '../transport/protocol.js';
import {guardFleetLaunch} from '../runner/fleet.js';

/** Trusted native launch-plan producer for the 12.2 START route. The plan names the admitted
 * connector/model/permission profile for the token's worker session and is persisted once per
 * scheduler command, so a replayed dispatch returns the same plan and never a second launch. */
type Selection={plan:RunnerLaunchPlan|null;reason:string|null;replayed:boolean};
const tokenKeys=['task_id','attempt_id','attempt_generation','authority_epoch','sandbox_id','slot_id','sandbox_boot_generation'] as const;
export function launchPlan(row:Record<string,unknown>):RunnerLaunchPlan{
 const env_refs=storedEnvReferences(row);
 return {launch_id:String(row.launch_id),slot_id:String(row.slot_id),agent_session_id:String(row.agent_session_id),connector_plan_digest:String(row.connector_plan_digest),...(env_refs?{env_refs}:{}),...(object(row.plan)&&row.plan.native_source?{native_source_required:true as const}:{})};
}
/** Persists one immutable plan from an admitted selection; the selection's env_refs (3.15) are stored
 * in their own column and bound into the plan digest when present. */
export async function insertLaunchPlan(tx:Pick<PrimaryTransaction,'query'>,input:RunnerSpawnInput,session_id:string,a:AdmissionPlanSelection,native?:Record<string,unknown>):Promise<RunnerLaunchPlan>{
 const {organisation_id:org,run_id:run,command_id:command,token}=input;
 const launch_id=randomUUID();
 const body={schema_version:1,command_id:command,launch_id,agent_session_id:session_id,slot_id:token.slot_id,attempt_id:token.attempt_id,attempt_generation:String(token.attempt_generation),
  packet_digest:input.packet_digest,connector:a.connector,connector_version:a.connector_version,provider:a.provider,model:a.model,auth_profile:a.auth_profile,
  permission_profile:a.permission_profile,qualification_receipt_digest:a.qualification_digest,admission_reservation_id:a.reservation_id,reservation_attempt:a.reservation_attempt,
  admission_policy_digest:a.policy_digest,run_policy_digest:a.run_policy_digest,native_delegation:false,unattended:true,
  ...(a.gateway?{gateway:{...a.gateway},environment:{...a.environment}}:{}),
  ...(Object.keys(a.env_refs).length?{env_refs:{...a.env_refs}}:{}),...(native??{})};
 const digest=agentDigest(body);
 const row=(await tx.query('INSERT INTO hyperfide.native_launch_plans(organisation_id,run_id,command_id,launch_id,agent_session_id,slot_id,attempt_id,attempt_generation,connector,connector_plan_digest,admission_reservation_id,reservation_attempt,admission_policy_digest,run_policy_digest,qualification_receipt_digest,packet_digest,payload_digest,plan,env_refs) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19::jsonb) RETURNING *',
  [org,run,command,launch_id,session_id,token.slot_id,token.attempt_id,token.attempt_generation,a.connector,digest,a.reservation_id,a.reservation_attempt,a.policy_digest,a.run_policy_digest,a.qualification_digest,input.packet_digest,input.payload_digest,JSON.stringify(body),JSON.stringify(a.env_refs)])).rows[0] as Record<string,unknown>;
 return launchPlan(row);
}
async function select(ctx:ComponentContext,tx:PrimaryTransaction,admission:AgentAdmissionCapability,input:RunnerSpawnInput,invocation:InvocationContext):Promise<Selection>{
 assertPrimaryTransaction(tx);assertInvocation(invocation);await invocation.guard(tx);
 const {organisation_id:org,run_id:run,command_id:command,token}=input;
 if(token.organisation_id!==org||token.run_id!==run||org!==invocation.principal.organisation_id||run!==invocation.principal.run_id)agentError('AGENT_SCOPE_DENIED');
 const existing=(await tx.query('SELECT * FROM hyperfide.native_launch_plans WHERE organisation_id=$1 AND run_id=$2 AND command_id=$3',[org,run,command])).rows[0] as Record<string,unknown>|undefined;
 if(existing){
  if(existing.payload_digest!==input.payload_digest||existing.packet_digest!==input.packet_digest||existing.slot_id!==token.slot_id||existing.attempt_id!==token.attempt_id||String(existing.attempt_generation)!==String(token.attempt_generation))agentError('NATIVE_PLAN_CONFLICT');
  return {plan:launchPlan(existing),reason:null,replayed:true};
 }
 // Independent of the caller: the plan binds only a committed, unresolved scheduler dispatch.
 const dispatch=(await tx.query('SELECT * FROM hyperfide.scheduler_dispatches WHERE organisation_id=$1 AND run_id=$2 AND id=$3 FOR SHARE',[org,run,command])).rows[0] as Record<string,unknown>|undefined;
 if(!dispatch||dispatch.payload_digest!==input.payload_digest||!['INTENT','UNKNOWN'].includes(String(dispatch.state)))return {plan:null,reason:'DISPATCH_NOT_PENDING',replayed:false};
 for(const key of tokenKeys)if(String(dispatch[key])!==String(token[key]))agentError('NATIVE_PLAN_TOKEN_MISMATCH');
 const sessions=(await tx.query("SELECT id FROM hyperfide.agent_sessions WHERE organisation_id=$1 AND run_id=$2 AND role='WORKER' AND attempt_id=$3 AND slot_id=$4 AND sandbox_id=$5 AND sandbox_boot_generation=$6 FOR SHARE",[org,run,token.attempt_id,token.slot_id,token.sandbox_id,token.sandbox_boot_generation])).rows;
 if(sessions.length!==1)return {plan:null,reason:sessions.length?'AGENT_SESSION_AMBIGUOUS':'AGENT_SESSION_UNBOUND',replayed:false};
 const session_id=String(sessions[0]!.id);
 const admitted=await admission.launchSelection(tx,{organisation_id:org,run_id:run,session_id},invocation);
 if(!admitted.selection)return {plan:null,reason:admitted.reason??'ADMISSION_UNAVAILABLE',replayed:false};
 const a=admitted.selection;
 if(a.native_delegation!==false)agentError('ADMISSION_DELEGATION_UNSUPPORTED');
 const consumed=await tx.query('SELECT command_id FROM hyperfide.native_launch_plans WHERE organisation_id=$1 AND run_id=$2 AND admission_reservation_id=$3 AND reservation_attempt=$4',[org,run,a.reservation_id,a.reservation_attempt]);
 if(consumed.rows.length)return {plan:null,reason:'ADMISSION_ATTEMPT_CONSUMED',replayed:false};
 const native=await deriveFleetConnectorPlan(ctx,tx,{organisation_id:org,run_id:run,session_id},a,input.packet_digest);
 return {plan:await insertLaunchPlan(tx,input,session_id,a,native??undefined),reason:null,replayed:false};
}
export function createComponent(ctx:ComponentContext):Component{
 const admission=ctx.dependencies.require('13.4','agent.admission.v1',(value:unknown):value is AgentAdmissionCapability=>isAgentAdmissionCapability(value)&&typeof (value as unknown as Record<string,unknown>).launchSelection==='function');
 const route=requireRunnerDispatch(ctx);
 // Exactly one trusted reader owns the native START route; a second producer fails startup.
 const unregister=route.registerPlanReader(async(tx,input,invocation)=>(await select(ctx,tx,admission,input,invocation)).plan);
 const controller=(invocation:InvocationContext|undefined):InvocationContext=>{
  assertInvocation(invocation);
  if(!['OPERATOR','COORDINATOR','DISPATCH'].includes(invocation.principal.role))agentError('AGENT_ROLE_DENIED');
  return invocation;
 };
 const command=(input:unknown):string=>agentString(exactAgentObject(input,['command_id']).command_id,'uuid');
 return {apiVersion:1,close:()=>unregister(),actions:{
  'agent.launch-plan.describe':async(input,context)=>{
   controller(context.invocation);exactAgentObject(input,[]);
   return {plan_reader_registered:true,route:route.describe(),native_delegation:false,launch_authority:false};
  },
  // Runs the same trusted reader the START route uses against a committed scheduler dispatch.
  'agent.launch-plan.prepare':async(input,context)=>{
   const invocation=controller(context.invocation);const id=command(input);
   return agentTransaction(ctx,invocation,async client=>{
    const tx=client as unknown as PrimaryTransaction;assertPrimaryTransaction(tx);
    const {organisation_id,run_id}=invocation.principal;
    const row=(await tx.query('SELECT d.*,a.input_packet_digest FROM hyperfide.scheduler_dispatches d JOIN hyperfide.attempts a ON a.organisation_id=d.organisation_id AND a.run_id=d.run_id AND a.id=d.attempt_id WHERE d.organisation_id=$1 AND d.run_id=$2 AND d.id=$3',[organisation_id,run_id,id])).rows[0] as Record<string,unknown>|undefined;
    if(!row)agentError('NATIVE_PLAN_DISPATCH_NOT_FOUND');
    const token={organisation_id,run_id,...Object.fromEntries(tokenKeys.map(k=>[k,String(row[k])]))} as RunnerSpawnInput['token'];
    const result=await select(ctx,tx,admission,{organisation_id,run_id,command_id:id,token,packet_digest:String(row.input_packet_digest),payload_digest:String(row.payload_digest)},invocation);
    return {...result,launch_authority:false,native_execution_observed:false};
   });
  },
  'agent.launch-plan.fetch':async(input,context)=>{
   const i=context.invocation;assertInvocation(i);if(i.principal.role!=='RUNNER')agentError('AGENT_ROLE_DENIED');
   const v=exactAgentObject(input,['command_id','launch_id']),command_id=agentString(v.command_id,'uuid'),launch_id=agentString(v.launch_id,'uuid');
   return agentTransaction(ctx,i,async client=>{
    assertPrimaryTransaction(client);const scope={organisation_id:i.principal.organisation_id,run_id:i.principal.run_id};
    const row=(await client.query('SELECT p.*,d.task_id,d.authority_epoch,d.sandbox_id,d.sandbox_boot_generation FROM hyperfide.native_launch_plans p JOIN hyperfide.scheduler_dispatches d ON d.organisation_id=p.organisation_id AND d.run_id=p.run_id AND d.id=p.command_id WHERE p.organisation_id=$1 AND p.run_id=$2 AND p.command_id=$3 AND p.launch_id=$4 FOR SHARE OF p,d',[scope.organisation_id,scope.run_id,command_id,launch_id])).rows[0];
    if(!row||row.sandbox_id!==i.principal.sandbox_id||String(row.sandbox_boot_generation)!==i.principal.boot_generation)agentError('AGENT_SCOPE_DENIED');
    const runner=await readRunnerBinding(client,{...scope,session_id:i.principal.actor_id});
    if(runner.credential_id!==i.principal.credential_id||runner.slot_id!==row.slot_id||runner.boot_id!==i.principal.boot_id)agentError('AGENT_SCOPE_DENIED');
    const compute=await assertCurrentCompute(client,{...scope,task_id:row.task_id,attempt_id:row.attempt_id,attempt_generation:String(row.attempt_generation),authority_epoch:row.authority_epoch,sandbox_id:row.sandbox_id,slot_id:row.slot_id,sandbox_boot_generation:String(row.sandbox_boot_generation)},{operation:'ADVANCE'});
    if(compute.input_packet_digest!==row.packet_digest)agentError('FLEET_NATIVE_PLAN_STALE');
    await guardFleetLaunch(client,i,{...scope,task_id:row.task_id,attempt_id:row.attempt_id,attempt_generation:String(row.attempt_generation),sandbox_id:row.sandbox_id,slot_id:row.slot_id,sandbox_boot_generation:String(row.sandbox_boot_generation)},launchPlan(row));
    const ready=await readRunnerReadiness(client,runner);if(ready.kind!=='FLEET_MANIFEST_V1'||row.plan?.readiness?.readiness_digest!==ready.readiness_digest)agentError('FLEET_NATIVE_PLAN_STALE');
    const bytes=Buffer.from(runnerCanonical(row.plan));if(hash(bytes)!==row.connector_plan_digest)agentError('NATIVE_PLAN_CONFLICT');
    return {command_id,launch_id,connector_plan_digest:row.connector_plan_digest,plan_base64:bytes.toString('base64url')};
   });
  },
  'agent.launch-plan.inspect':async(input,context)=>{
   const invocation=controller(context.invocation);const id=command(input);
   return agentTransaction(ctx,invocation,async client=>{
    const row=(await client.query('SELECT * FROM hyperfide.native_launch_plans WHERE organisation_id=$1 AND run_id=$2 AND command_id=$3',[invocation.principal.organisation_id,invocation.principal.run_id,id])).rows[0];
    if(!object(row))agentError('NATIVE_PLAN_NOT_FOUND');
    return {plan:row,launch_authority:false};
   });
  }
 }};
}
