"""Live prerequisite qualification reads authoritative PostgreSQL; archives and component checks grant no completion."""
from pathlib import Path
import argparse,base64,datetime,hashlib,json,os,re,stat,subprocess
ROOT=Path(__file__).resolve().parents[3]
INSTALL_CASES=('fresh_install','repeated_install','interrupted_install','missing_code','missing_dependencies','missing_configuration','stale_install','path_escape','concurrent_isolation','interface_subset','fetch_volume')
MODEL_CASES=('co_located_models','model_delegation','model_replan','constraint_refusal','supervisor_box_loss','stale_generation_replay','model_unavailability')
WORKER_CASES=('provider_creation','coding_worker','independent_test','worker_cancellation','failed_worker','manager_replacement','ambiguous_provider_outcome')
TASK_CASES={'0.11':INSTALL_CASES,'0.12':MODEL_CASES,'0.13':INSTALL_CASES+MODEL_CASES+WORKER_CASES,'0.14':INSTALL_CASES+MODEL_CASES+WORKER_CASES}
DIGEST=re.compile(r'^sha256:[0-9a-f]{64}$');OID=re.compile(r'^(?:[0-9a-f]{40}|[0-9a-f]{64})$')
class Refused(Exception):pass
def require(condition,code):
 if not condition:raise Refused(code)
def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode()
def digest(value):return 'sha256:'+hashlib.sha256(value if isinstance(value,bytes) else canonical(value)).hexdigest()
def unavailable_model_response(body, reasoning, allowed_codes):
 require(isinstance(body,dict),'ACTUAL_MODEL_FAILURE_CAPTURE_REQUIRED')
 if body.get('ok') is True:
  result=body.get('result',{})
  require(isinstance(result,dict) and reasoning.get('state')=='WAITING_FOR_MANAGER' and result.get('state')=='WAITING_FOR_MANAGER' and result.get('operation_id')==reasoning.get('id') and result.get('reason')==reasoning.get('reason') and result.get('reason') in allowed_codes and result.get('deterministic_fallback') is False,'ACTUAL_MODEL_FAILURE_CAPTURE_REQUIRED')
 else:
  require(body.get('ok') is False and body.get('error',{}).get('code') in allowed_codes,'ACTUAL_MODEL_FAILURE_CAPTURE_REQUIRED')

def private_json(filename):
 p=Path(filename);s=p.lstat();require(p.resolve()==p.absolute() and stat.S_ISREG(s.st_mode) and s.st_uid==os.getuid() and s.st_mode&0o077==0 and s.st_nlink==1 and 0<s.st_size<=4*1024*1024,'PRIVATE_EVIDENCE_REQUIRED')
 return json.loads(p.read_bytes())
# Only these fixed nonsecret columns are available to the verifier. Target data never selects SQL.
COLUMNS={
 'runs':'id,authority_epoch,spec_revision_id,spec_generation,state',
 'agent_sessions':'id,role,parent_session_id,native_session_id,sandbox_id,slot_id,state',
 'run_repositories':'repository_id,source_object_id',
 'identity_principals':'credential_id,actor_id,role,public_key_b64,deployment_epoch,state,credential_version,expires_at',
 'fleet_cohorts':'id,host_id,authority_epoch,leader_session_id,leader_generation,cohort_generation,controller_identity',
 'fleet_actor_sessions':'session_id,actor_role,cohort_id,cohort_generation,manager_generation,native_session_id,process_identity,plan_generation,state',
 'fleet_observations':'id,actor_id,cohort_generation,context_digest,body,created_at',
 'fleet_reasoning':'id,actor_id,observation_id,request_digest,state,reason,result,created_at,updated_at::text AS updated_at',
 'fleet_decisions':'id,operation_id,actor_id,action,reasoning_id,payload_digest,body,created_at',
 'fleet_effect_receipts':'operation_id,decision_id,payload_digest,result,created_at',
 'fleet_delegations':'package_id,manager_session_id,manager_generation,leader_generation,budget,decision_id',
 'hierarchy_ownership_events':'id,kind,payload,created_at',
 'tasks':'id,task_key,feature_package_id,spec_revision_id,spec_generation,criteria_digest,state',
 'attempts':'id,task_id,generation,compute_authority,execution_state,sandbox_id,slot_id,sandbox_boot_generation,created_at',
 'provisioning_intents':'id,pool_id,sandbox_id,kind,request_key,payload_digest,operation,state,native_sandbox_id,boot_generation,last_outcome,failure_code,created_at,updated_at',
 'provisioning_intent_reservations':'intent_id,reservation_id',
 'reservations':'id,request_id,capacity_account_id,quantity,state,expires_at::text AS expires_at,release_reason,released_at::text AS released_at',
 'provider_native_bootstraps':'intent_id,pool_id,configuration_digest,native_sandbox_id,sandbox_id,boot_id,boot_generation,state,manifest_digest,manifest,receipt,receipt_digest',
 'provider_worker_activations':'intent_id,sandbox_id,boot_id,boot_generation,worker_slot_id,state,permit,permit_digest,receipt,receipt_digest',
 'fleet_environment_specs':'input_digest,package_digest,source_config_digest,source_manifest_digest,plan_digest,package_spec,source_config,install_plan',
 'fleet_environment_installs':'operation_id,input_digest,sandbox_id,boot_id,boot_generation,authority_epoch,package_id,manager_session_id,admission,admission_digest,state,receipt,receipt_digest,completed_at,created_at::text AS created_at',
 'fleet_install_heads':'environment_id,environment_generation,sandbox_id,boot_id,boot_generation::text AS boot_generation,logical_operation_id,current_operation_id',
 'fleet_install_recoveries':'allocation_epoch_operation_id,operation_id,predecessor_install_operation_id,logical_operation_id,predecessor_admission_digest,runner_operation_id,runner_plan_digest,runner_result_digest,quiescence_operation_id,quiescence_receipt_digest,decision_id',
 'runner_not_started_proofs':'id,runner_operation_id,install_operation_id,runner_plan_digest,admission_digest,expires_at::text AS expires_at,proof_digest,proof,created_at::text AS created_at',
 'fleet_install_not_started_recoveries':'operation_id,predecessor_install_operation_id,logical_operation_id,proof_id,decision_id,created_at::text AS created_at',
 'runner_pre_provider_refusals':'id,runner_operation_id,claim_id,executor_credential_id,runner_plan_digest,request_digest,error_code,proof_digest,proof,created_at::text AS created_at',
 'fleet_install_pre_provider_recoveries':'operation_id,predecessor_install_operation_id,logical_operation_id,proof_id,decision_id',
 'fleet_install_delivery_executions':'operation_id,delivery_id,logical_operation_id,target_binding,request,request_digest,state',
 'runner_result_artifacts':'operation_id,role,artifact_id,artifact_digest,content_digest,size_bytes',
 'resource_job_allocations':'id,generation::text AS generation,request_id,reservation_id,assignee_session_id,sandbox_id,sandbox_boot_generation::text AS sandbox_boot_generation,slot_id,job_kind,state',
 'provider_remote_operations':'id,session_id,state,created_at::text AS created_at',
 'fleet_runtime_readiness':'id,install_operation_id,runner_operation_id,runner_result_digest,slot_id,runner_session_id,readiness_digest,publication',
 'runner_registry':'session_id,credential_id,sandbox_id,boot_id,boot_generation,slot_id,uid,gid,runner_binary_digest,readiness_digest,source_object_id,source_tree_id,state',
 'runner_remote_jobs':'operation_id,session_id,job_class,plan,plan_digest,state,claim_id,not_started_proof_id,pre_provider_refusal_id,native_claim_coverage,native_claimed_at::text AS native_claimed_at,native_claim_operation_id,failure_code,executor_credential_id,claimed_at,reservation_id,authority_epoch,expires_at::text AS expires_at,result,result_digest,result_signature,created_at,completed_at',
 'native_launch_plans':'command_id,launch_id,agent_session_id,slot_id,attempt_id,attempt_generation,qualification_receipt_digest,connector_plan_digest,plan',
 'fleet_worker_launches':'command_id,launch_id,runner_session_id,executor_credential_id,request,request_digest,state,result,result_digest,result_signature,created_at,completed_at',
 'submission_custodies':'id,task_id,source_attempt_id,source_generation,repository_id,source_object_id,source_manifest_digest,criteria_digest,qualification_outcome',
 'qualification_jobs':'id,custody_id,custody_generation,state,outcome,lease_generation,rubric_digest',
 'assurance_job_receipts':'job_id,lease_generation,verifier_id,environment_digest,receipt,receipt_digest,receipt_artifact_id',
 'assurance_check_intents':'job_id,lease_generation,check_id,operation_id,session_id,plan_digest,plan',
 'artifacts':'organisation_id,run_id,id,digest,size_bytes,storage_backend,status,completed_at',
 'outbox_events':'id,aggregate_type,aggregate_id,event_type,payload,created_at::text AS created_at',
 'runner_control_commands':'command_id,action,launch_id,slot_id,sandbox_id,boot_id,boot_generation,attempt_id,attempt_generation,authority_epoch,issued_by_credential_id,issued_at::text AS issued_at,state,outcome,termination,cleanup_complete,report,report_digest,reported_at::text AS reported_at',
 'command_inbox':'id,principal_scope,operation,idempotency_key,request_digest,state,result,created_at::text AS created_at',
}
NODE_SNAPSHOT=r"""
import fs from 'node:fs';import{createRequire}from'node:module';import{verify,createPublicKey}from'node:crypto';
const a=JSON.parse(fs.readFileSync(0,'utf8')),require=createRequire(a.root+'/core/control-plane/package.json'),{Client}=require('pg'),url=process.env[a.target.database_url_env];
if(!url)throw Error('DATABASE_CAPABILITY_MISSING');const c=new Client({connectionString:url,connectionTimeoutMillis:10000,statement_timeout:15000,application_name:'hyperfide-prerequisite-readonly'});
try{await c.connect();await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const identity=(await c.query("SELECT current_database() AS database_name,(pg_control_system()).system_identifier::text,clock_timestamp() AS observed_at,current_setting('transaction_read_only') AS read_only")).rows[0];if(identity.read_only!=='on'||identity.database_name!==a.target.database_name||identity.system_identifier!==a.target.system_identifier)throw Error('DATABASE_TARGET_MISMATCH');const rows={};for(const [table,columns]of Object.entries(a.columns)){const result=await c.query('SELECT '+columns+' FROM hyperfide.'+table+' WHERE organisation_id=$1 AND '+(table==='runs'?'id':'run_id')+'=$2 LIMIT 100001',[a.target.organisation_id,a.target.run_id]);if(result.rows.length>100000)throw Error('SNAPSHOT_ROW_BUDGET');rows[table]=result.rows;}
if(a.target.source_backend==='native'){if(!/^[0-9a-f-]{36}$/.test(a.target.security_domain_id??''))throw Error('NATIVE_DOMAIN_REQUIRED');for(const table of ['source_fleet_runs','source_fleet_assignments','source_fleet_submissions','source_fleet_qualifications','source_native_candidates','source_candidate_qualifications','source_native_assurance_policies','source_native_assurance_checkers','source_native_assurance_evidence','source_native_custodies','source_authority_domains']){rows[table]=(await c.query('SELECT * FROM hyperfide.'+table+' WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 LIMIT 100001',[a.target.organisation_id,a.target.repository_id,a.target.security_domain_id])).rows;if(rows[table].length>100000)throw Error('SNAPSHOT_ROW_BUDGET');}}
rows.provider_observations=(await c.query('SELECT o.id,o.intent_id,o.operation_id,o.payload_digest,o.observation,o.evidence_digest,o.observed_at FROM hyperfide.provider_observations o JOIN hyperfide.provisioning_intents i ON i.organisation_id=o.organisation_id AND i.id=o.intent_id WHERE o.organisation_id=$1 AND i.run_id=$2 LIMIT 100001',[a.target.organisation_id,a.target.run_id])).rows;
if(rows.provider_observations.length>100000)throw Error('SNAPSHOT_ROW_BUDGET');rows.environment_profiles=(await c.query('SELECT id,content_digest,provider,manifest FROM hyperfide.environment_profiles WHERE organisation_id=$1 LIMIT 100001',[a.target.organisation_id])).rows;
if(rows.environment_profiles.length>100000)throw Error('SNAPSHOT_ROW_BUDGET');rows.capacity_accounts=(await c.query('SELECT id,capacity_class,dimension FROM hyperfide.capacity_accounts WHERE organisation_id=$1 LIMIT 100001',[a.target.organisation_id])).rows;if(rows.capacity_accounts.length>100000)throw Error('SNAPSHOT_ROW_BUDGET');const keys=new Map(rows.identity_principals.map(p=>[p.credential_id,p.public_key_b64]));const canonical=v=>JSON.stringify(v&&typeof v==='object'?Array.isArray(v)?v.map(x=>JSON.parse(canonical(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(canonical(v[k]))])):v);
for(const table of ['runner_remote_jobs','fleet_worker_launches'])for(const row of rows[table])if(row.result){const pub=keys.get(row.executor_credential_id);if(!pub||!row.result_signature){row.signature_verified=false;continue;}const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(pub,'base64url')]),format:'der',type:'spki'}),message=table==='runner_remote_jobs'?`HYPERFIDE-RUNNER-RESULT-V1\n${a.target.organisation_id}\n${a.target.run_id}\n${row.operation_id}\n${row.plan_digest}\n${row.result_digest}\n`:canonical(row.result);row.signature_verified=verify(null,Buffer.from(message),key,Buffer.from(row.result_signature,'base64url'));}
const protocol=await import('./core/control-plane/dist/transport/protocol.js');rows.authenticated_fault_operations=[];
for(const entry of a.journals??[]){
 const journal=entry.capture,raw=Buffer.from(journal.body_base64,'base64'),decoded=protocol.decodeInvoke(raw),item=protocol.proof(Object.entries(journal.headers).flat()),principal=rows.identity_principals.find(p=>p.credential_id===item.id),stale=entry.case==='stale_generation_replay';
 const pin=journal.kind==='hyperfide.authenticated-operator-step'&&entry.case==='repeated_install'?a.target.repeat_driver?.journal:a.target.fault_drivers?.[entry.case];
 if(!principal||!pin||journal.origin!==a.target.origin||decoded.payload.run_id!==a.target.run_id||decoded.operation.operation_id!==journal.operation_id||journal.case!==entry.case||journal.organisation_id!==a.target.organisation_id||journal.run_id!==a.target.run_id)throw Error('FAULT_JOURNAL_SCOPE_MISMATCH');
 if(stale){
  const decision=decoded.payload.input?.decision,retained=rows.fleet_decisions.find(d=>d.id===pin.decision_id),reasoning=retained&&rows.fleet_reasoning.find(r=>r.id===retained.reasoning_id),actor=rows.fleet_actor_sessions.find(r=>r.session_id===pin.actor_id),receipt=reasoning?.result?.model_receipt;
  const fleet=await import('./contracts/fleet/index.mjs');
  if(!['LEADER','FEATURE_MANAGER'].includes(principal.role)||pin.credential_id!==item.id||principal.actor_id!==pin.actor_id||!decision||(principal.role==='LEADER'?decision.actor_role!=='PRIMARY':decision.actor_role!=='WAVE_MANAGER')||decoded.payload.action!=='fleet.decision.apply'||decoded.payload.component!=='fleet-orchestration'||!decision||decision.decision_id!==pin.decision_id||decision.operation_id!==pin.original_operation_id||decision.actor_id!==pin.actor_id||String(decision.expected_version)!==String(pin.replayed_plan_generation)||!retained||retained.actor_id!==pin.actor_id||retained.operation_id!==pin.original_operation_id||fleet.digest(decision)!==retained.payload_digest||canonical(retained.body)!==canonical(decision)||!reasoning||reasoning.state!=='COMPLETED'||reasoning.actor_id!==pin.actor_id||canonical(reasoning.result.decision)!==canonical(decision)||!receipt||!(receipt.session_kind==='LOGICAL_GATEWAY'?receipt.upstream_response_id:receipt.native_session_id&&receipt.binary_digest)||!actor||rows.fleet_effect_receipts.some(e=>e.operation_id===decision.operation_id||e.operation_id===journal.operation_id)||rows.runner_remote_jobs.some(j=>j.operation_id===decision.operation_id))throw Error('STALE_REPLAY_ACTOR_DECISION_REQUIRED');
  const generationKind=pin.generation_kind??'PLAN';
  if(generationKind==='PLAN'){
   if(BigInt(actor.plan_generation)<=BigInt(decision.expected_version))throw Error('STALE_PLAN_PROOF_REQUIRED');
  }else if(generationKind==='COHORT'){
   const observation=rows.fleet_observations.find(o=>o.id===pin.original_observation_id),cohort=rows.fleet_cohorts.find(c=>c.id===actor.cohort_id);
   if(!observation||reasoning.observation_id!==observation.id||observation.actor_id!==pin.actor_id||observation.context_digest!==decision.context_digest||protocol.hash(canonical(observation.body))!==observation.context_digest||String(observation.cohort_generation)!==String(pin.replayed_cohort_generation)||!cohort||BigInt(cohort.cohort_generation)<=BigInt(observation.cohort_generation)||BigInt(cohort.cohort_generation)<BigInt(pin.minimum_current_cohort_generation)||String(actor.cohort_generation)!==String(cohort.cohort_generation))throw Error('STALE_COHORT_PROOF_REQUIRED');
  }else throw Error('STALE_GENERATION_KIND_REQUIRED');
 }else if(entry.case==='model_unavailability'){
  const input=decoded.payload.input,binding=input?.binding,reason=rows.fleet_reasoning.find(r=>r.id===pin.reasoning_id),profile=reason?.result?.model_profile,original=rows.fleet_observations.find(o=>o.id===pin.observation_id),observation=reason&&rows.fleet_observations.find(o=>o.id===reason.observation_id),ids=input?.context_observation_ids??[input?.observation_id];
  if(!['LEADER','FEATURE_MANAGER'].includes(principal.role)||pin.credential_id!==item.id||principal.actor_id!==pin.actor_id||decoded.payload.action!=='fleet.session.reason'||decoded.payload.component!=='fleet-orchestration'||!binding||binding.actor_id!==pin.actor_id||(principal.role==='LEADER'?binding.actor_role!=='PRIMARY':binding.actor_role!=='WAVE_MANAGER')||binding.authority_epoch!==principal.deployment_epoch||binding.authority_epoch!==a.target.authority_epoch||input.operation_id!==pin.reasoning_id||input.observation_id!==pin.observation_id||!reason||reason.actor_id!==pin.actor_id||reason.request_digest!==protocol.hash(canonical(input))||reason.state!=='WAITING_FOR_MANAGER'||reason.reason!==pin.expected_reason||!(/^FLEET_GATEWAY_HTTP_[45][0-9]{2}$/.test(reason.reason)||reason.reason==='FLEET_GATEWAY_OUTCOME_UNKNOWN')||!profile||profile.backend!=='gateway'||protocol.hash(canonical(profile))!==pin.model_profile_digest||!original||original.actor_id!==pin.actor_id||canonical(original.body.binding)!==canonical(binding)||protocol.hash(canonical(original.body))!==original.context_digest||!observation||observation.actor_id!==pin.actor_id||canonical(observation.body.binding)!==canonical(binding)||String(observation.cohort_generation)!==String(original.cohort_generation)||observation.body.source_revision!==original.body.source_revision||protocol.hash(canonical(observation.body))!==observation.context_digest||observation.body.source_revision!==(a.target.source_backend==='native'?a.target.native_source_revision_id:'git:'+a.target.accepted_source_object_id)||(ids.length===1?observation.id!==original.id:canonical(observation.body.context_observation_ids)!==canonical(ids))||rows.fleet_decisions.some(d=>d.reasoning_id===reason.id)||rows.fleet_effect_receipts.some(e=>[reason.id,journal.operation_id].includes(e.operation_id))||rows.runner_remote_jobs.some(j=>[reason.id,journal.operation_id].includes(j.operation_id))||rows.provider_remote_operations.some(p=>[reason.id,journal.operation_id].includes(p.id)))throw Error('MODEL_FAILURE_ACTOR_REQUEST_REQUIRED');
 }else if(principal.role!=='OPERATOR'||item.id!==a.target.fault_operator_credential_id)throw Error('FAULT_JOURNAL_SCOPE_MISMATCH');
 protocol.verifyProof(principal.public_key_b64,item,journal.origin,'/v1/invoke',raw);
 const nonce=(await c.query('SELECT received_at FROM hyperfide.identity_request_nonces WHERE credential_id=$1 AND nonce=$2',[item.id,item.nonce])).rows[0];
 if(!nonce||Math.abs(new Date(nonce.received_at).getTime()/1000-Number(item.time))>a.target.auth_clock_skew_seconds)throw Error('FAULT_REQUEST_NOT_AUTHENTICATED');
 if(journal.driver_digest!==pin.driver_digest||decoded.operation.payload_digest!==pin.payload_digest||decoded.payload.action!==pin.action||decoded.payload.component!==pin.component||protocol.hash(raw)!==journal.request_digest)throw Error('FAULT_DRIVER_PIN_MISMATCH');
 const response=journal.response,responseBytes=Buffer.from(response.body_base64,'base64');
 if(protocol.hash(responseBytes)!==response.body_digest||JSON.stringify(protocol.strictJSON(responseBytes))!==JSON.stringify(response.body)||response.body.operation_id!==journal.operation_id)throw Error('FAULT_RESPONSE_CUSTODY_MISMATCH');
 if(stale&&(response.body.ok!==false||response.body.error?.code!==(pin.generation_kind==='COHORT'?'FLEET_OBSERVATION_STALE':'FLEET_PLAN_STALE')))throw Error('ACTUAL_STALE_GENERATION_REFUSAL_REQUIRED');
 if(entry.case==='model_unavailability'&&(response.body.ok!==true||response.body.result?.operation_id!==pin.reasoning_id||response.body.result?.state!=='WAITING_FOR_MANAGER'||response.body.result?.reason!==pin.expected_reason||response.body.result?.deterministic_fallback!==false))throw Error('ACTUAL_MODEL_WAIT_RESPONSE_REQUIRED');
 rows.authenticated_fault_operations.push(journal.operation_id);
}
let connector_verified=false;if(a.connector){const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(a.target.connector_public_key_hex,'hex')]),format:'der',type:'spki'});connector_verified=verify(null,Buffer.from(a.connector.payload,'utf8'),key,Buffer.from(a.connector.signature,'hex'));}await c.query('COMMIT');process.stdout.write(JSON.stringify({identity,rows,connector_verified}));}catch(e){await c.query('ROLLBACK').catch(()=>{});process.stdout.write(JSON.stringify({error:typeof e.code==='string'?e.code:/^[A-Z_]+$/.test(e.message)?e.message:'READONLY_SNAPSHOT_FAILED'}));process.exitCode=1;}finally{await c.end();}
"""
def snapshot(target,connector=None,journals=None):
 p=subprocess.run(['node','--input-type=module','-e',NODE_SNAPSHOT],input=json.dumps({'root':str(ROOT),'target':target,'columns':COLUMNS,'connector':connector,'journals':journals or []}),cwd=ROOT,text=True,capture_output=True,timeout=180)
 try:result=json.loads(p.stdout)
 except Exception:raise Refused('READONLY_SNAPSHOT_FAILED')
 require(p.returncode==0 and 'rows' in result,result.get('error','READONLY_SNAPSHOT_FAILED'));return result

