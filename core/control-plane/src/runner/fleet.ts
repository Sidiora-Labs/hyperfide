import type {PrimaryTransaction} from '../storage/transactions.js';
import type {InvocationContext} from '../transport/protocol.js';
import {validateAssignment,scopeContains} from '../contracts/fleet/index.mjs';
import {readReadyFleetInstall} from '../preparation/fleet_authority.js';
import {claimTask,parseClaim,fields,uuid,fail} from '../scheduler/claim.js';
import {issue} from '../events/instructions.js';
import type {WorkerRegistrationAuthority} from '../hierarchy/adoption.js';

export interface FleetManagerBinding {
 organisation_id:string;run_id:string;actor_id:string;delegation_id:string;manager_generation:string;
 leader_generation:string;authority_epoch:string;operation_id:string;decision_id:string;source_revision:string;
}
export async function requireOwnedFleetTask(tx:PrimaryTransaction,b:FleetManagerBinding,task:string):Promise<void>{
 const row=(await tx.query('SELECT feature_package_id FROM hyperfide.tasks WHERE organisation_id=$1 AND run_id=$2 AND id=$3 FOR SHARE',[b.organisation_id,b.run_id,uuid(task,'task_id')])).rows[0];
 if(!row||row.feature_package_id!==b.delegation_id)fail('FLEET_TASK_SCOPE_DENIED','Task is outside the current manager delegation');
}
export async function assignFleetWorker(tx:PrimaryTransaction,i:InvocationContext,b:FleetManagerBinding,value:unknown,recipients:{consumer_ids:string[]},workers:WorkerRegistrationAuthority):Promise<Record<string,unknown>>{
 const v=fields(value,['assignment','install_binding','claims']);
 const assignment=validateAssignment(v.assignment);
 const a=assignment as unknown as Record<string,unknown>;
 for(const [key,expected] of Object.entries({run_id:b.run_id,manager_id:b.actor_id,delegation_id:b.delegation_id,manager_generation:b.manager_generation,leader_generation:b.leader_generation,authority_epoch:b.authority_epoch,decision_id:b.decision_id,operation_id:b.operation_id,source_revision:b.source_revision}))
  if(a[key]!==expected)fail('FLEET_ASSIGNMENT_SCOPE_DENIED','Assignment does not bind the admitted manager decision: '+key);
 const install=fields(v.install_binding,['operation_id','environment_id','environment_generation','sandbox_id','boot_id','boot_generation','input_digest']);
 const ready=await readReadyFleetInstall(tx,i,install as unknown as Parameters<typeof readReadyFleetInstall>[2]);
 if(ready.package_id!==b.delegation_id||ready.manager_generation!==b.manager_generation||a.source_config_digest!==(ready.receipt as Record<string,unknown>).source_config_digest)
  fail('FLEET_INSTALL_SCOPE_DENIED','Ready environment belongs to another delegation, generation or source configuration');
 if(a.environment_id!==install.environment_id||a.environment_generation!==install.environment_generation||a.ready_receipt_digest!==ready.receipt_digest||a.package_digest!==ready.manifest_digest||a.source_revision!==ready.source_revision)
  fail('FLEET_INSTALL_MISMATCH','Assignment must bind the actual current committed install receipt');
 if(!Array.isArray(v.claims)||v.claims.length!==1)fail('FLEET_ASSIGNMENT_INVALID','Each worker assignment admits one isolated task attempt; use separate decisions for concurrent workers');
 const tasks=a.tasks as Record<string,unknown>[];
 uuid(a.worker_id,'worker_id');
 const installedSlots=(ready.receipt as Record<string,unknown>).slots;
 const installedSlot=Array.isArray(installedSlots)?installedSlots.find(slot=>slot.slot===a.worker_slot):undefined;
 if(!installedSlot)fail('FLEET_SLOT_UNPREPARED','Selected zero-based slot has no verified installed workspace');
 const selectedInterfaces=(ready.receipt as Record<string,unknown>).interfaces as Record<string,unknown>;
 for(const task of tasks){
  const read=task.read_scope as string[],write=task.write_scope as string[];
  if(!Array.isArray(ready.read_scope)||!Array.isArray(ready.write_scope)||read.some(path=>!scopeContains(ready.read_scope as string[],path))||write.some(path=>!scopeContains(ready.write_scope as string[],path)))fail('FLEET_INSTALL_SCOPE_DENIED','Assigned source scope exceeds installed source scope');
  if([...(task.required_interfaces as string[]),...(task.provided_interfaces as string[])].some(id=>!Array.isArray(selectedInterfaces.selected_ids)||!selectedInterfaces.selected_ids.includes(id)))fail('FLEET_INTERFACE_MISSING','Task interfaces must be in the verified installed subset');
 }
 if(v.claims.length!==tasks.length)fail('FLEET_ASSIGNMENT_INVALID','Every assigned task needs its own attributed claim');
 const claims=v.claims.map(parseClaim),slots=new Set<string>();
 const result:Record<string,unknown>[]=[];
 for(const claim of claims){
  const task=tasks.find(t=>t.task_id===claim.task_id&&t.attempt_id===claim.attempt_id&&t.attempt_generation===claim.attempt_generation);
  if(!task||claim.organisation_id!==b.organisation_id||claim.run_id!==b.run_id||claim.authority_epoch!==b.authority_epoch||claim.leader_generation!==b.leader_generation||claim.package_generation!==b.manager_generation||claim.sandbox_id!==install.sandbox_id||claim.sandbox_boot_generation!==install.boot_generation)
   fail('FLEET_ASSIGNMENT_SCOPE_DENIED','Each claim must bind its installed boot, delegated task and immutable attempt');
  if(claim.slot_id!==installedSlot.worker_slot_id)fail('FLEET_SLOT_WORKSPACE_MISMATCH','Claim must bind the actual installed zero-based worker slot UUID');
  if(slots.has(claim.slot_id))fail('FLEET_WORKSPACE_ISOLATION_REQUIRED','Concurrent task claims require distinct writable slots');
  slots.add(claim.slot_id);
  await requireOwnedFleetTask(tx,b,claim.task_id);
  const admitted=await claimTask(tx,claim,{session_id:b.actor_id,leader_generation:b.leader_generation,package_generation:b.manager_generation},recipients);
  const token={organisation_id:claim.organisation_id,run_id:claim.run_id,task_id:claim.task_id,attempt_id:claim.attempt_id,attempt_generation:claim.attempt_generation,authority_epoch:claim.authority_epoch,sandbox_id:claim.sandbox_id,slot_id:claim.slot_id,sandbox_boot_generation:claim.sandbox_boot_generation};
  const worker=await workers.registerAssignedWorker(tx,{token,packet_digest:claim.input_packet_digest,session_id:String(a.worker_id),leader_generation:b.leader_generation,package_generation:b.manager_generation},i);
  if(worker.session_id!==a.worker_id)fail('FLEET_WORKER_BINDING_MISMATCH','Actual immutable worker registration differs from the admitted assignment');
  result.push({task_id:claim.task_id,attempt_id:claim.attempt_id,attempt_generation:claim.attempt_generation,slot_id:claim.slot_id,claim:admitted});
 }
 return {kind:'ASSIGN_WORKER',delegation_id:b.delegation_id,assignment,install_binding:install,install_receipt_digest:ready.receipt_digest,sandbox_id:install.sandbox_id,boot_generation:install.boot_generation,tasks:result,execution_confirmed:false,task_qualified:false};
}
export async function controlFleetWorker(tx:PrimaryTransaction,b:FleetManagerBinding,action:'STEER_WORKER'|'CANCEL_ASSIGNMENT',value:unknown):Promise<Record<string,unknown>>{
 const v=fields(value,action==='STEER_WORKER'?['task_id','attempt_id','attempt_generation','launch_id','request_id','frame_b64']:['task_id','attempt_id','attempt_generation','launch_id']);
 await requireOwnedFleetTask(tx,b,uuid(v.task_id,'task_id'));
 const row=(await tx.query('SELECT task_id,generation::text,sandbox_boot_generation::text FROM hyperfide.attempts WHERE organisation_id=$1 AND run_id=$2 AND id=$3 FOR SHARE',[b.organisation_id,b.run_id,uuid(v.attempt_id,'attempt_id')])).rows[0];
 if(!row||row.task_id!==v.task_id||row.generation!==v.attempt_generation)fail('FLEET_ATTEMPT_STALE','Worker control must target the exact owned task attempt');
 const body=action==='STEER_WORKER'?{launch_id:v.launch_id,request_id:v.request_id,frame_b64:v.frame_b64}:{launch_id:v.launch_id};
 const command=await issue(tx,{organisation_id:b.organisation_id,run_id:b.run_id,id:b.operation_id,attempt_id:v.attempt_id,attempt_generation:v.attempt_generation,authority_epoch:b.authority_epoch,sandbox_boot_generation:row.sandbox_boot_generation,kind:action==='STEER_WORKER'?'STEER':'CANCEL',body});
 return {kind:action,delegation_id:b.delegation_id,task_id:v.task_id,attempt_id:v.attempt_id,command,acknowledged:false,task_qualified:false};
}

