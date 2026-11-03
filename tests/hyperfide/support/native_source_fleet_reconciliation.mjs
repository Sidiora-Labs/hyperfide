import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export async function assertNativeReleaseReconciliation({f,resources,controlRoot,scope,sourceAssignment,invocation}){
 const [{projectFleetCompletionCommands},{nextFleetCompletion,fleetCompletionNativeOperation},{runnerCanonical},{hash},{FoundationError}]=await Promise.all([
  import(pathToFileURL(path.join(controlRoot,'preparation/fleet_completion.js'))),
  import(pathToFileURL(path.join(controlRoot,'runner/fleet_completion.js'))),
  import(pathToFileURL(path.join(controlRoot,'runner/bridge.js'))),
  import(pathToFileURL(path.join(controlRoot,'transport/protocol.js'))),
  import(pathToFileURL(path.join(controlRoot,'policy/programme.js'))),
 ]);
 const rollback=new FoundationError('RECONCILIATION_TEST_ROLLBACK','Rollback declared reconciliation history');
 let verified=false,failure;
 try{
  await resources.gateway.withPrimaryTransaction({timeoutMs:15000,maxRetries:2},async tx=>{
   try{
   const insert=async(table,row)=>{const fields=Object.keys(row);await tx.query('INSERT INTO hyperfide.'+table+'('+fields.join(',')+') VALUES('+fields.map((_,n)=>'$'+(n+1)).join(',')+')',Object.values(row));};
   const assignment=(await tx.query('SELECT * FROM hyperfide.source_fleet_assignments WHERE organisation_id=$1 AND run_id=$2 AND assignment_id=$3',[scope.organisation_id,scope.run_id,sourceAssignment.assignment_id])).rows[0];
   assert(assignment?.submission_id,'The regression requires an actual submitted native assignment');
   const runner=(await tx.query('SELECT * FROM hyperfide.runner_registry WHERE organisation_id=$1 AND run_id=$2 AND slot_id=$3 AND sandbox_id=$4',[scope.organisation_id,scope.run_id,assignment.slot_id,assignment.sandbox_id])).rows[0];
   assert(runner,'The regression requires the existing assigned runner');
   const readiness=(await tx.query('SELECT * FROM hyperfide.fleet_runtime_readiness WHERE organisation_id=$1 AND run_id=$2 AND runner_session_id=$3 AND readiness_digest=$4',[scope.organisation_id,scope.run_id,runner.session_id,runner.readiness_digest])).rows[0];
   assert(readiness,'The regression requires the registered installation');
   const fixture={kind:'DECLARED_RECONCILIATION_HISTORY',execution_qualification:false};
   const publication={...readiness.publication,...fixture,kind:'FLEET_MANIFEST_V1',source_backend:'native'};
   const readinessDigest=hash(runnerCanonical(publication));
   const install=(await tx.query('SELECT * FROM hyperfide.fleet_environment_installs WHERE organisation_id=$1 AND run_id=$2 AND operation_id=$3',[scope.organisation_id,scope.run_id,readiness.install_operation_id])).rows[0];
   assert(install);
   const {created_at:_installCreated,...installFields}=install;
   const installOperation=randomUUID();
   await insert('fleet_environment_installs',{...installFields,operation_id:installOperation,environment_id:'reconciliation-'+randomUUID()});
   const {id:_id,created_at:_created,...readinessFields}=readiness;
   await insert('fleet_runtime_readiness',{...readinessFields,id:randomUUID(),install_operation_id:installOperation,readiness_digest:readinessDigest,publication});
   await tx.query('UPDATE hyperfide.runner_registry SET readiness_digest=$3 WHERE organisation_id=$1 AND session_id=$2',[scope.organisation_id,runner.session_id,readinessDigest]);
   const launch=randomUUID(),start=randomUUID(),stop=randomUUID(),event=randomUUID(),admission=randomUUID(),executor=randomUUID();
   const quota='reconciliation-'+randomUUID(),pair=generateKeyPairSync('ed25519'),pin=hash(runnerCanonical(fixture));
   await insert('identity_principals',{...scope,credential_id:executor,actor_id:randomUUID(),role:'PROVISIONER',public_key_b64:pair.publicKey.export({format:'jwk'}).x,deployment_epoch:invocation.principal.deployment_epoch,allowed_actions:['provider.remote.execute-bound'],expires_at:'2099-01-01T00:00:00Z'});
   await insert('agent_admission_accounts',{...scope,quota_key:quota,policy_digest:pin,max_concurrent:1});
   await insert('agent_admission_reservations',{...scope,id:admission,quota_key:quota,session_id:assignment.worker_principal_id,payload_digest:pin,policy_digest:pin,state:'RELEASED'});
   await insert('outbox_events',{...scope,id:event,aggregate_type:'fixture.reconciliation',aggregate_id:assignment.attempt_id,aggregate_version:1,event_type:'instruction.start',payload:fixture});
   await insert('scheduler_dispatches',{...scope,id:start,request_id:start,task_id:assignment.task_id,attempt_id:assignment.attempt_id,attempt_generation:assignment.attempt_generation,authority_epoch:assignment.run_authority_epoch,sandbox_id:assignment.sandbox_id,slot_id:assignment.slot_id,sandbox_boot_generation:assignment.sandbox_boot_generation,payload_digest:pin,state:'COMPLETED',event_id:event});
   await insert('native_launch_plans',{...scope,command_id:start,launch_id:launch,agent_session_id:assignment.worker_principal_id,slot_id:assignment.slot_id,attempt_id:assignment.attempt_id,attempt_generation:assignment.attempt_generation,connector:'codex',connector_plan_digest:pin,admission_reservation_id:admission,reservation_attempt:1,admission_policy_digest:pin,run_policy_digest:pin,qualification_receipt_digest:pin,packet_digest:pin,payload_digest:pin,plan:fixture});
   const result={...fixture,command_id:start,launch_id:launch,request_digest:pin,native:{foreground_owner:true,terminal_observed:true,state:'EXITED',exit_code:0}};
   await insert('fleet_worker_launches',{...scope,command_id:start,launch_id:launch,runner_session_id:runner.session_id,executor_credential_id:executor,authority_epoch:assignment.run_authority_epoch,request:fixture,request_digest:pin,state:'COMPLETED',result,result_digest:hash(runnerCanonical(result)),result_signature:sign(null,Buffer.from(runnerCanonical(result)),pair.privateKey).toString('base64url'),completed_at:new Date()});
   const report={...fixture,outcome:'STOPPED',termination:'CONFIRMED',remaining_descendants:0,cleanup_complete:true,cleanup_debt:[],credential_revocation:[],receipt_digest:pin};
   await insert('runner_control_commands',{...scope,command_id:stop,action:'runner.stop',launch_id:launch,slot_id:assignment.slot_id,sandbox_id:assignment.sandbox_id,boot_id:runner.boot_id,boot_generation:assignment.sandbox_boot_generation,attempt_id:assignment.attempt_id,attempt_generation:assignment.attempt_generation,authority_epoch:assignment.run_authority_epoch,fence_sequence:1,policy:{grace_ms:0,drain_deadline_ms:1000,on_drain_deadline:'STOP'},required_outputs:JSON.stringify([]),request_digest:pin,issued_by_credential_id:invocation.principal.credential_id,state:'REPORTED',outcome:'STOPPED',termination:'CONFIRMED',cleanup_complete:true,report,report_digest:hash(runnerCanonical(report)),reported_at:new Date()});
   await insert('runner_workspaces',{...scope,sandbox_id:assignment.sandbox_id,boot_generation:assignment.sandbox_boot_generation,slot_id:assignment.slot_id,slot_generation:runner.slot_generation,state:'LEASED',launch_id:launch,registered_by_credential_id:runner.credential_id});
   const target={state_dir:runner.state_dir,launch_id:launch,attempt_id:assignment.attempt_id,attempt_generation:String(assignment.attempt_generation),sandbox_id:assignment.sandbox_id,boot_id:runner.boot_id,boot_generation:String(assignment.sandbox_boot_generation),command_id:stop};
   const argv=[runner.runner_binary,'--component','12.4','--action','runner.stop','--request-base64',Buffer.from(JSON.stringify(target)).toString('base64url')];
   const stopOperation=randomUUID(),releaseOperation=fleetCompletionNativeOperation({kind:'FLEET_COMPLETION_NATIVE_V1',phase:'RELEASE',...scope,launch_id:launch,command_id:stop});
   const remote={...scope,session_id:runner.session_id,sandbox_id:assignment.sandbox_id,boot_generation:assignment.sandbox_boot_generation,request_digest:pin,runner_binding_evidence_digest:pin};
   await insert('provider_remote_operations',{...remote,id:stopOperation,state:'OBSERVED',operation:{...fixture,parameters:{argv}},outcome:{status:'SUCCEEDED',result:{phase:'EXITED',exit_code:'0',termination_confirmed:true}}});
   const unknown={...remote,id:releaseOperation,state:'UNKNOWN',operation:{...fixture,kind:'execute',parameters:{argv:[runner.runner_binary,'--component','12.4','--action','runner.slot.release']}}};
   await insert('provider_remote_operations',unknown);
   const before=(await tx.query('SELECT * FROM hyperfide.provider_remote_operations WHERE organisation_id=$1 AND id=$2',[scope.organisation_id,releaseOperation])).rows[0];
   const projected=await projectFleetCompletionCommands(tx,invocation,{after:null,limit:100});
   const waiting=projected.waiting.find(row=>row.launch_id===launch);
   assert.deepEqual(waiting,{launch_id:launch,state:'NATIVE_RELEASE_RECONCILIATION_REQUIRED',native_operation_id:releaseOperation,native_operation_state:'UNKNOWN'});
   assert.equal(projected.commands.some(row=>row.input?.launch_id===launch),false,'Unknown release must not create a new effect');
   assert.equal(await nextFleetCompletion(tx,{...invocation.principal,credential_id:executor}),null,'Automatic completion must not repeat the unknown release');
   const after=(await tx.query('SELECT * FROM hyperfide.provider_remote_operations WHERE organisation_id=$1 AND id=$2',[scope.organisation_id,releaseOperation])).rows[0];
   assert.deepEqual(after,before,'Projection must retain the original uncertain operation byte for byte');
   verified=true;
   throw rollback;
   }catch(error){if(error===rollback)throw error;failure=error;throw rollback;}
  });
 }catch(error){if(error.code!==rollback.code)throw error;}
 if(failure)throw failure;
 assert.equal(verified,true);
 return 'native release uncertainty is exposed for reconciliation under the original operation, without reexecution; declared signed history and persisted UNKNOWN input only';
}