def one(rows,key,value):
 found=[r for r in rows if str(r.get(key))==str(value)];require(len(found)==1,'EXACT_RECORD_REQUIRED');return found[0]
def signed_job(rows,operation):
 job=one(rows['runner_remote_jobs'],'operation_id',operation);require(job['state']=='COMPLETED' and job.get('signature_verified') is True and digest(job['result'])==job['result_digest'] and digest(job['plan'])==job['plan_digest'],'SIGNED_NATIVE_RESULT_REQUIRED')
 result=job['result'];require(result.get('outcome')=='SUCCEEDED' and result.get('cleanup_status')=='CONFIRMED' and result.get('cleanup',{}).get('complete') is True and result.get('cleanup',{}).get('observed_process_absent') is True,'NATIVE_CLEANUP_REQUIRED');return job

def verified_not_started_edge(rows,current,previous,edge):
 a=current['admission'];old=previous['admission'];operation=previous['operation_id']
 require(a.get('logical_operation_id')==current['operation_id'] and 'recovery_of' not in a,'NOT_STARTED_NATIVE_EPOCH_REQUIRED')
 proof=one(rows.get('runner_not_started_proofs',[]),'id',edge['proof_id']);body=proof.get('proof',{})
 fields={'schema_version','kind','organisation_id','run_id','install_operation_id','admission_digest','runner_operation_id','runner_plan_digest','expires_at','authority_epoch','binding','allocation','reservation_ids','reservations','claim_id','executor_credential_id','claimed_at','result','result_digest','result_signature','provider_operation_present'}
 require(isinstance(body,dict) and set(body)==fields and body['schema_version']==1 and body['kind']=='NOT_STARTED' and digest(body)==proof['proof_digest'],'NOT_STARTED_PROOF_DIGEST_REQUIRED')
 job=one(rows['runner_remote_jobs'],'operation_id',operation);plan=job['plan'];request=plan.get('preparation_request',{});binding=request.get('job_binding',{})
 require(proof['install_operation_id']==proof['runner_operation_id']==body['install_operation_id']==body['runner_operation_id']==operation and proof['admission_digest']==body['admission_digest']==previous['admission_digest'] and proof['runner_plan_digest']==body['runner_plan_digest']==job['plan_digest']==digest(plan),'NOT_STARTED_PROOF_BINDING_REQUIRED')
 require(body['organisation_id']==old['organisation_id'] and body['run_id']==old['run_id'] and body['authority_epoch']==job['authority_epoch']==previous['authority_epoch'],'NOT_STARTED_PROOF_SCOPE_REQUIRED')
 require(job.get('not_started_proof_id')==proof['id'],'NOT_STARTED_CLAIM_FENCE_REQUIRED')
 require(job['state']=='ADMITTED' and job['job_class']=='PREPARATION' and all(k in job and job[k] is None for k in ['claim_id','executor_credential_id','claimed_at','completed_at','result','result_digest','result_signature']) and all(body[k] is None for k in ['claim_id','executor_credential_id','claimed_at','result','result_digest','result_signature']) and body['provider_operation_present'] is False,'NOT_STARTED_UNCLAIMED_REQUIRED')
 require(evidence_time(body['expires_at'])==evidence_time(proof['expires_at'])==evidence_time(job['expires_at'])<=evidence_time(proof['created_at'])<=evidence_time(edge['created_at']),'NOT_STARTED_EXPIRY_REQUIRED')
 require(not any(r['id']==operation or r['session_id']==job['session_id'] and evidence_time(r['created_at'])<=evidence_time(proof['created_at']) for r in rows['provider_remote_operations']),'NOT_STARTED_PROVIDER_ABSENCE_REQUIRED')
 require(body['binding']==plan.get('binding') and binding.get('namespace')=='FLEET_INSTALL' and binding.get('job_id')==operation and binding.get('input_packet_digest')==previous['admission_digest'] and plan['binding'].get('session_id')==job['session_id'],'NOT_STARTED_PLAN_REQUIRED')
 allocation=plan.get('allocation',{});expected={'id':allocation.get('allocation_id'),'generation':str(allocation.get('generation')),'request_id':allocation.get('request_id'),'reservation_id':job['reservation_id'],'session_id':job['session_id']}
 require(body['allocation']==expected and isinstance(body['reservation_ids'],list) and body['reservation_ids'] and len(set(body['reservation_ids']))==len(body['reservation_ids']) and job['reservation_id'] in body['reservation_ids'],'NOT_STARTED_ALLOCATION_REQUIRED')
 vector=[r for r in rows['reservations'] if r['request_id']==body['allocation']['request_id']]
 require({r['id'] for r in vector}==set(body['reservation_ids']) and len(vector)==len(body['reservation_ids']) and all(r['state']=='RELEASED' and r['release_reason']=='RUNNER_NOT_STARTED' and evidence_time(r['expires_at'])<=evidence_time(proof['created_at'])<=evidence_time(r['released_at']) for r in vector),'NOT_STARTED_RELEASE_REQUIRED')
 retained=body['reservations'];dimensions=set()
 require(isinstance(retained,list) and len(retained)==4 and {r.get('id') for r in retained}==set(body['reservation_ids']),'NOT_STARTED_VECTOR_REQUIRED')
 for item in retained:
  require(set(item)=={'id','capacity_account_id','quantity','dimension','expires_at'},'NOT_STARTED_VECTOR_REQUIRED')
  actual=one(vector,'id',item['id']);account=one(rows['capacity_accounts'],'id',actual['capacity_account_id']);dimensions.add(item['dimension'])
  require(item['capacity_account_id']==actual['capacity_account_id'] and item['quantity']==str(actual['quantity']) and isinstance(item['quantity'],str) and item['quantity'].isdigit() and int(item['quantity'])>0 and item['dimension']==account['dimension'] and account['capacity_class']=='EXECUTION' and evidence_time(item['expires_at'])==evidence_time(actual['expires_at']),'NOT_STARTED_VECTOR_REQUIRED')
 require(dimensions=={'PREPARATION','CPU_MILLIS','MEMORY_BYTES','DISK_BYTES'},'NOT_STARTED_VECTOR_REQUIRED')
 require(not any(r['operation_id']!=operation and r.get('reservation_id')==job['reservation_id'] for r in rows['runner_remote_jobs']),'NOT_STARTED_RESERVATION_REQUIRED')

def verified_pre_provider_edge(rows,current,previous,edge):
 a=current['admission'];old=previous['admission'];operation=previous['operation_id']
 require(a.get('logical_operation_id')==current['operation_id'] and 'recovery_of' not in a,'PRE_PROVIDER_NATIVE_EPOCH_REQUIRED')
 proof=one(rows.get('runner_pre_provider_refusals',[]),'id',edge['proof_id']);body=proof.get('proof',{})
 fields={'schema_version','kind','organisation_id','run_id','runner_operation_id','claim_id','executor_credential_id','runner_plan_digest','request_digest','authority_epoch','bound_request','condition','original_state','allocation','reservations','provider_dispatch_present','native_execution_observed','native_claim_coverage','native_claimed_at','native_claim_operation_id'}
 require(isinstance(body,dict) and set(body)==fields and body['schema_version']==1 and body['kind']=='PRE_PROVIDER_REFUSAL' and digest(body)==proof['proof_digest'],'PRE_PROVIDER_PROOF_DIGEST_REQUIRED')
 job=one(rows['runner_remote_jobs'],'operation_id',operation);plan=job['plan'];binding=plan.get('binding',{});request=body['bound_request'];decision=one(rows['fleet_decisions'],'id',edge['decision_id'])
 require(proof['runner_operation_id']==body['runner_operation_id']==operation and proof['runner_plan_digest']==body['runner_plan_digest']==job['plan_digest']==digest(plan) and body['organisation_id']==old['organisation_id'] and body['run_id']==old['run_id'] and body['authority_epoch']==job['authority_epoch']==previous['authority_epoch'],'PRE_PROVIDER_PROOF_BINDING_REQUIRED')
 require(decision.get('body',{}).get('input',{}).get('recovery_of')=={'kind':'PRE_PROVIDER_REFUSAL','install_operation_id':operation,'admission_digest':previous['admission_digest'],'runner_operation_id':operation,'runner_plan_digest':job['plan_digest'],'proof_id':proof['id'],'proof_digest':proof['proof_digest']},'PRE_PROVIDER_DECISION_BINDING_REQUIRED')
 require(job.get('pre_provider_refusal_id')==proof['id'] and job.get('native_claim_coverage') is True and body['native_claim_coverage'] is True and all(job.get(k) is None and body[k] is None for k in ['native_claimed_at','native_claim_operation_id']) and job.get('not_started_proof_id') is None,'PRE_PROVIDER_NATIVE_FENCE_REQUIRED')
 require(job['state'] in ('CLAIMED','UNKNOWN') and body['original_state'] in ('CLAIMED','UNKNOWN') and job['job_class']=='PREPARATION' and job['claim_id']==proof['claim_id']==body['claim_id'] and job['executor_credential_id']==proof['executor_credential_id']==body['executor_credential_id'] and job['claim_id'] and job['executor_credential_id'] and job['claimed_at'] and all(k in job and job[k] is None for k in ['completed_at','result','result_digest','result_signature']) and body['provider_dispatch_present'] is False and body['native_execution_observed'] is False,'PRE_PROVIDER_UNEXECUTED_REQUIRED')
 producer=one(rows['identity_principals'],'credential_id',job['executor_credential_id']);require(producer['role']=='PROVISIONER' and producer['deployment_epoch']==job['authority_epoch'],'PRE_PROVIDER_PRODUCER_AUTHORITY_REQUIRED')
 require(evidence_time(job['claimed_at'])<=evidence_time(proof['created_at'])<=evidence_time(decision['created_at'])<=evidence_time(current['created_at']) and decision['operation_id']==current['operation_id'],'PRE_PROVIDER_PROOF_ORDER_REQUIRED')
 require(not any(r['id']==operation or r['session_id']==job['session_id'] and evidence_time(r['created_at'])<=evidence_time(current['created_at']) for r in rows['provider_remote_operations']),'PRE_PROVIDER_DISPATCH_ABSENCE_REQUIRED')
 expected_binding={k:binding.get(k) for k in ['organisation_id','run_id','session_id','pool_id','sandbox_id','external_sandbox_id']};expected_binding.update(boot_generation=str(binding.get('boot_generation')),preparation_digest=binding.get('boot_preparation_digest'))
 encoded=base64.urlsafe_b64encode(json.dumps({'config_path':binding['state_dir']+'/runner.json','operation_id':operation},separators=(',',':')).encode()).decode().rstrip('=')
 expected_request={'operation_id':operation,'binding':expected_binding,'argv':[binding['runner_binary'],'--component','12.4','--action','runner.job.execute','--request-base64',encoded],'cwd':str(Path(binding['workspace_path']).parent),'env_refs':plan.get('env_refs',{}),'timeout_ms':min(3600000,plan['request']['timeout_ms']+60000)}
 if 'env_ref_versions' in request or plan.get('env_ref_versions') is not None:expected_request['env_ref_versions']=plan.get('env_ref_versions')
 condition=body['condition'];maximum=condition.get('maximum_operation_ms')
 require(request==expected_request and digest(request)==proof['request_digest']==body['request_digest'] and condition.get('code')==proof['error_code']==job['failure_code']=='PROVIDER_DEADLINE_INVALID' and set(condition)=={'code','maximum_operation_ms','configuration_digest'} and isinstance(maximum,int) and not isinstance(maximum,bool) and maximum>=100 and request['timeout_ms']>maximum and DIGEST.fullmatch(condition.get('configuration_digest','')) is not None,'PRE_PROVIDER_REQUEST_REQUIRED')
 native=plan.get('preparation_request',{}).get('job_binding',{})
 require(native.get('namespace')=='FLEET_INSTALL' and native.get('job_id')==operation and native.get('input_packet_digest')==previous['admission_digest'] and binding.get('session_id')==job['session_id'] and binding.get('sandbox_id')==previous['sandbox_id'] and binding.get('boot_id')==previous['boot_id'] and str(binding.get('boot_generation'))==str(previous['boot_generation']),'PRE_PROVIDER_INSTALL_BINDING_REQUIRED')
 allocation=one(rows['resource_job_allocations'],'id',plan['allocation']['allocation_id']);expected={'id':allocation['id'],'generation':str(allocation['generation']),'request_id':allocation['request_id'],'reservation_id':job['reservation_id'],'session_id':job['session_id']}
 require(body['allocation']==expected and allocation['request_id']==plan['allocation']['request_id'] and str(allocation['generation'])==str(plan['allocation']['generation']) and allocation['reservation_id']==job['reservation_id'] and allocation['assignee_session_id']==job['session_id'] and allocation['sandbox_id']==previous['sandbox_id'] and str(allocation['sandbox_boot_generation'])==str(previous['boot_generation']) and allocation['slot_id']==binding['slot_id'] and allocation['job_kind']=='PREPARATION' and allocation['state']=='RELEASED','PRE_PROVIDER_ALLOCATION_REQUIRED')
 vector=[r for r in rows['reservations'] if r['request_id']==allocation['request_id']];retained=body['reservations'];dimensions=set()
 require(isinstance(retained,list) and len(retained)==len(vector)==4 and len({r.get('id') for r in retained})==4 and {r.get('id') for r in retained}=={r['id'] for r in vector} and job['reservation_id'] in {r['id'] for r in vector},'PRE_PROVIDER_VECTOR_REQUIRED')
 for item in retained:
  require(set(item)=={'id','capacity_account_id','quantity','dimension','expires_at'},'PRE_PROVIDER_VECTOR_REQUIRED')
  actual=one(vector,'id',item['id']);account=one(rows['capacity_accounts'],'id',actual['capacity_account_id']);dimensions.add(item['dimension'])
  require(item['capacity_account_id']==actual['capacity_account_id'] and item['quantity']==str(actual['quantity']) and isinstance(item['quantity'],str) and item['quantity'].isdigit() and int(item['quantity'])>0 and item['dimension']==account['dimension'] and account['capacity_class']=='EXECUTION' and evidence_time(item['expires_at'])==evidence_time(actual['expires_at']) and actual['state']=='RELEASED' and actual['release_reason']=='RUNNER_PRE_PROVIDER_REFUSAL' and evidence_time(proof['created_at'])<=evidence_time(actual['released_at']),'PRE_PROVIDER_VECTOR_REQUIRED')
 require(dimensions=={'PREPARATION','CPU_MILLIS','MEMORY_BYTES','DISK_BYTES'} and not any(r['operation_id']!=operation and r.get('reservation_id')==job['reservation_id'] for r in rows['runner_remote_jobs']),'PRE_PROVIDER_VECTOR_REQUIRED')

