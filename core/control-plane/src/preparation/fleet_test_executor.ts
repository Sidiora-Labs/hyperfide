import type {PrimaryTransaction} from '../storage/transactions.js';
import {assertPrimaryTransaction} from '../storage/transactions.js';
import type {InvocationContext} from '../transport/protocol.js';
import {assertInvocation,fail,hash,uuid} from '../transport/protocol.js';
import {object} from '../policy/programme.js';
import {fleetReadinessCanonical,fleetReadinessDigest} from './fleet_readiness_contract.js';

type Data=Record<string,any>;

/** Register the observed native TEST controller, never a model session or coding attempt. */
export async function ensureFleetTestExecutor(tx:PrimaryTransaction,i:InvocationContext,input:{runner:Data;manager_session_id:string;task_id:string;package_id:string}):Promise<void>{
 assertPrimaryTransaction(tx);assertInvocation(i);
 const {runner:r}=input,p=i.principal;
 if(!['OPERATOR','COORDINATOR'].includes(p.role)||r.capacity_kind!=='TEST')fail('FLEET_TEST_EXECUTOR_SCOPE','Mechanical authority and an actual TEST runner are required');
 const existing=(await tx.query('SELECT * FROM hyperfide.agent_sessions WHERE organisation_id=$1 AND run_id=$2 AND id=$3 FOR UPDATE',[p.organisation_id,p.run_id,r.session_id])).rows[0];
 if(existing){
  if(existing.role!=='VERIFIER'||existing.connector!=='hyperfide-native'||existing.account_key!==r.credential_id||existing.native_session_id!==r.session_id||existing.parent_session_id!==input.manager_session_id||existing.attempt_id!==null||existing.slot_id!==r.slot_id||existing.sandbox_id!==r.sandbox_id||String(existing.sandbox_boot_generation)!==r.boot_generation||!['REGISTERED','RUNNING'].includes(existing.state))fail('FLEET_TEST_EXECUTOR_CONFLICT','Existing verifier must retain its immutable independent manager and physical binding');
  return;
 }
 const bootstraps=(await tx.query(`SELECT n.*,s.observed_state,s.desired_state,s.boot_generation::text AS current_boot,b.boot_id AS current_boot_id
 FROM hyperfide.provider_native_bootstraps n JOIN hyperfide.sandboxes s ON s.organisation_id=n.organisation_id AND s.id=n.sandbox_id
 JOIN hyperfide.sandbox_boots b ON b.organisation_id=s.organisation_id AND b.sandbox_id=s.id AND b.boot_generation=s.boot_generation
 JOIN hyperfide.identity_enrollment_grants g ON g.organisation_id=n.organisation_id AND g.run_id=n.run_id AND g.id=n.grant_id
 WHERE n.organisation_id=$1 AND n.run_id=$2 AND n.sandbox_id=$3 AND n.boot_id=$4 AND n.boot_generation=$5
 AND n.state='READY' AND g.state='CONSUMED' AND g.credential_id=$6 FOR SHARE OF n,s,b,g`,[p.organisation_id,p.run_id,r.sandbox_id,r.boot_id,r.boot_generation,r.credential_id])).rows;
 if(bootstraps.length!==1)fail('FLEET_TEST_BOOTSTRAP_REQUIRED','One actually completed independent TEST bootstrap is required');
 const bootstrap=bootstraps[0]!,manifest=bootstrap.manifest,receipt=bootstrap.receipt;
 if(bootstrap.observed_state!=='RUNNING'||bootstrap.desired_state!=='RUNNING'||bootstrap.current_boot!==r.boot_generation||bootstrap.current_boot_id!==r.boot_id||!object(manifest)||manifest.kind!=='FLEET_NATIVE_TEST_BOOTSTRAP_V1'||hash(fleetReadinessCanonical(manifest))!==bootstrap.manifest_digest||fleetReadinessDigest(bootstrap.descriptor)!==bootstrap.descriptor_digest||!object(receipt)||receipt.kind!=='FLEET_NATIVE_TEST_BOOTSTRAP_RECEIPT_V1'||fleetReadinessDigest(receipt)!==bootstrap.receipt_digest||!Array.isArray(receipt.slots)||receipt.slots.length!==1)fail('FLEET_TEST_BOOTSTRAP_REQUIRED','Immutable current TEST bootstrap evidence is required');
 if(!object(manifest.template))fail('FLEET_TEST_EXECUTOR_SCOPE','Pinned TEST native template required');
 const slots=manifest.template.slots;
 if(!Array.isArray(slots)||slots.length!==1)fail('FLEET_TEST_EXECUTOR_SCOPE','Independent TEST bootstrap must contain exactly one TEST executor');
 const slot=slots[0],observed=receipt.slots[0];
 if(!object(slot)||slot.kind!=='TEST'||slot.credential_sensitive!==false||slot.slot_id!==r.slot_id||slot.session_id!==r.session_id||slot.uid!==r.uid||slot.gid!==r.gid||!object(observed)||observed.kind!=='TEST'||observed.slot_id!==slot.slot_id||observed.session_id!==slot.session_id||observed.uid!==slot.uid||observed.gid!==slot.gid||String(observed.slot_generation)!==r.slot_generation)fail('FLEET_TEST_EXECUTOR_SCOPE','Actual TEST identity differs from its isolated immutable template');
 const selected=bootstrap.descriptor.test_template;
 const task=(await tx.query('SELECT task_key,feature_package_id FROM hyperfide.tasks WHERE organisation_id=$1 AND run_id=$2 AND id=$3 FOR SHARE',[p.organisation_id,p.run_id,input.task_id])).rows[0];
 if(!object(selected)||!uuid(selected.job_id)||!task||selected.task_key!==task.task_key||task.feature_package_id!==input.package_id)fail('FLEET_TEST_EXECUTOR_SCOPE','TEST bootstrap must select the accepted delegated task and immutable verification job');
 {
  const job=(await tx.query(`SELECT a.sandbox_id FROM hyperfide.qualification_jobs j JOIN hyperfide.submission_custodies c ON c.organisation_id=j.organisation_id AND c.run_id=j.run_id AND c.id=j.custody_id JOIN hyperfide.attempts a ON a.organisation_id=c.organisation_id AND a.run_id=c.run_id AND a.id=c.source_attempt_id WHERE j.organisation_id=$1 AND j.run_id=$2 AND j.id=$3 AND c.task_id=$4 AND j.state IN('PENDING','RUNNING') FOR SHARE OF j,c,a`,[p.organisation_id,p.run_id,selected.job_id,input.task_id])).rows[0];
  if(!job||job.sandbox_id===r.sandbox_id)fail('QUALIFICATION_NOT_INDEPENDENT','TEST execution must use a different sandbox from the immutable submitted coding attempt');
 }
 await tx.query("INSERT INTO hyperfide.agent_sessions(organisation_id,run_id,id,role,parent_session_id,connector,account_key,native_session_id,slot_id,sandbox_id,sandbox_boot_generation,state) VALUES($1,$2,$3,'VERIFIER',$4,'hyperfide-native',$5,$9::text,$6,$7,$8,'REGISTERED')",[p.organisation_id,p.run_id,r.session_id,input.manager_session_id,r.credential_id,r.slot_id,r.sandbox_id,r.boot_generation,r.session_id]);
}
