import {fleetCompletionNativeOperation} from '../runner/fleet_completion.js';
import {createPublicKey,verify} from 'node:crypto';
import type {PrimaryTransaction} from '../storage/transactions.js';
import type {InvocationContext} from '../transport/protocol.js';
import {assertInvocation,hash,fail} from '../transport/protocol.js';
import {object} from '../policy/programme.js';
import {runnerCanonical} from '../runner/bridge.js';
type Data=Record<string,any>;
export function fleetCompletionId(identity:unknown):string{
 const bytes=Buffer.from(hash(runnerCanonical(identity)).slice(7,39),'hex');bytes[6]=(bytes[6]!&15)|80;bytes[8]=(bytes[8]!&63)|128;const h=bytes.toString('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
/** Mechanical preservation follows the launch already selected and admitted by the manager. */
export async function projectFleetCompletionCommands(tx:PrimaryTransaction,i:InvocationContext,input:{after:string|null;limit:number}):Promise<Data>{
 assertInvocation(i);if(!['OPERATOR','COORDINATOR'].includes(i.principal.role))fail('FLEET_COMPLETION_ROLE','Privileged mechanical completion authority required');await i.guard(tx);
 const rows=(await tx.query(`SELECT f.*,n.agent_session_id,n.attempt_id,n.attempt_generation::text,n.slot_id,a.task_id,a.sandbox_id,a.sandbox_boot_generation::text,r.boot_id,r.state_dir,r.runner_binary,p.public_key_b64
  FROM hyperfide.fleet_worker_launches f JOIN hyperfide.native_launch_plans n ON n.organisation_id=f.organisation_id AND n.run_id=f.run_id AND n.launch_id=f.launch_id
  JOIN hyperfide.attempts a ON a.organisation_id=n.organisation_id AND a.run_id=n.run_id AND a.id=n.attempt_id AND a.generation=n.attempt_generation
  JOIN hyperfide.tasks t ON t.organisation_id=a.organisation_id AND t.run_id=a.run_id AND t.id=a.task_id AND t.current_attempt_id=a.id AND t.generation=a.generation
  JOIN hyperfide.runner_registry r ON r.organisation_id=f.organisation_id AND r.run_id=f.run_id AND r.session_id=f.runner_session_id AND r.sandbox_id=a.sandbox_id AND r.slot_id=a.slot_id AND r.boot_generation=a.sandbox_boot_generation
  JOIN hyperfide.fleet_runtime_readiness q ON q.organisation_id=r.organisation_id AND q.run_id=r.run_id AND q.runner_session_id=r.session_id AND q.readiness_digest=r.readiness_digest AND q.publication->>'kind'='FLEET_MANIFEST_V1'
  JOIN hyperfide.sandboxes sb ON sb.organisation_id=r.organisation_id AND sb.id=r.sandbox_id AND sb.boot_generation=r.boot_generation
  JOIN hyperfide.sandbox_boots boot ON boot.organisation_id=sb.organisation_id AND boot.sandbox_id=sb.id AND boot.boot_generation=sb.boot_generation AND boot.boot_id=r.boot_id
  JOIN hyperfide.identity_principals p ON p.credential_id=f.executor_credential_id AND p.role='PROVISIONER'
  WHERE f.organisation_id=$1 AND f.run_id=$2 AND f.state='COMPLETED' AND f.authority_epoch=$3 AND r.readiness_digest IS NOT NULL
  AND ($4::uuid IS NULL OR f.launch_id>$4) ORDER BY f.launch_id LIMIT $5`,[i.principal.organisation_id,i.principal.run_id,i.principal.deployment_epoch,input.after,input.limit])).rows;
 const commands:Data[]=[],waiting:Data[]=[];
 for(const r of rows){
  if(typeof r.public_key_b64!=='string'||typeof r.result_signature!=='string'||!object(r.result)||hash(runnerCanonical(r.result))!==r.result_digest||r.result.launch_id!==r.launch_id||r.result.command_id!==r.command_id||r.result.request_digest!==r.request_digest||!object(r.result.native)||r.result.native.terminal_observed!==true||r.result.native.foreground_owner!==true)continue;
  const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(r.public_key_b64,'base64url')]),format:'der',type:'spki'});
  if(!verify(null,Buffer.from(runnerCanonical(r.result)),key,Buffer.from(r.result_signature,'base64url')))continue;
  const identity={organisation_id:r.organisation_id,run_id:r.run_id,launch_id:r.launch_id,attempt_id:r.attempt_id,attempt_generation:r.attempt_generation};
  let command_id=fleetCompletionId({...identity,step:'STOP'});
  const latest=(await tx.query('SELECT c.*,issuer.role AS issuer_role FROM hyperfide.runner_control_commands c JOIN hyperfide.identity_principals issuer ON issuer.credential_id=c.issued_by_credential_id WHERE c.organisation_id=$1 AND c.run_id=$2 AND c.launch_id=$3 ORDER BY c.fence_sequence DESC LIMIT 1',[r.organisation_id,r.run_id,r.launch_id])).rows[0];
  if(!latest){commands.push({operation_id:fleetCompletionId({...identity,step:'ISSUE_STOP'}),component:'12.4',action:'runner.control.issue',input:{command_id,action:'runner.stop',launch_id:r.launch_id,slot_id:r.slot_id,sandbox_id:r.sandbox_id,boot_generation:r.sandbox_boot_generation,attempt_id:r.attempt_id,attempt_generation:r.attempt_generation,policy:{grace_ms:0,drain_deadline_ms:30000,on_drain_deadline:'STOP'},required_outputs:['launch.stdout','launch.stderr']}});continue;}
  if(!['OPERATOR','COORDINATOR'].includes(latest.issuer_role)||latest.attempt_id!==r.attempt_id||String(latest.attempt_generation)!==r.attempt_generation||latest.slot_id!==r.slot_id||latest.sandbox_id!==r.sandbox_id||latest.boot_id!==r.boot_id||String(latest.boot_generation)!==r.sandbox_boot_generation||latest.authority_epoch!==i.principal.deployment_epoch||latest.action!=='runner.stop'||latest.state!=='REPORTED'||latest.cleanup_complete!==true||latest.outcome!=='STOPPED'||latest.termination!=='CONFIRMED'){const native_operation_id=fleetCompletionNativeOperation({kind:'FLEET_COMPLETION_NATIVE_V1',phase:'STOP',organisation_id:r.organisation_id,run_id:r.run_id,launch_id:r.launch_id,command_id:latest.command_id});const retained=(await tx.query('SELECT state FROM hyperfide.provider_remote_operations WHERE organisation_id=$1 AND run_id=$2 AND id=$3',[r.organisation_id,r.run_id,native_operation_id])).rows[0];waiting.push({launch_id:r.launch_id,state:retained?'NATIVE_STOP_RECONCILIATION_REQUIRED':'WAITING_SIGNED_STOP',...(retained?{native_operation_id,native_operation_state:retained.state}:{} )});continue;}
  command_id=latest.command_id;
  const target={state_dir:r.state_dir,launch_id:r.launch_id,attempt_id:r.attempt_id,attempt_generation:r.attempt_generation,sandbox_id:r.sandbox_id,boot_id:r.boot_id,boot_generation:r.sandbox_boot_generation,command_id};
  const argv=[r.runner_binary,'--component','12.4','--action','runner.stop','--request-base64',Buffer.from(JSON.stringify(target)).toString('base64url')];
  const remote=(await tx.query(`SELECT id FROM hyperfide.provider_remote_operations WHERE organisation_id=$1 AND run_id=$2 AND session_id=$3 AND sandbox_id=$4 AND boot_generation=$5 AND state='OBSERVED' AND operation->'parameters'->'argv'=$6::jsonb AND outcome->>'status'='SUCCEEDED' AND outcome->'result'->>'phase'='EXITED' AND outcome->'result'->>'exit_code'='0' AND outcome->'result'->>'termination_confirmed'='true' ORDER BY created_at DESC,id LIMIT 1`,[r.organisation_id,r.run_id,r.runner_session_id,r.sandbox_id,r.sandbox_boot_generation,JSON.stringify(argv)])).rows[0];
  if(!remote){waiting.push({launch_id:r.launch_id,state:'WAITING_NATIVE_STOP_CAPTURE'});continue;}
  const request_id=fleetCompletionId({...identity,step:'ARCHIVE'});
  const archive=(await tx.query('SELECT state FROM hyperfide.fleet_source_archive_deliveries WHERE organisation_id=$1 AND run_id=$2 AND operation_id=$3',[r.organisation_id,r.run_id,request_id])).rows[0];
  if(archive?.state==='COMPLETED'){const native_operation_id=fleetCompletionNativeOperation({kind:'FLEET_COMPLETION_NATIVE_V1',phase:'RELEASE',organisation_id:r.organisation_id,run_id:r.run_id,launch_id:r.launch_id,command_id});const retained=(await tx.query(`SELECT o.state FROM hyperfide.provider_remote_operations o JOIN hyperfide.runner_workspaces w ON w.organisation_id=o.organisation_id AND w.run_id=o.run_id AND w.sandbox_id=o.sandbox_id AND w.boot_generation=o.boot_generation AND w.slot_id=$4 WHERE o.organisation_id=$1 AND o.run_id=$2 AND o.id=$3 AND w.state<>'FREE'`,[r.organisation_id,r.run_id,native_operation_id,r.slot_id])).rows[0];if(retained)waiting.push({launch_id:r.launch_id,state:'NATIVE_RELEASE_RECONCILIATION_REQUIRED',native_operation_id,native_operation_state:retained.state});continue;}
  // Null RPC identity lets the supervisor journal a fresh poll while request_id keeps one capture.
  commands.push({operation_id:null,component:'16.1',action:'submission.archive.register',input:{organisation_id:r.organisation_id,run_id:r.run_id,request_id,task_id:r.task_id,attempt_id:r.attempt_id,attempt_generation:r.attempt_generation,session_id:r.agent_session_id,launch_id:r.launch_id,command_id,quiescence_operation_id:remote.id}});
 }
 return {commands,waiting,next_cursor:rows.length===input.limit?rows.at(-1)!.launch_id:null};
}