def verified_install_head(rows,install):
 admission=install['admission']
 require(all(str(admission.get(k))==str(install.get(k)) for k in ['sandbox_id','boot_id','boot_generation']),'INSTALL_HEAD_PHYSICAL_BINDING_REQUIRED')
 heads=[h for h in rows['fleet_install_heads'] if h['environment_id']==admission['environment_id'] and str(h['environment_generation'])==str(admission['environment_generation']) and all(str(h.get(k))==str(install[k]) for k in ['sandbox_id','boot_id','boot_generation'])]
 require(len(heads)==1 and heads[0]['current_operation_id']==install['operation_id'],'INSTALL_RECOVERY_HEAD_MISMATCH')
 return heads[0]

def verified_failed_allocation_epoch(rows,current,previous,recovery,failed,successor=None):
 epoch=recovery.get('allocation_epoch_operation_id')
 if epoch is None:return
 require(epoch==current['operation_id'] and current['operation_id']!=previous['operation_id'],'FAILED_ALLOCATION_EPOCH_ID_MISMATCH')
 require(failed['operation_id']==previous['operation_id']==recovery['runner_operation_id'] and digest(failed['plan'])==failed['plan_digest']==recovery['runner_plan_digest'] and digest(failed['result'])==failed['result_digest']==recovery['runner_result_digest'] and failed['result'].get('outcome')=='FAILED' and failed['result'].get('cleanup_status')=='CONFIRMED' and failed['result'].get('cleanup',{}).get('complete') is True and failed['result'].get('cleanup',{}).get('observed_process_absent') is True and failed['result']['cleanup'].get('receipt_digest')==recovery['quiescence_receipt_digest'],'FAILED_ALLOCATION_EPOCH_NATIVE_REQUIRED')
 require(failed.get('signature_verified') is True and failed['state']=='COMPLETED' and failed['job_class']=='PREPARATION' and failed.get('claim_id') and failed.get('native_claimed_at') and failed.get('completed_at') and failed['authority_epoch']==previous['authority_epoch'],'FAILED_ALLOCATION_EPOCH_NATIVE_REQUIRED')
 executor=one(rows['identity_principals'],'credential_id',failed['executor_credential_id'])
 require(executor['role']=='PROVISIONER' and executor['deployment_epoch']==failed['authority_epoch'],'FAILED_ALLOCATION_EPOCH_EXECUTOR_MISMATCH')
 retained=one([a for a in rows['runner_result_artifacts'] if a['role']=='native_receipt'],'operation_id',failed['operation_id'])
 require(retained['content_digest']==recovery['quiescence_receipt_digest']==failed['result'].get('native_receipt',{}).get('digest'),'FAILED_ALLOCATION_EPOCH_CAPTURE_MISMATCH')
 pins=failed['plan'].get('allocation',{});old=one(rows['resource_job_allocations'],'id',pins.get('allocation_id'));binding=failed['plan'].get('binding',{})
 require(binding.get('sandbox_id')==previous['sandbox_id'] and binding.get('boot_id')==previous['boot_id'] and str(binding.get('boot_generation'))==str(previous['boot_generation']),'FAILED_ALLOCATION_EPOCH_OLD_BOOT_MISMATCH')
 require(old['state']=='RELEASED' and old['job_kind']=='PREPARATION' and old['request_id']==pins.get('request_id') and str(old['generation'])==str(pins.get('generation')) and old['reservation_id']==failed['reservation_id'] and old['assignee_session_id']==failed['session_id'] and old['sandbox_id']==previous['sandbox_id'] and str(old['sandbox_boot_generation'])==str(previous['boot_generation']) and old['slot_id']==binding.get('slot_id'),'FAILED_ALLOCATION_EPOCH_OLD_TARGET_MISMATCH')
 vector=[r for r in rows['reservations'] if r['request_id']==old['request_id']];dimensions=set()
 require(len(vector)==4 and len({r['id'] for r in vector})==4 and old['reservation_id'] in {r['id'] for r in vector},'FAILED_ALLOCATION_EPOCH_VECTOR_MISMATCH')
 for reservation in vector:
  account=one(rows['capacity_accounts'],'id',reservation['capacity_account_id']);dimensions.add(account['dimension'])
  require(account['capacity_class']!='PHYSICAL' and reservation['state']=='RELEASED' and evidence_time(reservation['expires_at'])<=evidence_time(current['created_at']) and reservation.get('released_at') and evidence_time(reservation['released_at'])<=evidence_time(current['created_at']) and int(reservation['quantity'])>0,'FAILED_ALLOCATION_EPOCH_VECTOR_UNCLOSED')
 require(dimensions=={'PREPARATION','CPU_MILLIS','MEMORY_BYTES','DISK_BYTES'},'FAILED_ALLOCATION_EPOCH_VECTOR_MISMATCH')
 execution=one(rows['fleet_install_delivery_executions'],'operation_id',current['operation_id']);target=execution.get('target_binding',{})
 require(execution['logical_operation_id']==recovery['logical_operation_id'],'FAILED_ALLOCATION_EPOCH_ROOT_MISMATCH')
 fresh=one(rows['resource_job_allocations'],'id',target.get('allocation_id'))
 require(fresh['id']!=old['id'] and fresh['request_id']!=old['request_id'] and fresh['reservation_id']!=old['reservation_id'] and fresh['job_kind']=='PREPARATION' and fresh['request_id']==target.get('request_id') and fresh['reservation_id']==target.get('reservation_id') and fresh['assignee_session_id']==target.get('session_id') and fresh['slot_id']==target.get('slot_id') and fresh['sandbox_id']==current['sandbox_id'] and str(fresh['sandbox_boot_generation'])==str(current['boot_generation']) and target.get('boot_id')==current['boot_id'] and str(target.get('boot_generation'))==str(current['boot_generation']),'FAILED_ALLOCATION_EPOCH_FRESH_TARGET_MISMATCH')
 if successor is not None:
  actual=successor['plan'].get('allocation',{});native=successor['plan'].get('binding',{})
  require(actual.get('allocation_id')==fresh['id'] and actual.get('request_id')==fresh['request_id'] and str(actual.get('generation'))==str(fresh['generation']) and successor['reservation_id']==fresh['reservation_id'] and successor['session_id']==fresh['assignee_session_id'] and native.get('slot_id')==fresh['slot_id'],'FAILED_ALLOCATION_EPOCH_SUCCESSOR_MISMATCH')

def verified_install_recovery(rows,install,interrupted_operation_id):
 require(install['operation_id']!=interrupted_operation_id,'DISTINCT_INSTALL_RECOVERY_EXECUTION_REQUIRED')
 admission=install['admission']
 head=verified_install_head(rows,install);logical=head['logical_operation_id']
 require(isinstance(logical,str) and logical,'INSTALL_LOGICAL_ID_REQUIRED')
 current=install;seen=set();found_interrupted=False
 while True:
  require(current['operation_id'] not in seen,'INSTALL_RECOVERY_CYCLE');seen.add(current['operation_id'])
  require(len(seen)<64,'INSTALL_RECOVERY_DEPTH')
  failed_edges=[r for r in rows['fleet_install_recoveries'] if r['operation_id']==current['operation_id']]
  fresh_edges=[r for r in rows.get('fleet_install_not_started_recoveries',[]) if r['operation_id']==current['operation_id']]
  refused_edges=[r for r in rows.get('fleet_install_pre_provider_recoveries',[]) if r['operation_id']==current['operation_id']]
  if current['operation_id']==logical:
   require(not failed_edges and not fresh_edges and not refused_edges and current['admission'].get('logical_operation_id',logical)==logical and 'recovery_of' not in current['admission'],'INSTALL_RECOVERY_ROOT_MISMATCH');break
  require(len(failed_edges)+len(fresh_edges)+len(refused_edges)==1,'INSTALL_RECOVERY_EDGE_REQUIRED')
  recovery=(failed_edges or fresh_edges or refused_edges)[0]
  require(recovery['logical_operation_id']==logical,'INSTALL_RECOVERY_LINEAGE_MISMATCH')
  previous=one(rows['fleet_environment_installs'],'operation_id',recovery['predecessor_install_operation_id'])
  a=current['admission'];old=previous['admission'];binding=a.get('recovery_of')
  all_edges=rows['fleet_install_recoveries']+rows.get('fleet_install_not_started_recoveries',[])+rows.get('fleet_install_pre_provider_recoveries',[])
  require(len([r for r in all_edges if r['predecessor_install_operation_id']==previous['operation_id']])==1,'INSTALL_RECOVERY_BRANCH')
  require(all(a.get(k)==old.get(k) for k in ['input_digest','environment_id','environment_generation','sandbox_id','boot_id','boot_generation','package_digest','source_config_digest','plan_digest','source_revision','source_manifest_digest','slot_bindings']),'INSTALL_RECOVERY_PIN_MISMATCH')
  if refused_edges:
   verified_pre_provider_edge(rows,current,previous,recovery)
   current=previous;continue
  if fresh_edges:
   verified_not_started_edge(rows,current,previous,recovery)
   current=previous;continue
  if previous['operation_id']==interrupted_operation_id:found_interrupted=True
  expected={'install_operation_id':previous['operation_id'],'admission_digest':previous['admission_digest'],'runner_operation_id':recovery['runner_operation_id'],'runner_plan_digest':recovery['runner_plan_digest'],'quiescence_operation_id':recovery['quiescence_operation_id'],'quiescence_receipt_digest':recovery['quiescence_receipt_digest']}
  require(binding==expected and recovery['logical_operation_id']==logical and recovery['predecessor_admission_digest']==previous['admission_digest'] and a.get('logical_operation_id')==old.get('logical_operation_id',previous['operation_id']),'INSTALL_RECOVERY_LINEAGE_MISMATCH')
  require(current['operation_id']!=previous['operation_id'] and recovery['runner_operation_id']==recovery['quiescence_operation_id']==previous['operation_id'],'INSTALL_RECOVERY_PREDECESSOR_MISMATCH')
  failed=one(rows['runner_remote_jobs'],'operation_id',previous['operation_id'])
  require(failed['state']=='COMPLETED' and failed.get('signature_verified') is True and digest(failed['plan'])==failed['plan_digest']==recovery['runner_plan_digest'] and digest(failed['result'])==failed['result_digest']==recovery['runner_result_digest'],'SIGNED_INTERRUPTED_INSTALL_REQUIRED')
  result=failed['result'];cleanup=result.get('cleanup',{})
  require(result.get('outcome')=='FAILED' and result.get('cleanup_status')=='CONFIRMED' and cleanup.get('complete') is True and cleanup.get('observed_process_absent') is True and cleanup.get('receipt_digest')==recovery['quiescence_receipt_digest'],'INSTALL_RECOVERY_QUIESCENCE_MISMATCH')
  successor=one(rows['runner_remote_jobs'],'operation_id',current['operation_id'])
  verified_failed_allocation_epoch(rows,current,previous,recovery,failed,successor)
  old_request=failed['plan'].get('preparation_request',{});new_request=successor['plan'].get('preparation_request',{})
  require(failed['job_class']==successor['job_class']=='PREPARATION' and old_request.get('source')==new_request.get('source') and result['ended_at']<successor['result']['started_at'],'INTERRUPTED_INSTALL_PIN_RESTART_REQUIRED')
  for job,request,owner in [(failed,old_request,previous),(successor,new_request,current)]:
   job_binding=request.get('job_binding',{})
   require(job_binding.get('namespace')=='FLEET_INSTALL' and job_binding.get('job_id')==owner['operation_id'] and job_binding.get('input_packet_digest')==owner['admission_digest'] and request.get('input_manifest_digest')==job_binding.get('input_manifest_digest'),'INSTALL_RECOVERY_NATIVE_BINDING_MISMATCH')
  current=previous
 require(found_interrupted,'SIGNED_INTERRUPTED_INSTALL_REQUIRED')
 return logical

def verified_interrupted_install_capture(rows,install,case,capture):
 interrupted=one(rows['runner_remote_jobs'],'operation_id',case.get('interrupted_operation_id'))
 restarted=signed_install(rows,install)
 verified_install_recovery(rows,install,interrupted['operation_id'])
 require(capture.get('interrupted_operation_id')==interrupted['operation_id'] and capture.get('restarted_operation_id')==restarted['operation_id'] and capture.get('retained_stage_digests')==case.get('retained_stage_digests') and isinstance(capture.get('retained_stage_digests'),dict) and capture['retained_stage_digests'],'INTERRUPTED_STAGE_REUSE_REQUIRED')
 return restarted

def native_revision(target):
 return target['native_source_revision_id'] if target.get('source_backend')=='native' else 'git:'+target['accepted_source_object_id']

def verified_native_qualification(rows,qualification_id,target,checks=None):
 require(DIGEST.fullmatch(qualification_id or '') is not None,'NATIVE_QUALIFICATION_ID_REQUIRED')
 q=one(rows['source_fleet_qualifications'],'qualification_id',qualification_id)
 body=q['receipt'];require(digest({k:v for k,v in body.items() if k!='qualification_id'})==qualification_id and body.get('state')=='QUALIFIED' and body.get('run_id')==target['run_id'],'NATIVE_TASK_QUALIFICATION_DIGEST')
 custody=one(rows['source_fleet_submissions'],'custody_id',q['custody_id'])
 require(custody['authority']=='ACTIVE' and custody['qualification_outcome']=='PASS' and custody['current_qualification_id']==qualification_id and custody['run_authority_epoch']==target['authority_epoch'],'CURRENT_NATIVE_CUSTODY_REQUIRED')
 require(q['task_id']==custody['task_id'] and str(q['custody_generation'])==str(custody['custody_generation']) and body['revision_id']==custody['revision_id'] and body['root_tree_id']==custody['root_tree_id'] and body['input_digest']==digest(custody['input_manifest']),'NATIVE_CUSTODY_RECEIPT_MISMATCH')
 task=one(rows['tasks'],'id',custody['task_id']);require(task['state'] in ('QUALIFIED','INTEGRATING','INTEGRATED') and task['spec_revision_id']==q['spec_revision_id'] and str(task['spec_generation'])==str(q['spec_generation']) and task['criteria_digest']==q['criteria_digest'],'NATIVE_ACCEPTED_TASK_POLICY_REQUIRED')
 candidate=one(rows['source_native_candidates'],'candidate_id',q['candidate_id']);manifest=candidate['manifest']
 require(digest(manifest)==candidate['manifest_digest'] and manifest['revision_id']==custody['revision_id'] and manifest['root_tree_id']==custody['root_tree_id'] and manifest['inputs']==custody['input_manifest'] and manifest['policy_digest']==q['policy_digest'],'NATIVE_CANDIDATE_BINDING_REQUIRED')
 qualification=one(rows['source_candidate_qualifications'],'qualification_id',q['candidate_qualification_id']);proof=qualification['result']
 require(digest({k:v for k,v in proof.items() if k!='qualification_id'})==q['candidate_qualification_id'] and proof['candidate_id']==candidate['candidate_id'] and proof['manifest_digest']==candidate['manifest_digest'],'NATIVE_CANDIDATE_QUALIFICATION_REQUIRED')
 policy=one(rows['source_native_assurance_policies'],'policy_id',manifest['policy_id']);domain=one(rows['source_authority_domains'],'security_domain_id',target['security_domain_id']);require(domain['enabled'] is True and str(domain['authority_epoch'])==str(custody['source_authority_epoch'])==str(policy['authority_epoch']) and not policy.get('revoked_at') and policy['policy_digest']==manifest['policy_digest'],'CURRENT_NATIVE_POLICY_REQUIRED')
 retained=one(rows['source_native_custodies'],'custody_id',custody['custody_id']);require(not retained.get('revoked_at') and retained['revision_id']==custody['revision_id'] and retained['root_tree_id']==custody['root_tree_id'] and any(c.get('custody_id')==custody['custody_id'] and c.get('revision_id')==custody['revision_id'] for c in manifest['contributors']),'NATIVE_CONTRIBUTOR_CUSTODY_REQUIRED')
 ids=proof['evidence']['evidence_ids'];evidence=[one(rows['source_native_assurance_evidence'],'evidence_id',key) for key in ids]
 require(len(ids)==len(set(ids)) and {item['check_id'] for item in evidence}=={item['id'] for item in policy['checks']},'EXACT_NATIVE_CHECK_INVENTORY_REQUIRED')
 source_assignment=one(rows['source_fleet_assignments'],'assignment_id',custody['assignment_id']);source_attempt=one(rows['attempts'],'id',custody['attempt_id'])
 pins=target.get('native_check_executions');require(isinstance(pins,list) and pins,'NATIVE_CHECK_EXECUTION_PINS_REQUIRED')
 for item in evidence:
  receipt=item['receipt'];check=one(policy['checks'],'id',item['check_id']);pin=one(pins,'check_id',item['check_id'])
  checker=one([c for c in rows['source_native_assurance_checkers'] if c['policy_id']==policy['policy_id'] and c['check_id']==item['check_id']],'principal_id',item['checker_principal_id']);principal=one(rows['identity_principals'],'credential_id',item['checker_credential_id']);require(checker['credential_id']==principal['credential_id'] and not checker.get('revoked_at') and principal['actor_id']==item['checker_principal_id'] and principal['state']=='ACTIVE' and str(principal['credential_version'])==str(item['checker_credential_version']),'CURRENT_REGISTERED_NATIVE_CHECKER_REQUIRED')
  require(item['outcome']=='PASS' and not item.get('revoked_at') and digest(receipt)==item['receipt_digest'] and receipt.get('source_kind')=='NATIVE' and receipt['candidate_id']==candidate['candidate_id'] and receipt['candidate_manifest_digest']==candidate['manifest_digest'] and receipt['inputs']==custody['input_manifest'],'NATIVE_EXECUTION_RECEIPT_REQUIRED')
  require(receipt['revision_id']==custody['revision_id'] and receipt['root_tree_id']==custody['root_tree_id'] and item['checker_principal_id']!=source_assignment['worker_principal_id'],'INDEPENDENT_NATIVE_CHECKER_REQUIRED')
  command=receipt['command'];execution=receipt['execution']
  require(command['argv']==check['argv'] and command['executable_digest']==check['executable_digest'] and command['exit_code']==0 and command['signal'] is None and command['timed_out'] is False and command['interrupted'] is False and command['output_truncated'] is False,'ACTUAL_NATIVE_CHECK_COMMAND_REQUIRED')
  require(execution['source_revision_id']==custody['revision_id'] and execution['source_root_tree_id']==custody['root_tree_id'] and execution['input_digest']==digest(custody['input_manifest']) and execution['cleanup_complete'] is True and execution['process_absent'] is True,'NATIVE_EXECUTION_SOURCE_BINDING_REQUIRED')
  native=signed_job(rows,pin['operation_id']);native_role(rows,native,'test',target);registry=one(rows['runner_registry'],'session_id',native['session_id'])
  require(native['job_class']=='EXECUTION' and registry['sandbox_id']!=source_attempt['sandbox_id'] and execution['execution_id']==pin['execution_id'],'INDEPENDENT_NATIVE_PROVIDER_EXECUTION_REQUIRED')
  artifact=one(rows['artifacts'],'id',pin['receipt_artifact_id']);links=[r for r in rows['runner_result_artifacts'] if r['operation_id']==native['operation_id'] and r['artifact_id']==artifact['id']]
  require(artifact['status']=='COMPLETE' and artifact['completed_at'] and links and any(r['content_digest']==item['receipt_digest'] for r in links),'SIGNED_NATIVE_RECEIPT_ARTIFACT_REQUIRED')
  if checks is not None and any(p['check_id']==item['check_id'] for p in checks):
   expected=one(checks,'check_id',item['check_id']);require(expected['executable_digest']==command['executable_digest'] and expected['argv_digest']==digest(command['argv']),'CASE_NATIVE_PROBE_PIN_MISMATCH')
 if checks is not None:require({c['check_id'] for c in checks}.issubset({r['check_id'] for r in evidence}),'CASE_NATIVE_CHECK_SELECTION_MISMATCH')
 return {'source_object_id':custody['revision_id'],'native_receipt':body},{'source_attempt_id':custody['attempt_id'],'repository_id':custody['repository_id'],'source_object_id':custody['revision_id'],'native_custody':custody}

