#!/usr/bin/env python3
"""Controlled SDK HTTP, actual native recipe interruption, signed result and recovery application."""
import base64,copy,datetime,hashlib,importlib.util,json,os,select,shutil,signal,sqlite3,subprocess,sys,tempfile,time,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4];SUPPORT=ROOT/'tests/hyperfide/support'
def load(name,file):
 s=importlib.util.spec_from_file_location(name,file);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
def uid():return str(uuid.uuid4())
def canonical(v):return json.dumps(v,sort_keys=True,separators=(',',':')).encode()
def sha(v):return 'sha256:'+hashlib.sha256(v if isinstance(v,bytes) else v.encode() if isinstance(v,str) else canonical(v)).hexdigest()
def write(p,v):p.write_bytes(canonical(v));p.chmod(0o600)
archive=load('interrupted_archive_primitives',ROOT/'tests/hyperfide/cases/source_control/archive_registration.py')
stackmod=load('interrupted_submission_stack',ROOT/'tests/hyperfide/integration/submission_stack.py')
worker=load('interrupted_native_http',SUPPORT/'fleet_archive_worker_fixture.py')
cloud=load('interrupted_sdk_http',SUPPORT/'source_archive_http_fixture.py')
runtime_module=load('interrupted_real_runtime',SUPPORT/'fleet_interrupted_install_runtime.py')
authority=load('interrupted_initial_authority',SUPPORT/'fleet_install_recovery_seed.py')
registration=load('interrupted_initial_registration',SUPPORT/'fleet_preparation_registration_seed.py')
def uid_pids(uid):
 found=[]
 for entry in Path('/proc').iterdir():
  if not entry.name.isdigit():continue
  try:status=(entry/'status').read_text();ids=next(line for line in status.splitlines() if line.startswith('Uid:')).split()[1:]
  except (OSError,StopIteration):continue
  if str(uid) in ids:found.append(int(entry.name))
 return found
