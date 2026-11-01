import {createPublicKey,verify} from 'node:crypto';
import type {PrimaryTransaction} from '../storage/transactions.js';
import {assertPrimaryTransaction} from '../storage/transactions.js';
import type {InvocationContext} from '../transport/protocol.js';
import {assertInvocation,fail,hash,uuid} from '../transport/protocol.js';
import {object} from '../policy/programme.js';
import {runnerCanonical,runnerResultSigningBytes} from '../runner/bridge.js';
import {ResourceScheduler} from '../scheduler/resources.js';
import {lockRun} from '../events/outbox.js';
import {requestDigest} from '../scheduler/claim.js';

type Data=Record<string,any>;

export async function freshTestCleanupObservation(tx:PrimaryTransaction,scope:{organisation_id:string;run_id:string},boot:Data,job:Data,session:Data,slot:Data):Promise<{id:string;digest:string;observed_at:string}|null>{
 const row=(await tx.query(`SELECT n.*,clock_timestamp() AS db_now FROM hyperfide.command_inbox n
 JOIN hyperfide.identity_principals p ON p.credential_id::text=n.principal_scope AND p.organisation_id=n.organisation_id AND p.run_id=n.run_id
 WHERE n.organisation_id=$1 AND n.run_id=$2 AND n.principal_scope=$3 AND n.operation='fleet.test.cleanup.observe' AND n.state='COMPLETED'
 AND n.result->>'bootstrap_id'=$4 AND n.result->>'job_id'=$5 AND n.result->>'session_id'=$6
 AND p.role='RUNNER' AND p.state='ACTIVE' AND p.sandbox_id=$7 AND p.boot_id=$8 AND p.boot_generation=$9 AND p.expires_at>clock_timestamp()
 ORDER BY n.created_at DESC,n.id DESC LIMIT 1 FOR SHARE OF n,p`,[scope.organisation_id,scope.run_id,boot.receipt.credential_id,boot.id,job.id,session.id,boot.sandbox_id,boot.boot_id,String(boot.boot_generation)])).rows[0];
 if(!row||!object(row.result))return null;
 const r=row.result;
 if(r.schema_version!==1||r.kind!=='FLEET_TEST_CLEANUP_OBSERVATION_V1'||r.credential_id!==boot.receipt.credential_id||r.organisation_id!==scope.organisation_id||r.run_id!==scope.run_id||r.bootstrap_id!==boot.id||r.job_id!==job.id||r.session_id!==session.id||r.sandbox_id!==boot.sandbox_id||r.boot_id!==boot.boot_id||String(r.boot_generation)!==String(boot.boot_generation)||r.slot_id!==slot.slot_id||String(r.slot_generation)!==String(slot.slot_generation)||r.manifest_digest!==boot.manifest_digest||!uuid(r.request_nonce)||r.request_nonce!==row.idempotency_key||typeof r.observed_at!=='string'||typeof r.accepted_at!=='string'||!object(r.native_receipt)||r.native_receipt.slot_id!==slot.slot_id||r.native_receipt.released!==true||r.native_receipt.observed_process_absent!==true)return null;
 const now=new Date(row.db_now).getTime(),times=[Date.parse(r.observed_at),Date.parse(r.accepted_at),new Date(row.created_at).getTime()];
 if(times.some((time,index)=>!Number.isFinite(time)||now-time<(index===0?-5000:0)||now-time>30000))return null;
 const cleanup_observation={request_nonce:r.request_nonce,observed_at:r.observed_at,manifest_digest:r.manifest_digest,slot_id:r.slot_id,slot_generation:r.slot_generation,session_id:r.session_id,sandbox_id:r.sandbox_id,boot_id:r.boot_id,boot_generation:r.boot_generation,native_receipt:r.native_receipt};
 if(row.request_digest!==requestDigest({bootstrap_id:boot.id,session_id:session.id,cleanup_observation}))return null;
 return {id:row.id,digest:hash(runnerCanonical(r)),observed_at:r.observed_at};
}