def verified_qualification(rows,job_id,target,checks=None):
 if target.get('source_backend')=='native':return verified_native_qualification(rows,job_id,target,checks)
 job=one(rows['qualification_jobs'],'id',job_id);require(job['state']=='SUCCEEDED' and job['outcome']=='PASS','ACTUAL_QUALIFICATION_REQUIRED')
 custody=one(rows['submission_custodies'],'id',job['custody_id']);receipt=one([r for r in rows['assurance_job_receipts'] if str(r['lease_generation'])==str(job['lease_generation'])],'job_id',job_id)
 body=receipt['receipt'];receipt_artifact=one(rows['artifacts'],'id',receipt['receipt_artifact_id']);require(receipt_artifact['status']=='COMPLETE' and receipt_artifact['digest']==receipt['receipt_digest'],'QUALIFICATION_RECEIPT_ARTIFACT_REQUIRED');require(digest(body)==receipt['receipt_digest'] and body.get('job_id')==job_id and body.get('custody_id')==custody['id'] and body.get('source_attempt_id')==custody['source_attempt_id'] and body.get('source_object_id')==custody['source_object_id'] and body.get('outcome')=='PASS' and body.get('unmet')==[],'QUALIFICATION_CHAIN_MISMATCH')
 selected=body.get('required_check_ids');results=body.get('checks');require(isinstance(selected,list) and selected and len(set(selected))==len(selected) and isinstance(results,list) and len(results)==len(selected),'EXACT_CHECK_INVENTORY_REQUIRED')
 verifier=one(rows['agent_sessions'],'id',receipt['verifier_id']);source_attempt=one(rows['attempts'],'id',custody['source_attempt_id']);source_actor=[plan['agent_session_id'] for plan in rows['native_launch_plans'] if plan['attempt_id']==source_attempt['id']]
 require(verifier['role']=='VERIFIER' and receipt['verifier_id'] not in source_actor,'INDEPENDENT_VERIFIER_REQUIRED')
 for result in results:
  require(result.get('check_id') in selected and sum(r.get('check_id')==result['check_id'] for r in results)==1 and result.get('outcome')=='PASS' and result.get('source_object_id')==custody['source_object_id'],'CHECK_RESULT_MISMATCH')
  command=result.get('command',{});execution=result.get('execution',{});require(command.get('exit_code')==0 and command.get('signal') is None and command.get('timed_out') is False and command.get('interrupted') is False and command.get('output_truncated') is False,'ACTUAL_COMMAND_SUCCESS_REQUIRED')
  require(execution.get('sandbox_id')!=source_attempt.get('sandbox_id') and execution.get('cleanup_status')=='CONFIRMED' and execution.get('cleanup',{}).get('observed_process_absent') is True,'INDEPENDENT_TEST_SANDBOX_REQUIRED')
  native=signed_job(rows,execution.get('operation_id'));native_role(rows,native,'test',target);require(native['job_class']=='EXECUTION' and native['session_id']==execution.get('session_id'),'TEST_NATIVE_CHAIN_REQUIRED')
  check=one([r for r in rows['assurance_check_intents'] if r['job_id']==job_id],'check_id',result['check_id']);require(check['operation_id']==native['operation_id'] and isinstance(native['plan'].get('request'),dict) and check['plan_digest']==digest(native['plan']['request']) and check['plan']==native['plan']['request'],'CHECK_INTENT_MISMATCH')
  if checks is not None and any(pin['check_id']==result['check_id'] for pin in checks):
   pin=one(checks,'check_id',result['check_id']);require(pin['executable_digest']==result.get('executable_digest') and pin['argv_digest']==digest(command.get('argv')),'CASE_PROBE_PIN_MISMATCH')
  for reference in [*result.get('artifacts',[]),*result.get('output',{}).values()]:
   require(isinstance(reference,dict) and 'artifact_id' in reference,'COMPLETE_CHECK_OUTPUT_REQUIRED');artifact=one(rows['artifacts'],'id',reference['artifact_id']);require(artifact['status']=='COMPLETE' and artifact['completed_at'] and artifact['digest']==reference.get('digest'),'ACTUAL_ARTIFACT_REQUIRED')
 if checks is not None:require({c['check_id'] for c in checks}.issubset(set(selected)),'CASE_CHECK_SELECTION_MISMATCH')
 return body,custody

def signed_install(rows,install):
 readiness=[r for r in rows['fleet_runtime_readiness'] if r['install_operation_id']==install['operation_id']]
 require(readiness,'SIGNED_INSTALL_MEASUREMENT_REQUIRED')
 operations={r['runner_operation_id'] for r in readiness};require(len(operations)==1,'EXACT_INSTALL_EXECUTION_REQUIRED');job=signed_job(rows,next(iter(operations)))
 require(job['job_class']=='PREPARATION' and job['plan'].get('preparation_request',{}).get('job_binding',{}).get('job_id')==install['operation_id'] and all(r['runner_result_digest']==job['result_digest'] and r['publication'].get('prepared_receipt_digest')==install['receipt_digest'] for r in readiness),'SIGNED_INSTALL_BINDING_MISMATCH')
 return job

def native_role(rows,job,role,target):
 pin=target.get('native_binary_pins',{}).get(role);require(DIGEST.fullmatch(pin or '') is not None,'ROLE_NATIVE_PIN_REQUIRED')
 registry=one(rows['runner_registry'],'session_id',job['session_id']);require(registry['runner_binary_digest']==pin and job['plan'].get('binding',{}).get('runner_binary_digest')==pin,'ROLE_NATIVE_PIN_MISMATCH')

def native_capture(rows,operation,reference,evidence_root,kind):
 job=one(rows['runner_remote_jobs'],'operation_id',operation);require(job.get('signature_verified') is True and digest(job['result'])==job['result_digest'] and digest(job['plan'])==job['plan_digest'],'SIGNED_CAPTURE_REQUIRED')
 relative=Path(reference['path']);require(not relative.is_absolute() and '..' not in relative.parts,'CAPTURE_PATH_REFUSED');filename=Path(evidence_root)/relative
 require(digest(filename.read_bytes())==reference['digest']==job['result'].get(kind,{}).get('digest'),'SIGNED_CAPTURE_DIGEST_MISMATCH')
 return private_json(filename)

def verified_install_transfer(rows,install,case,target,evidence_root):
 job=signed_install(rows,install)
 native=native_capture(rows,job['operation_id'],one(case.get('native_receipts',[]),'operation_id',job['operation_id']),evidence_root,'native_receipt')
 transfer=install['receipt'].get('transfer',{});stage=transfer.get('native_stage')
 require(transfer.get('schema_version')==1 and transfer.get('kind')=='hyperfide.fleet-install-transfer' and transfer.get('operation_id')==job['operation_id'] and isinstance(stage,dict) and stage==native.get('preparation_stage',{}).get('artifact_transfer'),'MEASURED_TRANSFER_CAPTURE_REQUIRED')
 counters=('rpc_calls','http_responses','http_response_body_bytes','verified_object_reads','verified_object_bytes','staged_artifacts','staged_payload_bytes','cache_hits')
 require(set(stage)==set(('schema_version','kind','operation_id','measurement','cache_mode',*counters)) and stage['schema_version']==1 and stage['kind']=='hyperfide.artifact-stage-transfer' and stage['operation_id']==job['operation_id'] and stage['measurement']=='NATIVE_ARTIFACT_RPC_HTTP_BODY' and stage['cache_mode']=='UNCACHED','TRANSFER_MEASUREMENT_DOMAIN_MISMATCH')
 require(all(type(stage[k]) is int and 0<=stage[k]<=9007199254740991 for k in counters) and stage['cache_hits']==0 and 0<stage['http_responses']<=stage['rpc_calls'] and 0<stage['verified_object_reads']<=stage['rpc_calls'] and stage['staged_artifacts']>0 and stage['staged_payload_bytes']==stage['verified_object_bytes']>0,'ACTUAL_STAGE_TRANSFER_REQUIRED')
 limits=target.get('fetch_limits',{})
 for field,budget in [('http_response_body_bytes','max_stage_response_body_bytes'),('rpc_calls','max_stage_rpc_calls'),('verified_object_bytes','max_stage_verified_object_bytes')]:
  require(type(limits.get(budget)) is int and limits[budget]>0,'TRANSFER_BUDGET_PINS_REQUIRED')
  require(stage[field]<=limits[budget],'NATIVE_STAGE_TRANSFER_BUDGET_EXCEEDED')
 dependency=transfer.get('dependency_io',{})
 require(dependency.get('network_bytes') is None and dependency.get('network_requests') is None and dependency.get('observation')=='UNOBSERVED_SUBPROCESS_NETWORK','DEPENDENCY_NETWORK_SCOPE_REQUIRED')
 return stage

def verified_operator_artifact(rows,install,capture,case_name):
 require(capture.get('kind')=='hyperfide.authenticated-operator-step' and capture.get('operation_id') in rows.get('authenticated_fault_operations',[]) and capture.get('case')==case_name,'AUTHENTICATED_OPERATOR_ARTIFACT_REQUIRED')
 try:envelope=json.loads(base64.b64decode(capture['body_base64'],validate=True));payload=json.loads(base64.urlsafe_b64decode(envelope['payload_b64']+'='*((-len(envelope['payload_b64']))%4)));upload=payload['input'];raw=base64.b64decode(upload['data_base64'],validate=True);core=json.loads(raw)
 except (ValueError,TypeError,KeyError):raise Refused('OPERATOR_CAPTURE_ARTIFACT_REQUIRED')
 require(payload.get('component')=='15.2' and payload.get('action')=='artifact.object.put' and upload.get('organisation_id')==install['admission']['organisation_id'] and upload.get('run_id')==install['admission']['run_id'] and upload.get('digest')==digest(raw) and upload.get('size_bytes')==str(len(raw)) and raw==canonical(core),'OPERATOR_CAPTURE_ARTIFACT_REQUIRED')
 published=capture.get('response',{}).get('body',{}).get('result',{});artifact=one(rows['artifacts'],'id',published.get('artifact',{}).get('artifact_id'))
 require(published.get('outcome')=='SUCCEEDED' and published.get('availability')=='VERIFIED' and artifact['status']=='COMPLETE' and artifact['completed_at'] and artifact['digest']==digest(raw) and str(artifact['size_bytes'])==str(len(raw)),'OPERATOR_CAPTURE_ARTIFACT_REQUIRED')
 return core,artifact

def verified_install_interruption(rows,install,case,target,capture,evidence_root):
 require(case.get('producer_mode')=='OPERATOR_PROVIDER_EXEC','INSTALL_INTERRUPTION_PRODUCER_REQUIRED')
 previous=one(rows['fleet_environment_installs'],'operation_id',case.get('interrupted_operation_id'));job=one(rows['runner_remote_jobs'],'operation_id',previous['operation_id']);pin=target.get('fault_drivers',{}).get('interrupted_install',{})
 core,_artifact=verified_operator_artifact(rows,previous,capture,'interrupted_install')
 require(core.get('schema_version')==1 and core.get('kind')=='hyperfide.operator-provider-install-interruption' and core.get('install_operation_id')==core.get('interrupted_operation_id')==previous['operation_id'] and core.get('restarted_operation_id')==install['operation_id'] and core.get('admission_digest')==previous['admission_digest'] and core.get('plan_digest')==previous['admission']['plan_digest'] and core.get('organisation_id')==previous['admission']['organisation_id'] and core.get('run_id')==previous['admission']['run_id'],'OPERATOR_INTERRUPTION_SCOPE_REQUIRED')
 boot=one([r for r in rows['provider_native_bootstraps'] if r['sandbox_id']==previous['sandbox_id'] and r['boot_id']==previous['boot_id'] and str(r['boot_generation'])==str(previous['boot_generation'])],'state','READY');scope=core.get('provider_scope',{})
 require(scope==pin.get('provider_scope') and scope.get('sandbox_id')==previous['sandbox_id'] and scope.get('boot_id')==previous['boot_id'] and str(scope.get('boot_generation'))==str(previous['boot_generation']) and scope.get('native_sandbox_id')==boot['native_sandbox_id'] and scope.get('pool_id')==boot['pool_id'] and scope.get('configuration_digest')==boot['configuration_digest'],'OPERATOR_INTERRUPTION_PROVIDER_SCOPE_REQUIRED')
 for key in ['helper_path','request_path','cwd']:
  value=pin.get(key);require(isinstance(value,str) and Path(value).is_absolute() and str(Path(value))==value and '..' not in Path(value).parts,'INTERRUPTION_PROTECTED_PATH_REQUIRED')
 require(pin['helper_path']!=pin['request_path'],'INTERRUPTION_PROTECTED_PATH_REQUIRED')
 records=core.get('sdk_records',{});require(isinstance(records,dict) and set(records)=={'upload','readback_before','execute','process','readback_after','request_upload','request_readback_before','request_readback_after'},'ACTUAL_INTERRUPTION_SDK_RECORDS_REQUIRED')
 for record in records.values():require(isinstance(record,dict) and 'request' in record and 'response' in record and record.get('response_digest')==digest(record['response']),'INTERRUPTION_SDK_CUSTODY_REQUIRED')
 request_bytes=None
 for name in ['upload','readback_before','readback_after','request_upload','request_readback_before','request_readback_after']:
  is_request=name.startswith('request_');record=records[name];require(record['request'].get('path')==pin.get('request_path' if is_request else 'helper_path'),'INTERRUPTION_SDK_PATH_REQUIRED')
  encoded=record['request'].get('content_base64') if name in ('upload','request_upload') else record['response'].get('content_base64')
  try:data=base64.b64decode(encoded,validate=True)
  except (ValueError,TypeError):raise Refused('INTERRUPTION_SDK_BYTES_REQUIRED')
  require(len(data)<=(16384 if is_request else 65536) and DIGEST.fullmatch(pin.get('request_digest' if is_request else 'helper_digest','')) and digest(data)==pin['request_digest' if is_request else 'helper_digest'],'INTERRUPTION_SDK_BYTES_REQUIRED')
  if is_request:request_bytes=data
 try:request=json.loads(request_bytes)
 except (ValueError,TypeError):raise Refused('INTERRUPTION_REQUEST_REQUIRED')
 execution=records['execute']['request'];process=records['process']['response'];observed=core.get('capture',{})
 require(isinstance(process,dict) and process.get('name')==execution.get('name')==records['process']['request'].get('identifier') and isinstance(process.get('pid'),str) and process['pid'] and process.get('command')==execution.get('command') and digest(process.get('command','').encode())==pin.get('command_digest') and process.get('workingDir')==execution.get('workingDir')==pin.get('cwd') and process.get('status')=='completed' and process.get('exitCode')==0 and process.get('completedAt'),'ACTUAL_INTERRUPTION_PROCESS_REQUIRED')
 require(isinstance(process.get('stdout'),str) and len(process['stdout'].encode())<=65536 and isinstance(process.get('stderr'),str) and len(process['stderr'].encode())<=65536,'BOUNDED_INTERRUPTION_OUTPUT_REQUIRED')
 try:actual=json.loads(process['stdout'])
 except (ValueError,TypeError):raise Refused('ACTUAL_INTERRUPTION_STDOUT_REQUIRED')
 require(actual==observed,'ACTUAL_INTERRUPTION_STDOUT_REQUIRED')
 require(set(observed.get('retained_stage_digests',{}))=={'bootstrap-preflight','authority-resolution','plan-resolution','source-preparation','toolchain-preparation'},'INTERRUPTION_STAGE_PREFIX_REQUIRED')
 verified_install_interruption_observation(previous,job,request,observed,core,install)
 native_role(rows,job,'install',target)
 native=native_capture(rows,job['operation_id'],one(case.get('native_receipts',[]),'operation_id',job['operation_id']),evidence_root,'native_receipt');identity=native.get('start_identity',{});measured=observed['process']
 require(native.get('operation_id')==job['operation_id'] and native.get('plan_digest')==job['plan_digest'] and identity.get('pid')==measured['pid'] and str(identity.get('start_time'))==measured['process_start'] and identity.get('os_boot_id')==measured['os_boot_id'] and identity.get('uid')==measured['uid'] and native.get('signal')==9 and native.get('exit_code')==137 and native.get('cleanup_status')=='CONFIRMED' and native.get('observed_process_absent') is True,'SIGNED_INTERRUPTION_PROCESS_REQUIRED')
 started=int(evidence_time(native['started_at']).timestamp()*1000000000);ended=int(evidence_time(native['ended_at']).timestamp()*1000000000)
 require(started<=observed['observed_at_ns']<=observed['signal_sent_at_ns']<=ended,'INTERRUPTION_NATIVE_TIME_REQUIRED')
 verified_interrupted_install_capture(rows,install,case,core)
 return core

