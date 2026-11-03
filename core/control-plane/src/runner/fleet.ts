import type {PrimaryTransaction} from '../storage/transactions.js';
import type {ComponentContext} from '../components/registry.js';
import type {ExecutionPacketRecord} from '../hierarchy/packets.js';
import {object} from '../policy/programme.js';
import type {InvocationContext} from '../transport/protocol.js';
import {validateAssignment,scopeContains,canonical} from '../contracts/fleet/index.mjs';
import {readReadyFleetInstall,readReadyFleetInstallForDispatch} from '../preparation/fleet_authority.js';
import {claimTask,parseClaim,fields,uuid,fail} from '../scheduler/claim.js';
import {issue} from '../events/instructions.js';
import {nativeFleetWorkspaceId} from '../preparation/fleet_source.js';
import type {WorkerRegistrationAuthority} from '../hierarchy/adoption.js';

export interface FleetManagerBinding {
 organisation_id:string;run_id:string;actor_id:string;delegation_id:string;manager_generation:string;
 leader_generation:string;authority_epoch:string;operation_id:string;decision_id:string;source_revision:string;
}
function nativeAssignmentSource(ready:Record<string,any>,slot:number,assignmentId:string):Record<string,unknown>|null{
 if(ready.source_backend!=='native')return null;
 return {source_backend:'native',scope:ready.source_scope,revision_id:ready.source_revision,root_tree_id:ready.root_tree_id,source_manifest_digest:ready.source_manifest_digest,workspace_id:nativeFleetWorkspaceId(assignmentId,slot),bootstrap_workspace_id:nativeFleetWorkspaceId(ready.logical_operation_id,slot),workspace_generation:'1'};
}
function nativeSourceSetup(assignment:Record<string,any>,ready:Record<string,any>,install:Record<string,unknown>,task:Record<string,unknown>):Record<string,unknown>|null{
 if(ready.source_backend!=='native')return null;
 const prefixes=(scopes:string[])=>[...new Set(scopes.map(scope=>scope==='**'?'':scope.endsWith('/**')?scope.slice(0,-3):scope))];
 const modes:Record<string,string>={api_only:'API_ONLY',sparse:'SPARSE',materialized:'MATERIALIZED'};
 const mode=modes[ready.source_workspace_mode];if(!mode)fail('FLEET_ASSIGNMENT_SOURCE_MISMATCH','Native assignment requires a supported installed workspace mode');
 return {action:'source.fleet.assign',scope:assignment.source.scope,input:{assignment_id:assignment.assignment_id,run_id:assignment.run_id,task_id:task.task_id,attempt_id:task.attempt_id,attempt_generation:task.attempt_generation,workspace_id:assignment.source.workspace_id,base_revision_id:assignment.source.revision_id,closure_digest:assignment.package_digest,environment_digest:assignment.ready_receipt_digest,read_paths:prefixes(task.read_scope as string[]),write_paths:prefixes(task.write_scope as string[]),mode,worker_principal_id:assignment.worker_id,leader_generation:assignment.leader_generation,package_id:assignment.delegation_id,package_generation:assignment.manager_generation},required_fields:['worker_credential_id'],credential_binding:{actor_id:assignment.worker_id,run_id:assignment.run_id,task_id:task.task_id,attempt_id:task.attempt_id,attempt_generation:task.attempt_generation,sandbox_id:install.sandbox_id,sandbox_boot_generation:install.boot_generation},launch_requires:'COMMITTED_NATIVE_SOURCE_ASSIGNMENT'};
}
function requireAssignmentSource(assignment:Record<string,any>,ready:Record<string,any>):void{
 const expected=nativeAssignmentSource(ready,assignment.worker_slot,assignment.assignment_id);
 if(expected?assignment.schema_version!==2||canonical(assignment.source)!==canonical(expected):assignment.schema_version!==1||assignment.source!==undefined)fail('FLEET_ASSIGNMENT_SOURCE_MISMATCH','Assignment source must match the installed backend, native root and worker workspace');
}
export async function requireOwnedFleetTask(tx:PrimaryTransaction,b:FleetManagerBinding,task:string):Promise<void>{
 const row=(await tx.query('SELECT feature_package_id FROM hyperfide.tasks WHERE organisation_id=$1 AND run_id=$2 AND id=$3 FOR SHARE',[b.organisation_id,b.run_id,uuid(task,'task_id')])).rows[0];
 if(!row||row.feature_package_id!==b.delegation_id)fail('FLEET_TASK_SCOPE_DENIED','Task is outside the current manager delegation');
}
export interface FleetPacketFactory {createPacketTx(tx:PrimaryTransaction,input:unknown,context:ComponentContext):Promise<ExecutionPacketRecord>}
export async function prepareSelectedFleetAssignment(tx:PrimaryTransaction,i:InvocationContext,b:FleetManagerBinding,value:unknown,context:ComponentContext,packets:FleetPacketFactory):Promise<Record<string,unknown>>{
 const v=fields(value,['selection','install_binding']),selected=fields(v.selection,['task_id','expected_task_generation','worker_slot','lease_ms','max_runtime_seconds','max_output_bytes','capacity','optional_context']);
 const taskId=uuid(selected.task_id,'task_id');await requireOwnedFleetTask(tx,b,taskId);
 const task=(await tx.query('SELECT generation::text FROM hyperfide.tasks WHERE organisation_id=$1 AND run_id=$2 AND id=$3 FOR SHARE',[b.organisation_id,b.run_id,taskId])).rows[0]!;
 if(typeof selected.expected_task_generation!=='string'||!/^(0|[1-9][0-9]*)$/.test(selected.expected_task_generation)||task.generation!==selected.expected_task_generation)fail('STALE_ATTEMPT_GENERATION','Selected task generation changed');
 if(!Number.isSafeInteger(selected.worker_slot)||Number(selected.worker_slot)<0||Number(selected.worker_slot)>1023||!Number.isSafeInteger(selected.lease_ms)||Number(selected.lease_ms)<1000||Number(selected.lease_ms)>300000||!Number.isSafeInteger(selected.max_runtime_seconds)||Number(selected.max_runtime_seconds)<1||Number(selected.max_runtime_seconds)>604800||!Number.isSafeInteger(selected.max_output_bytes)||Number(selected.max_output_bytes)<0)fail('FLEET_ASSIGNMENT_INVALID','Explicit bounded selected slot, lease and output/runtime limits required');
 const install=fields(v.install_binding,['operation_id','environment_id','environment_generation','sandbox_id','boot_id','boot_generation','input_digest']);
 const ready=await readReadyFleetInstall(tx,i,install as unknown as Parameters<typeof readReadyFleetInstall>[2]);
 if(ready.package_id!==b.delegation_id||ready.manager_generation!==b.manager_generation||ready.source_revision!==b.source_revision)fail('FLEET_INSTALL_SCOPE_DENIED','Selected install must match current delegated source and generation');
 const receipt=ready.receipt as Record<string,any>,slot=Array.isArray(receipt.slots)?receipt.slots.find(s=>s.slot===selected.worker_slot):undefined;
 if(!slot||typeof slot.worker_slot_id!=='string')fail('FLEET_SLOT_UNPREPARED','Selected slot has no verified installed workspace');
 const generation=(BigInt(task.generation)+1n).toString();
 const prepared=await packets.createPacketTx(tx,{idempotency_key:b.operation_id,leader_generation:b.leader_generation,package_generation:b.manager_generation,task_id:taskId,attempt_id:b.operation_id,attempt_generation:generation,sandbox_id:install.sandbox_id,slot_id:slot.worker_slot_id,sandbox_boot_generation:install.boot_generation,max_bytes:262144,optional_context:selected.optional_context},{...context,invocation:i});
 const m=prepared.packet.mandatory;
 if(!object(m)||!object(m.identity)||!object(m.intent)||!Array.isArray(m.intent.owned_scope)||!object(prepared.packet.observation))fail('FLEET_ASSIGNMENT_INVALID','Actual prepared packet binding required');
 const scope=m.intent.owned_scope;
 if(!Array.isArray(ready.read_scope)||!Array.isArray(ready.write_scope)||scope.some(path=>typeof path!=='string'||!scopeContains(ready.read_scope as string[],path)||!scopeContains(ready.write_scope as string[],path)))fail('FLEET_INSTALL_SCOPE_DENIED','Accepted task scope is not fully installed and writable');
 const roles=(key:'required_interfaces'|'provided_interfaces'):string[]=>{
  const definition=m.intent as Record<string,unknown>;const raw=definition.definition;let value:unknown=object(raw)?raw[key]:undefined;
  if(value===undefined&&object(raw)&&object(raw.section)&&object(raw.section.fields))value=raw.section.fields[key];
  if(object(value)&&Object.hasOwn(value,'value'))value=value.value;
  if(typeof value==='string'){try{value=JSON.parse(value);}catch{fail('FLEET_INTERFACE_MISSING','Accepted interface roles must be explicit arrays');}}
  if(value===undefined)return [];
  if(!Array.isArray(value)||value.length>4096||value.some(id=>typeof id!=='string'||!/^interface\.[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(id))||new Set(value).size!==value.length)fail('FLEET_INTERFACE_MISSING','Accepted interface roles must be unique stable interface IDs');
  return value as string[];
 };
 const required=roles('required_interfaces'),provided=roles('provided_interfaces');
 if(!object(receipt.interfaces)||!Array.isArray(receipt.interfaces.selected_ids)||[...required,...provided].some(id=>!receipt.interfaces.selected_ids.includes(id)))fail('FLEET_INTERFACE_MISSING','Accepted task interfaces are absent from the actual installed subset');
 const nativeSource=nativeAssignmentSource(ready,Number(selected.worker_slot),b.decision_id);
 const assignment={schema_version:nativeSource?2:1,...(nativeSource?{source:nativeSource}:{}),kind:'hyperfide.task-assignment',assignment_id:b.decision_id,operation_id:b.operation_id,decision_id:b.decision_id,run_id:b.run_id,wave_id:b.delegation_id,delegation_id:b.delegation_id,manager_id:b.actor_id,manager_generation:b.manager_generation,leader_generation:b.leader_generation,authority_epoch:b.authority_epoch,environment_id:install.environment_id,environment_generation:Number(install.environment_generation),ready_receipt_digest:ready.receipt_digest,source_revision:ready.source_revision,package_digest:ready.manifest_digest,source_config_digest:receipt.source_config_digest,worker_id:b.decision_id,worker_slot:selected.worker_slot,tasks:[{task_id:taskId,attempt_id:b.operation_id,attempt_generation:generation,read_scope:scope,write_scope:scope,required_interfaces:required,provided_interfaces:provided}],limits:{max_runtime_seconds:selected.max_runtime_seconds,max_output_bytes:selected.max_output_bytes}};
 const claim={organisation_id:b.organisation_id,run_id:b.run_id,request_id:b.operation_id,task_id:taskId,attempt_id:b.operation_id,attempt_generation:generation,run_spec_generation:prepared.packet.observation.run_spec_generation,spec_generation:m.identity.spec_generation,spec_revision_id:m.identity.spec_revision_id,authority_epoch:b.authority_epoch,leader_generation:b.leader_generation,package_generation:b.manager_generation,sandbox_id:install.sandbox_id,slot_id:slot.worker_slot_id,sandbox_boot_generation:install.boot_generation,lease_ms:selected.lease_ms,input_packet_digest:prepared.digest,capacity:selected.capacity};
 return {assignment,install_binding:install,claims:[claim]};
}
export async function assignFleetWorker(tx:PrimaryTransaction,i:InvocationContext,b:FleetManagerBinding,value:unknown,recipients:{consumer_ids:string[]},workers:WorkerRegistrationAuthority):Promise<Record<string,unknown>>{
 const v=fields(value,['assignment','install_binding','claims']);
 const assignment=validateAssignment(v.assignment);
 const a=assignment as unknown as Record<string,unknown>;
 for(const [key,expected] of Object.entries({run_id:b.run_id,manager_id:b.actor_id,delegation_id:b.delegation_id,manager_generation:b.manager_generation,leader_generation:b.leader_generation,authority_epoch:b.authority_epoch,decision_id:b.decision_id,operation_id:b.operation_id,source_revision:b.source_revision}))
  if(a[key]!==expected)fail('FLEET_ASSIGNMENT_SCOPE_DENIED','Assignment does not bind the admitted manager decision: '+key);
 const install=fields(v.install_binding,['operation_id','environment_id','environment_generation','sandbox_id','boot_id','boot_generation','input_digest']);
 const ready=await readReadyFleetInstall(tx,i,install as unknown as Parameters<typeof readReadyFleetInstall>[2]);
 requireAssignmentSource(a,ready);
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
 const setup=nativeSourceSetup(a,ready,install,tasks[0]!);
 return {kind:'ASSIGN_WORKER',delegation_id:b.delegation_id,assignment,install_binding:install,install_receipt_digest:ready.receipt_digest,sandbox_id:install.sandbox_id,boot_generation:install.boot_generation,tasks:result,...(setup?{native_source_setup:setup}:{}),execution_confirmed:false,task_qualified:false};
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

export async function guardFleetLaunch(tx:PrimaryTransaction,i:InvocationContext,token:{organisation_id:string;run_id:string;task_id:string;attempt_id:string;attempt_generation:string;sandbox_id:string;slot_id:string;sandbox_boot_generation:string},plan:{agent_session_id:string;slot_id:string},phase:'PREPARE'|'EXECUTE'='EXECUTE'):Promise<void>{
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
 const ready=['OPERATOR','COORDINATOR','DISPATCH'].includes(i.principal.role)?await readReadyFleetInstallForDispatch(tx,i,install,{...token,authority_epoch:String(a.authority_epoch)},plan.agent_session_id):await readReadyFleetInstall(tx,i,install);
 requireAssignmentSource(a,ready);
 if(ready.source_backend==='native'&&phase==='EXECUTE'){
  const source=a.source as Record<string,any>,scope=source.scope;
  const bound=(await tx.query(`SELECT f.result FROM hyperfide.source_fleet_assignments f
   JOIN hyperfide.source_workspaces w USING(organisation_id,repository_id,security_domain_id,workspace_id)
   JOIN hyperfide.source_authority_domains d USING(organisation_id,repository_id,security_domain_id)
   JOIN hyperfide.source_capabilities c ON c.organisation_id=f.organisation_id AND c.repository_id=f.repository_id AND c.security_domain_id=f.security_domain_id AND c.id=f.capability_id
   WHERE f.organisation_id=$1 AND f.repository_id=$2 AND f.security_domain_id=$3 AND f.assignment_id=$4 AND f.run_id=$5
   AND f.task_id=$6 AND f.attempt_id=$7 AND f.attempt_generation=$8 AND f.worker_principal_id=$9 AND f.workspace_id=$10
   AND f.sandbox_id=$11 AND f.slot_id=$12 AND f.sandbox_boot_generation=$13 AND f.run_authority_epoch=$14
   AND f.base_revision_id=$15 AND f.closure_digest=$16 AND f.environment_digest=$17
   AND f.submission_id IS NULL AND w.closed_at IS NULL AND w.principal_id=f.worker_principal_id
   AND d.enabled=true AND d.authority_epoch=f.source_authority_epoch AND w.authority_epoch=d.authority_epoch
   AND c.principal_id=f.worker_principal_id AND c.credential_id=f.worker_credential_id AND c.authority_epoch=d.authority_epoch
   AND c.policy_version=d.policy_version AND c.revoked_at IS NULL AND c.expires_at>clock_timestamp()
   AND (EXISTS(SELECT 1 FROM hyperfide.source_principal_credentials k
     WHERE k.organisation_id=f.organisation_id AND k.repository_id=f.repository_id AND k.security_domain_id=f.security_domain_id
     AND k.credential_id=f.worker_credential_id AND k.principal_id=f.worker_principal_id
     AND k.principal_kind='worker' AND k.revoked_at IS NULL AND k.expires_at>clock_timestamp() FOR SHARE OF k)
    OR EXISTS(SELECT 1 FROM hyperfide.identity_principals p
     WHERE p.credential_id=f.worker_credential_id AND p.organisation_id=f.organisation_id AND p.run_id=f.run_id AND p.actor_id=f.worker_principal_id
     AND p.role='WORKER' AND p.state='ACTIVE' AND p.expires_at>clock_timestamp() AND p.deployment_epoch=f.run_authority_epoch
     AND p.attempt_id=f.attempt_id AND p.attempt_generation=f.attempt_generation AND p.sandbox_id=f.sandbox_id AND p.boot_generation=f.sandbox_boot_generation
     AND c.actions <@ p.allowed_actions FOR SHARE OF p))
   FOR SHARE OF f,w,d,c`,[token.organisation_id,scope.repository_id,scope.security_domain_id,a.assignment_id,token.run_id,token.task_id,token.attempt_id,token.attempt_generation,a.worker_id,source.workspace_id,token.sandbox_id,token.slot_id,token.sandbox_boot_generation,a.authority_epoch,source.revision_id,a.package_digest,a.ready_receipt_digest])).rows;
  if(bound.length!==1)fail('FLEET_SOURCE_ASSIGNMENT_REQUIRED','Native worker launch requires its current issued source workspace and capability');
 }
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
