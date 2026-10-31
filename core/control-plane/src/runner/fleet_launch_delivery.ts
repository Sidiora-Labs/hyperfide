import type {PrimaryTransaction} from '../storage/transactions.js';
import type {BoundProviderRequest} from '../providers/reconcile.js';
import {readRunnerBinding,readRunnerReadiness,taskEnvReferences,runnerCanonical} from './bridge.js';
import {assertCurrentCompute} from '../scheduler/leases.js';
import {fail,hash} from '../transport/protocol.js';
import {FoundationError} from '../policy/programme.js';

export interface FleetLaunchDelivery {organisation_id:string;run_id:string;command_id:string;launch_id:string;runner_session_id:string;authority_epoch:string;request:BoundProviderRequest;request_digest:string;[key:string]:any}
export function fleetForegroundRequest(binding:Record<string,any>,operation:string,env_refs:Readonly<Record<string,string>>):BoundProviderRequest{
 const input={config_path:binding.state_dir+'/runner.json',event_id:operation};
 return {binding:{organisation_id:binding.organisation_id,run_id:binding.run_id,session_id:binding.session_id,pool_id:binding.pool_id,sandbox_id:binding.sandbox_id,external_sandbox_id:binding.external_sandbox_id,boot_generation:String(binding.boot_generation),preparation_digest:binding.boot_preparation_digest},operation_id:operation,
  argv:[binding.runner_binary,'--component','12.2','--action','launch.run','--request-base64',Buffer.from(JSON.stringify(input)).toString('base64url')],cwd:binding.workspace_path,env_refs:{...env_refs},timeout_ms:3600000};
}
export async function claimFleetLaunch(tx:PrimaryTransaction,principal:Record<string,any>):Promise<FleetLaunchDelivery|null>{
 if(!(await tx.query("SELECT to_regclass('hyperfide.fleet_worker_launches') IS NOT NULL AS present")).rows[0]?.present)return null;
 const row=(await tx.query(`SELECT n.*,d.task_id,d.authority_epoch,d.sandbox_id,d.sandbox_boot_generation FROM hyperfide.native_launch_plans n
 JOIN hyperfide.scheduler_dispatches d ON d.organisation_id=n.organisation_id AND d.run_id=n.run_id AND d.id=n.command_id
 JOIN hyperfide.outbox_events e ON e.organisation_id=n.organisation_id AND e.run_id=n.run_id AND e.id=n.command_id AND e.event_type='instruction.start'
 LEFT JOIN hyperfide.fleet_worker_launches f ON f.organisation_id=n.organisation_id AND f.run_id=n.run_id AND f.command_id=n.command_id
 WHERE n.organisation_id=$1 AND n.run_id=$2 AND n.plan->'readiness'->>'kind'='FLEET_MANIFEST_V1' AND f.command_id IS NULL
 ORDER BY n.created_at,n.command_id LIMIT 1 FOR UPDATE OF n SKIP LOCKED`,[principal.organisation_id,principal.run_id])).rows[0];
 if(!row)return null;
 try{
 if(row.authority_epoch!==principal.deployment_epoch)fail('FLEET_LAUNCH_STALE','Pending START belongs to a different authority epoch');
 const current=await assertCurrentCompute(tx,{organisation_id:row.organisation_id,run_id:row.run_id,task_id:row.task_id,attempt_id:row.attempt_id,attempt_generation:String(row.attempt_generation),authority_epoch:row.authority_epoch,sandbox_id:row.sandbox_id,slot_id:row.slot_id,sandbox_boot_generation:String(row.sandbox_boot_generation)},{operation:'ADVANCE'});
 if(current.input_packet_digest!==row.packet_digest)fail('FLEET_LAUNCH_STALE','Pending START packet differs from current compute authority');
 const runners=(await tx.query("SELECT session_id FROM hyperfide.runner_registry WHERE organisation_id=$1 AND run_id=$2 AND sandbox_id=$3 AND boot_generation=$4 AND slot_id=$5 AND state='CURRENT'",[row.organisation_id,row.run_id,row.sandbox_id,row.sandbox_boot_generation,row.slot_id])).rows;
 if(runners.length!==1)fail('FLEET_LAUNCH_RUNNER_REQUIRED','Exactly one current manifest runner required');
 const binding=await readRunnerBinding(tx,{organisation_id:row.organisation_id,run_id:row.run_id,session_id:runners[0]!.session_id}),ready=await readRunnerReadiness(tx,binding);
 if(ready.kind!=='FLEET_MANIFEST_V1'||ready.readiness_digest!==row.plan.readiness.readiness_digest)fail('FLEET_LAUNCH_STALE','Pending START differs from the measured installation');
 const references=await taskEnvReferences(tx,row.organisation_id,binding.pool_id,row.env_refs),request=fleetForegroundRequest(binding,row.command_id,references),request_digest=hash(runnerCanonical(request));
 const inserted=(await tx.query("INSERT INTO hyperfide.fleet_worker_launches(organisation_id,run_id,command_id,launch_id,runner_session_id,executor_credential_id,authority_epoch,request,request_digest,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'CLAIMED') ON CONFLICT DO NOTHING RETURNING *",[row.organisation_id,row.run_id,row.command_id,row.launch_id,binding.session_id,principal.credential_id,row.authority_epoch,JSON.stringify(request),request_digest])).rows[0];
 return inserted?{...inserted,request} as FleetLaunchDelivery:null;
 }catch(error){
  if(!(error instanceof FoundationError))throw error;
  await tx.query("INSERT INTO hyperfide.fleet_worker_launches(organisation_id,run_id,command_id,launch_id,runner_session_id,executor_credential_id,authority_epoch,request,request_digest,state,failure_code,completed_at) SELECT $1,$2,$3,$4,r.session_id,$5,$6,'{}'::jsonb,$7,'REFUSED',$8,clock_timestamp() FROM hyperfide.runner_registry r WHERE r.organisation_id=$1 AND r.run_id=$2 AND r.sandbox_id=$9 AND r.boot_generation=$10 AND r.slot_id=$11 ORDER BY r.session_id LIMIT 1 ON CONFLICT DO NOTHING",[row.organisation_id,row.run_id,row.command_id,row.launch_id,principal.credential_id,row.authority_epoch,hash(runnerCanonical({})),error.code,row.sandbox_id,row.sandbox_boot_generation,row.slot_id]);
  return null;
 }
}