def verified_install_interruption_observation(previous,job,request,observed,core,install):
 fields={'schema_version','request_id','mode','sandbox_id','boot_id','boot_generation','os_boot_id','state_dir','uid','environment_id','environment_generation','environment_root','install_plan_digest','deadline_seconds','target'}
 require(isinstance(request,dict) and set(request)==fields and request.get('schema_version')==1 and request.get('mode')=='interrupt' and type(request.get('deadline_seconds')) is int and 1<=request['deadline_seconds']<=600,'INTERRUPTION_REQUEST_REQUIRED')
 binding=job['plan']['binding'];a=previous['admission'];live=observed.get('process',{});expected_target={'operation_id':previous['operation_id'],'runner_plan_digest':job['plan_digest'],'pid':live.get('pid'),'process_start':live.get('process_start'),'os_boot_id':live.get('os_boot_id')}
 require(request['target']==expected_target and all(str(request.get(k))==str(a.get(k)) for k in ['sandbox_id','boot_id','boot_generation','environment_id','environment_generation','environment_root']) and request['install_plan_digest']==a['plan_digest'] and request['state_dir']==binding['state_dir'] and request['uid']==binding['uid']==live.get('uid') and request['os_boot_id']==live.get('os_boot_id'),'INTERRUPTION_REQUEST_BINDING_REQUIRED')
 require(observed.get('schema_version')==1 and observed.get('kind')=='FLEET_INSTALL_FAULT_OBSERVATION_V1' and observed.get('authority')=='FAULT_CAPTURE_ONLY' and observed.get('request_id')==request['request_id'] and all(str(observed.get(k))==str(a.get(k)) for k in ['sandbox_id','boot_id','boot_generation']) and observed.get('operation_id')==previous['operation_id'] and observed.get('runner_plan_digest')==job['plan_digest'] and observed.get('install_plan_digest')==a['plan_digest'] and observed.get('native_job_state')=='START_RECORDED' and observed.get('signal')=='SIGKILL' and observed.get('outcome')=='FAULT_INJECTED_AWAIT_NATIVE_RESULT','ACTUAL_PIDFD_INTERRUPTION_REQUIRED')
 require(type(live.get('pid')) is int and live['pid']>0 and isinstance(live.get('process_start'),str) and live['process_start'].isdigit() and int(live['process_start'])>0 and live.get('state') not in (None,'Z','X','x') and DIGEST.fullmatch(live.get('cmdline_digest','')) and DIGEST.fullmatch(observed.get('stage_ledger_digest','')) and type(observed.get('observed_at_ns')) is int and type(observed.get('signal_sent_at_ns')) is int and 0<observed['observed_at_ns']<=observed['signal_sent_at_ns'],'EXACT_INTERRUPTION_PROCESS_REQUIRED')
 retained=observed.get('retained_stage_digests');require(isinstance(retained,dict) and retained and observed.get('stages')==sorted(retained) and 'toolchain-preparation' in retained and 'dependency-preparation' not in retained and all(DIGEST.fullmatch(v) for v in retained.values()) and core.get('retained_stage_digests')==retained,'INTERRUPTION_STAGE_WINDOW_REQUIRED')
 final={s['name']:s['evidence_digest'] for s in install['receipt']['stages'] if s['status']=='PASS'};require(all(final.get(k)==v for k,v in retained.items() if k!='authority-resolution'),'INTERRUPTION_RETAINED_STAGE_MISMATCH')
 if 'authority-resolution' in retained:require(retained['authority-resolution']==digest({'admission_digest':previous['admission_digest']}) and final.get('authority-resolution')==digest({'admission_digest':install['admission_digest']}),'INTERRUPTION_AUTHORITY_STAGE_REQUIRED')

def verified_install_replay(rows,install,case,target,capture):
 require(case.get('producer_mode')=='OPERATOR_PROVIDER_EXEC','INSTALL_REPLAY_PRODUCER_MODE_REQUIRED')
 pin=target.get('repeat_driver',{});expected_probe=digest((ROOT/'tests/hyperfide/support/fleet_install_replay_probe.mjs').read_bytes())
 require(pin.get('probe_digest')==expected_probe and capture.get('kind')=='hyperfide.authenticated-operator-step' and capture.get('operation_id') in rows.get('authenticated_fault_operations',[]) and capture.get('case')=='repeated_install','AUTHENTICATED_OPERATOR_REPLAY_REQUIRED')
 core,artifact=verified_operator_artifact(rows,install,capture,'repeated_install')
 require(core.get('schema_version')==1 and core.get('kind')=='hyperfide.operator-provider-install-replay' and core.get('install_operation_id')==install['operation_id'] and core.get('admission_digest')==install['admission_digest'] and core.get('plan_digest')==install['admission']['plan_digest'] and core.get('organisation_id')==install['admission']['organisation_id'] and core.get('run_id')==install['admission']['run_id'],'OPERATOR_REPLAY_SCOPE_REQUIRED')
 boot=one([r for r in rows['provider_native_bootstraps'] if r['sandbox_id']==install['sandbox_id'] and r['boot_id']==install['boot_id'] and str(r['boot_generation'])==str(install['boot_generation'])],'state','READY')
 scope=core.get('provider_scope',{});require(scope==pin.get('provider_scope') and scope.get('sandbox_id')==install['sandbox_id'] and scope.get('boot_id')==install['boot_id'] and str(scope.get('boot_generation'))==str(install['boot_generation']) and scope.get('native_sandbox_id')==boot['native_sandbox_id'] and scope.get('pool_id')==boot['pool_id'] and scope.get('configuration_digest')==boot['configuration_digest'],'OPERATOR_REPLAY_PROVIDER_SCOPE_REQUIRED')
 records=core.get('sdk_records',{});required={'upload','readback_before','execute','process','readback_after'};require(isinstance(records,dict) and set(records)==required,'ACTUAL_SDK_REPLAY_RECORDS_REQUIRED')
 for record in records.values():require(isinstance(record,dict) and 'request' in record and 'response' in record and record.get('response_digest')==digest(record['response']),'SDK_REPLAY_RESPONSE_CUSTODY_REQUIRED')
 probe=core.get('capture',{});path=pin.get('probe_path');require(isinstance(path,str) and path.startswith('/') and probe.get('probe_digest')==expected_probe and probe.get('probe_before',{}).get('path')==path,'SDK_REPLAY_PROBE_PATH_REQUIRED')
 for name in ['upload','readback_before','readback_after']:
  record=records[name];require(record['request'].get('path')==path,'SDK_REPLAY_PROBE_PATH_REQUIRED')
  encoded=record['request'].get('content_base64') if name=='upload' else record['response'].get('content_base64')
  try:data=base64.b64decode(encoded,validate=True)
  except (ValueError,TypeError):raise Refused('SDK_REPLAY_PROBE_BYTES_REQUIRED')
  require(digest(data)==expected_probe,'SDK_REPLAY_PROBE_BYTES_REQUIRED')
 execution=records['execute']['request'];process=records['process']['response']
 require(isinstance(process,dict) and process.get('name')==execution.get('name')==records['process']['request'].get('identifier') and isinstance(process.get('pid'),str) and process['pid'] and process.get('command')==execution.get('command') and digest(process.get('command','').encode())==pin.get('command_digest') and process.get('workingDir')==execution.get('workingDir')==pin.get('cwd') and process.get('status')=='completed' and process.get('exitCode')==0 and process.get('completedAt'),'ACTUAL_SDK_REPLAY_PROCESS_REQUIRED')
 require(isinstance(process.get('stdout'),str) and len(process['stdout'].encode())<=4*1024*1024 and isinstance(process.get('stderr'),str) and len(process['stderr'].encode())<=65536,'BOUNDED_REPLAY_OUTPUT_REQUIRED')
 try:actual=json.loads(process['stdout'])
 except (ValueError,TypeError):raise Refused('ACTUAL_REPLAY_STDOUT_REQUIRED')
 require(actual==probe,'ACTUAL_REPLAY_STDOUT_REQUIRED')
 require(probe.get('node_digest')==pin.get('node_digest'),'INSTALL_REPLAY_NODE_PIN_REQUIRED')
 verified_install_head(rows,install)
 verified_install_replay_capture(install,probe)
 return artifact

def verified_install_replay_capture(install,capture):
 require(isinstance(capture,dict) and capture.get('schema_version')==1 and capture.get('kind')=='hyperfide.install-replay-capture' and capture.get('install_operation_id')==install['operation_id'],'INSTALL_REPLAY_CAPTURE_REQUIRED')
 require(capture.get('plan_digest')==install['admission']['plan_digest'] and capture.get('probe_digest')==digest((ROOT/'tests/hyperfide/support/fleet_install_replay_probe.mjs').read_bytes()),'INSTALL_REPLAY_PROBE_PIN_REQUIRED')
 self_before=capture.get('probe_before');require(isinstance(self_before,dict) and self_before==capture.get('probe_after') and self_before.get('digest')==capture['probe_digest'] and self_before.get('uid')==0 and type(self_before.get('mode')) is int and self_before['mode']&0o022==0,'INSTALL_REPLAY_PROBE_CUSTODY_REQUIRED')
 status={'state':'READY','operation_id':install['operation_id'],'admission_digest':install['admission_digest'],'receipt_digest':install['receipt_digest']}
 require(capture.get('authority_before')==capture.get('authority_after')==status,'INSTALL_REPLAY_AUTHORITY_CHANGED')
 invocations=capture.get('invocations');require(isinstance(invocations,list) and len(invocations)==2,'TWO_INSTALL_REPLAY_INVOCATIONS_REQUIRED')
 for invocation in invocations:
  receipt=invocation.get('receipt',{});require(receipt.get('reused') is True and {k:v for k,v in receipt.items() if k!='reused'}==install['receipt'],'SAME_OPERATION_READY_REPLAY_REQUIRED')
 before=capture.get('dirty_before');after=capture.get('dirty_after');require(isinstance(before,dict) and before==after and set(before)=={'slot','path','digest','size_bytes','mode','uid','gid'} and DIGEST.fullmatch(before.get('digest','')) and type(before.get('size_bytes')) is int and before['size_bytes']>=0 and type(before.get('mode')) is int and 0<=before['mode']<=511,'INSTALL_REPLAY_DIRTY_PRESERVATION_REQUIRED')
 slot=one(install['receipt']['slots'],'slot',before['slot']);owner=one(install['admission']['slot_bindings'],'slot',before['slot']);dirty=Path(before['path']);root=Path(slot['source'])
 require(dirty.is_absolute() and str(dirty)==before['path'] and '..' not in dirty.parts and dirty!=root and dirty.is_relative_to(root) and before['uid']==owner['uid'] and before['gid']==owner['gid'],'INSTALL_REPLAY_DIRTY_SCOPE_REQUIRED')
 relative=str(dirty.relative_to(root));tracked=[r for r in install['receipt']['source_files'] if r['path']==relative]
 require(not tracked or all(r['digest']!=before['digest'] for r in tracked),'INSTALL_REPLAY_ACTUAL_DIRTY_BYTES_REQUIRED')
 return capture

def verified_worker_cancellation(rows,launch,case):
 operation=case.get('cancellation_operation_id');stop_id=case.get('stop_command_id')
 require(isinstance(operation,str) and operation and isinstance(stop_id,str) and stop_id,'CANCELLATION_PROVENANCE_REQUIRED')
 effect=one(rows['fleet_effect_receipts'],'operation_id',operation);decision=one(rows['fleet_decisions'],'id',effect['decision_id']);body=decision['body'];selected=body.get('input',{})
 plan=one(rows['native_launch_plans'],'command_id',launch['command_id']);attempt=one(rows['attempts'],'id',plan['attempt_id'])
 require(effect['payload_digest']==decision['payload_digest'] and decision['operation_id']==operation and decision['action']==body.get('action')=='CANCEL_ASSIGNMENT' and body.get('operation_id')==operation and digest(body)==decision['payload_digest'],'ADMITTED_CANCELLATION_REQUIRED')
 require(selected.get('task_id')==attempt['task_id'] and selected.get('attempt_id')==attempt['id'] and str(selected.get('attempt_generation'))==str(plan['attempt_generation']) and selected.get('launch_id')==launch['launch_id'],'CANCELLATION_TARGET_MISMATCH')
 result=effect['result'];command=result.get('command',{}).get('event',{})
 require(result.get('kind')=='CANCEL_ASSIGNMENT' and result.get('task_id')==attempt['task_id'] and result.get('attempt_id')==attempt['id'] and result.get('delegation_id')==body.get('delegation_id') and command.get('id')==operation,'CANCELLATION_EFFECT_REQUIRED')
 event=one(rows['outbox_events'],'id',operation);payload=event['payload']
 require(event['aggregate_type']=='attempt.instructions' and event['aggregate_id']==attempt['id'] and event['event_type']=='instruction.cancel' and payload==command.get('payload') and payload.get('instruction_id')==operation and payload.get('attempt_id')==attempt['id'] and str(payload.get('attempt_generation'))==str(plan['attempt_generation']) and payload.get('body',{}).get('launch_id')==launch['launch_id'],'CANCELLATION_INSTRUCTION_REQUIRED')
 control=one(rows['runner_control_commands'],'command_id',stop_id);report=control.get('report',{})
 require(control['action']=='runner.stop' and control['launch_id']==launch['launch_id'] and control['attempt_id']==attempt['id'] and str(control['attempt_generation'])==str(plan['attempt_generation']) and control['slot_id']==plan['slot_id'] and control['sandbox_id']==attempt['sandbox_id'] and str(control['boot_generation'])==str(attempt['sandbox_boot_generation']) and control['boot_id']==payload.get('boot_id') and control['authority_epoch']==payload.get('authority_epoch'),'CANCELLATION_STOP_TARGET_REQUIRED')
 issuer=one(rows['identity_principals'],'credential_id',control['issued_by_credential_id']);require(issuer['role'] in ('OPERATOR','COORDINATOR'),'CANCELLATION_STOP_AUTHORITY_REQUIRED')
 require(evidence_time(decision['created_at'])<=evidence_time(event['created_at'])<=evidence_time(control['issued_at'])<=evidence_time(control['reported_at']),'CANCELLATION_ORDER_REQUIRED')
 require(control['state']=='REPORTED' and control['outcome']=='STOPPED' and control['termination']=='CONFIRMED' and control['cleanup_complete'] is True and digest(report)==control['report_digest'] and report.get('outcome')=='STOPPED' and report.get('termination')=='CONFIRMED' and report.get('remaining_descendants')==0 and report.get('cleanup_complete') is True and report.get('cleanup_debt')==[] and isinstance(report.get('credential_revocation'),list) and all(c.get('state') in ('ABSENT','REVOKED') for c in report['credential_revocation']) and DIGEST.fullmatch(report.get('receipt_digest','')),'CANCELLATION_QUIESCENCE_REQUIRED')
 require(launch['result'].get('native',{}).get('state')=='STOPPED','CANCELLATION_TERMINAL_STOP_REQUIRED')
 terminal=[]
 for journal in rows['command_inbox']:
  r=journal.get('result',{});p=r.get('payload',{});data=p.get('data',{})
  if journal['operation']!='runner.launch-event' or journal['state']!='COMPLETED' or r.get('kind')!='launch.terminal' or r.get('launch_id')!=launch['launch_id']:continue
  if journal.get('principal_scope')!='runner:'+control['sandbox_id']+':'+control['boot_id']:continue
  if journal['request_digest']!=digest(p) or p.get('command_id')!=launch['command_id'] or p.get('launch_id')!=launch['launch_id'] or p.get('kind')!='launch.terminal' or p.get('sandbox_id')!=control['sandbox_id'] or p.get('boot_id')!=control['boot_id'] or str(p.get('sandbox_boot_generation'))!=str(control['boot_generation']):continue
  if data.get('state')=='STOPPED' and data.get('stopped_by_command') in (stop_id,operation) and r.get('attempt_id') in (None,attempt['id']) and data.get('agent_session_id')==plan['agent_session_id'] and evidence_time(journal['created_at'])>=evidence_time(event['created_at']):terminal.append(journal)
 require(terminal,'CANCELLATION_CAUSAL_TERMINAL_REQUIRED')
 return control

def fault_driver(name,case,rows,target,evidence_root,capture):
 pin=target.get('fault_drivers',{}).get(name);require(isinstance(pin,dict),'AUTHENTICATED_FAULT_DRIVER_REQUIRED')
 if capture.get('kind')=='hyperfide.authenticated-fault-step':
  require(capture.get('operation_id') in rows.get('authenticated_fault_operations',[]) and capture.get('driver_digest')==pin.get('driver_digest') and capture.get('case')==name and capture.get('run_id')==target['run_id'] and capture.get('authority_epoch')==target['authority_epoch'] and capture.get('source_object_id')==target['accepted_source_object_id'],'AUTHENTICATED_FAULT_JOURNAL_REQUIRED')
  return capture
 job=signed_job(rows,case.get('driver_operation_id'));request=job['plan'].get('request',{});require(request.get('executable_digest')==pin.get('executable_digest') and DIGEST.fullmatch(pin.get('executable_digest','')) and digest(request.get('argv'))==pin.get('argv_digest'),'FAULT_DRIVER_PIN_MISMATCH')
 require(job['result'].get('stdout',{}).get('digest')==case['capture']['digest'] and not case['capture'].get('json_path'),'AUTHENTICATED_DRIVER_CAPTURE_REQUIRED')
 require(capture.get('case')==name and capture.get('run_id')==target['run_id'] and capture.get('authority_epoch')==target['authority_epoch'] and capture.get('source_object_id')==target['accepted_source_object_id'],'FAULT_DRIVER_STAGE_MISMATCH')
 return capture

