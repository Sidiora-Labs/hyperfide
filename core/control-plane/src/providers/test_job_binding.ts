import type {ArtifactStoreCapability} from '../artifacts/objects.js';
import type {PrimaryTransaction} from '../storage/transactions.js';
import {assertPrimaryTransaction} from '../storage/transactions.js';
import type {InvocationContext} from '../transport/protocol.js';
import {assertInvocation,exact,fail,uuid,decimal} from '../transport/protocol.js';
import {object} from '../policy/programme.js';
import {digestDocument as hash} from './pools.js';
import {custodyLock,currentCustody} from '../assurance/submission.js';
import {loadPreparationIntent} from '../hierarchy/packets.js';
import {preparationPinInputs} from '../preparation/profile_pin_inputs.js';
import {validateBootstrapTestPolicy,validateBootstrapTestTemplate} from '../preparation/fleet_test_contract.js';
import {readConfirmedAbsence,readConfirmedCreateRejection,readNeverSubmittedExpiry} from './reconcile.js';
import type {FleetManagerBinding} from '../runner/fleet.js';
type Data=Record<string,any>;
export interface PreparedTestJob {job:Data;custody:Data;owner:FleetManagerBinding;policy_digest:string;template:Data;template_digest:string;previous_intent_id:string|null;replacement_proof:Data|null}
function positive(v:unknown):string{if(typeof v!=='string'||!decimal(v)||v==='0')fail('FLEET_TEST_SELECTION','Positive job version and custody generation required');return v;}
async function completeArtifact(tx:PrimaryTransaction,s:string[],id:string,expected?:string,kind:'object'|'manifest'='object'):Promise<void>{
 if(!uuid(id))fail('FLEET_TEST_ARTIFACT_POLICY','Approved artifact identity required');
 const row=(await tx.query("SELECT digest,storage_key FROM hyperfide.artifacts WHERE organisation_id=$1 AND run_id=$2 AND id=$3 AND status='COMPLETE' AND storage_backend='s3-v1' FOR SHARE",[...s,id])).rows[0];
 if(!row||row.storage_key!==`hyperfide/v1/${s[0]}/${s[1]}${kind==='manifest'?'/manifests':''}/sha256/${String(row.digest).slice(7)}`||expected!==undefined&&row.digest!==expected)fail('FLEET_TEST_ARTIFACT_POLICY','Approved complete artifact differs from accepted profile');
}
async function replacementProof(tx:PrimaryTransaction,s:string[],binding:Data):Promise<Data>{
 const busy=(await tx.query(`SELECT EXISTS(SELECT 1 FROM hyperfide.resource_job_allocations WHERE organisation_id=$1 AND run_id=$2 AND sandbox_id=$3 AND state IN('ACTIVE','RELEASE_PENDING'))
 OR EXISTS(SELECT 1 FROM hyperfide.runner_remote_jobs j JOIN hyperfide.runner_registry r ON r.organisation_id=j.organisation_id AND r.run_id=j.run_id AND r.session_id=j.session_id WHERE j.organisation_id=$1 AND j.run_id=$2 AND r.sandbox_id=$3 AND j.state<>'COMPLETED')
 OR EXISTS(SELECT 1 FROM hyperfide.attempts WHERE organisation_id=$1 AND run_id=$2 AND sandbox_id=$3 AND compute_authority='CURRENT') AS busy`,[...s,binding.sandbox_id])).rows[0];
 if(busy?.busy!==false)fail('FLEET_TEST_BINDING_UNSETTLED','Existing TEST compute must reconcile before replacement');
 const reservations=(await tx.query('SELECT r.id,r.state FROM hyperfide.provisioning_intent_reservations l JOIN hyperfide.reservations r ON r.organisation_id=l.organisation_id AND r.run_id=l.run_id AND r.id=l.reservation_id WHERE l.organisation_id=$1 AND l.run_id=$2 AND l.intent_id=$3 ORDER BY r.id FOR SHARE OF l,r',[...s,binding.intent_id])).rows;
 if(!reservations.length||reservations.some(r=>r.state!=='RELEASED'))fail('FLEET_TEST_BINDING_UNSETTLED','Existing TEST physical reservations remain held');
 const evidence=[];
 for(const r of reservations){const input={organisation_id:s[0]!,run_id:s[1]!,reservation_id:r.id};const proof=await readConfirmedAbsence(tx,input)??await readConfirmedCreateRejection(tx,input)??await readNeverSubmittedExpiry(tx,input);if(!proof)fail('FLEET_TEST_BINDING_UNSETTLED','Exact absence or proven noncreation required before replacement');evidence.push({reservation_id:r.id,...proof});}
 return {predecessor_intent_id:binding.intent_id,evidence};
}
export interface PrevalidatedTestArtifacts {policy_digest:string;manifests:ReadonlyMap<string,{digest:string;content_digest:string}>}
/** Read immutable manifest bytes before acquiring task/job locks or opening admission's bounded transaction. */
export async function validateManagerTestArtifacts(i:InvocationContext,recipe:Data,store:ArtifactStoreCapability):Promise<PrevalidatedTestArtifacts>{
 assertInvocation(i);const manifests=new Map<string,{digest:string;content_digest:string}>();
 if(recipe.executor_kind==='TEST'&&(recipe.schema_version===2||recipe.schema_version===3)){
  const policy=recipe.schema_version===3?validateBootstrapTestPolicy(recipe.test_template):validateBootstrapTestTemplate(recipe.test_template);
  for(const ref of policy.profile_pin_artifacts??[]){if(ref.storage_kind!=='manifest'||manifests.has(ref.artifact_id))continue;
   const checked=await store.invoke('artifact.manifest.read',{organisation_id:i.principal.organisation_id,run_id:i.principal.run_id,artifact_id:ref.artifact_id},i) as Data;
   if(checked.outcome!=='SUCCEEDED'||checked.availability!=='VERIFIED'||checked.artifact?.status!=='COMPLETE'||!checked.receipt||typeof checked.manifest?.content_digest!=='string')fail('FLEET_TEST_ARTIFACT_POLICY','Retained manifest must be actually verified before TEST admission');
   manifests.set(ref.artifact_id,{digest:checked.artifact.digest,content_digest:checked.manifest.content_digest});
  }
 }
 return {policy_digest:hash(recipe),manifests};
}
/** Model selects the job; the server resolves accepted immutable task and artifact policy. */
export async function prepareManagerTestJob(tx:PrimaryTransaction,i:InvocationContext,owner:FleetManagerBinding,budget:Data,input:Data,recipe:Data,verified:PrevalidatedTestArtifacts):Promise<PreparedTestJob|null>{
 assertPrimaryTransaction(tx);assertInvocation(i);
 if(verified.policy_digest!==hash(recipe))fail('FLEET_TEST_ARTIFACT_POLICY','Protected TEST policy changed after artifact validation');
 const test=recipe.executor_kind==='TEST'&&(recipe.schema_version===2||recipe.schema_version===3),generic=test&&recipe.schema_version===3;
 if(!test){if(input.qualification_job!==undefined)fail('FLEET_TEST_SELECTION','CODING provisioning cannot select a qualification job');return null;}
 if(!generic&&input.qualification_job===undefined)return null;
 if(!object(input.qualification_job))fail('FLEET_TEST_SELECTION','Generic TEST provisioning requires the manager-selected qualification job');
 const selected=input.qualification_job;exact(selected,['job_id','expected_state_version','custody_id','custody_generation']);
 if(!uuid(selected.job_id)||!uuid(selected.custody_id))fail('FLEET_TEST_SELECTION','Exact selected job and custody identities required');positive(selected.expected_state_version);positive(selected.custody_generation);
 const s=[owner.organisation_id,owner.run_id],custody=await custodyLock(tx,s as [string,string],selected.custody_id);currentCustody(custody,String(selected.custody_generation));
 const job=(await tx.query('SELECT *,state_version::text,lease_generation::text,custody_generation::text FROM hyperfide.qualification_jobs WHERE organisation_id=$1 AND run_id=$2 AND id=$3 FOR UPDATE',[...s,selected.job_id])).rows[0];
 if(!job||job.state!=='PENDING'||job.state_version!==selected.expected_state_version||job.custody_id!==custody.id||job.custody_generation!==selected.custody_generation||custody.task.feature_package_id!==owner.delegation_id||!Array.isArray(budget.task_ids)||!budget.task_ids.includes(custody.task.id))fail('FLEET_TEST_SELECTION_STALE','Current pending job, custody and delegated task required');
 const attempt=(await tx.query('SELECT sandbox_id,compute_authority FROM hyperfide.attempts WHERE organisation_id=$1 AND run_id=$2 AND id=$3 FOR SHARE',[...s,custody.source_attempt_id])).rows[0];
 if(!attempt||!['RELEASED','REVOKED'].includes(attempt.compute_authority)||attempt.sandbox_id===input.sandbox_id)fail('QUALIFICATION_NOT_INDEPENDENT','TEST provision must be separate from released coding compute');
 const intent=await loadPreparationIntent(tx,{organisation_id:owner.organisation_id,run_id:owner.run_id,task_id:custody.task.id,purpose:'QUALIFICATION'});
 if(intent.profile_id!==input.profile_id||intent.profile_id!==recipe.profile_id||intent.preparation_digest!==input.preparation_digest||intent.preparation_digest!==recipe.preparation_digest)fail('FLEET_TEST_PROFILE_MISMATCH','TEST pool and recipe must match the accepted qualification preparation profile');
 const policy=generic?validateBootstrapTestPolicy(recipe.test_template):validateBootstrapTestTemplate(recipe.test_template);
 if(!generic&&((policy as Data).job_id!==job.id||(policy as Data).task_key!==custody.task.task_key))fail('FLEET_TEST_SELECTION','Legacy fixed TEST recipe selects another job');
 await completeArtifact(tx,s,policy.recipe_policy_artifact_id,intent.declared_profile.recipe.digest);
 const external=preparationPinInputs(intent.declared_profile).filter(pin=>pin.origin==='PROFILE_ARTIFACT'),refs=policy.profile_pin_artifacts??[];
 if(refs.length!==external.length)fail('FLEET_TEST_ARTIFACT_POLICY','Complete approved profile pin inventory required');
 const seenPins=new Set<string>();
 for(const ref of refs){if(seenPins.has(ref.path))fail('FLEET_TEST_ARTIFACT_POLICY','Duplicate profile pin');seenPins.add(ref.path);const pin=external.find(pin=>pin.path===ref.path);if(!pin)fail('FLEET_TEST_ARTIFACT_POLICY','Profile pin is outside accepted TEST profile');await completeArtifact(tx,s,ref.artifact_id,undefined,ref.storage_kind);const artifact=(await tx.query('SELECT digest,storage_key FROM hyperfide.artifacts WHERE organisation_id=$1 AND run_id=$2 AND id=$3',[...s,ref.artifact_id])).rows[0];if(ref.storage_kind==='object'&&artifact?.digest!==pin.digest)fail('FLEET_TEST_ARTIFACT_POLICY','Profile pin bytes differ from accepted TEST profile');if(ref.storage_kind==='manifest'){const checked=verified.manifests.get(ref.artifact_id);if(!checked||checked.digest!==artifact?.digest||checked.content_digest!==pin.digest)fail('FLEET_TEST_ARTIFACT_POLICY','Retained manifest content differs from accepted TEST profile');}}
 const submitted=(await tx.query('SELECT manifest FROM hyperfide.assurance_submissions WHERE organisation_id=$1 AND run_id=$2 AND custody_id=$3 FOR SHARE',[...s,custody.id])).rows[0];
 if(!submitted)fail('FLEET_TEST_SELECTION','Actual admitted result source required');
 const repository=(await tx.query('SELECT url FROM hyperfide.repositories WHERE organisation_id=$1 AND id=$2',[s[0],custody.repository_id])).rows[0];
 const matching=intent.declared_profile.repositories.filter(r=>r.url===repository?.url);if(matching.length!==1)fail('FLEET_TEST_ARTIFACT_POLICY','Accepted result repository mapping must be unique');
 const counterfactual=(await tx.query("SELECT 1 FROM hyperfide.finding_repairs WHERE organisation_id=$1 AND run_id=$2 AND custody_id=$3 AND state='READY_FOR_RECHECK' LIMIT 1",[...s,custody.id])).rows.length>0;
 const expected=intent.declared_profile.repositories.filter(r=>!submitted.manifest.archive_source||counterfactual||r.id!==matching[0]!.id).map(r=>r.id);
 const sources=policy.source_bundles.filter(ref=>expected.includes(ref.repository_key));
 if(sources.length!==expected.length||new Set(sources.map(ref=>ref.repository_key)).size!==expected.length)fail('FLEET_TEST_ARTIFACT_POLICY','Approved baseline catalog cannot resolve this exact result preparation');
 for(const ref of sources)await completeArtifact(tx,s,ref.artifact_id,undefined,ref.storage_kind);
 if(policy.timeout_ms>intent.declared_profile.policy.max_process_lifetime_seconds*1000)fail('FLEET_TEST_ARTIFACT_POLICY','Approved TEST deadline exceeds accepted profile lifetime');
 const template=validateBootstrapTestTemplate({...policy,schema_version:policy.profile_pin_artifacts===undefined?1:2,task_key:custody.task.task_key,job_id:job.id,source_bundles:sources}) as unknown as Data;
 const previous=(await tx.query("SELECT * FROM hyperfide.fleet_test_job_bindings WHERE organisation_id=$1 AND run_id=$2 AND job_id=$3 AND state='ACTIVE' FOR UPDATE",[...s,job.id])).rows[0];
 const replacement=previous?await replacementProof(tx,s,previous):null;
 return {job,custody,owner,policy_digest:hash(recipe),template,template_digest:hash(template),previous_intent_id:previous?.intent_id??null,replacement_proof:replacement};
}
export async function retainManagerTestJob(tx:PrimaryTransaction,prepared:PreparedTestJob,intent:Data):Promise<Data>{
 assertPrimaryTransaction(tx);const p=prepared,b=p.owner,s=[b.organisation_id,b.run_id];
 if(p.previous_intent_id)await tx.query("UPDATE hyperfide.fleet_test_job_bindings SET state='SUPERSEDED',superseded_by=$4 WHERE organisation_id=$1 AND run_id=$2 AND intent_id=$3 AND state='ACTIVE'",[...s,p.previous_intent_id,intent.id]);
 const row=(await tx.query(`INSERT INTO hyperfide.fleet_test_job_bindings(organisation_id,run_id,intent_id,job_id,custody_id,custody_generation,task_id,package_id,manager_session_id,manager_generation,leader_generation,authority_epoch,selected_job_state_version,decision_id,decision_operation_id,pool_id,sandbox_id,profile_id,preparation_digest,policy_digest,template_digest,template,replacement_proof,state)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,'ACTIVE') RETURNING *`,[...s,intent.id,p.job.id,p.custody.id,p.custody.custody_generation,p.custody.task.id,b.delegation_id,b.actor_id,b.manager_generation,b.leader_generation,b.authority_epoch,p.job.state_version,b.decision_id,b.operation_id,intent.pool_id,intent.sandbox_id,intent.profile_id,intent.operation.preparation_digest,p.policy_digest,p.template_digest,p.template,p.replacement_proof])).rows[0];
 if(!row)fail('FLEET_TEST_BINDING_CONFLICT','Selected TEST binding was not retained');
 return {intent_id:row.intent_id,job_id:row.job_id,custody_id:row.custody_id,custody_generation:String(row.custody_generation),task_id:row.task_id,template_digest:row.template_digest,policy_digest:row.policy_digest};
}
/** Initial expected version is an admission pin, not a prohibition on this job's own lease transitions. */
export async function readManagerTestJob(tx:PrimaryTransaction,i:InvocationContext,intent_id:string,mode:'BOOTSTRAP'|'EXECUTION'|'CLEANUP'='BOOTSTRAP'):Promise<Data|null>{
 assertPrimaryTransaction(tx);assertInvocation(i);const s=[i.principal.organisation_id,i.principal.run_id];
 const row=(await tx.query(`SELECT x.*,j.state AS job_state,j.custody_generation::text AS job_custody_generation,c.authority AS custody_authority,t.current_custody_id,f.manager_session_id AS current_manager,h.owner_generation::text AS current_manager_generation,l.generation::text AS current_leader_generation,l.authority_epoch AS current_epoch
 FROM hyperfide.fleet_test_job_bindings x JOIN hyperfide.qualification_jobs j ON j.organisation_id=x.organisation_id AND j.run_id=x.run_id AND j.id=x.job_id
 JOIN hyperfide.submission_custodies c ON c.organisation_id=x.organisation_id AND c.run_id=x.run_id AND c.id=x.custody_id
 JOIN hyperfide.tasks t ON t.organisation_id=x.organisation_id AND t.run_id=x.run_id AND t.id=x.task_id
 JOIN hyperfide.feature_packages f ON f.organisation_id=x.organisation_id AND f.run_id=x.run_id AND f.id=x.package_id
 JOIN hyperfide.hierarchy_packages h ON h.organisation_id=f.organisation_id AND h.run_id=f.run_id AND h.package_id=f.id
 JOIN hyperfide.hierarchy_leaders l ON l.organisation_id=f.organisation_id AND l.run_id=f.run_id
 WHERE x.organisation_id=$1 AND x.run_id=$2 AND x.intent_id=$3 FOR SHARE OF x,j,c,t,f,h,l`,[...s,intent_id])).rows[0];
 if(!row)return null;
 if(hash(row.template)!==row.template_digest)fail('FLEET_TEST_BINDING_STALE','Immutable TEST template digest changed');
 if(mode==='CLEANUP'){if(!['SUCCEEDED','FAILED','CANCELLED'].includes(row.job_state))fail('FLEET_TEST_BINDING_STALE','Terminal job required for cleanup-only binding');return row;}
 if(mode==='BOOTSTRAP'?row.job_state!=='PENDING':!['PENDING','RUNNING'].includes(row.job_state))fail('FLEET_TEST_BINDING_STALE','Current executable TEST job required');
 if(row.state!=='ACTIVE'||row.current_custody_id!==row.custody_id||row.job_custody_generation!==String(row.custody_generation)||row.custody_authority!=='ACTIVE'||row.current_manager!==row.manager_session_id||row.current_manager_generation!==String(row.manager_generation)||row.current_leader_generation!==String(row.leader_generation)||row.current_epoch!==row.authority_epoch||hash(row.template)!==row.template_digest)fail('FLEET_TEST_BINDING_STALE','Selected TEST job, custody or current manager authority changed');
 const accepted=await loadPreparationIntent(tx,{organisation_id:s[0]!,run_id:s[1]!,task_id:row.task_id,purpose:'QUALIFICATION'});
 if(accepted.profile_id!==row.profile_id||accepted.preparation_digest!==row.preparation_digest)fail('FLEET_TEST_BINDING_STALE','Accepted qualification preparation changed');
 return row;
}
