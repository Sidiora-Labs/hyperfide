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
 'identity_principals':'credential_id,actor_id,role,public_key_b64,deployment_epoch,state',
 'fleet_cohorts':'id,host_id,authority_epoch,leader_session_id,leader_generation,cohort_generation,controller_identity',
 'fleet_actor_sessions':'session_id,actor_role,cohort_id,cohort_generation,manager_generation,native_session_id,process_identity,plan_generation,state',
 'fleet_observations':'id,actor_id,cohort_generation,context_digest,body,created_at',
 'fleet_reasoning':'id,actor_id,observation_id,state,reason,result,created_at',
 'fleet_decisions':'id,operation_id,actor_id,action,reasoning_id,payload_digest,body,created_at',
 'fleet_effect_receipts':'operation_id,decision_id,payload_digest,result,created_at',
 'fleet_delegations':'package_id,manager_session_id,manager_generation,leader_generation,budget,decision_id',
 'hierarchy_ownership_events':'id,kind,payload,created_at',
 'tasks':'id,task_key,feature_package_id,spec_revision_id,spec_generation,criteria_digest,state',
 'attempts':'id,task_id,generation,compute_authority,execution_state,sandbox_id,slot_id,sandbox_boot_generation,created_at',
 'provisioning_intents':'id,pool_id,sandbox_id,kind,request_key,payload_digest,operation,state,native_sandbox_id,boot_generation,last_outcome,failure_code,created_at,updated_at',
 'provisioning_intent_reservations':'intent_id,reservation_id',
 'reservations':'id,request_id,capacity_account_id,quantity,state,release_reason,released_at',
 'provider_native_bootstraps':'intent_id,sandbox_id,boot_id,boot_generation,state,manifest_digest,manifest,receipt,receipt_digest',
 'provider_worker_activations':'intent_id,sandbox_id,boot_id,boot_generation,worker_slot_id,state,permit,permit_digest,receipt,receipt_digest',
 'fleet_environment_specs':'input_digest,package_digest,source_config_digest,source_manifest_digest,plan_digest,package_spec,source_config,install_plan',
 'fleet_environment_installs':'operation_id,input_digest,sandbox_id,boot_id,boot_generation,authority_epoch,package_id,manager_session_id,admission,admission_digest,state,receipt,receipt_digest,completed_at',
 'fleet_install_heads':'environment_id,environment_generation,logical_operation_id,current_operation_id',
 'fleet_install_recoveries':'operation_id,predecessor_install_operation_id,logical_operation_id,predecessor_admission_digest,runner_operation_id,runner_plan_digest,runner_result_digest,quiescence_operation_id,quiescence_receipt_digest,decision_id',
 'fleet_runtime_readiness':'id,install_operation_id,runner_operation_id,runner_result_digest,slot_id,runner_session_id,readiness_digest,publication',
 'runner_registry':'session_id,credential_id,sandbox_id,boot_id,boot_generation,slot_id,uid,gid,runner_binary_digest,readiness_digest,source_object_id,source_tree_id,state',
 'runner_remote_jobs':'operation_id,session_id,job_class,plan,plan_digest,state,executor_credential_id,result,result_digest,result_signature,created_at,completed_at',
 'native_launch_plans':'command_id,launch_id,agent_session_id,slot_id,attempt_id,attempt_generation,qualification_receipt_digest,connector_plan_digest,plan',
 'fleet_worker_launches':'command_id,launch_id,runner_session_id,executor_credential_id,request,request_digest,state,result,result_digest,result_signature,created_at,completed_at',
 'submission_custodies':'id,task_id,source_attempt_id,source_generation,repository_id,source_object_id,source_manifest_digest,criteria_digest,qualification_outcome',
 'qualification_jobs':'id,custody_id,custody_generation,state,outcome,lease_generation,rubric_digest',
 'assurance_job_receipts':'job_id,lease_generation,verifier_id,environment_digest,receipt,receipt_digest,receipt_artifact_id',
 'assurance_check_intents':'job_id,lease_generation,check_id,operation_id,session_id,plan_digest,plan',
 'artifacts':'organisation_id,run_id,id,digest,size_bytes,storage_backend,status,completed_at',
 'command_inbox':'id,operation,idempotency_key,request_digest,state,result',
}
NODE_SNAPSHOT=r"""
import fs from 'node:fs';import{createRequire}from'node:module';import{verify,createPublicKey}from'node:crypto';
const a=JSON.parse(fs.readFileSync(0,'utf8')),require=createRequire(a.root+'/core/control-plane/package.json'),{Client}=require('pg'),url=process.env[a.target.database_url_env];
if(!url)throw Error('DATABASE_CAPABILITY_MISSING');const c=new Client({connectionString:url,connectionTimeoutMillis:10000,statement_timeout:15000,application_name:'hyperfide-prerequisite-readonly'});
try{await c.connect();await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const identity=(await c.query("SELECT current_database() AS database_name,(pg_control_system()).system_identifier::text,clock_timestamp() AS observed_at,current_setting('transaction_read_only') AS read_only")).rows[0];if(identity.read_only!=='on'||identity.database_name!==a.target.database_name||identity.system_identifier!==a.target.system_identifier)throw Error('DATABASE_TARGET_MISMATCH');const rows={};for(const [table,columns]of Object.entries(a.columns)){const result=await c.query('SELECT '+columns+' FROM hyperfide.'+table+' WHERE organisation_id=$1 AND '+(table==='runs'?'id':'run_id')+'=$2 LIMIT 100001',[a.target.organisation_id,a.target.run_id]);if(result.rows.length>100000)throw Error('SNAPSHOT_ROW_BUDGET');rows[table]=result.rows;}
rows.provider_observations=(await c.query('SELECT o.id,o.intent_id,o.operation_id,o.payload_digest,o.observation,o.evidence_digest,o.observed_at FROM hyperfide.provider_observations o JOIN hyperfide.provisioning_intents i ON i.organisation_id=o.organisation_id AND i.id=o.intent_id WHERE o.organisation_id=$1 AND i.run_id=$2 LIMIT 100001',[a.target.organisation_id,a.target.run_id])).rows;
if(rows.provider_observations.length>100000)throw Error('SNAPSHOT_ROW_BUDGET');rows.environment_profiles=(await c.query('SELECT id,content_digest,provider,manifest FROM hyperfide.environment_profiles WHERE organisation_id=$1 LIMIT 100001',[a.target.organisation_id])).rows;
if(rows.environment_profiles.length>100000)throw Error('SNAPSHOT_ROW_BUDGET');const keys=new Map(rows.identity_principals.map(p=>[p.credential_id,p.public_key_b64]));const canonical=v=>JSON.stringify(v&&typeof v==='object'?Array.isArray(v)?v.map(x=>JSON.parse(canonical(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(canonical(v[k]))])):v);
for(const table of ['runner_remote_jobs','fleet_worker_launches'])for(const row of rows[table])if(row.result){const pub=keys.get(row.executor_credential_id);if(!pub||!row.result_signature){row.signature_verified=false;continue;}const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(pub,'base64url')]),format:'der',type:'spki'}),message=table==='runner_remote_jobs'?`HYPERFIDE-RUNNER-RESULT-V1\n${a.target.organisation_id}\n${a.target.run_id}\n${row.operation_id}\n${row.plan_digest}\n${row.result_digest}\n`:canonical(row.result);row.signature_verified=verify(null,Buffer.from(message),key,Buffer.from(row.result_signature,'base64url'));}
const protocol=await import('./core/control-plane/dist/transport/protocol.js');rows.authenticated_fault_operations=[];
for(const entry of a.journals??[]){const journal=entry.capture,raw=Buffer.from(journal.body_base64,'base64'),decoded=protocol.decodeInvoke(raw),item=protocol.proof(Object.entries(journal.headers).flat()),principal=rows.identity_principals.find(p=>p.credential_id===item.id);if(!principal||principal.role!=='OPERATOR'||item.id!==a.target.fault_operator_credential_id||journal.origin!==a.target.origin||decoded.payload.run_id!==a.target.run_id||decoded.operation.operation_id!==journal.operation_id||journal.case!==entry.case||journal.organisation_id!==a.target.organisation_id||journal.run_id!==a.target.run_id)throw Error('FAULT_JOURNAL_SCOPE_MISMATCH');protocol.verifyProof(principal.public_key_b64,item,journal.origin,'/v1/invoke',raw);const nonce=(await c.query('SELECT received_at FROM hyperfide.identity_request_nonces WHERE credential_id=$1 AND nonce=$2',[item.id,item.nonce])).rows[0];if(!nonce||Math.abs(new Date(nonce.received_at).getTime()/1000-Number(item.time))>a.target.auth_clock_skew_seconds)throw Error('FAULT_REQUEST_NOT_AUTHENTICATED');const pin=a.target.fault_drivers?.[entry.case];if(!pin||journal.driver_digest!==pin.driver_digest||decoded.operation.payload_digest!==pin.payload_digest||decoded.payload.action!==pin.action||decoded.payload.component!==pin.component||protocol.hash(raw)!==journal.request_digest)throw Error('FAULT_DRIVER_PIN_MISMATCH');const response=journal.response,responseBytes=Buffer.from(response.body_base64,'base64');if(protocol.hash(responseBytes)!==response.body_digest||JSON.stringify(protocol.strictJSON(responseBytes))!==JSON.stringify(response.body)||response.body.operation_id!==journal.operation_id)throw Error('FAULT_RESPONSE_CUSTODY_MISMATCH');rows.authenticated_fault_operations.push(journal.operation_id);}
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

def verified_install_recovery(rows,install,interrupted_operation_id):
 require(install['operation_id']!=interrupted_operation_id,'DISTINCT_INSTALL_RECOVERY_EXECUTION_REQUIRED')
 admission=install['admission'];logical=admission.get('logical_operation_id')
 require(isinstance(logical,str) and logical,'INSTALL_LOGICAL_ID_REQUIRED')
 heads=[h for h in rows['fleet_install_heads'] if h['environment_id']==admission['environment_id'] and str(h['environment_generation'])==str(admission['environment_generation'])]
 require(len(heads)==1 and heads[0]['current_operation_id']==install['operation_id'] and heads[0]['logical_operation_id']==logical,'INSTALL_RECOVERY_HEAD_MISMATCH')
 current=install;seen=set()
 while current['operation_id']!=interrupted_operation_id:
  require(current['operation_id'] not in seen,'INSTALL_RECOVERY_CYCLE');seen.add(current['operation_id'])
  recovery=one(rows['fleet_install_recoveries'],'operation_id',current['operation_id'])
  previous=one(rows['fleet_environment_installs'],'operation_id',recovery['predecessor_install_operation_id'])
  a=current['admission'];old=previous['admission'];binding=a.get('recovery_of')
  expected={'install_operation_id':previous['operation_id'],'admission_digest':previous['admission_digest'],'runner_operation_id':recovery['runner_operation_id'],'runner_plan_digest':recovery['runner_plan_digest'],'quiescence_operation_id':recovery['quiescence_operation_id'],'quiescence_receipt_digest':recovery['quiescence_receipt_digest']}
  require(binding==expected and recovery['logical_operation_id']==logical and recovery['predecessor_admission_digest']==previous['admission_digest'] and a.get('logical_operation_id')==old.get('logical_operation_id',previous['operation_id'])==logical,'INSTALL_RECOVERY_LINEAGE_MISMATCH')
  require(current['operation_id']!=previous['operation_id'] and recovery['runner_operation_id']==recovery['quiescence_operation_id']==previous['operation_id'],'INSTALL_RECOVERY_PREDECESSOR_MISMATCH')
  require(all(a.get(k)==old.get(k) for k in ['input_digest','environment_id','environment_generation','sandbox_id','boot_id','boot_generation','package_digest','source_config_digest','plan_digest','source_revision','source_manifest_digest','slot_bindings']),'INSTALL_RECOVERY_PIN_MISMATCH')
  failed=one(rows['runner_remote_jobs'],'operation_id',previous['operation_id'])
  require(failed['state']=='COMPLETED' and failed.get('signature_verified') is True and digest(failed['plan'])==failed['plan_digest']==recovery['runner_plan_digest'] and digest(failed['result'])==failed['result_digest']==recovery['runner_result_digest'],'SIGNED_INTERRUPTED_INSTALL_REQUIRED')
  result=failed['result'];cleanup=result.get('cleanup',{})
  require(result.get('outcome')=='FAILED' and result.get('cleanup_status')=='CONFIRMED' and cleanup.get('complete') is True and cleanup.get('observed_process_absent') is True and cleanup.get('receipt_digest')==recovery['quiescence_receipt_digest'],'INSTALL_RECOVERY_QUIESCENCE_MISMATCH')
  successor=one(rows['runner_remote_jobs'],'operation_id',current['operation_id'])
  old_request=failed['plan'].get('preparation_request',{});new_request=successor['plan'].get('preparation_request',{})
  require(failed['job_class']==successor['job_class']=='PREPARATION' and old_request.get('source')==new_request.get('source') and result['ended_at']<successor['result']['started_at'],'INTERRUPTED_INSTALL_PIN_RESTART_REQUIRED')
  for job,request,owner in [(failed,old_request,previous),(successor,new_request,current)]:
   job_binding=request.get('job_binding',{})
   require(job_binding.get('namespace')=='FLEET_INSTALL' and job_binding.get('job_id')==owner['operation_id'] and job_binding.get('input_packet_digest')==owner['admission_digest'] and request.get('input_manifest_digest')==job_binding.get('input_manifest_digest'),'INSTALL_RECOVERY_NATIVE_BINDING_MISMATCH')
  current=previous
 return logical

def verified_interrupted_install_capture(rows,install,case,capture):
 interrupted=one(rows['runner_remote_jobs'],'operation_id',case.get('interrupted_operation_id'))
 restarted=signed_install(rows,install)
 verified_install_recovery(rows,install,interrupted['operation_id'])
 require(capture.get('interrupted_operation_id')==interrupted['operation_id'] and capture.get('restarted_operation_id')==restarted['operation_id'] and capture.get('retained_stage_digests')==case.get('retained_stage_digests') and isinstance(capture.get('retained_stage_digests'),dict) and capture['retained_stage_digests'],'INTERRUPTED_STAGE_REUSE_REQUIRED')
 return restarted

def verified_qualification(rows,job_id,target,checks=None):
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

def case_oracle(name,case,rows,target,evidence_root,index):
 capture=captured_case(name,case,target,evidence_root)
 # Captures retain fault provenance; authoritative effects and native outcomes come from PostgreSQL.
 if name in ('fresh_install','repeated_install','interrupted_install','concurrent_isolation','interface_subset','fetch_volume'):
  operations=case.get('install_operation_ids');require(isinstance(operations,list) and operations and len(set(operations))==len(operations),'INSTALL_CASE_OPERATIONS_REQUIRED')
  installs=[one(rows['fleet_environment_installs'],'operation_id',op) for op in operations]
  require(all(i['state']=='READY' and i['authority_epoch']==target['authority_epoch'] for i in installs),'INSTALL_CASE_READY_REQUIRED')
  require(index['install_operation_id'] in operations,'CASE_INSTALL_STAGE_MISMATCH')
  for i in installs:native_role(rows,signed_install(rows,i),'install',target)
  if name=='repeated_install':require(len(installs)>=2 and len({i['input_digest'] for i in installs})==1,'REPEATED_INSTALL_IDENTITY_REQUIRED')
  if name=='concurrent_isolation':
   require(len(installs)>=2 and len({(i['sandbox_id'],i['boot_id']) for i in installs})==len(installs),'DISTINCT_INSTALL_SANDBOXES_REQUIRED')
   jobs=[signed_install(rows,i) for i in installs];require(max(j['result']['started_at'] for j in jobs)<min(j['result']['ended_at'] for j in jobs),'ACTUAL_INSTALL_OVERLAP_REQUIRED')
   for i,j in zip(installs,jobs):
    native=native_capture(rows,j['operation_id'],one(case.get('native_receipts',[]),'operation_id',j['operation_id']),evidence_root,'native_receipt');isolation=native.get('fleet_isolation',{})
    require(isolation.get('status')=='ENFORCED' and isolation.get('method')=='UNIX_UID_GID' and isolation.get('operation_id')==i['operation_id'] and isolation.get('prepared_receipt_digest')==i['receipt_digest'] and isolation.get('slots')==i['admission'].get('slot_bindings'),'NATIVE_WRITABLE_ISOLATION_REQUIRED')
  if name=='interrupted_install':
   interrupted=one(rows['runner_remote_jobs'],'operation_id',case.get('interrupted_operation_id'));require(interrupted.get('signature_verified') is True and interrupted['state']=='COMPLETED' and interrupted['result'].get('outcome')=='FAILED' and digest(interrupted['result'])==interrupted['result_digest'] and digest(interrupted['plan'])==interrupted['plan_digest'],'SIGNED_INTERRUPTED_INSTALL_REQUIRED')
   fault_driver(name,case,rows,target,evidence_root,capture)
   verified_interrupted_install_capture(rows,installs[-1],case,capture)
  require(isinstance(capture,dict) and (name=='interrupted_install' or any(capture==i['receipt'] and capture.get('operation_id')==i['operation_id'] for i in installs)),'INSTALL_CAPTURE_OPERATION_MISMATCH')
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
   actor=one(rows['fleet_actor_sessions'],'session_id',case.get('actor_id'));require(int(actor['plan_generation'])>int(case['replayed_plan_generation']),'STALE_PLAN_PROOF_REQUIRED')
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
  reason=one(rows['fleet_reasoning'],'id',case.get('reasoning_id'));require(reason['state'] in ('UNKNOWN','WAITING_FOR_MANAGER') and not any(d['reasoning_id']==reason['id'] for d in rows['fleet_decisions']),'UNAVAILABLE_MODEL_FALLBACK_EFFECT')
  unavailable_model_response(capture.get('response',{}).get('body',{}),reason,target.get('case_error_codes',{}).get(name,[]))
 elif name in ('failed_worker','worker_cancellation'):
  launch=one(rows['fleet_worker_launches'],'command_id',case.get('command_id'));require(capture==launch['result'],'CASE_FAILED_WORKER_CAPTURE_MISMATCH');require(launch.get('signature_verified') is True and launch['result_digest']==digest(launch['result']),'SIGNED_FAILED_WORKER_RESULT_REQUIRED')
  native=launch['result'].get('native',{});require(native.get('terminal_observed') is True and (native.get('exit_code') not in (None,0) or native.get('state') in ('STOPPED','LEASE_EXPIRED')),'CONFIRMED_WORKER_FAILURE_REQUIRED')
  attempt=one(rows['attempts'],'id',one(rows['native_launch_plans'],'command_id',launch['command_id'])['attempt_id']);require(attempt['compute_authority']=='RELEASED','FAILED_WORKER_CAPACITY_HELD');coding=one(rows['native_launch_plans'],'command_id',index['coding_command_id']);coding_attempt=one(rows['attempts'],'id',coding['attempt_id']);require(attempt['task_id']==coding_attempt['task_id'],'WORKER_FAILURE_TASK_MISMATCH')
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
  require(case.get('job_id')==index['independent_test_job_id'],'CASE_TEST_STAGE_MISMATCH');job=one(rows['qualification_jobs'],'id',case['job_id']);receipt=one([r for r in rows['assurance_job_receipts'] if str(r['lease_generation'])==str(job['lease_generation'])],'job_id',job['id']);require(capture==receipt['receipt'] and digest(capture)==receipt['receipt_digest'],'CASE_TEST_CAPTURE_MISMATCH')
 else:raise Refused('CASE_ORACLE_UNSUPPORTED')

def verify(task,index,target,evidence_root=None):
 require(isinstance(index,dict) and isinstance(target,dict),'LIVE_EVIDENCE_OBJECT_REQUIRED')
 require(index.get('schema_version')==1 and index.get('kind')=='hyperfide.fleet-live-evidence' and index.get('target_digest')==digest(target),'EVIDENCE_TARGET_MISMATCH')
 cases=index.get('cases',{});required=TASK_CASES[task];require(isinstance(cases,dict) and all(name in cases for name in required),'REQUIRED_LIVE_CASES_MISSING')
 require(target.get('schema_version')==1 and re.fullmatch(r'[A-Z][A-Z0-9_]*',target.get('database_url_env','')) and str(target.get('system_identifier','')).isdigit(),'TRUSTED_DATABASE_TARGET_REQUIRED')
 for key in ('organisation_id','run_id','authority_epoch','repository_id'):require(re.fullmatch(r'[0-9a-f-]{36}',target.get(key,'')) is not None,'TARGET_SCOPE_REQUIRED')
 for key in ('accepted_source_object_id','installed_source_tree_id'):require(OID.fullmatch(target.get(key,'')) is not None,'SOURCE_PINS_REQUIRED')
 require(DIGEST.fullmatch(target.get('input_digest','')) is not None and DIGEST.fullmatch(target.get('interface_digest','')) is not None,'INSTALL_PINS_REQUIRED')
 pins=target.get('contract_files');require(isinstance(pins,list) and {'contracts/fleet/index.mjs','spec/hyperfide-source-control/spec.kvx'}.issubset({p.get('path') for p in pins if isinstance(p,dict)}),'CONTRACT_PINS_REQUIRED')
 for pin in pins:
  relative=Path(pin['path']);require(not relative.is_absolute() and '..' not in relative.parts,'CONTRACT_PATH_REFUSED');file=ROOT/relative;require(file.resolve().is_relative_to(ROOT) and digest(file.read_bytes())==pin['digest'],'CONTRACT_PIN_MISMATCH')
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
   if isinstance(capture,dict) and capture.get('kind')=='hyperfide.authenticated-fault-step':journals.append({'case':name,'capture':capture})
 if journals:require(isinstance(target.get('auth_clock_skew_seconds'),int) and 1<=target['auth_clock_skew_seconds']<=300 and isinstance(target.get('origin'),str) and isinstance(target.get('fault_operator_credential_id'),str),'FAULT_AUTHORITY_PINS_REQUIRED')
 observed=snapshot(target,connector,journals);rows=observed['rows'];run=one(rows['runs'],'id',target['run_id']);require(run['authority_epoch']==target['authority_epoch'],'AUTHORITY_EPOCH_MISMATCH');source=one(rows['run_repositories'],'repository_id',target['repository_id']);require(source['source_object_id']==target['accepted_source_object_id'],'ACCEPTED_SOURCE_MISMATCH')
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
  require(install['admission'].get('source_revision')=='git:'+target['accepted_source_object_id'] and receipt.get('interfaces',{}).get('fragment_digest')==target['interface_digest'],'SOURCE_INTERFACE_PIN_MISMATCH')
  for tool in target['toolchains']:require(any(t.get('name')==tool['name'] and t.get('version')==tool['version'] and t.get('digest')==tool['digest'] for t in receipt.get('toolchains',[])),'TOOLCHAIN_PIN_MISMATCH')
  readiness=[r for r in rows['fleet_runtime_readiness'] if r['install_operation_id']==install['operation_id']];require(readiness and all(digest({k:v for k,v in r['publication'].items() if k!='readiness_digest'})==r['readiness_digest'] for r in readiness),'NATIVE_READINESS_REQUIRED');require(any(reg['source_tree_id']==target['installed_source_tree_id'] and any(r['runner_session_id']==reg['session_id'] for r in readiness) for reg in rows['runner_registry']),'INSTALLED_SOURCE_TREE_MISMATCH')
 if any(name in required for name in WORKER_CASES):
  intent=one(rows['provisioning_intents'],'id',index['provider_intent_id']);require(intent['kind']=='CREATE' and intent['native_sandbox_id'] and intent['state'] in ('ACKNOWLEDGED','TERMINAL') and any(o['intent_id']==intent['id'] and o['observation'].get('operation',{}).get('kind')=='create' and o['observation'].get('outcome',{}).get('status')=='SUCCEEDED' for o in rows['provider_observations']),'ACTUAL_PROVIDER_CREATION_REQUIRED')
  effects=[e for e in rows['fleet_effect_receipts'] if e['result'].get('provider_intent_id')==intent['id']];require(len(effects)==1,'MODEL_PROVIDER_SELECTION_REQUIRED');selection=one(rows['fleet_decisions'],'id',effects[0]['decision_id']);require(selection['action']=='PROVISION_SANDBOX' and selection['body'].get('actor_role')=='WAVE_MANAGER' and selection['actor_id'] in index['actors']['managers'],'MODEL_PROVIDER_SELECTION_REQUIRED')
  launch=one(rows['fleet_worker_launches'],'command_id',index['coding_command_id']);registry=one(rows['runner_registry'],'session_id',launch['runner_session_id']);require(registry['runner_binary_digest']==target.get('native_binary_pins',{}).get('coding'),'CODING_NATIVE_PIN_MISMATCH');plan=one(rows['native_launch_plans'],'command_id',launch['command_id']);require(launch['state']=='COMPLETED' and launch.get('signature_verified') is True and digest(launch['result'])==launch['result_digest'] and launch['result'].get('native',{}).get('terminal_observed') is True and launch['result']['native'].get('exit_code')==0,'ACTUAL_CODING_WORKER_REQUIRED')
  require(observed.get('connector_verified') is True and digest(connector['payload'].encode())==plan['qualification_receipt_digest'],'CONNECTOR_SIGNATURE_BINDING_REQUIRED');capability=json.loads(connector['payload']);require(all(capability.get('capabilities',{}).get(name)=='QUALIFIED' for name in ('launch','input','output','cancel')),'ACTUAL_NATIVE_CAPABILITIES_REQUIRED')
  assigned=[e for e in rows['fleet_effect_receipts'] if e['result'].get('kind')=='ASSIGN_WORKER' and e['result'].get('assignment',{}).get('worker_id')==plan['agent_session_id'] and any(t.get('attempt_id')==plan['attempt_id'] for t in e['result'].get('tasks',[]))];require(len(assigned)==1,'MODEL_WORKER_ASSIGNMENT_REQUIRED');choice=one(rows['fleet_decisions'],'id',assigned[0]['decision_id']);require(choice['actor_id'] in index['actors']['managers'] and choice['body'].get('actor_role')=='WAVE_MANAGER' and assigned[0]['result'].get('install_binding',{}).get('operation_id')==index['install_operation_id'],'MODEL_INSTALLED_WORKER_BINDING_REQUIRED')
  require(launch['result'].get('request_digest')==launch['request_digest'] and launch['launch_id']==plan['launch_id'],'CODING_INPUT_CHAIN_MISMATCH')
  test,custody=verified_qualification(rows,index['independent_test_job_id'],target);require(custody['source_attempt_id']==plan['attempt_id'] and custody['repository_id']==target['repository_id'] and custody['source_object_id']==target.get('result_source_object_id') and test['source_object_id']==custody['source_object_id'],'INDEPENDENT_TEST_OF_CODING_RESULT_REQUIRED')
 return {'schema_version':1,'task':task,'status':'PASS','qualified':True,'scope':'actual read-only PostgreSQL, signed native execution and pinned scenario captures','assertions':list(required),'target_digest':digest(target),'evidence_digest':digest(index),'observed_at':observed['identity']['observed_at']}

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