def captured_case(name,case,target,evidence_root):
 require(isinstance(case,dict),'CASE_ORACLE_REQUIRED')
 ref=case.get('capture');require(isinstance(ref,dict) and evidence_root is not None,'CASE_CAPTURE_REQUIRED')
 relative=Path(ref['path']);require(not relative.is_absolute() and '..' not in relative.parts,'CAPTURE_PATH_REFUSED')
 filename=Path(evidence_root)/relative;require(digest(filename.read_bytes())==ref['digest'] and target.get('case_capture_digests',{}).get(name)==ref['digest'],'CASE_CAPTURE_PIN_MISMATCH')
 capture=private_json(filename)
 for key in ref.get('json_path',[]):require(isinstance(key,str) and isinstance(capture,dict) and key in capture,'CAPTURE_JSON_PATH_REFUSED');capture=capture[key]
 return capture

def evidence_time(value):
 require(isinstance(value,str),'PROVIDER_TERMINATION_TIME_REQUIRED')
 try:parsed=datetime.datetime.fromisoformat(value.replace('Z','+00:00'))
 except ValueError:raise Refused('PROVIDER_TERMINATION_TIME_REQUIRED')
 require(parsed.tzinfo is not None,'PROVIDER_TERMINATION_TIME_REQUIRED');return parsed

def provider_recovery_timeline(before,after,bounds):
 require(evidence_time(before['created_at'])<=bounds['old_measurement'] and bounds['removed']<=evidence_time(after['created_at']) and bounds['new_measurement']<=evidence_time(after['created_at']) and bounds['replacement']<=evidence_time(after['created_at']),'PROVIDER_RECOVERY_OBSERVATION_ORDER_REQUIRED')

def provider_fault_custody(capture,rows,target,evidence_root):
 core=capture.get('physical_proof');require(isinstance(core,dict) and core.get('schema_version')==1 and core.get('kind')=='FLEET_PROVIDER_FAULT_PROOF_V1','PROVIDER_FAULT_CORE_REQUIRED')
 fields=('case','organisation_id','run_id','authority_epoch','source_object_id','before_observation_id','after_observation_id','coding_command_id','launch_id','fault_event_id','fault_observed_at','process_observations')
 require(all(core.get(k)==capture.get(k) for k in fields) and core.get('organisation_id')==target['organisation_id'] and core.get('run_id')==target['run_id'],'PROVIDER_FAULT_CORE_BINDING_REQUIRED')
 try:
  envelope=json.loads(base64.b64decode(capture.get('body_base64',''),validate=True));payload=json.loads(base64.urlsafe_b64decode(envelope['payload_b64']+'='*((-len(envelope['payload_b64']))%4)));input=payload['input'];raw=base64.b64decode(input['data_base64'],validate=True)
 except (ValueError,TypeError,KeyError):raise Refused('SIGNED_PROVIDER_ARTIFACT_REQUEST_REQUIRED')
 require(payload.get('component')=='15.2' and payload.get('action')=='artifact.object.put' and input.get('organisation_id')==target['organisation_id'] and input.get('run_id')==target['run_id'] and raw==canonical(core) and input.get('digest')==digest(raw) and input.get('size_bytes')==str(len(raw)),'SIGNED_PROVIDER_ARTIFACT_REQUEST_REQUIRED')
 result=capture.get('response',{}).get('body',{}).get('result',{});artifact=result.get('artifact',{});matches=[a for a in rows['artifacts'] if a['id']==artifact.get('artifact_id') and a['organisation_id']==target['organisation_id'] and a['run_id']==target['run_id']]
 require(result.get('outcome')=='SUCCEEDED' and result.get('availability')=='VERIFIED' and len(matches)==1 and matches[0]['status']=='COMPLETE' and matches[0].get('completed_at') is not None and matches[0]['storage_backend']=='s3-v1' and matches[0]['digest']==digest(raw) and str(matches[0]['size_bytes'])==str(len(raw)),'COMPLETE_PROVIDER_FAULT_ARTIFACT_REQUIRED')
 proof=core['process_observations'].get('old_process_absence',{});references=[proof.get(k) for k in ('old_measurement','new_measurement','before_provider','after_old_provider','after_new_provider','restart_receipt')];blobs=core.get('evidence_blobs',{})
 require(isinstance(blobs,dict) and all(isinstance(ref,dict) for ref in references) and set(blobs)=={ref.get('path') for ref in references},'PROVIDER_FAULT_CLOSURE_REQUIRED')
 for ref in references:
  relative=Path(ref.get('path',''));require(not relative.is_absolute() and '..' not in relative.parts,'PROVIDER_FAULT_CLOSURE_REQUIRED');filename=Path(evidence_root)/relative;private_json(filename)
  try:blob=base64.b64decode(blobs[ref['path']],validate=True)
  except (ValueError,TypeError,KeyError):raise Refused('PROVIDER_FAULT_CLOSURE_REQUIRED')
  require(blob==filename.read_bytes() and digest(blob)==ref.get('digest'),'PROVIDER_FAULT_CLOSURE_REQUIRED')
 return matches[0]

def railway_instance_absence(physical,capture,target,evidence_root,name='supervisor_box_loss'):
 """Exact provider REMOVED proves loss of the old container namespace, which a replacement cannot probe with kill(0).
 A restart ACK, changed PID or missing list entry is insufficient. Read time is an upper bound, never a termination timestamp.
 Physical event identity may be shared by explicit supervisor and manager cases; this does not claim separate failures.
 """
 proof=physical.get('old_process_absence',{});pin=target.get('fault_drivers',{}).get(name,{});scope=pin.get('provider_scope',{})
 require(proof.get('kind')=='RAILWAY_INSTANCE_TERMINATION_V1' and scope.get('provider')=='railway' and all(isinstance(scope.get(k),str) and scope[k] for k in ('project_id','environment_id','service_id','api_origin')),'PROVIDER_TERMINATION_SCOPE_REQUIRED')
 require(scope['api_origin'] in ('https://backboard.railway.app','https://backboard.railway.com') and DIGEST.fullmatch(pin.get('provider_collector_digest','')),'PROVIDER_TERMINATION_COLLECTOR_REQUIRED')
 require(set(proof)=={'kind','identity','old_measurement','new_measurement','before_provider','after_old_provider','after_new_provider','restart_receipt'},'PROVIDER_TERMINATION_FIELDS_REQUIRED')
 def evidence(ref):
  require(isinstance(ref,dict) and DIGEST.fullmatch(ref.get('digest','')),'PROVIDER_TERMINATION_EVIDENCE_REQUIRED')
  relative=Path(ref.get('path',''));require(not relative.is_absolute() and '..' not in relative.parts and str(relative) not in ('','.'),'PROVIDER_TERMINATION_PATH_REFUSED')
  filename=Path(evidence_root)/relative;record=private_json(filename);require(digest(filename.read_bytes())==ref['digest'] and isinstance(record,dict),'PROVIDER_TERMINATION_DIGEST_MISMATCH');return record
 clock=evidence_time
 def measured(ref):
  record=evidence(ref);body=record.get('body',{});require(isinstance(body,dict),'ACTUAL_MAIN_IDENTITY_REQUIRED');process=body.get('process',{});require(isinstance(process,dict),'ACTUAL_MAIN_IDENTITY_REQUIRED')
  require(record.get('exit_code')==0 and isinstance(process.get('pid'),int) and process['pid']>0 and isinstance(process.get('start_time_ticks'),str) and process['start_time_ticks'].isdigit() and process.get('uid')==scope.get('main_uid') and isinstance(scope.get('main_uid'),int) and scope['main_uid']>0,'ACTUAL_MAIN_IDENTITY_REQUIRED')
  require(all(isinstance(body.get(k),str) and body[k] for k in ('kernel_boot_id','railway_replica_id','railway_deployment_id','observed_at')),'ACTUAL_MAIN_IDENTITY_REQUIRED')
  return {**process,**{k:body[k] for k in ('kernel_boot_id','railway_replica_id','railway_deployment_id','observed_at')}}
 old=measured(proof.get('old_measurement'));new=measured(proof.get('new_measurement'))
 require(physical.get('old_identity')==old and physical.get('new_identity')==new and proof.get('identity')==old and old['railway_replica_id']!=new['railway_replica_id'],'PROVIDER_TERMINATION_IDENTITY_MISMATCH')
 def provider(ref,identity,status):
  record=evidence(ref);response=record.get('response',{});request=record.get('request',{})
  require(record.get('schema_version')==1 and record.get('kind')=='RAILWAY_DEPLOYMENT_INSTANCE_OBSERVATION_V1' and record.get('driver_digest')==pin['provider_collector_digest'] and record.get('origin')==scope['api_origin'] and request.get('variables')=={'id':identity['railway_deployment_id']} and isinstance(request.get('query'),str) and request['query'].lstrip().startswith('query') and response.get('http_status')==200,'AUTHENTICATED_PROVIDER_INSTANCE_READ_REQUIRED')
  try:raw=base64.b64decode(response.get('body_base64',''),validate=True);body=json.loads(raw)
  except (ValueError,TypeError):raise Refused('PROVIDER_RESPONSE_CUSTODY_MISMATCH')
  require(raw and isinstance(body,dict) and digest(raw)==response.get('body_digest') and body==response.get('body') and not body.get('errors'),'PROVIDER_RESPONSE_CUSTODY_MISMATCH')
  require(isinstance(body,dict) and isinstance(body.get('data'),dict),'PROVIDER_RESPONSE_CUSTODY_MISMATCH');deployment=body['data'].get('deployment',{});require(isinstance(deployment,dict),'PROVIDER_RESPONSE_CUSTODY_MISMATCH')
  require(deployment.get('id')==identity['railway_deployment_id'] and deployment.get('projectId')==scope['project_id'] and deployment.get('environmentId')==scope['environment_id'] and deployment.get('serviceId')==scope['service_id'],'PROVIDER_INSTANCE_SCOPE_MISMATCH')
  instances=deployment.get('instances');require(isinstance(instances,list) and all(isinstance(item,dict) for item in instances),'EXACT_PROVIDER_INSTANCE_STATE_REQUIRED');matches=[item for item in instances if item.get('id')==identity['railway_replica_id']]
  require(len(matches)==1 and matches[0].get('status')==status,'EXACT_PROVIDER_INSTANCE_STATE_REQUIRED');return clock(record.get('observed_at'))
 before=provider(proof.get('before_provider'),old,'RUNNING');removed=provider(proof.get('after_old_provider'),old,'REMOVED');replacement=provider(proof.get('after_new_provider'),new,'RUNNING')
 restart=evidence(proof.get('restart_receipt'));requested=clock(restart.get('requested_at'))
 require(restart.get('schema_version')==1 and restart.get('action')=='railway.deployment.restart' and restart.get('state')=='ACKNOWLEDGED' and restart.get('exit_code')==0 and restart.get('launch_id')==capture.get('launch_id') and isinstance(restart.get('local_operation_id'),str) and restart.get('local_operation_id')==capture.get('fault_event_id') and restart.get('scope')=={k:scope[k] for k in ('project_id','environment_id','service_id')},'BOUND_PROVIDER_RESTART_REQUIRED')
 require(clock(old['observed_at'])<=before<requested<=removed and requested<=clock(new['observed_at'])<=replacement and clock(capture.get('fault_observed_at'))==removed,'PROVIDER_TERMINATION_ORDER_REQUIRED')
 return {'old_measurement':clock(old['observed_at']),'removed':removed,'new_measurement':clock(new['observed_at']),'replacement':replacement}

def verified_model_failure_request(rows,pin,request,response,outer_operation_id):
 reason=one(rows['fleet_reasoning'],'id',pin.get('reasoning_id'));binding=request.get('binding',{});profile=reason.get('result',{}).get('model_profile',{});original=one(rows['fleet_observations'],'id',pin.get('observation_id'));observed=one(rows['fleet_observations'],'id',reason['observation_id']);ids=request.get('context_observation_ids',[request.get('observation_id')])
 require(request.get('operation_id')==reason['id']==pin.get('reasoning_id') and request.get('observation_id')==pin.get('observation_id') and binding.get('actor_id')==reason['actor_id']==pin.get('actor_id') and digest(request)==reason.get('request_digest') and original['actor_id']==reason['actor_id'] and original['body']['binding']==binding and digest(original['body'])==original['context_digest'] and observed['actor_id']==reason['actor_id'] and observed['body']['binding']==binding and str(observed['cohort_generation'])==str(original['cohort_generation']) and observed['body']['source_revision']==original['body']['source_revision'] and digest(observed['body'])==observed['context_digest'] and (observed['id']==original['id'] if len(ids)==1 else observed['body'].get('context_observation_ids')==ids),'MODEL_FAILURE_REQUEST_BINDING_REQUIRED')
 require(reason['state']=='WAITING_FOR_MANAGER' and reason['reason']==pin.get('expected_reason') and (re.fullmatch(r'FLEET_GATEWAY_HTTP_[45][0-9]{2}',reason['reason']) or reason['reason']=='FLEET_GATEWAY_OUTCOME_UNKNOWN') and profile.get('backend')=='gateway' and digest(profile)==pin.get('model_profile_digest'),'ACTUAL_MODEL_TRANSPORT_FAILURE_REQUIRED')
 require(not any(d['reasoning_id']==reason['id'] for d in rows['fleet_decisions']) and not any(e['operation_id'] in (reason['id'],outer_operation_id) for e in rows['fleet_effect_receipts']) and not any(j['operation_id'] in (reason['id'],outer_operation_id) for j in rows['runner_remote_jobs']) and not any(p['id'] in (reason['id'],outer_operation_id) for p in rows['provider_remote_operations']),'MODEL_FAILURE_EFFECT_PRESENT')
 require(response.get('ok') is True,'ACTUAL_MODEL_WAIT_RESPONSE_REQUIRED');unavailable_model_response(response,reason,[pin['expected_reason']]);return reason

def verified_stale_generation(rows,case,target,response):
 pin=target.get('fault_drivers',{}).get('stale_generation_replay',{});kind=pin.get('generation_kind','PLAN');actor=one(rows['fleet_actor_sessions'],'session_id',case.get('actor_id'))
 require(kind in ('PLAN','COHORT') and case.get('generation_kind','PLAN')==kind and case.get('actor_id')==pin.get('actor_id') and str(case.get('replayed_plan_generation'))==str(pin.get('replayed_plan_generation')),'STALE_GENERATION_SCOPE_REQUIRED')
 if kind=='PLAN':
  require(response.get('error',{}).get('code')=='FLEET_PLAN_STALE' and int(actor['plan_generation'])>int(case['replayed_plan_generation']),'STALE_PLAN_PROOF_REQUIRED')
 else:
  decision=one(rows['fleet_decisions'],'id',pin.get('decision_id'));reasoning=one(rows['fleet_reasoning'],'id',decision['reasoning_id']);observation=one(rows['fleet_observations'],'id',pin.get('original_observation_id'));cohort=one(rows['fleet_cohorts'],'id',actor['cohort_id'])
  require(response.get('error',{}).get('code')=='FLEET_OBSERVATION_STALE' and reasoning['observation_id']==observation['id'] and observation['actor_id']==actor['session_id']==pin['actor_id'] and digest(observation['body'])==observation['context_digest']==decision['body']['context_digest'] and str(observation['cohort_generation'])==str(pin.get('replayed_cohort_generation')) and int(cohort['cohort_generation'])>int(observation['cohort_generation']) and int(cohort['cohort_generation'])>=int(pin['minimum_current_cohort_generation']) and str(actor['cohort_generation'])==str(cohort['cohort_generation']),'STALE_COHORT_PROOF_REQUIRED')