def main():
 if not os.environ.get('DATABASE_URL'):return subprocess.run([sys.executable,str(SUPPORT/'withpg.py'),'--',sys.executable,str(Path(__file__).resolve())],cwd=ROOT).returncode
 if uid_pids(62181) or uid_pids(62182):raise RuntimeError('Dedicated interruption fixture UIDs are occupied')
 protected=Path('/var/lib/hyperfide/component-fixtures');protected.mkdir(mode=0o755,parents=True,exist_ok=True)
 if protected.is_symlink() or protected.stat().st_uid!=0 or protected.stat().st_mode&0o022:raise RuntimeError('Protected fixture runtime parent required')
 owned=Path(tempfile.mkdtemp(prefix='hf-install-interrupted-',dir=protected));owned.chmod(0o755);stack=None;backend=None;executor=None;handlers=None;checks=[];policy=None
 runtime=runtime_module.prepare_runtime(owned/'runtime',ROOT/'core/control-plane/dist')
 holder={}
 backend=cloud.BlaxelHttpFixture({'metadata':{'name':'pending-controlled-input'}},lambda p:holder['handlers'].resolve_path(p),lambda m,i,b:holder['handlers'].process_handler(m,i,b))
 def setup(f):
  config=f.path/'executor.json';write(config,{'schema_version':1,'principals':[{'credential_id':f.ids['provisioner'],'key_path':str(f.keys['provisioner']['path'])}],'concurrency':1})
  secrets=f.path/'secret-store';attachments=f.path/'attachments';secrets.mkdir(mode=0o700);attachments.mkdir(mode=0o700);credentials=f.path/'credentials.json';write(credentials,{'schema_version':1,'secret_root':str(secrets),'attachment_root':str(attachments),'sources':[],'targets':[]})
  limits={'SANDBOX':'100','PROVISIONING':'100','CPU_MILLIS':'100000','MEMORY_BYTES':'1099511627776','DISK_BYTES':'1099511627776'}
  pools=f.path/'pools.json';write(pools,{'schema_version':1,'organisation_id':f.ids['organisation'],'revision':'EXPLICIT_INTERRUPTION_FIXTURE_INPUT','accounts':[{'provider':'blaxel','account_key':'archive-fixture-account','approved_limits':limits,'planning_limits':limits}],'pools':[{'id':f.ids['pool'],'provider':'blaxel','account_key':'archive-fixture-account','environment_key':'archive-fixture-workspace','region':'us-pdx-1','profile_id':f.ids['profile'],'preparation_digest':f.preparation,'approved_limits':limits,'planning_limits':limits,'create_policy':{'seed_reference':'DECLARED_LOCAL_FILES','network':'ISOLATED','stdin_required':False}}],'maximum_operation_ms':300000})
  f.env.update(NODE_OPTIONS=(f.env.get('NODE_OPTIONS','')+' --import '+str(SUPPORT/'source_archive_sdk_transport.mjs')).strip(),HF_SOURCE_ARCHIVE_HTTP_FIXTURE=backend.endpoint,HF_SOURCE_ARCHIVE_FIXTURE_CWD=str(f.path),BL_DISABLE_H2='true',BL_DISABLE_CONTROL_PLANE_H2='true',HF_BLAXEL_LIVE_ENABLED='true',HF_BLAXEL_API_KEY='isolated-fixture-no-live-authority',HF_BLAXEL_WORKSPACE='archive-fixture-workspace',HF_BLAXEL_ACCOUNT_ID='archive-fixture-account',HF_CREDENTIAL_CONFIG_FILE=str(credentials),HF_RUNNER_EXECUTOR_CONFIG_FILE=str(config),HF_PROVISIONER_EXECUTOR_CONFIG_FILE=str(config),HYPERFIDE_POOL_CONFIG=str(pools),HYPERFIDE_SUPERVISOR_PYTHON='/usr/bin/python3')
  placement=f.path/'placement.json';write(placement,{**{k:json.loads(f.policy.read_text())[k] for k in ['schema_version','programme_id','repository','spec_revision','policy_revision']},'supervisory_host_id':'ISOLATED_COMPONENT_MAIN','restrictions':{'profile_digest':sha(b'ISOLATED_INPUT_NOT_MAIN_HOST_QUALIFICATION'),'evidence_digest':sha(b'ISOLATED_COMPONENT_INPUT'),'qualification':'QUALIFIED','expires_at':'2099-01-01T00:00:00.000Z'}});f.env['HF_PLACEMENT_POLICY_FILE']=str(placement);f.env['HF_EXECUTION_HOST_BINDING']=json.dumps({'host_id':'ISOLATED_COMPONENT_MAIN','kind':'SUPERVISORY','boot_generation':'1'})
 try:
  names=archive.components(['16.1','16.2','fleet-install','fleet-install-delivery','12.4-executor','12.4','10.3','1.1'])
  stack=stackmod.SubmissionStack(owned/'resources.json',['q1'],extra_components=names,before_start=setup,baseline_files=runtime_module.BASELINE_FILES,provider_config={'provider':'blaxel','account':'archive-fixture-account','workspace':'archive-fixture-workspace','region':'us-pdx-1','image_digest':runtime['image_digest'],'runtime_platform':'linux-amd64'})
  f=stack.fixture;i=f.ids;scope={'organisation_id':i['organisation'],'run_id':i['run']};claim=stack.claim('q1',upload=False);token=claim['token']
  def ok(action,value,component='fleet-install-delivery',key='operator'):
   status,response=f.invoke(action,value,component=component,key=key)
   if status!=200 or response.get('ok') is not True:raise AssertionError(action+': '+json.dumps(response.get('error',response)))
   return response['result']
  for object_id,kind in [(stack.baseline,'commit'),(stack.git('rev-parse',stack.baseline+'^{tree}'),'tree')]:
   if stack.git('cat-file','-t',object_id)!=kind:raise AssertionError('Measured initial Git object type differs')
   f.sql('INSERT INTO hyperfide.source_objects(organisation_id,repository_id,object_id,object_type) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[i['organisation'],i['repository'],object_id,kind])
  f.stop();f.service_role='provisioner';f.start()
  try:ok('provider.pools.configure',{},component='8.2',key='provisioner')
  finally:f.stop();f.service_role='control';f.start()
  for dimension,limit in {'CPU_MILLIS':'8000','MEMORY_BYTES':'17179869184','DISK_BYTES':'34359738368','PREPARATION':'2'}.items():
   f.sql("UPDATE hyperfide.capacity_accounts SET configured_limit=$4,qualification_state='QUALIFIED',provenance_digest=$5,state_version=state_version+1 WHERE organisation_id=$1 AND pool_id=$2 AND dimension=$3 AND capacity_class='EXECUTION'",[i['organisation'],i['pool'],dimension,limit,sha('explicit isolated scheduler budget input')])
  configuration=f.sql('SELECT configuration_digest FROM hyperfide.provider_pool_configurations WHERE organisation_id=$1 AND pool_id=$2 AND active',[i['organisation'],i['pool']])[0]['configuration_digest'];create_id=uid()
  operation={'schema_version':1,'kind':'create','scope':dict(organisation_id=i['organisation'],pool_id=i['pool'],provider='blaxel',provider_account_id='archive-fixture-account',environment_id='archive-fixture-workspace',region='us-pdx-1',configuration_digest=configuration),'deadline_at':datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z'),'identity':{k:create_id for k in ['operation_id','idempotency_key','correlation_id','causation_id']},'resource':None,'preparation_digest':f.preparation,'parameters':{'preparation_reference':'DECLARED_LOCAL_FILES','resources':{'cpu_millis':4000,'memory_bytes':'8589934592','disk_bytes':'21474836480','persistent_volume_bytes':'0'},'network':'ISOLATED','stdin_required':False}}
  normalize="import fs from 'node:fs';import{operationPayloadDigest,validateProviderOperation}from'./core/control-plane/dist/providers/contract.js';import{blaxelCreateName}from'./core/control-plane/dist/providers/blaxel/processes.js';const op=JSON.parse(fs.readFileSync(0,'utf8'));op.identity.payload_digest=operationPayloadDigest(op);validateProviderOperation(op);console.log(JSON.stringify({operation:op,native_sandbox_id:blaxelCreateName(op,'1')}));"
  create=json.loads(subprocess.check_output(['node','--input-type=module','-e',normalize],input=canonical(operation),cwd=ROOT));operation=create['operation'];create.update(configuration_digest=configuration,profile_id=i['profile'])
  backend.metadata={'metadata':{'name':create['native_sandbox_id'],'workspace':'archive-fixture-workspace','labels':{'hyperfide-operation':create_id,'hyperfide-payload':operation['identity']['payload_digest'],'hyperfide-scope':sha(operation['scope']),'hyperfide-boot':'1','hyperfide-preparation':f.preparation}},'spec':{'region':'us-pdx-1','enabled':True},'status':'RUNNING'}
  f.sql('UPDATE hyperfide.sandboxes SET native_sandbox_id=$3,state_version=state_version+1 WHERE organisation_id=$1 AND id=$2',[i['organisation'],token['sandbox_id'],create['native_sandbox_id']])
  parent=owned/'environment-parent';parent.mkdir(mode=0o700);os.chown(parent,62181,62181);environment=parent/'workspace';state=owned/'native-state';state.mkdir(mode=0o700);home=owned/'prep-home';temporary=owned/'prep-tmp';base=owned/'base';base.mkdir(mode=0o755)
  for directory in [home,temporary]:directory.mkdir(mode=0o700);os.chown(directory,62181,62181)
  env_id='isolated-interruption-'+uid();input_request={**{k:runtime[k] for k in ['node_path','node_version','npm_path','npm_version','native_path','runtime_files','image_digest']},'repository_path':str(stack.repository),'repository_id':i['repository'],'revision':stack.baseline,'authority_epoch':i['epoch'],'origin':f.origin,'environment_root':str(environment),'environment_id':env_id}
  inputs=json.loads(subprocess.check_output(['node',str(SUPPORT/'fleet_interrupted_install_inputs.mjs')],input=canonical(input_request),cwd=ROOT))
  context_bytes=canonical({'schema_version':1,'kind':'ISOLATED_PREPARATION_RUNTIME_INPUT','native_path':runtime['native_path'],'native_digest':runtime['native_digest'],'runtime_ready':False,'verifier_files':runtime['runtime_files']});context_id=stack.put(context_bytes)
  minimal=f.sql('SELECT p.id AS package_id,p.manager_session_id AS manager_id,h.owner_generation::text AS manager_generation,l.generation::text AS leader_generation FROM hyperfide.tasks t JOIN hyperfide.feature_packages p ON p.organisation_id=t.organisation_id AND p.run_id=t.run_id AND p.id=t.feature_package_id JOIN hyperfide.hierarchy_packages h ON h.organisation_id=p.organisation_id AND h.run_id=p.run_id AND h.package_id=p.id JOIN hyperfide.hierarchy_leaders l ON l.organisation_id=p.organisation_id AND l.run_id=p.run_id WHERE t.organisation_id=$1 AND t.run_id=$2 AND t.id=$3',[i['organisation'],i['run'],token['task_id']])[0]
  paths={'state_dir':str(state),'workspace_path':str(environment),'home_path':str(home),'tmp_path':str(temporary),'uid':62181,'gid':62181,'worker_uid':62182,'worker_gid':62182,'worker_source':str(environment/'workers/0/source'),'worker_home':str(environment/'workers/0/home'),'worker_tmp':str(environment/'workers/0/tmp'),'base_root':str(base),'readiness_context':{'artifact_id':context_id,'digest':sha(context_bytes),'size_bytes':str(len(context_bytes))}}
  registered=registration.seed(f,claim,runtime,inputs,paths,minimal);policy=Path(registered['policy_path']);ok('identity.runner.register',{'preparation_digest':f.preparation,'inventory':[{'kind':'ISOLATED_PREPARATION_SLOT_INPUT','slot_id':registered['slot_id'],'uid':paths['uid'],'gid':paths['gid'],'workspace_path':paths['workspace_path'],'workspace_exists':False,'state':'PREPARING'}]},component='14.1',key='runner');f.stop();f.start();manager=authority.seed_manager_inputs(f,stack,claim);authority.seed_historical_sandbox_ownership(f,manager,create)
  registered_spec=ok('fleet.install.register',{'package_kvx':inputs['package_kvx'],'source_config_kvx':inputs['source_config_kvx'],'source_manifest_digest':inputs['source_manifest_digest'],'plan_digest':inputs['plan_digest'],'install_plan':inputs['install_plan']},component='fleet-install')
  logical=uid();worker_root=environment/'workers/0';a={'schema_version':1,'kind':'hyperfide.fleet-install-admission','operation_id':logical,'logical_operation_id':logical,**scope,'environment_root':str(environment),'environment_id':env_id,'environment_generation':1,'sandbox_id':token['sandbox_id'],'boot_id':i['boot'],'boot_generation':token['sandbox_boot_generation'],'authority_epoch':i['epoch'],'input_digest':registered_spec['input_digest'],'package_digest':inputs['install_plan']['package_digest'],'source_config_digest':inputs['install_plan']['source_config_digest'],'plan_digest':inputs['plan_digest'],'source_revision':'git:'+stack.baseline,'source_manifest_digest':inputs['source_manifest_digest'],'read_scope':inputs['source_config']['workspace']['read_scope'],'write_scope':inputs['source_config']['workspace']['write_scope'],'slot_bindings':[{'slot':0,'worker_slot_id':registered['worker']['slot_id'],'slot_generation':'1','uid':62182,'gid':62182,'worker_root':str(worker_root),'source':paths['worker_source'],'home':paths['worker_home'],'temporary':paths['worker_tmp'],'build':str(worker_root/'build'),'dirty':str(worker_root/'dirty')}],'expires_at':(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(minutes=5)).isoformat(timespec='milliseconds').replace('+00:00','Z')};a['admission_digest']=sha(a);authority.seed_initial_admission(f,manager,a)
  print('DECLARED_CAPACITY_INPUTS '+json.dumps(f.sql('SELECT dimension,capacity_class,resource_key,qualification_state,configured_limit::text FROM hyperfide.capacity_accounts WHERE organisation_id=$1 AND pool_id=$2 ORDER BY capacity_class,dimension',[i['organisation'],i['pool']])),flush=True)
  allocation=ok('fleet.install.delivery.prepare.allocate',registered['allocation_request'])
  refs=[]
  for role,data in [('fleet.package',inputs['package_kvx'].encode()),('fleet.source-config',inputs['source_config_kvx'].encode()),('fleet.source-manifest',canonical(inputs['source_manifest'])),('fleet.interfaces',inputs['interfaces'].encode()),('fleet.interface-proof',canonical(inputs['interface_proof'])),('fleet.plan',canonical(inputs['install_plan']))]:refs.append({'role':role,'artifact_id':stack.put(data),'storage_kind':'object','digest':sha(data),'size_bytes':str(len(data))})
  ok('fleet.install.delivery.register',{'input_digest':registered_spec['input_digest'],'environment_id':env_id,'environment_generation':1,'sandbox_id':token['sandbox_id'],'boot_id':i['boot'],'boot_generation':token['sandbox_boot_generation'],'session_id':registered['session_id'],'reservation_id':allocation['allocation']['reservation_id'],'target_binding_id':allocation['target_binding_id'],'source':{'repository_key':i['repository'],'source_object_id':stack.baseline,'source_tree_id':stack.git('rev-parse',stack.baseline+'^{tree}'),'source_manifest_digest':inputs['source_manifest_digest']},'staging':refs,'timeout_ms':120000})
  config={'transport_config':str(owned/'transport.json'),'state_dir':str(state),'slot_root':str(owned/'slots'),'connector_plan_path':str(owned/'unused-plan.json'),**scope,'sandbox_id':token['sandbox_id'],'boot_id':i['boot'],'boot_generation':token['sandbox_boot_generation'],'consumer_id':uid(),'preparation_recipes':{'environment.prepare.v1':registered['recipe']}}
  write(owned/'transport.json',{'origin':f.origin,'ca_file':str(f.ca),'key_path':str(f.keys['runner']['path']),'credential_id':i['runner'],'timeout_ms':10000});write(state/'runner.json',config);(owned/'slots').mkdir(mode=0o711)
  handlers=worker.NativeArchiveWorkerHandlers([owned,f.path,Path('/tmp/hyperfide-output/1')],[Path('/usr/bin/python3').resolve(),Path(shutil.which('node')).resolve(),Path(runtime['native_path'])],{'PATH':str(Path(shutil.which('node')).parent)+':/usr/bin:/bin','LANG':'C.UTF-8'},owned/'process-output');holder['handlers']=handlers
  ok('fleet.install.delivery.schedule',{'operation_id':logical})
  def heartbeat():
   version=f.sql('SELECT state_version::text FROM hyperfide.identity_runner_status WHERE credential_id=$1',[i['runner']])[0]['state_version'];ok('identity.runner.heartbeat',{'expected_version':version},component='14.1',key='runner')
  heartbeat()
  stderr=(owned/'executor.stderr').open('w+');executor=subprocess.Popen(['node',str(SUPPORT/'archive_executor_process.mjs'),str(ROOT/'core/control-plane/dist'),str(f.components),str(f.policy)],cwd=f.path,env=f.env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=stderr,text=True,bufsize=1)
  staging=parent/('.hyperfide-install-'+sha(env_id+':1:'+inputs['plan_digest'])[7:31]);marker=staging/'.installer-home/interrupted-install-ready';deadline=time.monotonic()+60;pid=None
  while time.monotonic()<deadline:
   heartbeat()
   state_rows=f.sql('SELECT state FROM hyperfide.runner_remote_jobs WHERE organisation_id=$1 AND run_id=$2 AND operation_id=$3',[i['organisation'],i['run'],logical])
   if state_rows and state_rows[0]['state'] in ['COMPLETED','UNKNOWN']:break
   if marker.exists() and (state/'jobs.db').exists():
    with sqlite3.connect(state/'jobs.db') as db:row=db.execute('SELECT pid FROM jobs WHERE id=?',(logical,)).fetchone()
    if row and row[0]:pid=row[0];break
   if executor.poll() is not None:raise AssertionError('Executor died: '+(owned/'executor.stderr').read_text()[-2000:])
   time.sleep(.2)
  if not pid:
   executor.stdin.write(json.dumps({'id':'failed-stage-status','operation':'status'})+'\n');executor.stdin.flush()
   status_line=executor.stdout.readline()
   jobs=f.sql('SELECT state,result FROM hyperfide.runner_remote_jobs WHERE organisation_id=$1 AND run_id=$2 AND operation_id=$3',[i['organisation'],i['run'],logical])
   raise AssertionError('Actual dependency stage not reached: '+status_line+' jobs='+json.dumps(jobs)+' processes='+json.dumps([handlers.describe(name) for name in handlers.processes])+' transport='+json.dumps({'requests':backend.requests,'errors':handlers.observations,'observations':f.sql('SELECT observation FROM hyperfide.provider_remote_observations')})+' stderr='+(owned/'executor.stderr').read_text()[-2000:])
  prior_ledger=(staging.with_name(staging.name+'.ledger.json')).read_bytes();baseline_lock=(staging/'source/package-lock.json').read_bytes();os.kill(pid,signal.SIGKILL)
  deadline=time.monotonic()+40;failed=None
  while time.monotonic()<deadline:
   heartbeat();rows=f.sql('SELECT state,result,result_digest FROM hyperfide.runner_remote_jobs WHERE organisation_id=$1 AND run_id=$2 AND operation_id=$3',[i['organisation'],i['run'],logical])
   if rows and rows[0]['state'] in ['COMPLETED','UNKNOWN']:failed=rows[0];break
   time.sleep(.2)
  if not failed or failed['state']!='COMPLETED' or failed['result']['outcome']!='FAILED' or failed['result']['cleanup']['complete'] is not True or failed['result']['cleanup']['observed_process_absent'] is not True:raise AssertionError('Real interrupted owner did not produce signed FAILED/quiescence: '+json.dumps(failed))
  checks.append('actual recipe SIGKILL retained native owner produced signed FAILED and confirmed quiescence')
  old_plan=f.sql('SELECT plan_digest FROM hyperfide.runner_remote_jobs WHERE organisation_id=$1 AND run_id=$2 AND operation_id=$3',[i['organisation'],i['run'],logical])[0]['plan_digest']
  recovery={'install_operation_id':logical,'admission_digest':a['admission_digest'],'runner_operation_id':logical,'runner_plan_digest':old_plan,'quiescence_operation_id':logical,'quiescence_receipt_digest':failed['result']['cleanup']['receipt_digest']}
  install_input={'input_digest':a['input_digest'],'environment_id':env_id,'environment_generation':1,'sandbox_id':a['sandbox_id'],'boot_id':a['boot_id'],'boot_generation':a['boot_generation'],'ttl_seconds':300,'slot_bindings':[{'slot':0,'worker_slot_id':registered['worker']['slot_id']}]}
  decision=authority.admitted_recovery_decision_input(f,manager,install_input,recovery);status,response=authority.apply_recovery(f,decision)
  if status!=200 or response.get('ok') is not True:raise AssertionError('Actual recovery admission refused '+json.dumps(response))
  replacement=response['result']['admission'];newop=replacement['operation_id']
  if newop==logical or replacement['logical_operation_id']!=logical:raise AssertionError('Recovery reused interrupted execution identity')
  checks.append('actual recovery admission preserved predecessor and issued distinct linked execution')
  ok('fleet.install.delivery.schedule',{'operation_id':newop});deadline=time.monotonic()+90;success=None
  while time.monotonic()<deadline:
   heartbeat();rows=f.sql('SELECT state,result FROM hyperfide.runner_remote_jobs WHERE organisation_id=$1 AND run_id=$2 AND operation_id=$3',[i['organisation'],i['run'],newop])
   if rows and rows[0]['state'] in ['COMPLETED','UNKNOWN']:success=rows[0];break
   time.sleep(.2)
  if not success or success['state']!='COMPLETED' or success['result']['outcome']!='SUCCEEDED':raise AssertionError('Replacement execution failed '+json.dumps(success))
  collected=ok('fleet.install.delivery.collect',{'operation_id':newop})
  if collected.get('state')!='READY' or (environment/'source/package-lock.json').read_bytes()!=baseline_lock:raise AssertionError('Resumed source pins or readiness differ')
  histories=list(parent.glob(staging.name+'.recovery-*.json'))
  if not any(p.read_bytes()==prior_ledger for p in histories):raise AssertionError('Original stage evidence was overwritten')
  checks.extend(['actual replacement recipe reused retained stage and completed native readiness','original source lock bytes and interrupted stage evidence retained'])
  print(json.dumps({'status':'PASS','scope':'controlled-SDK actual-native interrupted-install component boundary','fixture_preconditions':['accepted initial graph/admission/identity/ownership/capacity metadata','labeled admitted recovery decision input; no model claim'],'checks':checks}))
  return 0
 finally:
  if executor:
   executor.terminate()
   try:executor.wait(timeout=10)
   except subprocess.TimeoutExpired:executor.kill();executor.wait(timeout=5)
  if handlers:handlers.close()
  for process_id in uid_pids(62181)+uid_pids(62182):
   try:os.kill(process_id,signal.SIGKILL)
   except ProcessLookupError:pass
  if backend:backend.close()
  if stack:stack.close()
  if policy:policy.unlink(missing_ok=True)
  if checks and len(checks)>=4:shutil.rmtree(owned,ignore_errors=True)
  else:print('RETAINED_FAILED_COMPONENT_ROOT '+str(owned),file=sys.stderr)
if __name__=='__main__':raise SystemExit(main())
