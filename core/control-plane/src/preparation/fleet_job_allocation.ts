import {randomUUID} from 'node:crypto';
import type {PrimaryTransaction} from '../storage/transactions.js';
import {assertPrimaryTransaction} from '../storage/transactions.js';
import {assertInvocation,exact,fail,uuid,decimal} from '../transport/protocol.js';
import type {InvocationContext} from '../transport/protocol.js';
import {lockRun} from '../events/outbox.js';
import {object} from '../policy/programme.js';
import {readRunnerPreparationBinding} from '../runner/bridge.js';
import {requireSchedulerAuthority,operationReplay,recordOutcome,jobPolicy,approvedDimensions,requestDigest,allocateReservations,bindJobReservation,readJobAllocation,assertNoExecutionHold} from '../scheduler/claim.js';
import {reserveDynamic} from '../scheduler/resources.js';
import {ensureFleetTestExecutor} from './fleet_test_executor.js';
type Data=Record<string,any>;
/** The caller selects an exact accepted task and executor; this function never searches for work. */
export async function allocateFleetJob(tx:PrimaryTransaction,i:InvocationContext,value:unknown,purpose:'PREPARATION'|'TEST'):Promise<Data>{
 assertPrimaryTransaction(tx);assertInvocation(i);await i.guard(tx);
 if(!['OPERATOR','COORDINATOR'].includes(i.principal.role))fail('FLEET_JOB_ROLE','Mechanical orchestration authority required');
 if(!object(value))fail('FLEET_JOB_INPUT','Exact selected task and runner binding required');
 exact(value,['request_id','task_id','package_id','manager_session_id','manager_generation','leader_generation','authority_epoch','session_id','slot_id','slot_generation','sandbox_id','boot_id','boot_generation','deadline_ms']);
 const v=value as Data;
 if(![v.request_id,v.task_id,v.package_id,v.manager_session_id,v.authority_epoch,v.session_id,v.slot_id,v.sandbox_id,v.boot_id].every(uuid)||![v.manager_generation,v.leader_generation,v.slot_generation,v.boot_generation].every(x=>decimal(x,true))||!Number.isSafeInteger(v.deadline_ms)||v.deadline_ms<1000||v.deadline_ms>3600000||v.authority_epoch!==i.principal.deployment_epoch)fail('FLEET_JOB_INPUT','Canonical current generation identities and bounded deadline required');
 const scope={organisation_id:i.principal.organisation_id,run_id:i.principal.run_id};await lockRun(tx,scope);
 const task=(await tx.query('SELECT feature_package_id,spec_revision_id,spec_generation,criteria_digest FROM hyperfide.tasks WHERE organisation_id=$1 AND run_id=$2 AND id=$3 FOR SHARE',[scope.organisation_id,scope.run_id,v.task_id])).rows[0];
 if(!task||task.feature_package_id!==v.package_id)fail('FLEET_JOB_TASK','Selected task must belong to the current accepted package');
 await requireSchedulerAuthority(tx,scope,{session_id:v.manager_session_id,leader_generation:v.leader_generation,package_generation:v.manager_generation},v.authority_epoch,v.package_id);
 const owner=(await tx.query(`SELECT d.budget FROM hyperfide.feature_packages p JOIN hyperfide.agent_sessions m ON m.organisation_id=p.organisation_id AND m.run_id=p.run_id AND m.id=p.manager_session_id JOIN hyperfide.fleet_delegations d ON d.organisation_id=p.organisation_id AND d.run_id=p.run_id AND d.package_id=p.id WHERE p.organisation_id=$1 AND p.run_id=$2 AND p.id=$3 AND p.manager_session_id=$4 AND m.role='FEATURE_MANAGER' AND d.manager_session_id=$4 AND d.manager_generation=$5 AND d.leader_generation=$6 FOR SHARE OF p,m,d`,[scope.organisation_id,scope.run_id,v.package_id,v.manager_session_id,v.manager_generation,v.leader_generation])).rows[0];
 if(!owner)fail('FLEET_JOB_MANAGER','Selected current manager must own the exact delegated package');if(!Array.isArray(owner.budget?.task_ids)||!owner.budget.task_ids.includes(v.task_id))fail('FLEET_JOB_TASK_BUDGET','Selected task is outside the current manager task budget');
 await assertNoExecutionHold(tx,scope,{package_id:v.package_id,sandbox_id:v.sandbox_id,operation:'ADMISSION'});
 const sandbox=(await tx.query(`SELECT s.*,p.profile_id,p.provider FROM hyperfide.sandboxes s JOIN hyperfide.provider_pools p ON p.organisation_id=s.organisation_id AND p.id=s.pool_id WHERE s.organisation_id=$1 AND s.id=$2 AND EXISTS(SELECT 1 FROM hyperfide.fleet_effect_receipts e WHERE e.organisation_id=s.organisation_id AND e.run_id=$3 AND e.result->>'delegation_id'=$4 AND e.result->>'sandbox_id'=s.id::text) FOR SHARE OF s,p`,[scope.organisation_id,v.sandbox_id,scope.run_id,v.package_id])).rows[0];
 if(!sandbox||sandbox.desired_state!=='RUNNING'||sandbox.observed_state!=='RUNNING'||!Array.isArray(owner.budget?.provider_ids)||!owner.budget.provider_ids.includes(sandbox.provider)||!Array.isArray(owner.budget?.profile_ids)||!owner.budget.profile_ids.includes(sandbox.profile_id))fail('FLEET_JOB_SANDBOX_SCOPE','Selected sandbox must belong to this admitted manager effect and provider/profile budget');

 const operation='fleet-job-allocation:'+purpose,prior=await operationReplay(tx,scope,i.principal.actor_id,operation,v.request_id,v);
 const runner=await readRunnerPreparationBinding(tx,{...scope,session_id:v.session_id});
 if(runner.slot_id!==v.slot_id||runner.sandbox_id!==v.sandbox_id||runner.boot_id!==v.boot_id||runner.boot_generation!==v.boot_generation||runner.slot_generation!==v.slot_generation||!(purpose==='PREPARATION'?['PREPARATION','TEST'].includes(runner.capacity_kind):runner.capacity_kind==='TEST'))fail('FLEET_JOB_RUNNER','Selected runner must match the exact current purpose slot and boot');
 if(runner.capacity_kind==='TEST')await ensureFleetTestExecutor(tx,i,{runner,manager_session_id:v.manager_session_id,task_id:v.task_id,package_id:v.package_id});
 if(prior!==undefined){const previous=prior as Data;const current=await readJobAllocation(tx,{...scope,reservation_id:previous.allocation.reservation_id});if(current.allocation_id!==previous.allocation.allocation_id)fail('FLEET_JOB_REPLAY_STALE','Retained executor allocation differs');return previous;}
 await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[scope.organisation_id+':'+runner.pool_id+':resource-admission']);
 const policy=await jobPolicy(tx,scope,v.task_id,'ADMISSION'),dimensions=await approvedDimensions(tx,scope,runner.pool_id,policy,purpose);
 const queued=await tx.query("SELECT id FROM hyperfide.resource_waiters WHERE organisation_id=$1 AND pool_id=$2 AND state='WAITING' AND deadline_at>clock_timestamp() LIMIT 1",[scope.organisation_id,runner.pool_id]);
 if(queued.rows.length)fail('FLEET_JOB_QUEUE_PENDING','Existing resource waiters must be resolved before immediate exact job binding');
 const duplicate=await tx.query('SELECT id FROM hyperfide.resource_waiters WHERE organisation_id=$1 AND run_id=$2 AND request_id=$3',[scope.organisation_id,scope.run_id,v.request_id]);if(duplicate.rows.length)fail('FLEET_JOB_REQUEST_CONFLICT','Request already belongs to another resource admission');
 const clock=(await tx.query("SELECT (clock_timestamp()+$1::integer*interval '1 millisecond')::text AS expires_at",[v.deadline_ms])).rows[0]!;
 const waiter=randomUUID();await tx.query("INSERT INTO hyperfide.resource_waiters(organisation_id,run_id,id,request_id,pool_id,owner_session_id,task_id,job_kind,priority,wait_reason,deadline_at,spec_revision_id,spec_generation,criteria_digest,resource_policy_digest,state,admitted_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,0,'CAPACITY',$9,$10,$11,$12,$13,'ADMITTED',clock_timestamp())",[scope.organisation_id,scope.run_id,waiter,v.request_id,runner.pool_id,v.manager_session_id,v.task_id,purpose,clock.expires_at,task.spec_revision_id,task.spec_generation,task.criteria_digest,requestDigest(policy)]);
 for(const dimension of dimensions)await tx.query('INSERT INTO hyperfide.resource_waiter_dimensions(organisation_id,run_id,waiter_id,pool_id,capacity_account_id,quantity) VALUES($1,$2,$3,$4,$5,$6)',[scope.organisation_id,scope.run_id,waiter,runner.pool_id,dimension.capacity_account_id,dimension.quantity]);
 await reserveDynamic(tx,{...scope,request_id:v.request_id,pool_id:runner.pool_id,dimensions,expires_at:clock.expires_at});
 const reservations=(await tx.query('SELECT r.id,a.dimension FROM hyperfide.reservations r JOIN hyperfide.capacity_accounts a ON a.organisation_id=r.organisation_id AND a.id=r.capacity_account_id WHERE r.organisation_id=$1 AND r.run_id=$2 AND r.request_id=$3 ORDER BY r.id',[scope.organisation_id,scope.run_id,v.request_id])).rows;
 await allocateReservations(tx,{...scope,reservation_ids:reservations.map(row=>row.id)});
 const selected=reservations.find(row=>row.dimension===purpose);if(!selected)fail('FLEET_JOB_RESERVATION','Dedicated purpose reservation is absent');
 if(purpose==='PREPARATION'){
  // This is the observed native preparation executor, not a coding attempt or model session.
  const existing=(await tx.query('SELECT * FROM hyperfide.agent_sessions WHERE organisation_id=$1 AND run_id=$2 AND id=$3 FOR UPDATE',[scope.organisation_id,scope.run_id,runner.session_id])).rows[0];
  if(existing&&runner.capacity_kind!=='PREPARATION'){
   if(existing.parent_session_id!==v.manager_session_id||existing.slot_id!==runner.slot_id||existing.sandbox_id!==runner.sandbox_id||String(existing.sandbox_boot_generation)!==runner.boot_generation||!['REGISTERED','RUNNING'].includes(existing.state))fail('FLEET_JOB_EXECUTOR_CONFLICT','Existing fallback executor differs from the selected manager and physical binding');
  }else if(existing){
   if(existing.role!=='WORKER'||existing.parent_session_id!==v.manager_session_id||existing.connector!=='hyperfide-native'||existing.account_key!==runner.credential_id||existing.native_session_id!==runner.session_id||existing.slot_id!==runner.slot_id||existing.sandbox_id!==runner.sandbox_id||String(existing.sandbox_boot_generation)!==runner.boot_generation||existing.attempt_id!==null||!['REGISTERED','RUNNING'].includes(existing.state))fail('FLEET_JOB_EXECUTOR_CONFLICT','Existing preparation executor differs from the observed native identity');
  }else{
   if(runner.capacity_kind!=='PREPARATION')fail('FLEET_JOB_EXECUTOR_MISSING','Only an observed PREPARATION slot may create its mechanical executor registration');
   await tx.query("INSERT INTO hyperfide.agent_sessions(organisation_id,run_id,id,role,parent_session_id,connector,account_key,native_session_id,slot_id,sandbox_id,sandbox_boot_generation,state) VALUES($1,$2,$3,'WORKER',$4,'hyperfide-native',$5,$9,$6,$7,$8,'REGISTERED')",[scope.organisation_id,scope.run_id,runner.session_id,v.manager_session_id,runner.credential_id,runner.slot_id,runner.sandbox_id,runner.boot_generation,runner.session_id]);
  }
 }
 const allocation=await bindJobReservation(tx,{...scope,task_id:v.task_id,job_kind:purpose,reservation_id:selected.id,slot_id:v.slot_id,sandbox_id:v.sandbox_id,sandbox_boot_generation:v.boot_generation,assignee_session_id:v.session_id});
 const result={allocation,reservation_ids:reservations.map(row=>row.id),waiter_id:waiter,target_binding_id:allocation.allocation_id,runner_session_id:runner.session_id,boot_id:runner.boot_id,authority:'ACCEPTED_TASK_RESOURCE_BINDING',runtime_ready:false};
 await recordOutcome(tx,scope,i.principal.actor_id,operation,v.request_id,v,result);return result;
}