def case_oracle(name,case,rows,target,evidence_root,index):
 capture=captured_case(name,case,target,evidence_root)
 # Captures retain fault provenance; authoritative effects and native outcomes come from PostgreSQL.
 if name in ('fresh_install','repeated_install','interrupted_install','concurrent_isolation','interface_subset','fetch_volume'):
  operations=case.get('install_operation_ids');require(isinstance(operations,list) and operations and len(set(operations))==len(operations),'INSTALL_CASE_OPERATIONS_REQUIRED')
  installs=[one(rows['fleet_environment_installs'],'operation_id',op) for op in operations]
  require(all(i['state']=='READY' and i['authority_epoch']==target['authority_epoch'] for i in installs),'INSTALL_CASE_READY_REQUIRED')
  require(index['install_operation_id'] in operations,'CASE_INSTALL_STAGE_MISMATCH')
  for i in installs:native_role(rows,signed_install(rows,i),'install',target)
  if name=='repeated_install':
   require(len(installs)==1,'REPEATED_INSTALL_SAME_OPERATION_REQUIRED');verified_install_replay(rows,installs[0],case,target,capture)
  if name=='concurrent_isolation':
   require(len(installs)>=2 and len({(i['sandbox_id'],i['boot_id']) for i in installs})==len(installs),'DISTINCT_INSTALL_SANDBOXES_REQUIRED')
   jobs=[signed_install(rows,i) for i in installs];require(max(j['result']['started_at'] for j in jobs)<min(j['result']['ended_at'] for j in jobs),'ACTUAL_INSTALL_OVERLAP_REQUIRED')
   for i,j in zip(installs,jobs):
    native=native_capture(rows,j['operation_id'],one(case.get('native_receipts',[]),'operation_id',j['operation_id']),evidence_root,'native_receipt');isolation=native.get('fleet_isolation',{})
    require(isolation.get('status')=='ENFORCED' and isolation.get('method')=='UNIX_UID_GID' and isolation.get('operation_id')==i['operation_id'] and isolation.get('prepared_receipt_digest')==i['receipt_digest'] and isolation.get('slots')==i['admission'].get('slot_bindings'),'NATIVE_WRITABLE_ISOLATION_REQUIRED')
  if name=='interrupted_install':
   interrupted=one(rows['runner_remote_jobs'],'operation_id',case.get('interrupted_operation_id'));require(interrupted.get('signature_verified') is True and interrupted['state']=='COMPLETED' and interrupted['result'].get('outcome')=='FAILED' and digest(interrupted['result'])==interrupted['result_digest'] and digest(interrupted['plan'])==interrupted['plan_digest'],'SIGNED_INTERRUPTED_INSTALL_REQUIRED')
   if case.get('producer_mode')=='OPERATOR_PROVIDER_EXEC':verified_install_interruption(rows,installs[-1],case,target,capture,evidence_root)
   else:
    fault_driver(name,case,rows,target,evidence_root,capture)
    verified_interrupted_install_capture(rows,installs[-1],case,capture)
  require(isinstance(capture,dict) and (name in ('interrupted_install','repeated_install') or any(capture==i['receipt'] and capture.get('operation_id')==i['operation_id'] for i in installs)),'INSTALL_CAPTURE_OPERATION_MISMATCH')
  if name=='interface_subset':
   for i in installs:
    spec=one(rows['fleet_environment_specs'],'input_digest',i['input_digest']);require(i['receipt'].get('interfaces',{}).get('selected_ids')==spec['package_spec']['interfaces']['selected_ids'] and i['receipt']['interfaces']['fragment_digest']==target['interface_digest'],'EXACT_INTERFACE_SUBSET_REQUIRED')
  if name=='fetch_volume':
   for i in installs:verified_install_transfer(rows,i,case,target,evidence_root)
 elif name in ('missing_code','missing_dependencies','missing_configuration','stale_install','path_escape','constraint_refusal','stale_generation_replay'):
  fault_driver(name,case,rows,target,evidence_root,capture)
  body=capture.get('response',{}).get('body',{});operation=case.get('operation_id')
  require(body.get('operation_id')==operation and body.get('ok') is False and body.get('error',{}).get('code') in target.get('case_error_codes',{}).get(name,[]),'ACTUAL_EXPECTED_REFUSAL_REQUIRED')
  require(not any(e['operation_id']==operation for e in rows['fleet_effect_receipts']) and not any(j['operation_id']==operation for j in rows['runner_remote_jobs']),'REFUSED_OPERATION_EFFECT_PRESENT')
  if name=='stale_generation_replay':
   verified_stale_generation(rows,case,target,body)
 elif name in ('supervisor_box_loss','manager_replacement'):
  fault_driver(name,case,rows,target,evidence_root,capture)
  before=one(rows['fleet_observations'],'id',case.get('before_observation_id'));after=one(rows['fleet_observations'],'id',case.get('after_observation_id'))
  require(digest(before['body'])==before['context_digest'] and digest(after['body'])==after['context_digest'] and before['created_at']<after['created_at'],'IMMUTABLE_RECOVERY_OBSERVATIONS_REQUIRED')
  old_binding=before['body'].get('binding',{});new_binding=after['body'].get('binding',{})
  if name=='supervisor_box_loss':require(int(after['cohort_generation'])>int(before['cohort_generation']),'RECOVERED_COHORT_FENCE_REQUIRED')
  else:require(old_binding.get('delegation_id')==new_binding.get('delegation_id') and int(new_binding['manager_generation'])>int(old_binding['manager_generation']),'RECOVERED_MANAGER_FENCE_REQUIRED')
  physical=capture.get('process_observations',{});old=physical.get('old_identity',{});new=physical.get('new_identity',{})
  require(old and new and old!=new and old.get('kernel_boot_id') and new.get('kernel_boot_id'),'PHYSICAL_OLD_PROCESS_ABSENCE_REQUIRED')
  if physical.get('old_process_absence',{}).get('kind')=='RAILWAY_INSTANCE_TERMINATION_V1':
   provider_fault_custody(capture,rows,target,evidence_root);bounds=railway_instance_absence(physical,capture,target,evidence_root,name);provider_recovery_timeline(before,after,bounds)
  else:require(physical.get('old_process_absence',{}).get('errno')=='ESRCH' and physical['old_process_absence'].get('identity')==old,'PHYSICAL_OLD_PROCESS_ABSENCE_REQUIRED')
  decisions=[d for d in rows['fleet_decisions'] if d['actor_id']==after['actor_id'] and one(rows['fleet_reasoning'],'id',d['reasoning_id'])['observation_id']==after['id']]
  require(any(any(e['decision_id']==d['id'] for e in rows['fleet_effect_receipts']) for d in decisions),'RECOVERED_MODEL_EFFECT_REQUIRED')
  if name=='supervisor_box_loss':
   coding=one(rows['fleet_worker_launches'],'command_id',case.get('coding_command_id'));require(coding['command_id']==index['coding_command_id'] and coding['created_at']<capture['fault_observed_at']<coding['completed_at'],'BOX_LOSS_DURING_CODING_REQUIRED')
  require(capture.get('before_observation_id')==before['id'] and capture.get('after_observation_id')==after['id'],'RECOVERY_CAPTURE_BINDING_REQUIRED')
  for effect in rows['fleet_effect_receipts']:
   if effect['created_at']<=after['created_at']:continue
   decision=one(rows['fleet_decisions'],'id',effect['decision_id']);observation=one(rows['fleet_observations'],'id',one(rows['fleet_reasoning'],'id',decision['reasoning_id'])['observation_id'])
   require(int(observation['cohort_generation'])>=int(after['cohort_generation']),'OLD_COHORT_EFFECT_AFTER_RECOVERY')
 elif name=='ambiguous_provider_outcome':
  intent=one(rows['provisioning_intents'],'id',case.get('intent_id'));observations=[o for o in rows['provider_observations'] if o['intent_id']==intent['id']]
  require(any(o['observation'].get('outcome',{}).get('status')=='UNKNOWN' for o in observations),'ACTUAL_PROVIDER_AMBIGUITY_REQUIRED')
  links=[r['reservation_id'] for r in rows['provisioning_intent_reservations'] if r['intent_id']==intent['id']];require(links,'AMBIGUITY_RESERVATIONS_REQUIRED')
  same_boot=[i for i in rows['provisioning_intents'] if i['sandbox_id']==intent['sandbox_id'] and i['native_sandbox_id']==intent['native_sandbox_id'] and str(i['boot_generation'])==str(intent['boot_generation']) and i['state']=='TERMINAL']
  absence=[]
  for o in rows['provider_observations']:
   outcome=o['observation'].get('outcome',{});resource=outcome.get('resource',{});result=outcome.get('result',{})
   if intent['state']=='TERMINAL' and o['intent_id'] in {i['id'] for i in same_boot} and o['observation'].get('operation',{}).get('kind')=='observe' and outcome.get('status')=='SUCCEEDED' and outcome.get('acceptance')=='CONFIRMED_ACCEPTED' and result.get('provider_state')=='DESTROYED' and result.get('health')=='ABSENT' and resource.get('native_sandbox_id')==intent['native_sandbox_id'] and str(resource.get('sandbox_boot_generation'))==str(intent['boot_generation']):absence.append(o)
  for rid in links:
   reservation=one(rows['reservations'],'id',rid)
   require(reservation['state'] in ('HELD','RELEASE_PENDING') or reservation['state']=='RELEASED' and any(str(o['observed_at'])<=str(reservation['released_at']) for o in absence),'AMBIGUOUS_CAPACITY_RELEASED_WITHOUT_ABSENCE')
 elif name=='model_unavailability':
  fault_driver(name,case,rows,target,evidence_root,capture)
  if capture.get('kind')=='hyperfide.authenticated-fault-step':
   try:wire=json.loads(base64.b64decode(capture['body_base64'],validate=True));payload=json.loads(base64.urlsafe_b64decode(wire['payload_b64']+'='*((-len(wire['payload_b64']))%4)))
   except (ValueError,TypeError,KeyError):raise Refused('MODEL_FAILURE_REQUEST_REQUIRED')
   pin=target.get('fault_drivers',{}).get(name,{});require(case.get('operation_id')==capture.get('operation_id') and case.get('reasoning_id')==pin.get('reasoning_id') and payload.get('component')=='fleet-orchestration' and payload.get('action')=='fleet.session.reason','MODEL_FAILURE_REQUEST_REQUIRED');verified_model_failure_request(rows,pin,payload['input'],capture.get('response',{}).get('body',{}),capture['operation_id'])
  else:
   reason=one(rows['fleet_reasoning'],'id',case.get('reasoning_id'));require(reason['state']=='WAITING_FOR_MANAGER' and (re.fullmatch(r'FLEET_GATEWAY_HTTP_[45][0-9]{2}',reason.get('reason','')) or reason.get('reason')=='FLEET_GATEWAY_OUTCOME_UNKNOWN') and not any(d['reasoning_id']==reason['id'] for d in rows['fleet_decisions']),'UNAVAILABLE_MODEL_FALLBACK_EFFECT')
   unavailable_model_response(capture.get('response',{}).get('body',{}),reason,target.get('case_error_codes',{}).get(name,[]))
 elif name in ('failed_worker','worker_cancellation'):
  launch=one(rows['fleet_worker_launches'],'command_id',case.get('command_id'));require(capture==launch['result'],'CASE_FAILED_WORKER_CAPTURE_MISMATCH');require(launch.get('signature_verified') is True and launch['result_digest']==digest(launch['result']),'SIGNED_FAILED_WORKER_RESULT_REQUIRED')
  native=launch['result'].get('native',{});require(native.get('terminal_observed') is True and (native.get('exit_code') not in (None,0) or native.get('state') in ('STOPPED','LEASE_EXPIRED')),'CONFIRMED_WORKER_FAILURE_REQUIRED')
  attempt=one(rows['attempts'],'id',one(rows['native_launch_plans'],'command_id',launch['command_id'])['attempt_id']);require(attempt['compute_authority']=='RELEASED','FAILED_WORKER_CAPACITY_HELD');coding=one(rows['native_launch_plans'],'command_id',index['coding_command_id']);coding_attempt=one(rows['attempts'],'id',coding['attempt_id']);require(attempt['task_id']==coding_attempt['task_id'],'WORKER_FAILURE_TASK_MISMATCH')
  if name=='worker_cancellation':verified_worker_cancellation(rows,launch,case)
 elif name in ('co_located_models','model_delegation'):
  selected=case.get('decision_ids');require(isinstance(selected,list) and selected,'CASE_MODEL_DECISIONS_REQUIRED')
  for decision_id in selected:
   decision=one(rows['fleet_decisions'],'id',decision_id);require(decision['actor_id'] in [index['actors']['primary'],*index['actors']['managers']] and any(e['decision_id']==decision_id for e in rows['fleet_effect_receipts']),'CASE_MODEL_STAGE_MISMATCH')
  require(isinstance(capture,list) and capture==[one(rows['fleet_decisions'],'id',d)['body'] for d in selected],'CASE_MODEL_CAPTURE_MISMATCH')
  if name=='co_located_models':require({one(rows['fleet_decisions'],'id',d)['actor_id'] for d in selected}=={index['actors']['primary'],*index['actors']['managers']},'ALL_ACTORS_MODEL_CASE_REQUIRED')
  if name=='model_delegation':require(any(one(rows['fleet_decisions'],'id',d)['action']=='DELEGATE_WAVE' for d in selected),'ACTUAL_DELEGATION_CASE_REQUIRED')
 elif name=='model_replan':
  effect=one(rows['fleet_effect_receipts'],'operation_id',case.get('operation_id'));decision=one(rows['fleet_decisions'],'id',effect['decision_id']);result=effect['result']
  require(decision['action']=='REPLAN' and decision['actor_id']==index['actors']['primary'] and capture==effect['result'],'CASE_REPLAN_STAGE_MISMATCH')
  if result.get('proposal_kind')=='UPDATE_DELEGATION_BUDGET':
   require(result.get('old_budget_digest')!=result.get('new_budget_digest') and digest(result.get('old_budget'))==result.get('old_budget_digest') and digest(result.get('new_budget'))==result.get('new_budget_digest') and int(result['manager_plan_generation'])>int(result['previous_manager_plan_generation']) and result.get('added_profile_ids'),'APPLIED_PROFILE_REPLAN_REQUIRED')
   require(any(e['kind']=='DELEGATION_BUDGET_REPLANNED' and e['payload'].get('decision_id')==decision['id'] and e['payload'].get('new_budget_digest')==result['new_budget_digest'] for e in rows['hierarchy_ownership_events']),'IMMUTABLE_PROFILE_REPLAN_AUDIT_REQUIRED')
  else:require(result.get('admission',{}).get('decision')=='ACCEPTED' and result.get('task_definitions_changed') is True,'APPLIED_VERSIONED_REPLAN_REQUIRED')
 elif name=='provider_creation':
  require(case.get('intent_id')==index['provider_intent_id'],'CASE_PROVIDER_STAGE_MISMATCH');observation=one(rows['provider_observations'],'id',case.get('observation_id'));require(observation['intent_id']==case['intent_id'] and observation['observation']==capture,'CASE_PROVIDER_CAPTURE_MISMATCH')
 elif name=='coding_worker':
  require(case.get('command_id')==index['coding_command_id'],'CASE_CODING_STAGE_MISMATCH');launch=one(rows['fleet_worker_launches'],'command_id',case['command_id']);require(capture==launch['result'] and digest(capture)==launch['result_digest'],'CASE_CODING_CAPTURE_MISMATCH')
 elif name=='independent_test':
  if target.get('source_backend')=='native':
   require(case.get('native_qualification_id')==index['native_qualification_id'],'CASE_NATIVE_TEST_STAGE_MISMATCH');qualification=one(rows['source_fleet_qualifications'],'qualification_id',case['native_qualification_id']);require(capture==qualification['receipt'] and digest({k:v for k,v in capture.items() if k!='qualification_id'})==qualification['qualification_id'],'CASE_NATIVE_TEST_CAPTURE_MISMATCH')
  else:
   require(case.get('job_id')==index['independent_test_job_id'],'CASE_TEST_STAGE_MISMATCH');job=one(rows['qualification_jobs'],'id',case['job_id']);receipt=one([r for r in rows['assurance_job_receipts'] if str(r['lease_generation'])==str(job['lease_generation'])],'job_id',job['id']);require(capture==receipt['receipt'] and digest(capture)==receipt['receipt_digest'],'CASE_TEST_CAPTURE_MISMATCH')
 else:raise Refused('CASE_ORACLE_UNSUPPORTED')

def verified_contract_status_derivation(declaration,pin,current,evidence_root):
 if isinstance(declaration,dict) and declaration.get('schema_version')==2:
  require(type(declaration['schema_version']) is int and set(declaration)=={'schema_version','path','baseline','mode'} and declaration['mode']=='kvx-existing-status-values-v1' and declaration['path']==pin.get('path')=='spec/hyperfide-source-control/spec.kvx','STATUS_DERIVATION_SCOPE_REQUIRED')
  require(isinstance(current,bytes) and 0<len(current)<=4*1024*1024,'STATUS_CURRENT_BUDGET')
  archive=declaration['baseline'];require(isinstance(archive,dict) and set(archive)=={'path','digest'} and archive['digest']==pin.get('digest') and DIGEST.fullmatch(archive['digest']),'STATUS_BASELINE_PIN_MISMATCH')
  relative=Path(archive['path']);require(evidence_root is not None and not relative.is_absolute() and '..' not in relative.parts and str(relative)==archive['path'],'STATUS_BASELINE_PATH_REQUIRED')
  filename=Path(evidence_root)/relative;require(filename.resolve()==filename.absolute() and filename.resolve().is_relative_to(Path(evidence_root).resolve()) and filename.resolve()!=(ROOT/declaration['path']).resolve(),'STATUS_BASELINE_PATH_REQUIRED')
  fd=os.open(filename,os.O_RDONLY|os.O_NOFOLLOW)
  try:
   before=os.fstat(fd);require(stat.S_ISREG(before.st_mode) and before.st_uid==os.getuid() and before.st_mode&0o077==0 and before.st_nlink==1 and 0<before.st_size<=4*1024*1024,'PRIVATE_STATUS_BASELINE_REQUIRED')
   chunks=[];size=0
   while True:
    chunk=os.read(fd,min(65536,4*1024*1024+1-size))
    if not chunk:break
    size+=len(chunk);require(size<=4*1024*1024,'STATUS_BASELINE_BUDGET');chunks.append(chunk)
   baseline=b''.join(chunks);after=os.fstat(fd)
   require((before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns) and size==before.st_size and digest(baseline)==pin['digest'],'STATUS_BASELINE_PIN_MISMATCH')
  finally:os.close(fd)
  import importlib.util
  module=importlib.util.spec_from_file_location('fleet_status_contract',ROOT/'tests/hyperfide/qualify.py');qualifier=importlib.util.module_from_spec(module);module.loader.exec_module(qualifier)
  try:equivalent=qualifier.status_projection(baseline)==qualifier.status_projection(current)
  except (qualifier.GateError,UnicodeError):equivalent=False
  require(equivalent,'STATUS_ONLY_CONTRACT_DERIVATION_MISMATCH')
  return {'schema_version':2,'kind':'SPEC_STATUS_ONLY_DERIVATION_V2','path':declaration['path'],'mode':declaration['mode'],'baseline':archive,'baseline_digest':pin['digest'],'current_digest':digest(current)}
 path='spec/hyperfide-source-control/spec.kvx';order=['0.10','0.11','0.12','0.13','0.14']
 require(isinstance(current,bytes) and 0<len(current)<=4*1024*1024,'STATUS_CURRENT_BUDGET')
 require(isinstance(declaration,dict) and set(declaration)=={'schema_version','path','baseline','allowed_transitions'} and type(declaration['schema_version']) is int and declaration['schema_version']==1 and declaration['path']==pin.get('path')==path,'STATUS_DERIVATION_SCOPE_REQUIRED')
 archive=declaration['baseline'];allowed=declaration['allowed_transitions']
 require(isinstance(archive,dict) and set(archive)=={'path','digest'} and archive['digest']==pin['digest'] and DIGEST.fullmatch(archive['digest']) and isinstance(allowed,list) and 1<=len(allowed)<=5 and allowed==[{'task':t,'from':'in_progress','to':'done'} for t in order[:len(allowed)]],'STATUS_DERIVATION_DECLARATION_REQUIRED')
 relative=Path(archive['path']);require(evidence_root is not None and not relative.is_absolute() and '..' not in relative.parts and str(relative)==archive['path'],'STATUS_BASELINE_PATH_REQUIRED')
 filename=Path(evidence_root)/relative;require(filename.resolve()==filename.absolute() and filename.resolve().is_relative_to(Path(evidence_root).resolve()) and filename.resolve()!=(ROOT/path).resolve(),'STATUS_BASELINE_PATH_REQUIRED')
 fd=os.open(filename,os.O_RDONLY|os.O_NOFOLLOW)
 try:
  before=os.fstat(fd);require(stat.S_ISREG(before.st_mode) and before.st_uid==os.getuid() and before.st_mode&0o077==0 and before.st_nlink==1 and 0<before.st_size<=4*1024*1024,'PRIVATE_STATUS_BASELINE_REQUIRED')
  parts=[];total=0
  while True:
   chunk=os.read(fd,min(65536,4*1024*1024+1-total))
   if not chunk:break
   total+=len(chunk);require(total<=4*1024*1024,'STATUS_BASELINE_BUDGET');parts.append(chunk)
  baseline=b''.join(parts);after=os.fstat(fd)
  require((before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns) and len(baseline)==before.st_size and digest(baseline)==pin['digest'],'STATUS_BASELINE_PIN_MISMATCH')
 finally:os.close(fd)
 lines=baseline.splitlines(keepends=True);positions=[]
 for transition in allowed:
  heading=('[task.'+transition['task']+']').encode();starts=[n for n,line in enumerate(lines) if line.removesuffix(b'\n')==heading];require(len(starts)==1,'STATUS_BASELINE_SECTION_REQUIRED')
  candidates=[]
  for n in range(starts[0]+1,len(lines)):
   if lines[n].startswith(b'['):break
   if re.match(br'^status[ \t]*=',lines[n]):candidates.append(n)
  require(len(candidates)==1,'STATUS_BASELINE_SECTION_REQUIRED');n=candidates[0];require(lines[n] in (b'status = "in_progress"\n',b'status = "in_progress"'),'STATUS_BASELINE_CANONICAL_REQUIRED');positions.append(n)
 for count in range(len(allowed)+1):
  derived=list(lines)
  for n in positions[:count]:derived[n]=b'status = "done"'+(b'\n' if lines[n].endswith(b'\n') else b'')
  if b''.join(derived)==current:
   return {'schema_version':1,'kind':'SPEC_STATUS_ONLY_DERIVATION_V1','path':path,'baseline':archive,'baseline_digest':pin['digest'],'current_digest':digest(current),'allowed_transitions_digest':digest(allowed),'transitions':[{**t,'line':n+1} for t,n in zip(allowed[:count],positions[:count])]}
 raise Refused('STATUS_ONLY_CONTRACT_DERIVATION_MISMATCH')

