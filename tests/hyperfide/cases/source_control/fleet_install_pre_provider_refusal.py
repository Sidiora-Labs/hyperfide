#!/usr/bin/env python3
"""Actual PG authority/trigger races; declared expired job inputs, no executor/native qualification."""
import shutil,select,copy,importlib.util,json,os,socket,subprocess,sys,base64,datetime,time,concurrent.futures
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4];sys.path.insert(0,str(ROOT/'tests/hyperfide/support'))
from fleet_prerequisite_fixture import component_closure
from identity_fixture import uid,sha
s=importlib.util.spec_from_file_location('not_started_assignment',ROOT/'tests/hyperfide/cases/source_control/fleet_selected_assignment.py');a=importlib.util.module_from_spec(s);s.loader.exec_module(a)
insert=a.insert;digest=a.digest
EXPIRED='2000-01-01T00:00:00Z'
def setup(f):
 a.adoption.native_profiles(f)
 limits={'SANDBOX':'20','PROVISIONING':'20','CPU_MILLIS':'100000','MEMORY_BYTES':'107374182400','DISK_BYTES':'1073741824000'}
 config={'schema_version':1,'organisation_id':f.ids['organisation'],'revision':'CONTROLLED_REFUSAL_COMPONENT','maximum_operation_ms':1000,'accounts':[{'provider':'blaxel','account_key':'fixture','approved_limits':limits,'planning_limits':limits}],'pools':[{'id':f.ids['pool'],'provider':'blaxel','account_key':'fixture','environment_key':'not-started','region':'fixture','profile_id':f.ids['profile'],'preparation_digest':f.preparation,'approved_limits':limits,'planning_limits':limits,'create_policy':{'seed_reference':'CONTROLLED_COMPONENT','network':'ISOLATED','stdin_required':False}}]}
 executor=f.path/'runner-executor.json';executor.write_text(json.dumps({'schema_version':1,'principals':[{'credential_id':f.ids['provisioner'],'key_path':str(f.keys['provisioner']['path'])}],'concurrency':1}));executor.chmod(0o600)
 f.env.update(HF_RUNNER_EXECUTOR_CONFIG_FILE=str(executor),HF_PROVISIONER_EXECUTOR_CONFIG_FILE=str(executor),HF_ARTIFACT_S3_ENDPOINT='http://127.0.0.1:9',HF_ARTIFACT_ALLOW_LOOPBACK_HTTP='1',HF_ARTIFACT_S3_REGION='fixture',HF_ARTIFACT_S3_BUCKET='fixture-bucket',HF_ARTIFACT_S3_ACCESS_KEY_ID='fixture-no-live-authority',HF_ARTIFACT_S3_SECRET_ACCESS_KEY='fixture-no-live-authority',HF_ARTIFACT_ORGANISATION_ID=f.ids['organisation'],HF_ARTIFACT_ALLOWED_RUN_IDS=json.dumps([f.ids['run']]))
 secrets=f.path/'refusal-secrets';attachments=f.path/'refusal-attachments';secrets.mkdir(mode=0o700);attachments.mkdir(mode=0o700);credentials=f.path/'refusal-credentials.json';credentials.write_text(json.dumps({'schema_version':1,'secret_root':str(secrets),'attachment_root':str(attachments),'sources':[],'targets':[]}));credentials.chmod(0o600);f.env['HF_CREDENTIAL_CONFIG_FILE']=str(credentials)
 path=f.path/'refusal-pools.json';path.write_text(json.dumps(config));path.chmod(0o600);f.env['HYPERFIDE_POOL_CONFIG']=str(path);f.refusal_config=config