/** A completed qualification releases only its isolated TEST executor, never coding compute. */
export async function retireFleetTestExecutor(tx:PrimaryTransaction,i:InvocationContext,input:{bootstrap_id:string;job_id:string;session_id:string}):Promise<Data>{
 assertPrimaryTransaction(tx);assertInvocation(i);await i.guard(tx);
 if(!['OPERATOR','COORDINATOR'].includes(i.principal.role)||![input.bootstrap_id,input.job_id,input.session_id].every(uuid))fail('FLEET_TEST_RETIRE_SCOPE','Mechanical authority and exact independent TEST identities required');
 const scope={organisation_id:i.principal.organisation_id,run_id:i.principal.run_id},s=[scope.organisation_id,scope.run_id];
 await lockRun(tx,scope);
 const boot=(await tx.query(`SELECT n.*,b.boot_id AS current_boot_id,s.boot_generation::text AS current_generation,s.observed_state,s.desired_state FROM hyperfide.provider_native_bootstraps n JOIN hyperfide.sandboxes s ON s.organisation_id=n.organisation_id AND s.id=n.sandbox_id JOIN hyperfide.sandbox_boots b ON b.organisation_id=s.organisation_id AND b.sandbox_id=s.id AND b.boot_generation=s.boot_generation WHERE n.organisation_id=$1 AND n.run_id=$2 AND n.id=$3 FOR SHARE OF n,s,b`,[...s,input.bootstrap_id])).rows[0];
 const slot=boot?.receipt?.slots?.[0],testTemplate=boot?.descriptor?.test_template;
 if(!boot||boot.state!=='READY'||!object(boot.manifest)||!object(boot.receipt)||boot.manifest.kind!=='FLEET_NATIVE_TEST_BOOTSTRAP_V1'||hash(runnerCanonical(boot.manifest))!==boot.manifest_digest||!object(boot.descriptor)||hash(runnerCanonical(boot.descriptor))!==boot.descriptor_digest||boot.receipt.manifest_digest!==boot.manifest_digest||hash(runnerCanonical(boot.receipt))!==boot.receipt_digest||boot.receipt?.kind!=='FLEET_NATIVE_TEST_BOOTSTRAP_RECEIPT_V1'||!Array.isArray(boot.receipt.slots)||boot.receipt.slots.length!==1||!object(slot)||slot.kind!=='TEST'||slot.session_id!==input.session_id||!object(testTemplate)||testTemplate.job_id!==input.job_id||boot.current_boot_id!==boot.boot_id||boot.current_generation!==String(boot.boot_generation)||boot.observed_state!=='RUNNING'||boot.desired_state!=='RUNNING')fail('FLEET_TEST_RETIRE_SCOPE','Current immutable independent TEST bootstrap required');
 const job=(await tx.query(`SELECT j.*,c.task_id,a.sandbox_id AS coding_sandbox FROM hyperfide.qualification_jobs j JOIN hyperfide.submission_custodies c ON c.organisation_id=j.organisation_id AND c.run_id=j.run_id AND c.id=j.custody_id JOIN hyperfide.attempts a ON a.organisation_id=c.organisation_id AND a.run_id=c.run_id AND a.id=c.source_attempt_id WHERE j.organisation_id=$1 AND j.run_id=$2 AND j.id=$3 FOR UPDATE OF j`,[...s,input.job_id])).rows[0];
 const session=(await tx.query('SELECT * FROM hyperfide.agent_sessions WHERE organisation_id=$1 AND run_id=$2 AND id=$3 FOR UPDATE',[...s,input.session_id])).rows[0];
 if(!job||!['SUCCEEDED','FAILED','CANCELLED'].includes(job.state)||job.coding_sandbox===boot.sandbox_id||!session||session.role!=='VERIFIER'||session.connector!=='hyperfide-native'||session.native_session_id!==session.id||session.account_key!==boot.receipt.credential_id||session.attempt_id!==null||session.slot_id!==slot.slot_id||session.sandbox_id!==boot.sandbox_id||String(session.sandbox_boot_generation)!==String(boot.boot_generation)||!['REGISTERED','RUNNING','STOPPED'].includes(session.state))fail('FLEET_TEST_RETIRE_SCOPE','Terminal independent job and its exact native verifier required');
 const receipt=(await tx.query('SELECT * FROM hyperfide.assurance_job_receipts WHERE organisation_id=$1 AND run_id=$2 AND job_id=$3 AND lease_generation=$4 FOR SHARE',[...s,input.job_id,String(job.lease_generation)])).rows[0];
 const r=receipt?.receipt;
 if(!receipt||!object(r)||hash(runnerCanonical(r))!==receipt.receipt_digest||receipt.verifier_id!==session.id||r.verifier_id!==session.id||r.verifier_sandbox_id!==boot.sandbox_id||r.verifier_boot_id!==boot.boot_id||String(r.verifier_boot_generation)!==String(boot.boot_generation)||r.job_id!==job.id||String(r.lease_generation)!==String(job.lease_generation)||!Array.isArray(r.checks)||!r.checks.length)fail('FLEET_TEST_RETIRE_RECEIPT','Exact retained terminal qualification receipt required');
 const allocation=(await tx.query('SELECT * FROM hyperfide.resource_job_allocations WHERE organisation_id=$1 AND run_id=$2 AND id=$3 FOR UPDATE',[...s,r.allocation_id])).rows[0];
 if(!allocation||allocation.job_kind!=='TEST'||allocation.task_id!==job.task_id||allocation.assignee_session_id!==session.id||allocation.slot_id!==slot.slot_id||allocation.sandbox_id!==boot.sandbox_id||String(allocation.sandbox_boot_generation)!==String(boot.boot_generation)||String(allocation.generation)!==String(r.allocation_generation)||allocation.reservation_id!==r.reservation_id||!['RELEASE_PENDING','RELEASED'].includes(allocation.state))fail('FLEET_TEST_RETIRE_ALLOCATION','Exact logically released TEST allocation required');
 const checks=(await tx.query(`SELECT c.check_id,c.plan_digest AS intent_plan_digest,c.plan AS intent_plan,j.*,p.role AS executor_role,p.public_key_b64,clock_timestamp() AS db_now FROM hyperfide.assurance_check_intents c JOIN hyperfide.runner_remote_jobs j ON j.organisation_id=c.organisation_id AND j.run_id=c.run_id AND j.operation_id=c.operation_id JOIN hyperfide.identity_principals p ON p.credential_id=j.executor_credential_id WHERE c.organisation_id=$1 AND c.run_id=$2 AND c.job_id=$3 AND c.lease_generation=$4 ORDER BY j.completed_at FOR SHARE OF c,j,p`,[...s,job.id,String(job.lease_generation)])).rows;
 if(checks.length!==r.checks.length||new Set(checks.map((c:Data)=>c.check_id)).size!==checks.length)fail('FLEET_TEST_RETIRE_QUIESCENCE','Every retained qualification check requires its actual provider result');
 for(const check of checks){
  const result=check.result,plan=check.plan,recorded=r.checks.find((c:Data)=>c.check_id===check.check_id);
  if(!recorded||check.state!=='COMPLETED'||check.job_class!=='EXECUTION'||check.executor_role!=='PROVISIONER'||check.session_id!==session.id||check.reservation_id!==allocation.reservation_id||!object(plan)||hash(runnerCanonical(plan))!==check.plan_digest||!object(plan.request)||hash(runnerCanonical(plan.request))!==check.intent_plan_digest||runnerCanonical(plan.request)!==runnerCanonical(check.intent_plan)||!object(plan.binding)||!object(plan.allocation)||plan.binding.sandbox_id!==boot.sandbox_id||plan.binding?.boot_id!==boot.boot_id||plan.binding?.slot_id!==slot.slot_id||plan.allocation?.allocation_id!==allocation.id||String(plan.allocation?.generation)!==String(allocation.generation)||!object(result)||hash(runnerCanonical(result))!==check.result_digest||result.operation_id!==check.operation_id||result.organisation_id!==scope.organisation_id||result.run_id!==scope.run_id||result.session_id!==session.id||result.sandbox_id!==boot.sandbox_id||result.boot_id!==boot.boot_id||String(result.boot_generation)!==String(boot.boot_generation)||result.slot_id!==slot.slot_id||String(result.slot_generation)!==String(slot.slot_generation)||result.outcome==='UNKNOWN'||result.cleanup_status!=='CONFIRMED'||!object(result.cleanup)||result.cleanup.complete!==true||result.cleanup?.observed_process_absent!==true||!object(recorded.execution)||recorded.execution.operation_id!==check.operation_id||recorded.execution?.session_id!==session.id||recorded.execution?.sandbox_id!==boot.sandbox_id||recorded.execution?.boot_id!==boot.boot_id||recorded.execution?.slot_id!==slot.slot_id||typeof check.result_signature!=='string'||typeof check.public_key_b64!=='string')fail('FLEET_TEST_RETIRE_QUIESCENCE','Actual signed complete TEST check cleanup required');
  const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(check.public_key_b64,'base64url')]),format:'der',type:'spki'});
  if(!verify(null,runnerResultSigningBytes(scope.organisation_id,scope.run_id,check.operation_id,check.plan_digest,check.result_digest),key,Buffer.from(check.result_signature,'base64url')))fail('FLEET_TEST_RETIRE_QUIESCENCE','TEST provider cleanup signature differs');
 }
 const other=(await tx.query("SELECT id FROM hyperfide.resource_job_allocations WHERE organisation_id=$1 AND run_id=$2 AND assignee_session_id=$3 AND id<>$4 AND state<>'RELEASED' LIMIT 1",[...s,session.id,allocation.id])).rows;
 const running=(await tx.query("SELECT operation_id FROM hyperfide.runner_remote_jobs WHERE organisation_id=$1 AND run_id=$2 AND session_id=$3 AND state<>'COMPLETED' LIMIT 1",[...s,session.id])).rows;
 if(other.length||running.length)fail('FLEET_TEST_RETIRE_QUIESCENCE','Preparation allocations and all remote operations must be actually released or complete');
 const reservations=(await tx.query('SELECT id,state FROM hyperfide.reservations WHERE organisation_id=$1 AND run_id=$2 AND request_id=$3 ORDER BY id',[...s,allocation.request_id])).rows;
 if(!reservations.length)fail('FLEET_TEST_RETIRE_ALLOCATION','TEST reservation inventory required');
 if(allocation.state!=='RELEASED'||reservations.some((v:Data)=>v.state!=='RELEASED')){
  const latest=checks.at(-1)!,age=new Date(latest.db_now).getTime()-Date.parse(latest.result.ended_at);
  let proof={id:String(latest.operation_id),digest:String(latest.result_digest),observed_at:String(latest.result.ended_at)};
  if(!Number.isFinite(age)||age<0||age>30000){const observed=await freshTestCleanupObservation(tx,scope,boot,job,session,slot);if(!observed)fail('FLEET_TEST_RETIRE_QUIESCENCE','Fresh signed final empty TEST slot observation required');proof=observed;}
  const scheduler=new ResourceScheduler(),ids=new Set<string>(reservations.map((v:Data)=>String(v.id)));
  scheduler.registerProofReader('runner.quiescence',async(_tx,request)=>ids.has(request.reservation_id)?proof:null);
  try{await scheduler.release(tx,{...scope,reservation_ids:[...ids]});}finally{scheduler.close();}
 }
 const held=(await tx.query("SELECT id FROM hyperfide.resource_job_allocations WHERE organisation_id=$1 AND run_id=$2 AND assignee_session_id=$3 AND state<>'RELEASED' LIMIT 1",[...s,session.id])).rows;
 if(held.length)fail('FLEET_TEST_RETIRE_QUIESCENCE','All actual TEST/PREPARATION capacity must be released before verifier retirement');
 await tx.query("UPDATE hyperfide.agent_sessions SET state='STOPPED',state_version=state_version+1 WHERE organisation_id=$1 AND run_id=$2 AND id=$3 AND state<>'STOPPED'",[...s,session.id]);
 await tx.query("UPDATE hyperfide.identity_principals SET state='REVOKED',credential_version=credential_version+1 WHERE organisation_id=$1 AND run_id=$2 AND actor_id=$3 AND role='VERIFIER' AND sandbox_id=$4 AND boot_id=$5 AND boot_generation=$6 AND state='ACTIVE'",[...s,session.id,boot.sandbox_id,boot.boot_id,String(boot.boot_generation)]);
 return {state:'STOPPED',bootstrap_id:input.bootstrap_id,job_id:job.id,session_id:session.id,reservation_ids:reservations.map((v:Data)=>v.id),resources_still_counted:false,coding_compute_changed:false};
}