export async function guardFleetLaunch(tx:PrimaryTransaction,i:InvocationContext,token:{organisation_id:string;run_id:string;task_id:string;attempt_id:string;attempt_generation:string;sandbox_id:string;slot_id:string;sandbox_boot_generation:string},plan:{agent_session_id:string;slot_id:string}):Promise<void>{
 const schema=(await tx.query("SELECT to_regclass('hyperfide.fleet_cohorts') IS NOT NULL AS ready")).rows[0];
 if(!schema?.ready)return;
 const cohort=(await tx.query('SELECT authority_epoch,leader_generation::text FROM hyperfide.fleet_cohorts WHERE organisation_id=$1 AND run_id=$2 FOR SHARE',[token.organisation_id,token.run_id])).rows[0];
 if(!cohort)return;
 const rows=await tx.query(`SELECT e.result,d.manager_generation::text,d.leader_generation::text,d.manager_session_id FROM hyperfide.fleet_effect_receipts e
 JOIN hyperfide.fleet_delegations d ON d.organisation_id=e.organisation_id AND d.run_id=e.run_id AND d.package_id::text=e.result->>'delegation_id'
 WHERE e.organisation_id=$1 AND e.run_id=$2 AND e.result->>'kind'='ASSIGN_WORKER'
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(e.result->'tasks') t WHERE t->>'attempt_id'=$3 AND t->>'attempt_generation'=$4) FOR SHARE OF d`,[token.organisation_id,token.run_id,token.attempt_id,token.attempt_generation]);
 if(rows.rows.length!==1)fail('FLEET_ASSIGNMENT_REQUIRED','Managed runner launch needs one committed manager assignment');
 const row=rows.rows[0]!,result=row.result as Record<string,unknown>,a=result.assignment as Record<string,unknown>;
 const task=(result.tasks as Record<string,unknown>[]).find(t=>t.attempt_id===token.attempt_id);
 if(a.manager_generation!==row.manager_generation||a.leader_generation!==row.leader_generation||row.leader_generation!==cohort.leader_generation||a.authority_epoch!==cohort.authority_epoch||a.manager_id!==row.manager_session_id||a.worker_id!==plan.agent_session_id||task?.task_id!==token.task_id||task.slot_id!==token.slot_id||plan.slot_id!==token.slot_id)
  fail('FLEET_ASSIGNMENT_STALE','Launch differs from current delegated worker, task, slot or manager generation');
 const install=result.install_binding as Parameters<typeof readReadyFleetInstall>[2];
 const ready=await readReadyFleetInstall(tx,i,install);
 if(ready.package_id!==result.delegation_id||ready.manager_generation!==a.manager_generation||ready.receipt_digest!==a.ready_receipt_digest||ready.source_revision!==a.source_revision||install.sandbox_id!==token.sandbox_id||install.boot_generation!==token.sandbox_boot_generation)
  fail('FLEET_INSTALL_STALE','Worker launch no longer matches its actual installed environment');
 const receipt=ready.receipt as Record<string,unknown>;
 const installed=Array.isArray(receipt.slots)?receipt.slots.find(slot=>slot.slot===a.worker_slot):undefined;
 if(!installed||installed.worker_slot_id!==token.slot_id)fail('FLEET_SLOT_UNPREPARED','Assigned zero-based workspace no longer exists in the actual install receipt');
 const registered=await tx.query(`SELECT workspace_path,home_path,tmp_path FROM hyperfide.runner_registry
 WHERE organisation_id=$1 AND run_id=$2 AND sandbox_id=$3 AND boot_generation=$4 AND slot_id=$5 FOR SHARE`,[token.organisation_id,token.run_id,token.sandbox_id,token.sandbox_boot_generation,token.slot_id]);
 if(!registered.rows.some(r=>r.workspace_path===installed.source&&r.home_path===installed.home&&r.tmp_path===installed.temporary))
  fail('FLEET_SLOT_WORKSPACE_MISMATCH','Actual runner slot must use the exact installed source, home and temporary roots');
}