def main():
 if not os.environ.get('DATABASE_URL'):return subprocess.run([sys.executable,str(ROOT/'tests/hyperfide/support/withpg.py'),'--',sys.executable,str(Path(__file__).resolve())],cwd=ROOT).returncode
 image=sha(b'CONTROLLED_PRIOR_IMAGE_PIN');f=a.AssignmentFixture(extra_components=component_closure(['fleet-orchestration','fleet-manager-effects','fleet-install','fleet-install-delivery','8.3','12.4-executor']),extra_setup=setup,provider_config={'provider':'blaxel','account':'fixture','workspace':'not-started','region':'fixture','image_digest':image,'runtime_platform':'linux-amd64'})
 try:
  print(json.dumps({'phase':'fixture_ready'}),flush=True)
  i=f.ids;scope={'organisation_id':i['organisation'],'run_id':i['run']};common=[i['organisation'],i['run']];pin=sha(b'CONTROLLED_INITIAL_NOT_STARTED_METADATA')
  f.ok('fleet.cohort.bind',{'cohort_id':uid(),'host_id':socket.gethostname(),'leader_generation':'1','expected_generation':'0'},component='fleet-orchestration');cohort=f.sql('SELECT id::text,cohort_generation::text FROM hyperfide.fleet_cohorts WHERE organisation_id=$1 AND run_id=$2',common)[0]
  insert(f,'fleet_delegations',{**scope,'package_id':i['package'],'manager_session_id':i['manager'],'manager_generation':2,'leader_generation':1,'budget':{'allowed_actions':['fleet.install.admit'],'provider_ids':['blaxel'],'profile_ids':[i['profile']],'max_sandboxes':1,'max_concurrent_workers':4,'task_ids':[i['task_a']]},'decision_id':uid()})
  binding={'actor_id':i['manager'],'actor_role':'WAVE_MANAGER','authority_epoch':i['epoch'],'leader_generation':'1','delegation_id':i['package'],'manager_generation':'2'};f.ok('fleet.session.bind',{'binding':binding},key='manager',component='fleet-orchestration')
  def record(value,action='fleet.install.admit'):
   operation,decision,observation,reason=[uid() for _ in range(4)];generation=f.sql('SELECT plan_generation::text FROM hyperfide.fleet_actor_sessions WHERE session_id=$1',[i['manager']])[0]['plan_generation'];body={'schema_version':1,'kind':'hyperfide.fleet-decision','operation_id':operation,'decision_id':decision,'run_id':i['run'],**binding,'source_revision':'git:'+f.source,'spec_revision':i['accepted_spec'],'context_digest':sha(operation.encode()),'action':action,'input':value,'input_digest':digest(value),'expected_version':generation,'rationale_summary':'Controlled historical manager decision input; no model inference evidence'}
   insert(f,'fleet_observations',{**scope,'id':observation,'actor_id':i['manager'],'cohort_generation':int(cohort['cohort_generation']),'context_digest':body['context_digest'],'body':{'controlled_fixture_input':True}});insert(f,'fleet_reasoning',{**scope,'id':reason,'actor_id':i['manager'],'request_digest':body['context_digest'],'observation_id':observation,'state':'COMPLETED','result':{'controlled_fixture_input':True}});insert(f,'fleet_decisions',{**scope,'id':decision,'operation_id':operation,'actor_id':i['manager'],'action':action,'context_digest':body['context_digest'],'payload_digest':digest(body),'reasoning_id':reason,'body':body});return body
  previous=record({},'PROVISION_SANDBOX');insert(f,'fleet_effect_receipts',{**scope,'operation_id':previous['operation_id'],'decision_id':previous['decision_id'],'payload_digest':digest(previous),'result':{'kind':'PROVISION_SANDBOX','delegation_id':i['package'],'sandbox_id':i['sandbox'],'fixture':'CONTROLLED_PRIOR_OWNERSHIP_INPUT'}})
  admitted_principal=f.ok('identity.describe',{},key='manager',component='14.1')['principal']
  accepted_policy=f.primary("const policy=await claims.jobPolicy(tx,data.scope,data.task,'ADVANCE',{job_kind:'PREPARATION',pool_id:data.pool});return {digest:claims.requestDigest(policy),dimensions:await claims.approvedDimensions(tx,data.scope,data.pool,policy,'PREPARATION')}",{'task':i['task_a'],'pool':i['pool']});assert 'result' in accepted_policy,accepted_policy
  quantities={row['capacity_account_id']:row['quantity'] for row in accepted_policy['result']['dimensions']}
  boot_credential=uid()
  def seed(name):
   operation,prep_slot,session,reservation,request,allocation,waiter=[uid() for _ in range(7)];root='/component/not-started/'+operation;env='not-started-'+operation
   insert(f,'worker_slots',{'organisation_id':i['organisation'],'id':prep_slot,'sandbox_id':i['sandbox'],'slot_key':'prep-'+operation,'boot_generation':1,'capacity_kind':'PREPARATION','state':'ALLOCATED'})
   insert(f,'agent_sessions',{**scope,'id':session,'role':'WORKER','parent_session_id':i['manager'],'connector':'fixture','account_key':'fixture','native_session_id':'CONTROLLED_PRIOR_PREPARATION-'+operation,'slot_id':prep_slot,'sandbox_id':i['sandbox'],'sandbox_boot_generation':1,'state':'REGISTERED'})
   insert(f,'runner_registry',{**scope,'session_id':session,'credential_id':boot_credential if name in ['executor-first','native-claimed','native-race'] else uid(),'sandbox_id':i['sandbox'],'boot_generation':1,'boot_id':i['boot'],'slot_id':prep_slot,'state_dir':root+'/state','runner_binary':'/component/native','workspace_path':root+'/prep-source','home_path':root+'/prep-home','tmp_path':root+'/prep-tmp','runner_binary_digest':pin,'boot_preparation_digest':f.preparation,'preparation_digest':f.preparation,'slot_generation':1,'uid':41401,'gid':41401,'observation_digest':pin,'preparation_recipes':{},'state':'PREPARING'})
   worker_slot=uid();worker_session=uid();worker_root=root+'/workers/0'
   insert(f,'worker_slots',{'organisation_id':i['organisation'],'id':worker_slot,'sandbox_id':i['sandbox'],'slot_key':'agent-'+operation,'boot_generation':1,'capacity_kind':'AGENT','state':'READY'})
   insert(f,'runner_registry',{**scope,'session_id':worker_session,'credential_id':uid(),'sandbox_id':i['sandbox'],'boot_generation':1,'boot_id':i['boot'],'slot_id':worker_slot,'state_dir':root+'/worker-state','runner_binary':'/component/native','workspace_path':worker_root+'/source','home_path':worker_root+'/home','tmp_path':worker_root+'/tmp','runner_binary_digest':pin,'boot_preparation_digest':f.preparation,'preparation_digest':f.preparation,'slot_generation':1,'uid':41402+len(cases),'gid':41402+len(cases),'observation_digest':pin,'preparation_recipes':{},'state':'PREPARING'})
   package={'environment':{'environment_id':env,'environment_generation':1,'root':root,'platform':'linux-amd64','image_digest':image},'workers':{'slots':1,**{n+'_template':root+'/workers/{slot}/'+v for n,v in [('source','source'),('home','home'),('build','build'),('temporary','tmp'),('dirty','dirty')]}}};source={'source':{'revision':'git:'+f.source,'repository':i['repository']},'workspace':{'authority_epoch':i['epoch'],'read_scope':['src/**'],'write_scope':['src/**']}};input_digest=digest({'case':operation});insert(f,'fleet_environment_specs',{**scope,'input_digest':input_digest,'package_digest':pin,'source_config_digest':pin,'source_manifest_digest':pin,'plan_digest':pin,'package_spec':package,'source_config':source,'install_plan':{'controlled_prior_spec':True},'registered_by':i['manager']})
   slot={'slot':0,'worker_slot_id':worker_slot,'uid':41402+len(cases),'gid':41402+len(cases),'slot_generation':'1','worker_root':worker_root,**{n:worker_root+'/'+v for n,v in [('source','source'),('home','home'),('build','build'),('temporary','tmp'),('dirty','dirty')]}}
   admission={**scope,'operation_id':operation,'logical_operation_id':operation,'sandbox_id':i['sandbox'],'boot_id':i['boot'],'boot_generation':'1','authority_epoch':i['epoch'],'input_digest':input_digest,'environment_id':env,'environment_generation':1,'slot_bindings':[slot],'expires_at':EXPIRED};admission_digest=digest(admission);admission['admission_digest']=admission_digest
   install={**scope,'operation_id':operation,'input_digest':input_digest,'environment_id':env,'environment_generation':1,'sandbox_id':i['sandbox'],'boot_id':i['boot'],'boot_generation':1,'authority_epoch':i['epoch'],'package_id':i['package'],'manager_session_id':i['manager'],'manager_generation':2,'leader_generation':1,'cohort_id':cohort['id'],'cohort_generation':int(cohort['cohort_generation']),'admission':admission,'admission_digest':admission_digest,'expires_at':EXPIRED};insert(f,'fleet_environment_installs',install);insert(f,'fleet_install_heads',{**scope,'environment_id':env,'environment_generation':1,'logical_operation_id':operation,'current_operation_id':operation})
   task=f.sql('SELECT spec_revision_id::text,spec_generation::text,criteria_digest FROM hyperfide.tasks WHERE id=$1',[i['task_a']])[0]
   insert(f,'resource_waiters',{**scope,'id':waiter,'request_id':request,'pool_id':i['pool'],'owner_session_id':i['manager'],'task_id':i['task_a'],'spec_revision_id':task['spec_revision_id'],'spec_generation':int(task['spec_generation']),'criteria_digest':task['criteria_digest'],'resource_policy_digest':accepted_policy['result']['digest'],'job_kind':'PREPARATION','priority':0,'state':'ADMITTED','admitted_at':'1999-12-31T23:59:59Z','enqueued_at':'1999-12-31T23:59:58Z','deadline_at':EXPIRED})
   insert(f,'reservations',{**scope,'id':reservation,'request_id':request,'capacity_account_id':f.accounts['PREPARATION'],'quantity':quantities[f.accounts['PREPARATION']],'expires_at':'2099-01-01T00:00:00Z','state':'ALLOCATED'});f.sql('UPDATE hyperfide.capacity_accounts SET allocated=allocated+$2::numeric,state_version=state_version+1 WHERE id=$1',[f.accounts['PREPARATION'],quantities[f.accounts['PREPARATION']]])
   extra_reservations=[]
   for dimension in ['CPU_MILLIS','MEMORY_BYTES','DISK_BYTES']:
    ident=uid();extra_reservations.append(ident);insert(f,'reservations',{**scope,'id':ident,'request_id':request,'capacity_account_id':f.accounts[dimension],'quantity':quantities[f.accounts[dimension]],'expires_at':'2099-01-01T00:00:00Z','state':'ALLOCATED'});f.sql('UPDATE hyperfide.capacity_accounts SET allocated=allocated+$2::numeric,state_version=state_version+1 WHERE id=$1',[f.accounts[dimension],quantities[f.accounts[dimension]]])
   insert(f,'resource_job_allocations',{**scope,'id':allocation,'request_id':request,'task_id':i['task_a'],'reservation_id':reservation,'job_kind':'PREPARATION','slot_id':prep_slot,'sandbox_id':i['sandbox'],'sandbox_boot_generation':1,'assignee_session_id':session})
   plan={'operation_id':operation,'binding':{'sandbox_id':i['sandbox'],'boot_id':i['boot'],'boot_generation':'1','session_id':session,'slot_id':prep_slot},'allocation':{'allocation_id':allocation,'generation':'1','request_id':request},'preparation_request':{'job_binding':{'namespace':'FLEET_INSTALL','job_id':operation,'input_packet_digest':admission_digest}}}
   registry=f.sql('SELECT to_jsonb(r) AS row FROM hyperfide.runner_registry r WHERE session_id=$1',[session])[0]['row']
   plan['binding']={key:registry[key] for key in ['organisation_id','run_id','session_id','sandbox_id','boot_id','slot_id','state_dir','runner_binary','workspace_path','boot_preparation_digest']}
   plan['binding'].update(pool_id=i['pool'],external_sandbox_id='packet-fixture-resource',boot_generation='1')
   plan['allocation']=f.sql('SELECT id::text AS allocation_id,request_id::text,task_id::text,job_kind,reservation_id::text,slot_id::text,sandbox_id::text,sandbox_boot_generation::text,assignee_session_id::text,generation::text FROM hyperfide.resource_job_allocations WHERE id=$1',[allocation])[0]
   plan['request']={'timeout_ms':60000};plan['env_refs']={};plan_digest=digest(plan)
   principal=admitted_principal
   insert(f,'runner_remote_jobs',{**scope,'operation_id':operation,'session_id':session,'job_class':'PREPARATION','native_claim_coverage':name!='legacy-uncovered','plan':plan,'plan_digest':plan_digest,'principal':principal,'admission_digest':pin,'authority_epoch':i['epoch'],'reservation_id':reservation,'expires_at':'2099-01-01T00:00:00Z'})
   value={'input_digest':input_digest,'environment_id':env,'environment_generation':1,'sandbox_id':i['sandbox'],'boot_id':i['boot'],'boot_generation':'1','ttl_seconds':300,'slot_bindings':[{'slot':0,'worker_slot_id':worker_slot}],'recovery_of':{'kind':'NOT_STARTED','install_operation_id':operation,'admission_digest':admission_digest,'runner_operation_id':operation,'runner_plan_digest':plan_digest}}
   out={'name':name,'install':install,'binding':value['recovery_of'],'input':value,'reservation':reservation,'reservation_ids':[reservation,*extra_reservations],'allocation':allocation,'session':session};cases.append(out);return out
  f.sql('UPDATE hyperfide.capacity_accounts SET configured_limit=100,state_version=state_version+1 WHERE id=$1',[f.accounts['PREPARATION']])
  # Controlled current configuration metadata; no provider quota qualification is claimed.
  config=f.refusal_config;pool=config['pools'][0];account=config['accounts'][0];configuration=digest({'revision':config['revision'],'pool':pool,'account':account})
  provider_scope={'organisation_id':i['organisation'],'pool_id':i['pool'],'provider':'blaxel','provider_account_id':'fixture','environment_id':'not-started','region':'fixture','configuration_digest':configuration}
  insert(f,'provider_pool_configurations',{'organisation_id':i['organisation'],'pool_id':i['pool'],'configuration_digest':configuration,'document':{'scope':provider_scope,'pool':pool,'account':account}})
  provisioner=copy.copy(f);provisioner.child=None;provisioner.service_role='provisioner'
  with socket.socket() as listener:listener.bind(('127.0.0.1',0));provisioner.port=listener.getsockname()[1]
  cases=[]
  physical_ids=[]
  for dimension,quantity in {'SANDBOX':'1','CPU_MILLIS':'4000','MEMORY_BYTES':'8589934592','DISK_BYTES':'21474836480'}.items():
   physical_id=uid();physical_ids.append(physical_id)
   insert(f,'reservations',{**scope,'id':physical_id,'request_id':uid(),'capacity_account_id':f.physical_accounts[dimension],'quantity':quantity,'expires_at':'2099-01-01T00:00:00Z'})
   f.sql('UPDATE hyperfide.capacity_accounts SET reserved=reserved+$2::numeric,state_version=state_version+1 WHERE id=$1',[f.physical_accounts[dimension],quantity])
  physical_before=f.sql('SELECT id::text,state FROM hyperfide.reservations WHERE id=ANY($1::uuid[]) ORDER BY id',[physical_ids])
  for name in ['executor-first','historical-unknown','wrong-request','provider-race','native-claimed','native-race','legacy-uncovered']:seed(name)
  by={c['name']:c for c in cases}
  for c in cases:
   operation=c['install']['operation_id']
   registry=f.sql('SELECT to_jsonb(r) AS row FROM hyperfide.runner_registry r WHERE session_id=$1',[c['session']])[0]['row']
   plan=f.sql('SELECT plan FROM hyperfide.runner_remote_jobs WHERE operation_id=$1',[operation])[0]['plan']
   c['plan']=plan
   if c['name'] in ['executor-first','native-claimed','native-race']:
    if c['name']=='executor-first':
     key=f.path/'boot-native-prerequisite.pem';subprocess.run(['openssl','genpkey','-algorithm','Ed25519','-out',str(key)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
     public=subprocess.check_output(['openssl','pkey','-in',str(key),'-pubout','-outform','DER'],stderr=subprocess.DEVNULL)
     insert(f,'identity_principals',{'credential_id':boot_credential,**scope,'actor_id':boot_credential,'role':'RUNNER','public_key_b64':base64.urlsafe_b64encode(public[-32:]).decode().rstrip('='),'deployment_epoch':i['epoch'],'allowed_actions':['identity.describe','runner.job.claim'],'expires_at':'2099-01-01T00:00:00Z','sandbox_id':i['sandbox'],'boot_id':i['boot'],'boot_generation':1})
     insert(f,'identity_runner_status',{'credential_id':boot_credential,'preparation_digest':f.preparation,'inventory':json.dumps([])})
    f.keys[c['name']]={'path':key,'public_key_b64':base64.urlsafe_b64encode(public[-32:]).decode().rstrip('=')};i[c['name']]=boot_credential
   if c['name']!='executor-first':
    # Explicit historical claimed request prerequisite; never a fabricated positive proof.
    c['claim_id']=uid()
    f.sql("UPDATE hyperfide.runner_remote_jobs SET state='CLAIMED',claim_id=$2,executor_credential_id=$3,claimed_at=clock_timestamp() WHERE operation_id=$1",[operation,c['claim_id'],i['provisioner']])
    if c['name'] not in ['native-claimed','native-race']:f.sql("UPDATE hyperfide.runner_remote_jobs SET state='UNKNOWN' WHERE operation_id=$1",[operation])
   encoded=base64.urlsafe_b64encode(json.dumps({'config_path':registry['state_dir']+'/runner.json','operation_id':operation},separators=(',',':')).encode()).decode().rstrip('=')
   c['request']={'binding':{'organisation_id':i['organisation'],'run_id':i['run'],'session_id':c['session'],'pool_id':i['pool'],'sandbox_id':i['sandbox'],'external_sandbox_id':'packet-fixture-resource','boot_generation':'1','preparation_digest':f.preparation},'operation_id':operation,'argv':[registry['runner_binary'],'--component','12.4','--action','runner.job.execute','--request-base64',encoded],'cwd':str(Path(registry['workspace_path']).parent),'env_refs':{},'timeout_ms':120000}
  first=by['executor-first']
  diagnostic=f.primary("const {readRunnerPreparationBinding}=await import('./core/control-plane/dist/runner/bridge.js');const b=await readRunnerPreparationBinding(tx,{...data.scope,session_id:data.session});const a=await claims.readJobAllocation(tx,{...data.scope,reservation_id:data.reservation});return {binding_differences:Object.keys(data.plan.binding).filter(k=>JSON.stringify(b[k])!==JSON.stringify(data.plan.binding[k])).map(k=>({key:k,actual:b[k],admitted:data.plan.binding[k]})),allocation_differences:['allocation_id','generation','slot_id','sandbox_id','sandbox_boot_generation','assignee_session_id','request_id'].filter(k=>JSON.stringify(a[k])!==JSON.stringify(data.plan.allocation[k])).map(k=>({key:k,actual:a[k],admitted:data.plan.allocation[k]}))}",{'session':first['session'],'reservation':first['reservation'],'plan':first['plan']})
  print(json.dumps({'phase':'actual_preclaim_binding_diagnostic','result':diagnostic}),flush=True)
  assert 'result' in diagnostic and diagnostic['result']=={'binding_differences':[],'allocation_differences':[]},diagnostic
  provisioner.components=f.components
  provisioner.start()
  print(json.dumps({'phase':'provisioner_started','cases':len(cases)}),flush=True)
  def certify(c,request=None):return provisioner.invoke('provider.remote.execute-bound',request or c['request'],key='provisioner',component='8.3')[1]
  def job(c):return f.sql('SELECT to_jsonb(j) AS row FROM hyperfide.runner_remote_jobs j WHERE operation_id=$1',[c['install']['operation_id']])[0]['row']
  def proof(c):return f.sql('SELECT * FROM hyperfide.runner_pre_provider_refusals WHERE runner_operation_id=$1',[c['install']['operation_id']])
  first=by['executor-first'];until=time.monotonic()+15
  while time.monotonic()<until and not proof(first):time.sleep(0.1)
  first_job=job(first);assert len(proof(first))==1 and first_job['claim_id'] and first_job['executor_credential_id']==i['provisioner'] and first_job['state'] in ['CLAIMED','UNKNOWN'] and first_job['result'] is None,{'job':first_job,'proof':proof(first),'status':provisioner.invoke('runner.executor.describe',{},key='provisioner',component='12.4-executor')[1]}
  print(json.dumps({'phase':'actual_executor_timeout_proof','claim_id':first_job['claim_id']}),flush=True)
  native=by['native-claimed'];native_response=f.invoke('runner.job.claim',{'operation_id':native['install']['operation_id']},key='native-claimed',component='12.4')[1];assert native_response.get('ok'),native_response
  native_refusal=certify(native);assert native_refusal.get('error',{}).get('code') in ['PRE_PROVIDER_REFUSAL_UNPROVEN','PRE_PROVIDER_REFUSAL_LEGACY_UNPROVEN'] and proof(native)==[],native_refusal
  native_race=by['native-race']
  with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
   refusing=executor.submit(certify,native_race)
   claiming=executor.submit(f.invoke,'runner.job.claim',{'operation_id':native_race['install']['operation_id']},key='native-race',component='12.4')
   native_race_results=[refusing.result(timeout=30),claiming.result(timeout=30)[1]]
  race_job=job(native_race);race_proofs=proof(native_race)
  assert (len(race_proofs)==1 and race_job['native_claimed_at'] is None and not native_race_results[1].get('ok')) or (not race_proofs and race_job['native_claimed_at'] is not None and not native_race_results[0].get('ok')),(native_race_results,race_job,race_proofs)
  legacy_refusal=certify(by['legacy-uncovered']);assert legacy_refusal.get('error',{}).get('code')=='PRE_PROVIDER_REFUSAL_LEGACY_UNPROVEN' and proof(by['legacy-uncovered'])==[],legacy_refusal
  c=by['historical-unknown'];before=job(c);certified=certify(c);assert certified.get('ok'),certified
  print(json.dumps({'phase':'historical_posttracking_certification','response':certified}),flush=True)
  retained=proof(c);assert len(retained)==1 and digest(retained[0]['proof'])==retained[0]['proof_digest'],retained
  after=job(c)
  for key in ['state','claim_id','executor_credential_id','claimed_at','result','result_digest','result_signature','completed_at','plan','plan_digest']:assert after[key]==before[key],key
  replay=certify(c);assert replay.get('ok') and proof(c)==retained,replay
  fence_script="""
import pg from './core/control-plane/node_modules/pg/lib/index.js';import fs from 'node:fs';const x=JSON.parse(fs.readFileSync(0,'utf8')),c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();const out=[];
try{for(const [sql,args]of [["UPDATE hyperfide.runner_remote_jobs SET claim_id=$2 WHERE operation_id=$1",[x.operation,x.fresh]],["INSERT INTO hyperfide.provider_remote_operations(organisation_id,run_id,id,session_id,sandbox_id,boot_generation,request_digest,runner_binding_evidence_digest,operation,state) VALUES($1,$2,$3,$4,$5,1,$6,$6,'{}','UNKNOWN')",[x.org,x.run,x.operation,x.session,x.sandbox,x.pin]],["UPDATE hyperfide.runner_pre_provider_refusals SET proof_digest=$2 WHERE id=$1",[x.proof,x.pin]]]){await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE');let code;try{await c.query(sql,args)}catch(e){code=e.code}await c.query('ROLLBACK');if(code!=='23514'&&!(sql.includes('UPDATE hyperfide.runner_pre_provider_refusals')&&code==='42501'))throw Error('Expected permanent fence or proof-write ACL refusal, got '+code);out.push(code)}console.log(JSON.stringify(out))}finally{await c.end()}
"""
  fence_args={'operation':c['install']['operation_id'],'fresh':uid(),'org':i['organisation'],'run':i['run'],'session':c['session'],'sandbox':i['sandbox'],'pin':pin,'proof':retained[0]['id']}
  fenced=subprocess.run(['node','--input-type=module','-e',fence_script],input=json.dumps(fence_args),text=True,capture_output=True,cwd=ROOT,env=f.env,timeout=20);assert fenced.returncode==0,fenced.stderr
  assert job(c)==after and proof(c)==retained
  wrong=copy.deepcopy(by['wrong-request']['request']);wrong['cwd']+='/wrong';denied=certify(by['wrong-request'],wrong);assert denied.get('error',{}).get('code')=='PRE_PROVIDER_REFUSAL_UNPROVEN' and proof(by['wrong-request'])==[],denied
  contender=by['provider-race']
  race_script="""
import pg from './core/control-plane/node_modules/pg/lib/index.js';import fs from 'node:fs';
const x=JSON.parse(process.argv[1]),c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();
try{await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE');await c.query('SELECT operation_id FROM hyperfide.runner_remote_jobs WHERE operation_id=$1 FOR UPDATE',[x.operation]);console.log('LOCKED');await new Promise(resolve=>process.stdin.once('data',resolve));await c.query("INSERT INTO hyperfide.provider_remote_operations(organisation_id,run_id,id,session_id,sandbox_id,boot_generation,request_digest,runner_binding_evidence_digest,operation,state) VALUES($1,$2,$3,$4,$5,1,$6,$6,$7,'UNKNOWN')",[x.org,x.run,x.operation,x.session,x.sandbox,x.pin,{controlled_admission_contender:true}]);await c.query('COMMIT');console.log('ADMITTED');}finally{await c.end()}
"""
  args={'org':i['organisation'],'run':i['run'],'operation':contender['install']['operation_id'],'session':contender['session'],'sandbox':i['sandbox'],'pin':pin}
  racing=subprocess.Popen(['node','--input-type=module','-e',race_script,json.dumps(args)],cwd=ROOT,env=f.env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  assert select.select([racing.stdout],[],[],10)[0] and racing.stdout.readline().strip()=='LOCKED'
  with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
   pending=executor.submit(certify,contender);time.sleep(0.15);assert not pending.done()
   racing.stdin.write('GO\n');racing.stdin.flush();racing.stdin.close();racing.wait(timeout=10)
   assert racing.returncode==0,racing.stderr.read()
   race_response=pending.result(timeout=20)
  assert race_response.get('error',{}).get('code')=='PRE_PROVIDER_REFUSAL_UNPROVEN' and proof(contender)==[],race_response
  racing.stdin.close();racing.stdout.close();racing.stderr.close()
  recovery={**c['input']['recovery_of'],'kind':'PRE_PROVIDER_REFUSAL','proof_id':retained[0]['id'],'proof_digest':retained[0]['proof_digest']};value={**c['input'],'recovery_of':recovery}
  accounts=f.sql('SELECT id::text,capacity_class,allocated::text,reserved::text FROM hyperfide.capacity_accounts WHERE organisation_id=$1 ORDER BY id',[i['organisation']])
  for field,bad in [('proof_digest',sha(b'wrong')),('proof_id',uid())]:
   invalid=copy.deepcopy(value);invalid['recovery_of'][field]=bad;decision=record(invalid);response=f.invoke('fleet.install.admit',{'decision':decision},key='manager',component='fleet-install')[1];assert response.get('error',{}).get('code')=='FLEET_INSTALL_PRE_PROVIDER_UNPROVEN',response
  wrong_boot=copy.deepcopy(value);wrong_boot['boot_id']=uid();wrong_boot_decision=record(wrong_boot);wrong_boot_response=f.invoke('fleet.install.admit',{'decision':wrong_boot_decision},key='manager',component='fleet-install')[1];assert wrong_boot_response.get('error',{}).get('code')=='FLEET_INSTALL_INVALID' and job(c)==after and proof(c)==retained,wrong_boot_response
  decision=record(value);response=f.invoke('fleet.install.admit',{'decision':decision},key='manager',component='fleet-install')[1];assert response.get('ok'),response
  print(json.dumps({'phase':'signed_consumer_admitted','operation_id':decision['operation_id']}),flush=True)
  admission=response['result']['admission'];assert admission['operation_id']==admission['logical_operation_id']==decision['operation_id'] and 'recovery_of' not in admission,admission
  head=f.sql('SELECT logical_operation_id::text,current_operation_id::text FROM hyperfide.fleet_install_heads WHERE environment_id=$1',[c['install']['environment_id']])[0];assert head=={'logical_operation_id':c['install']['operation_id'],'current_operation_id':decision['operation_id']},head
  edge=f.sql('SELECT * FROM hyperfide.fleet_install_pre_provider_recoveries WHERE operation_id=$1',[decision['operation_id']]);assert len(edge)==1 and edge[0]['proof_id']==retained[0]['id'],edge
  assert job(c)==after and proof(c)==retained
  released=f.sql('SELECT state FROM hyperfide.reservations WHERE id=ANY($1::uuid[])',[c['reservation_ids']]);assert len(released)==4 and all(row['state']=='RELEASED' for row in released),released
  actual=f.sql('SELECT id::text,capacity_class,allocated::text,reserved::text FROM hyperfide.capacity_accounts WHERE organisation_id=$1 ORDER BY id',[i['organisation']]);expected=copy.deepcopy(accounts)
  for row in expected:
   if row['id'] in [f.accounts[n] for n in ['PREPARATION','CPU_MILLIS','MEMORY_BYTES','DISK_BYTES']]:row['allocated']=str(int(row['allocated'])-int(quantities[row['id']]))
  assert actual==expected,(accounts,actual)
  extension_spec=importlib.util.spec_from_file_location('refusal_delivery_target',ROOT/'tests/hyperfide/cases/source_control/fleet_install_not_started_delivery.py');extension=importlib.util.module_from_spec(extension_spec);extension_spec.loader.exec_module(extension)
  revoked=f.invoke('identity.principal.revoke',{'credential_id':boot_credential,'expected_version':'1'},key='operator',component='14.1')[1];assert revoked.get('ok'),revoked
  target=extension.actual_target(f,admission,c['install'])
  lineage_script="""
import fs from 'node:fs';import{createResourceContainer}from'./core/control-plane/dist/storage/runtime.js';import{readBootstrapInstallAllocationEpoch}from'./core/control-plane/dist/preparation/fleet_install_lineage.js';
const x=JSON.parse(fs.readFileSync(0,'utf8')),r=createResourceContainer({role:'control',env:process.env,signal:new AbortController().signal});try{console.log(JSON.stringify(await r.gateway.withPrimaryTransaction({},tx=>readBootstrapInstallAllocationEpoch(tx,x))))}finally{await r.close()}
"""
  lineage_result=subprocess.run(['node','--input-type=module','-e',lineage_script],input=json.dumps({**scope,'operation_id':decision['operation_id']}),text=True,capture_output=True,cwd=ROOT,env=f.env,timeout=20);assert lineage_result.returncode==0,lineage_result.stderr
  lineage=json.loads(lineage_result.stdout);assert lineage['logical_operation_id']==c['install']['operation_id'] and lineage['allocation_epoch_operation_id']==decision['operation_id'],lineage
  assert f.sql('SELECT id::text,state FROM hyperfide.reservations WHERE id=ANY($1::uuid[]) ORDER BY id',[physical_ids])==physical_before
  assert target['allocation']['allocation_id']!=c['allocation'] and target['allocation']['reservation_id']!=c['reservation'],target

  remote=f.sql('SELECT id::text FROM hyperfide.provider_remote_operations WHERE organisation_id=$1',[i['organisation']]);assert remote==[{'id':contender['install']['operation_id']}],remote
  print(json.dumps({'status':'PASS','scope':'actual executor timeout refusal, tracked post-migration UNKNOWN certification and signed recovery; legacy claims refuse; controlled prior registration metadata, no native/provider execution qualification','actual_executor_claim':first_job['claim_id'],'actual_native_claim_refusal':native_refusal,'legacy_refusal':legacy_refusal,'native_claim_proof_race':native_race_results,'provider_admission_race':race_response,'certification':certified,'wrong_request':denied,'admission':admission,'head':head,'lineage':lineage,'fresh_allocation':target['allocation'],'checks':['actual signed producer retained immutable proof and permanent request marker','replay preserves original UNKNOWN claim and null result','signed7pin consumer releases exactlogical4 and preservesphysical','new head/native identity is fresh while coordinator logical root remains original']}));return 0
 finally:
  if 'provisioner' in locals():provisioner.stop()
  f.close()
if __name__=='__main__':raise SystemExit(main())
