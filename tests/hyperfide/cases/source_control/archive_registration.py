#!/usr/bin/env python3
"""Real PG, signed API, native executor and SDK HTTP boundary backed by actual local Unix execution."""
import base64,copy,hashlib,importlib.util,json,os,select,shutil,signal,subprocess,sys,tempfile,time,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4];SUPPORT=ROOT/'tests/hyperfide/support'
def load(name,path):
 s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
stackmod=load('archive_submission_stack',ROOT/'tests/hyperfide/integration/submission_stack.py');worker=load('archive_native_worker',SUPPORT/'fleet_archive_worker_fixture.py');cloud=load('archive_sdk_http',SUPPORT/'source_archive_http_fixture.py');seedmod=load('archive_historical_registration',SUPPORT/'source_archive_registration_seed.py')
def uid():return str(uuid.uuid4())
def sha(x):return 'sha256:'+hashlib.sha256(x if isinstance(x,bytes) else json.dumps(x,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def write(file,value):file.write_text(json.dumps(value));file.chmod(0o600)
def components(ids):
 definitions={}
 for p in (ROOT/'core/control-plane/components').glob('*.json'):
  d=json.loads(p.read_text())
  if 'id' in d:definitions[d['id']]=(p.stem,d)
 selected=set()
 def include(i):
  if i in selected:return
  selected.add(i)
  for r in definitions[i][1]['requires']:include(r)
 for i in ids:include(i)
 return [definitions[i][0] for i in sorted(selected)]
def main():
 native_file=os.environ.get('HF_ARCHIVE_NATIVE_BINARY');native_pin=os.environ.get('HF_ARCHIVE_NATIVE_DIGEST')
 if not native_file or not native_pin:print('SKIP: set HF_ARCHIVE_NATIVE_BINARY and HF_ARCHIVE_NATIVE_DIGEST to the immutable production artifact');return 77
 native_file=Path(native_file).resolve();assert native_file.is_file() and sha(native_file.read_bytes())==native_pin,'Selected native artifact differs from explicit immutable pin'
 if not os.environ.get('DATABASE_URL'):return subprocess.run([sys.executable,str(SUPPORT/'withpg.py'),'--',sys.executable,str(Path(__file__).resolve())],cwd=ROOT).returncode
 fixture_root=Path('/var/lib/hf-cf');fixture_root.mkdir(parents=True,exist_ok=True,mode=0o755)
 owned=Path(tempfile.mkdtemp(prefix='a-',dir=fixture_root));owned.chmod(0o755);state={'handler':None,'mode':None};backend=None;stack=None;executor=None;checks=[];physical_boot=None
 def process(method,identifier,body):
  answer=state['handler'].process_handler(method,identifier,body)
  if method=='POST' and body and body.get('name','').startswith('hf-source-archive-') and state['mode']=='postsubmit':
   state['postsubmit_loss_observed']=True;raise OSError('Controlled final response loss after actual producer submission')
  if method=='GET' and identifier and identifier.startswith('hf-source-archive-') and answer[0]==200:
   if state['mode']=='wrong-command':return 200,dict(answer[1],command=answer[1]['command']+' --forged')
   if state['mode']=='forged-stdout' and answer[1].get('status')=='completed':
    receipt=json.loads(answer[1]['stdout']);receipt['archive_digest']='sha256:'+'0'*64;return 200,dict(answer[1],stdout=json.dumps(receipt,sort_keys=True,separators=(',',':')))
  return answer
 def resolve(path):
  if state['mode']=='preexec' and path=='/opt/hyperfide/runtime/node':raise OSError('Controlled pre-submission runtime read failure')
  return state['handler'].resolve_path(path)
 backend=cloud.BlaxelHttpFixture({'metadata':{'name':'waiting-actual-claim'}},resolve,process)
 def setup(f):
  auth=f.path/'auth-home';auth.mkdir(mode=0o700);os.chown(auth,62173,62173);secrets=f.path/'secret-store';attachments=f.path/'attachments';secrets.mkdir(mode=0o700);attachments.mkdir(mode=0o700)
  profile={'schema_version':1,'profile_id':'fixture-declared-python','profile_revision':'1','connector':'claude','auth_mode':'account_session','binary':{'path':str(Path('/usr/bin/python3').resolve()),'digest':sha(Path('/usr/bin/python3').resolve().read_bytes()),'version':subprocess.check_output(['/usr/bin/python3','--version'],text=True).strip()},'credential_reference':'fixture-no-credential-resolution','configured_provider_id':'fixture-local','configured_model_alias':'fixture-no-model','requested_model_id':'fixture-no-model','permission_profile_id':'fixture-local-source','capabilities':{'unattended':True,'refresh':False,'concurrent_account':False,'portable_session':False,'explicit_resume':False},'runtime_home':str(auth),'target_uid':62173,'configured_account_key':'fixture-local'}
  profiles=f.path/'profiles.json';write(profiles,{'schema_version':1,'profiles':[profile]});credentials=f.path/'credentials.json';write(credentials,{'schema_version':1,'secret_root':str(secrets),'attachment_root':str(attachments),'sources':[],'targets':[]})
  executor_config=f.path/'executor.json';write(executor_config,{'schema_version':1,'principals':[{'credential_id':f.ids['provisioner'],'key_path':str(f.keys['provisioner']['path'])}],'concurrency':1})
  limits={'SANDBOX':'100','PROVISIONING':'100','CPU_MILLIS':'100000','MEMORY_BYTES':'1099511627776','DISK_BYTES':'1099511627776'}
  policy=f.path/'pools.json';write(policy,{'schema_version':1,'organisation_id':f.ids['organisation'],'revision':'ISOLATED_COMPONENT_DECLARED_PROFILE','accounts':[{'provider':'blaxel','account_key':'archive-fixture-account','approved_limits':limits,'planning_limits':limits}],'pools':[{'id':f.ids['pool'],'provider':'blaxel','account_key':'archive-fixture-account','environment_key':'archive-fixture-workspace','region':'us-pdx-1','profile_id':f.ids['profile'],'preparation_digest':f.preparation,'approved_limits':limits,'planning_limits':limits,'create_policy':{'seed_reference':'ISOLATED_NOT_LIVE','network':'ISOLATED','stdin_required':False}}],'maximum_operation_ms':3600000})
  retention=f.path/'retention.json';write(retention,{'schema_version':1,'organisation_id':f.ids['organisation'],'policy_id':uid(),'policy_revision':1,'minimum_age_ms':{'EPHEMERAL':0,'RUN':0,'RELEASE':0,'LEGAL_HOLD':None}})
  f.env.update(NODE_OPTIONS=(f.env.get('NODE_OPTIONS','')+' --import '+str(SUPPORT/'source_archive_sdk_transport.mjs')).strip(),HF_SOURCE_ARCHIVE_HTTP_FIXTURE=backend.endpoint,HF_SOURCE_ARCHIVE_FIXTURE_CWD=str(f.path),BL_DISABLE_H2='true',BL_DISABLE_CONTROL_PLANE_H2='true',HF_BLAXEL_LIVE_ENABLED='true',HF_BLAXEL_API_KEY='isolated-fixture-token-no-live-authority',HF_BLAXEL_WORKSPACE='archive-fixture-workspace',HF_BLAXEL_ACCOUNT_ID='archive-fixture-account',HF_NATIVE_AUTH_PROFILES_FILE=str(profiles),HF_CREDENTIAL_CONFIG_FILE=str(credentials),HF_RUNNER_EXECUTOR_CONFIG_FILE=str(executor_config),HF_PROVISIONER_EXECUTOR_CONFIG_FILE=str(executor_config),HYPERFIDE_POOL_CONFIG=str(policy),HF_ARTIFACT_RETENTION_POLICY_FILE=str(retention),HYPERFIDE_SUPERVISOR_PYTHON='/usr/bin/python3')
  placement=f.path/'placement.json';write(placement,{**{k:json.loads(f.policy.read_text())[k] for k in ['schema_version','programme_id','repository','spec_revision','policy_revision']},'supervisory_host_id':'ISOLATED_COMPONENT_MAIN','restrictions':{'profile_digest':sha(b'DECLARED_COMPONENT_NOT_MAIN_QUALIFICATION'),'evidence_digest':sha(b'ISOLATED_COMPONENT_PRECONDITION'),'qualification':'QUALIFIED','expires_at':'2099-01-01T00:00:00.000Z'}});f.env['HF_PLACEMENT_POLICY_FILE']=str(placement);f.env['HF_EXECUTION_HOST_BINDING']=json.dumps({'host_id':'ISOLATED_COMPONENT_MAIN','kind':'SUPERVISORY','boot_generation':'1'})
 try:
  names=components(['16.1','16.2','15.4','13.4.dispatch','6.3','12.4-capture','12.4-executor','10.3','1.1'])
  baseline_files={'worker.py':worker.WORKER_SOURCE,'README':b'accepted baseline\n'}
  stack=stackmod.SubmissionStack(owned/'resources.json',['q1'],extra_components=names,before_start=setup,baseline_files=baseline_files,provider_config={'provider':'blaxel','account':'archive-fixture-account','workspace':'archive-fixture-workspace','region':'us-pdx-1'})
  f=stack.fixture;i=f.ids;scope={'organisation_id':i['organisation'],'run_id':i['run']}
  def ok(action,value,component='16.1',key='operator'):
   answer=f.invoke(action,value,component=component,key=key)[1];assert answer.get('ok'),answer;return answer['result']
  def reject(value,code,contains=None):
   answer=f.invoke('submission.archive.register',value,component='16.1')[1];assert answer.get('ok') is False and answer['error']['code']==code,answer
   if contains:assert contains in answer['error']['message'],answer
   return answer
  claim=stack.claim('q1',upload=False);token=claim['token'];consumer=uid();ok('instructions.consumer.register',dict(scope,consumer_id=consumer),component='6.3',key='runner')
  transport=owned/'transport.json';write(transport,{'origin':f.origin,'ca_file':str(f.ca),'key_path':str(f.keys['runner']['path']),'credential_id':i['runner'],'timeout_ms':10000})
  identity=dict(scope,sandbox_id=token['sandbox_id'],boot_id=i['boot'],boot_generation=token['sandbox_boot_generation'],slot_id=token['slot_id'],task_id=token['task_id'],attempt_id=token['attempt_id'],attempt_generation=token['attempt_generation'],authority_epoch=token['authority_epoch'],session_id=claim['session'])
  native=worker.prepare_native_manifest_launch(owned/'physical',identity,transport,consumer,'git:'+stack.baseline,sha(b'actual-source-manifest-fixture'),b'{}\n',stack.baseline,stack.git('rev-parse',stack.baseline+'^{tree}'),62171,62171,baseline_files=baseline_files)
  native['native_binary']=str(native_file)
  handlers=worker.NativeArchiveWorkerHandlers([owned,f.path,Path('/tmp/hyperfide-output/1'),Path('/var/lib/hyperfide/bootstrap')],[Path('/usr/bin/python3').resolve(),Path(shutil.which('node')).resolve(),Path(native['runtime'])/'node',Path(native['native_binary']).resolve()],{'PATH':str(Path(shutil.which('node')).parent)+':/usr/bin:/bin','LANG':'C.UTF-8'},owned/'process-output')
  shutil.copyfile(ROOT/'core/control-plane/dist/artifacts/fleet_source_archive.js',Path(native['runtime'])/'fleet_source_archive.js');(Path(native['runtime'])/'fleet_source_archive.js').chmod(0o444)
  handlers.path_resolver=lambda path:Path(native['runtime'])/'node' if path=='/opt/hyperfide/runtime/node' else Path(native['runtime'])/'fleet_source_archive.js' if path=='/opt/hyperfide/runtime/fleet_source_archive.js' else Path(native['runtime']) if path=='/opt/hyperfide/runtime' else Path(path)
  state['handler']=handlers
  f.stop();f.service_role='provisioner';f.start()
  try:ok('provider.pools.configure',{},component='8.2',key='provisioner')
  finally:f.stop();f.service_role='control';f.start()
  configuration=f.sql('SELECT configuration_digest FROM hyperfide.provider_pool_configurations WHERE organisation_id=$1 AND pool_id=$2 AND active',[i['organisation'],i['pool']])[0]['configuration_digest']
  create_scope=dict(scope,pool_id=i['pool'],provider='blaxel',provider_account_id='archive-fixture-account',environment_id='archive-fixture-workspace',region='us-pdx-1',configuration_digest=configuration);create_id=uid()
  operation={'schema_version':1,'kind':'create','scope':{k:v for k,v in create_scope.items() if k!='run_id'},'deadline_at':__import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z'),'identity':{k:create_id for k in ['operation_id','idempotency_key','correlation_id','causation_id']},'resource':None,'preparation_digest':f.preparation,'parameters':{'preparation_reference':'ISOLATED_DECLARED_PROFILE','resources':{'cpu_millis':4000,'memory_bytes':'8589934592','disk_bytes':'21474836480','persistent_volume_bytes':'0'},'network':'ISOLATED','stdin_required':False}}
  normalize="import fs from 'node:fs';import{operationPayloadDigest,validateProviderOperation}from'./core/control-plane/dist/providers/contract.js';import{blaxelCreateName}from'./core/control-plane/dist/providers/blaxel/processes.js';const op=JSON.parse(fs.readFileSync(0,'utf8'));op.identity.payload_digest=operationPayloadDigest(op);validateProviderOperation(op);console.log(JSON.stringify({operation:op,native_sandbox_id:blaxelCreateName(op,'1')}));"
  actual=json.loads(subprocess.check_output(['node','--input-type=module','-e',normalize],input=json.dumps(operation).encode(),cwd=ROOT));operation=actual['operation'];native['provider_create']={'operation':operation,'configuration_digest':configuration,'profile_id':i['profile'],'native_sandbox_id':actual['native_sandbox_id']}
  projection=seedmod.seed(f,stack,claim,native)
  metadata={'metadata':{'name':actual['native_sandbox_id'],'workspace':'archive-fixture-workspace','labels':{'hyperfide-operation':create_id,'hyperfide-payload':operation['identity']['payload_digest'],'hyperfide-scope':sha(operation['scope']),'hyperfide-boot':'1','hyperfide-preparation':f.preparation}},'spec':{'region':'us-pdx-1','enabled':True},'status':'RUNNING'};backend.metadata=metadata
  physical_boot=Path(projection['bootstrap_state_root'])/token['sandbox_id']/i['boot'];physical_boot.mkdir(parents=True,exist_ok=True,mode=0o700)
  module=(ROOT/'core/control-plane/dist/artifacts/fleet_source_archive.js').read_bytes();module_id=stack.put(module);policy={'schema_version':1,'node_path':'/opt/hyperfide/runtime/node','node_digest':sha(Path(native['runtime']).joinpath('node').read_bytes()),'module_path':'/opt/hyperfide/runtime/fleet_source_archive.js','module_digest':sha(module),'module_artifact':{'artifact_id':module_id,'storage_kind':'object','digest':sha(module),'size_bytes':str(len(module))},'request_root':str(Path(projection['bootstrap_state_root'])),'loader_path':None,'max_files':1000,'max_bytes':1048576,'excluded_paths':['.neron'],'timeout_ms':60000};policy_file=f.path/'source-archive-policy.json';write(policy_file,policy);f.env['HF_FLEET_SOURCE_ARCHIVE_POLICY_FILE']=str(policy_file)
  f.stop();f.start()
  start=dict(scope,id=projection['command_id'],attempt_id=token['attempt_id'],attempt_generation=token['attempt_generation'],authority_epoch=token['authority_epoch'],sandbox_boot_generation=token['sandbox_boot_generation'],kind='START',body={'launch_id':projection['launch_id'],'slot_id':token['slot_id'],'agent_session_id':claim['session'],'connector_plan_digest':native['native_plan_digest']})
  ok('instructions.issue',start,component='6.3')
  observation=f.sql('SELECT session_id,slot_id,repository_id,launch_id,state_dir,runner_binary,workspace_path,home_path,tmp_path,runner_binary_digest,preparation_digest,readiness_digest,source_digest,source_object_id,source_tree_id,slot_generation::text,uid,gid FROM hyperfide.runner_registry WHERE organisation_id=$1 AND run_id=$2 AND session_id=$3',[i['organisation'],i['run'],projection['runner_session']])[0]
  ok('identity.runner.register',{'preparation_digest':f.preparation,'inventory':[observation]},component='14.1',key='runner')
  polled=ok('instructions.runner.poll',dict(scope,limit=16,lease_ms=1000),component='6.3',key='runner');assert any(command['event_id']==projection['command_id'] for command in polled['commands']),polled
  fetched=ok('agent.launch-plan.fetch',{'command_id':projection['command_id'],'launch_id':projection['launch_id']},component='13.4.dispatch',key='runner');assert fetched['connector_plan_digest']==native['native_plan_digest'],fetched
  ok('placement.runner.authorize',{'runner_action':'runner.agent.launch'},component='1.1',key='runner')
  print('EXECUTOR_PRINCIPAL_PRECONDITION '+json.dumps(f.sql("SELECT p.role,p.state,p.attempt_id,p.deployment_epoch=r.authority_epoch AS epoch_current,p.expires_at>clock_timestamp() AS unexpired,'provider.remote.execute-bound'=ANY(p.allowed_actions) AS execute_bound_allowed,r.state AS run_state FROM hyperfide.identity_principals p JOIN hyperfide.runs r ON r.organisation_id=p.organisation_id AND r.id=p.run_id WHERE p.credential_id=$1",[i['provisioner']])),flush=True)
  log=(owned/'executor.stderr').open('w+');executor=subprocess.Popen(['node',str(SUPPORT/'archive_executor_process.mjs'),str(ROOT/'core/control-plane/dist'),str(f.components),str(f.policy)],cwd=f.path,env=f.env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=log,text=True,bufsize=1)
  started=time.time();deadline=started+45
  while time.time()<deadline:
   rows=f.sql('SELECT state,failure_code,result FROM hyperfide.fleet_worker_launches WHERE organisation_id=$1 AND run_id=$2 AND command_id=$3',[i['organisation'],i['run'],projection['command_id']])
   if rows and rows[0]['state'] in ['COMPLETED','UNKNOWN','REFUSED']:break
   if not rows and time.time()-started>5:break
   if executor.poll() is not None:raise AssertionError('Actual executor exited: '+(owned/'executor.stderr').read_text()[-2000:])
   time.sleep(.2)
  if not rows or rows[0]['state']!='COMPLETED':
   executor.stdin.write(json.dumps({'id':uid(),'operation':'status'})+'\n');executor.stdin.flush();ready,_,_=select.select([executor.stdout],[],[],10);diagnostic=executor.stdout.readline() if ready else 'STATUS_TIMEOUT';print('EXECUTOR_DIAGNOSTIC '+diagnostic,flush=True)
   print('PENDING_START_DIAGNOSTIC '+json.dumps(f.sql("SELECT n.command_id,n.plan->'readiness'->>'kind' AS kind,e.event_type FROM hyperfide.native_launch_plans n LEFT JOIN hyperfide.outbox_events e ON e.organisation_id=n.organisation_id AND e.run_id=n.run_id AND e.id=n.command_id WHERE n.organisation_id=$1 AND n.run_id=$2",[i['organisation'],i['run']])),flush=True)
   print('SDK_REQUEST_DIAGNOSTIC '+json.dumps(backend.requests),flush=True)
   print('ACTUAL_PROCESS_DIAGNOSTIC '+json.dumps({key:{field:value for field,value in handlers.describe(key).items() if field in ('status','exitCode','stdout','stderr')} for key in handlers.processes}),flush=True)
   print('ACTUAL_NATIVE_CAPTURE_DIAGNOSTIC '+json.dumps({name:{stream:(Path('/tmp/hyperfide-output/1')/name/stream).read_text()[:4096] for stream in ('stdout','stderr') if (Path('/tmp/hyperfide-output/1')/name/stream).is_file()} for name in handlers.processes}),flush=True)
   from urllib.parse import urlparse,parse_qs
   pglog=Path(parse_qs(urlparse(os.environ['DATABASE_URL']).query)['host'][0])/'server.log';print('POSTGRES_ERROR_DIAGNOSTIC '+json.dumps([line for line in pglog.read_text().splitlines() if 'ERROR:' in line or 'STATEMENT:' in line][-12:]),flush=True)
  assert rows and rows[0]['state']=='COMPLETED',(rows,(owned/'executor.stderr').read_text()[-2000:]);checks.append('actual SDK/native foreground worker produced production signed completion')
  launch=projection['launch_id'];stop_id=uid();stop_request={'command_id':stop_id,'action':'runner.stop','launch_id':launch,'slot_id':token['slot_id'],'sandbox_id':token['sandbox_id'],'boot_generation':'1','attempt_id':token['attempt_id'],'attempt_generation':token['attempt_generation'],'policy':{'grace_ms':100,'drain_deadline_ms':1000,'on_drain_deadline':'REPORT'},'required_outputs':['launch.stdout','launch.stderr']};ok('runner.control.issue',stop_request,component='12.4-capture')
  def native_call(action,operation):
   request={'id':uid(),'operation':'native','input':{'session_id':projection['runner_session'],'operation_id':operation,'action':action,'command_id':stop_id,'launch_id':launch}};executor.stdin.write(json.dumps(request)+'\n');executor.stdin.flush();ready,_,_=select.select([executor.stdout],[],[],40);assert ready,'Native component timed out';result=json.loads(executor.stdout.readline())
   if not result.get('ok'):
    print('NATIVE_PROVIDER_JOURNAL '+json.dumps(f.sql('SELECT state,outcome FROM hyperfide.provider_remote_operations WHERE organisation_id=$1 AND run_id=$2 AND id=$3',[i['organisation'],i['run'],operation])),flush=True)
    print('NATIVE_PROVIDER_PROCESS '+json.dumps({name:{k:v for k,v in handlers.describe(name).items() if k in ('status','exitCode','stdout','stderr')} for name in handlers.processes}),flush=True)
   assert result.get('ok'),result;return result['result']
  quiescence=uid();native_call('runner.stop',quiescence)
  selection=dict(scope,request_id=uid(),task_id=token['task_id'],attempt_id=token['attempt_id'],attempt_generation=token['attempt_generation'],session_id=claim['session'],launch_id=launch,command_id=stop_id,quiescence_operation_id=quiescence)
  reject(dict(selection,archive={'forged':'caller receipt'}),'INVALID_REQUEST')
  reject(dict(selection,request_id=uid(),attempt_generation='2'),'QUALIFICATION_ARCHIVE_STALE')
  state['mode']='preexec';reject(selection,'HANDLER_FAILED','status 500');state['mode']=None
  journal=f.sql('SELECT state FROM hyperfide.fleet_source_archive_deliveries WHERE organisation_id=$1 AND run_id=$2 AND operation_id=$3',[i['organisation'],i['run'],selection['request_id']]);assert journal[0]['state']=='PINNED',journal
  state['mode']='postsubmit'
  reject(selection,'HANDLER_FAILED','status 500');assert state.get('postsubmit_loss_observed') is True,'Expected final-response fault was not reached'
  actual_producers=[name for name in handlers.processes if name.startswith('hf-source-archive-')];assert len(actual_producers)==1,actual_producers
  producer_deadline=time.time()+10
  while handlers.describe(actual_producers[0])['status']=='running' and time.time()<producer_deadline:time.sleep(.1)
  assert handlers.describe(actual_producers[0])['exitCode']==0,handlers.describe(actual_producers[0])
  state['mode']='wrong-command';reject(selection,'SOURCE_ARCHIVE_PROCESS_CONFLICT');state['mode']='forged-stdout';reject(selection,'SOURCE_ARCHIVE_BYTES_INVALID');state['mode']=None
  registered=ok('submission.archive.register',selection);archive=registered['archive'];assert registered['submission']['submission']['authority']=='ACTIVE',registered
  same=ok('submission.archive.register',selection);assert same['replayed'] is True and same['archive']['id']==archive['id'],same
  archive_processes=[name for name in handlers.processes if name.startswith('hf-source-archive-')];assert len(archive_processes)==1,archive_processes;checks.append('pre-exec failure retries and post-submit uncertainty reconciles same actual producer exactly once')
  links=f.sql('SELECT artifact_id FROM hyperfide.fleet_source_archive_artifacts WHERE organisation_id=$1 AND run_id=$2 AND archive_id=$3',[i['organisation'],i['run'],archive['id']]);linked_ids={link['artifact_id'] for link in links}
  signed=f.sql('SELECT result FROM hyperfide.fleet_worker_launches WHERE organisation_id=$1 AND run_id=$2 AND command_id=$3',[i['organisation'],i['run'],projection['command_id']])[0]['result'];semantic_ids={signed[name]['artifact_id'] for name in ('stdout','stderr')};assert all(signed[name]['complete'] is True for name in ('stdout','stderr'))
  required=f.sql('SELECT required_outputs FROM hyperfide.runner_control_commands WHERE organisation_id=$1 AND run_id=$2 AND command_id=$3',[i['organisation'],i['run'],stop_id])[0]['required_outputs'];captures=f.sql('SELECT name,state,manifest_artifact_id FROM hyperfide.runner_output_captures WHERE organisation_id=$1 AND run_id=$2 AND command_id=$3',[i['organisation'],i['run'],stop_id]);assert required and all(any(capture['name']==name and capture['state']=='COMPLETE' for capture in captures) for name in required),captures
  semantic_ids.update(capture['manifest_artifact_id'] for capture in captures if capture['name'] in required);expected_ids=semantic_ids|{archive['archive_artifact_id'],archive['capture_receipt_artifact_id']};assert expected_ids<=linked_ids,(expected_ids,linked_ids)
  assurance=f.sql('SELECT manifest FROM hyperfide.assurance_submissions WHERE organisation_id=$1 AND run_id=$2 AND custody_id=$3',[i['organisation'],i['run'],archive['custody_id']])[0]['manifest'];assert expected_ids<=set(assurance['evidence_artifact_ids']),assurance
  root=ok('artifact.object.read',dict(scope,artifact_id=archive['archive_artifact_id']),component='15.2');assert root['availability']=='VERIFIED' and root['artifact']['status']=='COMPLETE',root
  parts=[]
  if 'data_base64' in root:parts.append(base64.b64decode(root['data_base64'],validate=True))
  else:
   for part in root['manifest']['chunks']:
    stored=ok('artifact.object.read',dict(scope,artifact_id=part['artifact_id']),component='15.2');content=base64.b64decode(stored['data_base64'],validate=True);assert stored['availability']=='VERIFIED' and sha(content)==part['digest'] and len(content)==int(part['size_bytes']),stored;parts.append(content)
  capsule_bytes=b''.join(parts);assert sha(capsule_bytes)==archive['archive_digest']==root.get('content_digest',root['artifact']['digest']);capsule=json.loads(capsule_bytes);changed=[entry for entry in capsule['files'] if entry['path']=='src/q1.ts'];assert len(changed)==1 and base64.b64decode(changed[0]['content_base64'],validate=True)==b'export const value = 42;\n',changed
  checks.append('verified artifact reconstruction preserves actual generated file and exact signed worker/STOP evidence roots')
  retention_pin=sha(Path(f.env['HF_ARTIFACT_RETENTION_POLICY_FILE']).read_bytes())
  for link in links:
   payload=dict(scope,artifact_id=link['artifact_id'],policy_digest=retention_pin);inspection=ok('artifact.retention.inspect',payload,component='15.4');assert 'SOURCE_ARCHIVE_CUSTODY' in inspection['blockers'],inspection
   version=f.sql('SELECT state_version::text FROM hyperfide.artifacts WHERE organisation_id=$1 AND run_id=$2 AND id=$3',[i['organisation'],i['run'],link['artifact_id']])[0]['state_version'];collected=ok('artifact.retention.collect',dict(payload,expected_state_version=version,reason='active custody component refusal'),component='15.4');assert collected['operation']['state']=='RETAINED',collected
  checks.append('archive and actual semantic outputs resist GC while custody ACTIVE')
  print(json.dumps({'status':'PASS','scope':'isolated actual PostgreSQL signed component APIs plus pinned SDK HTTP fixture backed by actual Unix worker/STOP/archive producer; accepted registration prerequisites controlled','checks':checks,'provider_live':'UNRUN','coding_model_qualification':'NOT_CLAIMED'}));return 0
 finally:
  if executor:
   try:executor.stdin.write(json.dumps({'operation':'close'})+'\n');executor.stdin.flush();executor.wait(timeout=10)
   except Exception:executor.kill();executor.wait(timeout=10)
  if state['handler']:state['handler'].close()
  if stack:stack.close()
  if backend:backend.close()
  if physical_boot and physical_boot.exists():shutil.rmtree(physical_boot)
  if os.environ.get('HF_ARCHIVE_RETAIN_FAILED_FIXTURE')=='1' and sys.exc_info()[0]:print('RETAINED_COMPONENT_FIXTURE '+str(owned),flush=True)
  else:shutil.rmtree(owned,ignore_errors=True)
if __name__=='__main__':raise SystemExit(main())