def verify(task,index,target,evidence_root=None):
 require(isinstance(index,dict) and isinstance(target,dict),'LIVE_EVIDENCE_OBJECT_REQUIRED')
 require(target.get('source_backend','git') in ('git','native'),'SOURCE_BACKEND_REQUIRED')
 require(index.get('schema_version')==1 and index.get('kind')=='hyperfide.fleet-live-evidence' and index.get('target_digest')==digest(target),'EVIDENCE_TARGET_MISMATCH')
 cases=index.get('cases',{});required=TASK_CASES[task];require(isinstance(cases,dict) and all(name in cases for name in required),'REQUIRED_LIVE_CASES_MISSING')
 require(target.get('schema_version')==1 and re.fullmatch(r'[A-Z][A-Z0-9_]*',target.get('database_url_env','')) and str(target.get('system_identifier','')).isdigit(),'TRUSTED_DATABASE_TARGET_REQUIRED')
 for key in ('organisation_id','run_id','authority_epoch','repository_id'):require(re.fullmatch(r'[0-9a-f-]{36}',target.get(key,'')) is not None,'TARGET_SCOPE_REQUIRED')
 for key in ('accepted_source_object_id','installed_source_tree_id'):require((OID.fullmatch(target.get(key,'')) is not None or target.get('source_backend')=='native' and DIGEST.fullmatch(target.get(key,'')) is not None),'SOURCE_PINS_REQUIRED')
 if target.get('source_backend')=='native':require(all(DIGEST.fullmatch(target.get(k,'')) is not None for k in ('native_source_revision_id','native_source_root_tree_id')) and re.fullmatch(r'[0-9a-f-]{36}',target.get('security_domain_id','')) is not None,'EXACT_NATIVE_SOURCE_PINS_REQUIRED')
 require(DIGEST.fullmatch(target.get('input_digest','')) is not None and DIGEST.fullmatch(target.get('interface_digest','')) is not None,'INSTALL_PINS_REQUIRED')
 pins=target.get('contract_files');require(isinstance(pins,list) and {'contracts/fleet/index.mjs','spec/hyperfide-source-control/spec.kvx'}.issubset({p.get('path') for p in pins if isinstance(p,dict)}),'CONTRACT_PINS_REQUIRED')
 require(len({p.get('path') for p in pins})==len(pins),'CONTRACT_PINS_REQUIRED')
 derivations=[];declaration=target.get('contract_status_derivation')
 if declaration is not None:require(isinstance(declaration,dict) and declaration.get('path')=='spec/hyperfide-source-control/spec.kvx','STATUS_DERIVATION_SCOPE_REQUIRED')
 for pin in pins:
  relative=Path(pin['path']);require(not relative.is_absolute() and '..' not in relative.parts,'CONTRACT_PATH_REFUSED');file=ROOT/relative;require(file.resolve().is_relative_to(ROOT),'CONTRACT_PATH_REFUSED');current=file.read_bytes()
  if declaration is not None and pin['path']==declaration['path']:derivations.append(verified_contract_status_derivation(declaration,pin,current,evidence_root))
  else:require(digest(current)==pin['digest'],'CONTRACT_PIN_MISMATCH')
 require(isinstance(target.get('toolchains'),list) and target['toolchains'],'TOOLCHAIN_PINS_REQUIRED')
 role_pins=target.get('native_binary_pins');require(isinstance(role_pins,dict) and all(DIGEST.fullmatch(role_pins.get(role,'')) for role in ('install','coding','test')),'ROLE_NATIVE_PINS_REQUIRED')
 connector=None
 if any(name in required for name in WORKER_CASES):
  ref=index.get('connector_receipt');require(isinstance(ref,dict) and evidence_root is not None,'CONNECTOR_RECEIPT_REQUIRED');relative=Path(ref['path']);require(not relative.is_absolute() and '..' not in relative.parts,'CAPTURE_PATH_REFUSED');filename=Path(evidence_root)/relative;require(digest(filename.read_bytes())==ref['digest'],'CAPTURE_DIGEST_MISMATCH');connector=private_json(filename)
  for key in ref.get('json_path',[]):require(isinstance(key,str) and isinstance(connector,dict) and key in connector,'CAPTURE_JSON_PATH_REFUSED');connector=connector[key]
  require(isinstance(connector,dict) and connector.get('schema_version')==1 and isinstance(connector.get('payload'),str) and re.fullmatch(r'[0-9a-f]{128}',connector.get('signature','')) is not None and re.fullmatch(r'[0-9a-f]{64}',target.get('connector_public_key_hex','')) is not None,'SIGNED_CONNECTOR_RECEIPT_REQUIRED')
 journals=[]
 for name in required:
  case=cases[name]
  if isinstance(case,dict) and isinstance(case.get('capture'),dict):
   capture=captured_case(name,case,target,evidence_root)
   if isinstance(capture,dict) and capture.get('kind') in ('hyperfide.authenticated-fault-step','hyperfide.authenticated-operator-step'):journals.append({'case':name,'capture':capture})
 if journals:require(isinstance(target.get('auth_clock_skew_seconds'),int) and 1<=target['auth_clock_skew_seconds']<=300 and isinstance(target.get('origin'),str) and isinstance(target.get('fault_operator_credential_id'),str),'FAULT_AUTHORITY_PINS_REQUIRED')
 observed=snapshot(target,connector,journals);rows=observed['rows'];run=one(rows['runs'],'id',target['run_id']);require(run['authority_epoch']==target['authority_epoch'],'AUTHORITY_EPOCH_MISMATCH');source=one(rows['run_repositories'],'repository_id',target['repository_id']);require(source['source_object_id']==target['accepted_source_object_id'],'ACCEPTED_SOURCE_MISMATCH')
 if target.get('source_backend')=='native':
  native=one(rows['source_fleet_runs'],'run_id',target['run_id']);require(native['revision_id']==target['native_source_revision_id'] and native['root_tree_id']==target['native_source_root_tree_id'] and native['authority_epoch']==target['authority_epoch'],'NATIVE_RUN_BINDING_MISMATCH')
 for name in required:case_oracle(name,cases[name],rows,target,evidence_root,index)
 if any(name in required for name in MODEL_CASES):
  ids=index['actors'];primary=one(rows['fleet_actor_sessions'],'session_id',ids['primary']);managers=[one(rows['fleet_actor_sessions'],'session_id',v) for v in ids['managers']];require(primary['actor_role']=='PRIMARY' and len(managers)>=2 and all(m['actor_role']=='WAVE_MANAGER' and m['cohort_id']==primary['cohort_id'] for m in managers),'COLOCATED_ACTORS_REQUIRED')
  actors=[primary,*managers];require(len({a['native_session_id'] for a in actors})==len(actors) and all(a.get('native_session_id') and a.get('process_identity') for a in actors),'DISTINCT_ACTUAL_MODELS_REQUIRED')
  for actor in actors:
   reasoning=[r for r in rows['fleet_reasoning'] if r['actor_id']==actor['session_id'] and r['state']=='COMPLETED'];require(reasoning and all(isinstance(r.get('result',{}).get('model_receipt'),dict) for r in reasoning),'ACTUAL_MODEL_RECEIPT_REQUIRED')
   for r in reasoning:
    receipt=r['result']['model_receipt'];require(receipt.get('upstream_response_id') if receipt.get('session_kind')=='LOGICAL_GATEWAY' else receipt.get('native_session_id') and receipt.get('binary_digest'),'ACTUAL_MODEL_UPSTREAM_REQUIRED')
  for decision in rows['fleet_decisions']:require(digest(decision['body'])==decision['payload_digest'],'DECISION_DIGEST_MISMATCH')
  for effect in rows['fleet_effect_receipts']:
   decision=one(rows['fleet_decisions'],'id',effect['decision_id']);require(effect['operation_id']==decision['operation_id'] and effect['payload_digest']==decision['payload_digest'],'MODEL_EFFECT_BINDING_MISMATCH')
  for action in ('CONFIGURE_WAVE','DELEGATE_WAVE'):
   decisions=[d for d in rows['fleet_decisions'] if d['actor_id']==primary['session_id'] and d['action']==action];require(any(any(e['decision_id']==d['id'] and e['payload_digest']==d['payload_digest'] for e in rows['fleet_effect_receipts']) for d in decisions),'MODEL_SELECTED_EFFECT_REQUIRED')
 if any(name in required for name in INSTALL_CASES):
  install=one(rows['fleet_environment_installs'],'operation_id',index['install_operation_id']);require(install['state']=='READY' and install['input_digest']==target['input_digest'] and install['authority_epoch']==target['authority_epoch'],'ACTUAL_READY_INSTALL_REQUIRED')
  receipt=install['receipt'];require(receipt and receipt.get('receipt_digest')==install['receipt_digest'] and digest({k:v for k,v in receipt.items() if k!='receipt_digest'})==install['receipt_digest'],'INSTALL_RECEIPT_MISMATCH')
  preparation=signed_install(rows,install);native_role(rows,preparation,'install',target);spec=one(rows['fleet_environment_specs'],'input_digest',target['input_digest']);require(digest(spec['package_spec'])==spec['package_digest'] and digest(spec['source_config'])==spec['source_config_digest'] and digest(spec['install_plan'])==spec['plan_digest'],'INSTALL_CONTRACT_CHAIN_REQUIRED')
  require(install['admission'].get('source_revision')==native_revision(target) and receipt.get('interfaces',{}).get('fragment_digest')==target['interface_digest'],'SOURCE_INTERFACE_PIN_MISMATCH')
  if target.get('source_backend')=='native':require(spec['source_config'].get('source',{}).get('source_backend')=='native' and spec['source_config']['source']['revision']==target['native_source_revision_id'],'NATIVE_INSTALL_CONFIG_REQUIRED')
  for tool in target['toolchains']:require(any(t.get('name')==tool['name'] and t.get('version')==tool['version'] and t.get('digest')==tool['digest'] for t in receipt.get('toolchains',[])),'TOOLCHAIN_PIN_MISMATCH')
  readiness=[r for r in rows['fleet_runtime_readiness'] if r['install_operation_id']==install['operation_id']];require(readiness and all(digest({k:v for k,v in r['publication'].items() if k!='readiness_digest'})==r['readiness_digest'] for r in readiness),'NATIVE_READINESS_REQUIRED');require(any(reg['source_tree_id']==(target['native_source_root_tree_id'] if target.get('source_backend')=='native' else target['installed_source_tree_id']) and any(r['runner_session_id']==reg['session_id'] for r in readiness) for reg in rows['runner_registry']),'INSTALLED_SOURCE_TREE_MISMATCH')
 if any(name in required for name in WORKER_CASES):
  intent=one(rows['provisioning_intents'],'id',index['provider_intent_id']);require(intent['kind']=='CREATE' and intent['native_sandbox_id'] and intent['state'] in ('ACKNOWLEDGED','TERMINAL') and any(o['intent_id']==intent['id'] and o['observation'].get('operation',{}).get('kind')=='create' and o['observation'].get('outcome',{}).get('status')=='SUCCEEDED' for o in rows['provider_observations']),'ACTUAL_PROVIDER_CREATION_REQUIRED')
  effects=[e for e in rows['fleet_effect_receipts'] if e['result'].get('provider_intent_id')==intent['id']];require(len(effects)==1,'MODEL_PROVIDER_SELECTION_REQUIRED');selection=one(rows['fleet_decisions'],'id',effects[0]['decision_id']);require(selection['action']=='PROVISION_SANDBOX' and selection['body'].get('actor_role')=='WAVE_MANAGER' and selection['actor_id'] in index['actors']['managers'],'MODEL_PROVIDER_SELECTION_REQUIRED')
  launch=one(rows['fleet_worker_launches'],'command_id',index['coding_command_id']);registry=one(rows['runner_registry'],'session_id',launch['runner_session_id']);require(registry['runner_binary_digest']==target.get('native_binary_pins',{}).get('coding'),'CODING_NATIVE_PIN_MISMATCH');plan=one(rows['native_launch_plans'],'command_id',launch['command_id']);require(launch['state']=='COMPLETED' and launch.get('signature_verified') is True and digest(launch['result'])==launch['result_digest'] and launch['result'].get('native',{}).get('terminal_observed') is True and launch['result']['native'].get('exit_code')==0,'ACTUAL_CODING_WORKER_REQUIRED')
  require(observed.get('connector_verified') is True and digest(connector['payload'].encode())==plan['qualification_receipt_digest'],'CONNECTOR_SIGNATURE_BINDING_REQUIRED');capability=json.loads(connector['payload']);require(all(capability.get('capabilities',{}).get(name)=='QUALIFIED' for name in ('launch','input','output','cancel')),'ACTUAL_NATIVE_CAPABILITIES_REQUIRED')
  assigned=[e for e in rows['fleet_effect_receipts'] if e['result'].get('kind')=='ASSIGN_WORKER' and e['result'].get('assignment',{}).get('worker_id')==plan['agent_session_id'] and any(t.get('attempt_id')==plan['attempt_id'] for t in e['result'].get('tasks',[]))];require(len(assigned)==1,'MODEL_WORKER_ASSIGNMENT_REQUIRED');choice=one(rows['fleet_decisions'],'id',assigned[0]['decision_id']);require(choice['actor_id'] in index['actors']['managers'] and choice['body'].get('actor_role')=='WAVE_MANAGER' and assigned[0]['result'].get('install_binding',{}).get('operation_id')==index['install_operation_id'],'MODEL_INSTALLED_WORKER_BINDING_REQUIRED')
  require(launch['result'].get('request_digest')==launch['request_digest'] and launch['launch_id']==plan['launch_id'],'CODING_INPUT_CHAIN_MISMATCH')
  test,custody=verified_qualification(rows,index['native_qualification_id'] if target.get('source_backend')=='native' else index['independent_test_job_id'],target);require(custody['source_attempt_id']==plan['attempt_id'] and custody['repository_id']==target['repository_id'] and custody['source_object_id']==target.get('result_source_object_id') and test['source_object_id']==custody['source_object_id'],'INDEPENDENT_TEST_OF_CODING_RESULT_REQUIRED')
 return {'schema_version':1,'task':task,'status':'PASS','qualified':True,'source_backend':target.get('source_backend','git'),'scope':'actual read-only PostgreSQL, signed native execution and pinned scenario captures','assertions':list(required),'target_digest':digest(target),'evidence_digest':digest(index),'contract_derivations':derivations,'observed_at':observed['identity']['observed_at']}

def main(task,component,output):
 parser=argparse.ArgumentParser();parser.add_argument('--component',action='store_true');parser.add_argument('--live-evidence',default=os.environ.get('HF_FLEET_QUALIFICATION_EVIDENCE'));parser.add_argument('--target',default=os.environ.get('HF_FLEET_QUALIFICATION_TARGET'));parser.add_argument('--receipt');parser.add_argument('--inventory',action='store_true');args=parser.parse_args()
 if args.inventory:print(json.dumps({'task':task,'cases':TASK_CASES[task],'qualified':False}));return 0
 if args.component:
  require(not args.live_evidence and not args.target,'COMPONENT_AND_LIVE_MODES_CONFLICT');result=component();print(json.dumps({'task':task,'mode':'COMPONENT','qualified':False}));return result
 report={'schema_version':1,'task':task,'status':'UNQUALIFIED','qualified':False};code=77
 try:
  require(args.live_evidence and args.target,'LIVE_EVIDENCE_REQUIRED');report=verify(task,private_json(args.live_evidence),private_json(args.target),Path(args.live_evidence).parent);code=0
 except (Refused,OSError,ValueError,KeyError,TypeError,subprocess.SubprocessError) as error:report['reason']=str(error) if isinstance(error,Refused) else 'LIVE_EVIDENCE_INVALID'
 destination=Path(args.receipt) if args.receipt else Path(output)/'live-receipt.json';destination.parent.mkdir(parents=True,exist_ok=True);destination.write_text(json.dumps(report,indent=2)+'\n');destination.chmod(0o600)
 print(json.dumps(report));return code
