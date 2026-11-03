import {createPublicKey,verify} from 'node:crypto';
import type {PrimaryTransaction} from '../storage/transactions.js';
import {assertPrimaryTransaction} from '../storage/transactions.js';
import {hash,fail} from '../transport/protocol.js';
import {runnerCanonical} from './bridge.js';
import {readNativeFleetCleanup} from '../source_control/fleet-cleanup.js';
export interface FleetCompletionTarget {phase:'STOP'|'RELEASE';session_id:string;launch_id:string;command_id:string;organisation_id:string;run_id:string;authority_epoch:string;operation_id:string;binding:Record<string,any>}
export function fleetCompletionNativeOperation(identity:Record<string,string>):string{const h=hash(runnerCanonical(identity)).slice(7);return h.slice(0,8)+'-'+h.slice(8,12)+'-4'+h.slice(13,16)+'-a'+h.slice(17,20)+'-'+h.slice(20,32);}
interface CompletionCursor{completion_time:string;control_time:string;launch_id:string}
const completionCursors=new Map<string,CompletionCursor>();
export async function nextFleetCompletion(tx:PrimaryTransaction,principal:Record<string,any>,selected?:{command_id:string;launch_id:string;session_id:string}):Promise<FleetCompletionTarget|null>{
 assertPrimaryTransaction(tx);
 const cursorKey=[principal.organisation_id,principal.run_id,principal.credential_id,principal.deployment_epoch].join(':');
 const cursor=selected?undefined:completionCursors.get(cursorKey);
 const present=(await tx.query("SELECT to_regclass('hyperfide.fleet_source_archive_custodies') IS NOT NULL AS archive, to_regclass('hyperfide.source_fleet_assignments') IS NOT NULL AS native")).rows[0];if(!present?.archive&&!present?.native)return null;
 const archiveComplete=present.archive?`EXISTS(SELECT 1 FROM hyperfide.fleet_source_archive_custodies a
 JOIN hyperfide.artifacts bytes ON bytes.organisation_id=a.organisation_id AND bytes.run_id=a.run_id AND bytes.id=a.archive_artifact_id AND bytes.status='COMPLETE' AND bytes.storage_backend='s3-v1'
 JOIN hyperfide.artifacts receipt ON receipt.organisation_id=a.organisation_id AND receipt.run_id=a.run_id AND receipt.id=a.capture_receipt_artifact_id AND receipt.status='COMPLETE' AND receipt.storage_backend='s3-v1'
 WHERE a.organisation_id=f.organisation_id AND a.run_id=f.run_id AND a.launch_id=f.launch_id AND a.command_id=c.command_id
 AND a.sandbox_id=c.sandbox_id AND a.boot_id=c.boot_id AND a.boot_generation=c.boot_generation AND a.attempt_id=c.attempt_id AND a.attempt_generation=c.attempt_generation)`:'false';
 const nativeAssignment=present.native?`(EXISTS(SELECT 1 FROM hyperfide.source_fleet_assignments native WHERE native.organisation_id=f.organisation_id AND native.run_id=f.run_id AND native.attempt_id=c.attempt_id AND native.attempt_generation=c.attempt_generation) OR EXISTS(SELECT 1 FROM hyperfide.fleet_runtime_readiness ready WHERE ready.organisation_id=r.organisation_id AND ready.run_id=r.run_id AND ready.runner_session_id=r.session_id AND ready.readiness_digest=r.readiness_digest AND ready.publication->>'source_backend'='native'))`:'false';
 const rows=(await tx.query(`WITH candidates AS (SELECT f.completed_at::text AS completion_time,c.issued_at::text AS control_time,f.command_id AS start_command_id,f.launch_id AS completion_launch_id,f.runner_session_id,f.result,f.result_digest,f.result_signature,f.request_digest,k.public_key_b64,
 c.command_id,c.attempt_id AS completion_attempt_id,c.attempt_generation::text AS completion_attempt_generation,c.state AS control_state,c.outcome,c.termination,c.cleanup_complete,c.authority_epoch,
 r.*,s.pool_id,s.native_sandbox_id AS external_sandbox_id,p.provider,
 ${archiveComplete} AS archive_complete, ${nativeAssignment} AS native_assignment
 FROM hyperfide.fleet_worker_launches f
 JOIN hyperfide.identity_principals k ON k.credential_id=f.executor_credential_id AND k.organisation_id=f.organisation_id AND k.run_id=f.run_id AND k.role='PROVISIONER'
 JOIN hyperfide.runner_control_commands c ON c.organisation_id=f.organisation_id AND c.run_id=f.run_id AND c.launch_id=f.launch_id AND c.action='runner.stop'
 JOIN hyperfide.identity_principals issuer ON issuer.credential_id=c.issued_by_credential_id AND issuer.organisation_id=c.organisation_id AND issuer.run_id=c.run_id AND issuer.role IN ('OPERATOR','COORDINATOR')
 JOIN hyperfide.runner_registry r ON r.organisation_id=f.organisation_id AND r.run_id=f.run_id AND r.session_id=f.runner_session_id AND r.sandbox_id=c.sandbox_id AND r.boot_id=c.boot_id AND r.boot_generation=c.boot_generation AND r.slot_id=c.slot_id
 JOIN hyperfide.sandboxes s ON s.organisation_id=r.organisation_id AND s.id=r.sandbox_id AND s.boot_generation=r.boot_generation
 JOIN hyperfide.sandbox_boots boot ON boot.organisation_id=r.organisation_id AND boot.sandbox_id=r.sandbox_id AND boot.boot_generation=r.boot_generation AND boot.boot_id=r.boot_id
 JOIN hyperfide.provider_pools p ON p.organisation_id=s.organisation_id AND p.id=s.pool_id
 JOIN hyperfide.runner_workspaces w ON w.organisation_id=c.organisation_id AND w.run_id=c.run_id AND w.sandbox_id=c.sandbox_id AND w.boot_generation=c.boot_generation AND w.slot_id=c.slot_id AND w.launch_id=c.launch_id AND w.state<>'FREE'
 WHERE f.organisation_id=$1 AND f.run_id=$2 AND f.state='COMPLETED' AND c.authority_epoch=$3
 AND (c.state IN('ISSUED','DELIVERED') OR c.state='REPORTED' AND c.outcome='STOPPED' AND c.termination='CONFIRMED' AND c.cleanup_complete=true)
 AND ($4::uuid IS NULL OR c.command_id=$4 AND f.launch_id=$5 AND f.runner_session_id=$6)
 AND NOT EXISTS(SELECT 1 FROM hyperfide.runner_control_commands newer WHERE newer.organisation_id=c.organisation_id AND newer.run_id=c.run_id AND newer.launch_id=c.launch_id AND newer.fence_sequence>c.fence_sequence)
 ) SELECT * FROM candidates WHERE (control_state IN ('ISSUED','DELIVERED') OR archive_complete OR native_assignment) AND ($7::timestamptz IS NULL OR (completion_time::timestamptz,control_time::timestamptz,completion_launch_id)>($7::timestamptz,$8::timestamptz,$9::uuid)) ORDER BY completion_time::timestamptz,control_time::timestamptz,completion_launch_id LIMIT 100`,[principal.organisation_id,principal.run_id,principal.deployment_epoch,selected?.command_id??null,selected?.launch_id??null,selected?.session_id??null,cursor?.completion_time??null,cursor?.control_time??null,cursor?.launch_id??null])).rows;
 const advance=(row:Record<string,any>)=>{completionCursors.set(cursorKey,{completion_time:row.completion_time,control_time:row.control_time,launch_id:row.completion_launch_id});if(completionCursors.size>1024)completionCursors.delete(completionCursors.keys().next().value!);};
 const operationFor=(row:Record<string,any>)=>fleetCompletionNativeOperation({kind:'FLEET_COMPLETION_NATIVE_V1',phase:row.control_state==='REPORTED'?'RELEASE':'STOP',organisation_id:principal.organisation_id,run_id:principal.run_id,launch_id:row.completion_launch_id,command_id:row.command_id});
 const retained=new Set(selected||!rows.length?[]:(await tx.query('SELECT id FROM hyperfide.provider_remote_operations WHERE organisation_id=$1 AND run_id=$2 AND id=ANY($3::uuid[])',[principal.organisation_id,principal.run_id,rows.map(operationFor)])).rows.map(r=>r.id));
 for(const row of rows){
 const result=row.result;
 if(!result||result.command_id!==row.start_command_id||result.launch_id!==row.completion_launch_id||result.request_digest!==row.request_digest||result.native?.foreground_owner!==true||result.native?.terminal_observed!==true||!Number.isInteger(result.native?.exit_code)||result.native.exit_code>255||result.native.exit_code<0&&!(result.native.exit_code===-1&&['STOPPED','LEASE_EXPIRED'].includes(result.native.state))||hash(runnerCanonical(result))!==row.result_digest||typeof row.public_key_b64!=='string'||typeof row.result_signature!=='string')fail('FLEET_COMPLETION_RESULT_INVALID','Exact signed terminal foreground result required');
 const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(row.public_key_b64,'base64url')]),format:'der',type:'spki'});
 if(!verify(null,Buffer.from(runnerCanonical(result)),key,Buffer.from(row.result_signature,'base64url')))fail('FLEET_COMPLETION_RESULT_INVALID','Actual executor result signature required');
 const phase=row.control_state==='REPORTED'?'RELEASE':'STOP';
 if(phase==='RELEASE'){
  if(row.native_assignment){const native=await readNativeFleetCleanup(tx,{organisation_id:principal.organisation_id,run_id:principal.run_id,attempt_id:row.completion_attempt_id,attempt_generation:row.completion_attempt_generation,sandbox_id:row.sandbox_id,slot_id:row.slot_id,boot_generation:String(row.boot_generation),authority_epoch:principal.deployment_epoch});if(!native.native||!native.custody)continue;}
  else if(!row.archive_complete)continue;
 }
 const operation_id=operationFor(row);
 if(retained.has(operation_id))continue;
 if(!selected)advance(row);
 return {phase,session_id:row.runner_session_id,launch_id:row.completion_launch_id,command_id:row.command_id,organisation_id:principal.organisation_id,run_id:principal.run_id,authority_epoch:principal.deployment_epoch,operation_id,binding:{...row,launch_id:row.completion_launch_id,attempt_id:row.completion_attempt_id,attempt_generation:row.completion_attempt_generation,boot_generation:String(row.boot_generation)}};
 }
 if(!selected){if(rows.length===100)advance(rows.at(-1)!);else completionCursors.delete(cursorKey);}
 return null;
}
