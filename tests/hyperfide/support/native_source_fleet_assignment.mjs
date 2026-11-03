import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {hostname} from 'node:os';

export const nativeFleetAssignmentFixtureScope = 'Actual signed manager assignment, immutable packet, scheduler claim and worker registration; prior cohort, provisioning, profile and READY rows are controlled historical inputs. Native installation is proved separately.';

export async function createNativeFleetAssignmentFixture({f,ids:i,controlCall,installed,specification,tasks,capacity}) {
  const scope={organisation_id:i.organisation,run_id:i.run},keys=[i.organisation,i.run],digest=f.sourceDigest;
  const query=(sql,values=[])=>f.pool.query(sql,values);
  const insert=async(table,record)=>{
    const columns=Object.keys(record);
    await query('INSERT INTO hyperfide.'+table+'('+columns.join(',')+') VALUES('+columns.map((_,index)=>'$'+(index+1)).join(',')+')',Object.values(record));
  };
  const taskIds=Object.values(tasks).map(task=>task.task);
  assert.equal(new Set(taskIds).size,taskIds.length);
  assert(installed.prepared.receipt.slots.length>0);
  const slots=installed.admission.slot_bindings;
  assert.equal(slots.length,installed.prepared.receipt.slots.length);
  const previousProfile=(await query('SELECT p.provider,e.* FROM hyperfide.provider_pools p JOIN hyperfide.environment_profiles e ON e.organisation_id=p.organisation_id AND e.id=p.profile_id WHERE p.organisation_id=$1 AND p.id=$2',[i.organisation,i.pool])).rows[0];
  assert(previousProfile,'The scheduler fixture must supply a prior sandbox profile');
  assert.equal(previousProfile.manifest.profile.image.digest,installed.packageValue.environment.image_digest);
  assert.equal(previousProfile.runtime_platform,installed.packageValue.environment.platform);
  const profileId=previousProfile.id,preparation=previousProfile.content_digest;
  await controlCall('leader','fleet-orchestration','fleet.cohort.bind',{cohort_id:randomUUID(),host_id:hostname(),leader_generation:'1',expected_generation:'0'});
  const cohort=(await query('SELECT id::text,cohort_generation::text FROM hyperfide.fleet_cohorts WHERE organisation_id=$1 AND run_id=$2',keys)).rows[0];
  assert(cohort);
  const budget={allowed_actions:['ASSIGN_WORKER'],provider_ids:[previousProfile.provider],profile_ids:[profileId],max_sandboxes:1,max_concurrent_workers:slots.length,task_ids:taskIds};
  await insert('fleet_delegations',{...scope,package_id:i.package,manager_session_id:i.manager,manager_generation:2,leader_generation:1,budget,decision_id:randomUUID()});
  const binding={actor_id:i.manager,actor_role:'WAVE_MANAGER',authority_epoch:i.epoch,leader_generation:'1',delegation_id:i.package,manager_generation:'2'};
  await controlCall('manager','fleet-orchestration','fleet.session.bind',{binding});
  const recordDecision=async(input,action='ASSIGN_WORKER')=>{
    const operation=randomUUID(),decision=randomUUID(),observation=randomUUID(),reasoning=randomUUID();
    const state=(await query('SELECT plan_generation::text FROM hyperfide.fleet_actor_sessions WHERE organisation_id=$1 AND run_id=$2 AND session_id=$3',[...keys,i.manager])).rows[0];
    const body={schema_version:1,kind:'hyperfide.fleet-decision',operation_id:operation,decision_id:decision,run_id:i.run,...binding,source_revision:installed.source.revision,spec_revision:specification,context_digest:digest({operation,scope:'CONTROLLED_PRIOR_MODEL_DECISION'}),action,input,input_digest:digest(input),expected_version:state.plan_generation,rationale_summary:nativeFleetAssignmentFixtureScope};
    await insert('fleet_observations',{...scope,id:observation,actor_id:i.manager,cohort_generation:Number(cohort.cohort_generation),context_digest:body.context_digest,body:{fixture:'CONTROLLED_PRIOR_MODEL_OBSERVATION'}});
    await insert('fleet_reasoning',{...scope,id:reasoning,actor_id:i.manager,request_digest:body.context_digest,observation_id:observation,state:'COMPLETED',result:{fixture:'CONTROLLED_PRIOR_MODEL_REASONING'}});
    await insert('fleet_decisions',{...scope,id:decision,operation_id:operation,actor_id:i.manager,action,context_digest:body.context_digest,payload_digest:digest(body),reasoning_id:reasoning,body});
    return body;
  };
  const priorProvision=await recordDecision({fixture:'CONTROLLED_PRIOR_PROVISION_INPUT'},'PROVISION_SANDBOX');
  await insert('fleet_effect_receipts',{...scope,operation_id:priorProvision.operation_id,decision_id:priorProvision.decision_id,payload_digest:digest(priorProvision),result:{kind:'PROVISION_SANDBOX',delegation_id:i.package,sandbox_id:i.sandbox,fixture:'CONTROLLED_PRIOR_PROVISION_INPUT'}});
  const pin=digest({fixture:'CONTROLLED_PRIOR_READY_INPUT',operation:installed.admission.operation_id});
  const preparationAccount=(await query("SELECT id::text FROM hyperfide.capacity_accounts WHERE organisation_id=$1 AND pool_id=$2 AND dimension='PREPARATION' AND capacity_class='EXECUTION'",[i.organisation,i.pool])).rows[0];
  assert(preparationAccount);
  const runnerRows=[];
  for(const slot of slots){
    await insert('worker_slots',{organisation_id:i.organisation,id:slot.worker_slot_id,sandbox_id:i.sandbox,slot_key:'native-installed-'+slot.slot,boot_generation:1,capacity_kind:'AGENT',state:'READY'});
    const runner=randomUUID();
    await insert('runner_registry',{...scope,session_id:runner,credential_id:randomUUID(),sandbox_id:i.sandbox,boot_generation:1,boot_id:i.boot,slot_id:slot.worker_slot_id,repository_id:i.repository,state_dir:slot.worker_root+'/prior-runner',runner_binary:slot.worker_root+'/prior-native',workspace_path:slot.source,home_path:slot.home,tmp_path:slot.temporary,runner_binary_digest:pin,boot_preparation_digest:preparation,preparation_digest:preparation,readiness_digest:digest({prior:installed.admission.operation_id,slot:slot.slot}),source_digest:installed.source.digest,source_object_id:installed.source.revision,source_tree_id:installed.source.root_tree_id,slot_generation:1,uid:slot.uid,gid:slot.gid,observation_digest:pin,state:'CURRENT'});
    runnerRows.push({runner,slot});
  }
  const reservation=randomUUID(),job=randomUUID();
  await insert('reservations',{...scope,id:reservation,request_id:randomUUID(),capacity_account_id:preparationAccount.id,quantity:'1',expires_at:'2099-01-01T00:00:00Z',state:'RELEASED',released_at:'2026-01-01T00:00:00Z'});
  await insert('runner_remote_jobs',{...scope,operation_id:job,session_id:runnerRows[0].runner,job_class:'PREPARATION',plan:{fixture:'CONTROLLED_PRIOR_REGISTRATION'},plan_digest:pin,principal:{fixture:'CONTROLLED_PRIOR_REGISTRATION'},admission_digest:pin,authority_epoch:i.epoch,reservation_id:reservation,expires_at:'2000-01-01T00:00:00Z'});
  await query("UPDATE hyperfide.runner_remote_jobs SET state='UNKNOWN' WHERE organisation_id=$1 AND run_id=$2 AND operation_id=$3",[...keys,job]);
  const admission=installed.admission,receipt=installed.prepared.receipt;
  await insert('fleet_environment_specs',{...scope,input_digest:admission.input_digest,package_digest:admission.package_digest,source_config_digest:admission.source_config_digest,source_manifest_digest:admission.source_manifest_digest,plan_digest:admission.plan_digest,package_spec:installed.packageValue,source_config:installed.neron,install_plan:installed.plan,registered_by:i.manager});
  await insert('fleet_environment_installs',{...scope,operation_id:admission.operation_id,input_digest:admission.input_digest,environment_id:admission.environment_id,environment_generation:admission.environment_generation,sandbox_id:i.sandbox,boot_id:i.boot,boot_generation:1,authority_epoch:i.epoch,package_id:i.package,manager_session_id:i.manager,manager_generation:2,leader_generation:1,cohort_id:cohort.id,cohort_generation:Number(cohort.cohort_generation),admission,admission_digest:admission.admission_digest,expires_at:admission.expires_at,state:'READY',receipt,receipt_digest:receipt.receipt_digest,completed_at:receipt.completed_at});
  await insert('fleet_install_heads',{...scope,environment_id:admission.environment_id,environment_generation:admission.environment_generation,sandbox_id:i.sandbox,boot_id:i.boot,boot_generation:1,logical_operation_id:admission.operation_id,current_operation_id:admission.operation_id});
  for(const {runner,slot}of runnerRows)await insert('fleet_runtime_readiness',{...scope,id:randomUUID(),install_operation_id:admission.operation_id,runner_operation_id:job,runner_result_digest:pin,sandbox_id:i.sandbox,boot_id:i.boot,boot_generation:1,slot_id:slot.worker_slot_id,slot_generation:1,runner_session_id:runner,readiness_digest:digest({prior:admission.operation_id,slot:slot.slot}),receipt_digest:receipt.receipt_digest,input_digest:admission.input_digest,measurement_digest:pin,source_digest:installed.source.digest,source_object_id:installed.source.revision,source_tree_id:installed.source.root_tree_id,publication:{fixture:'CONTROLLED_PRIOR_READY_INPUT',installation_receipt_digest:receipt.receipt_digest}});
  const installBinding={operation_id:admission.operation_id,environment_id:admission.environment_id,environment_generation:admission.environment_generation,sandbox_id:i.sandbox,boot_id:i.boot,boot_generation:'1',input_digest:admission.input_digest};
  const applied=new Map();
  return {
    scope:nativeFleetAssignmentFixtureScope,
    installBinding,
    slots,
    async assign(taskId,slot=0){
      assert(taskIds.includes(taskId),'Selected task must be explicitly delegated');
      assert(slots.some(value=>value.slot===slot),'Selected workspace slot must be installed');
      const task=(await query('SELECT generation::text FROM hyperfide.tasks WHERE organisation_id=$1 AND run_id=$2 AND id=$3',[...keys,taskId])).rows[0];
      const input={selection:{task_id:taskId,expected_task_generation:task.generation,worker_slot:slot,lease_ms:300000,max_runtime_seconds:3600,max_output_bytes:1048576,capacity,optional_context:[]},install_binding:installBinding};
      const decision=await recordDecision(input);
      const result=await controlCall('manager','fleet-orchestration','fleet.decision.apply',{decision});
      assert.equal(result.assignment.assignment_id,decision.decision_id);
      assert.equal(result.assignment.worker_id,decision.decision_id);
      assert.equal(result.assignment.tasks[0].attempt_id,decision.operation_id);
      const packet=(await query('SELECT digest FROM hyperfide.hierarchy_execution_packets WHERE organisation_id=$1 AND run_id=$2 AND attempt_id=$3',[...keys,decision.operation_id])).rows;
      assert.equal(packet.length,1);
      const attempt=(await query('SELECT input_packet_digest,compute_authority FROM hyperfide.attempts WHERE organisation_id=$1 AND run_id=$2 AND id=$3',[...keys,decision.operation_id])).rows[0];
      assert.equal(attempt.compute_authority,'CURRENT');
      assert.equal(attempt.input_packet_digest,packet[0].digest);
      const worker=(await query('SELECT packet_digest FROM hyperfide.hierarchy_worker_registrations WHERE organisation_id=$1 AND run_id=$2 AND session_id=$3',[...keys,decision.decision_id])).rows[0];
      assert.equal(worker.packet_digest,packet[0].digest);
      applied.set(decision.decision_id,decision);
      return result;
    },
    async replay(assignmentId){
      const decision=applied.get(assignmentId);assert(decision,'A real assignment decision must have been applied');
      const result=await controlCall('manager','fleet-orchestration','fleet.decision.apply',{decision});
      assert.equal(result.replayed,true);return result;
    },
  };
}
