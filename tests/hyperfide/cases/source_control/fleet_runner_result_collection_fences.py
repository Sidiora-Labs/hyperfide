#!/usr/bin/env python3
"""Signed private existing-process observation fences with genuine native execution and lease."""
import base64,copy,importlib.util,json,os,select,subprocess,sys,threading,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4];SUPPORT=ROOT/'tests/hyperfide/support'
spec=importlib.util.spec_from_file_location('collection_core_gate',Path(__file__).with_name('fleet_runner_result_collection.py'));core=importlib.util.module_from_spec(spec);spec.loader.exec_module(core)
fixture=core.fixture
STATE={'entered':threading.Event(),'release':threading.Event(),'hold':False,'held':False,'wrong_pid':False,'wrong_pid_served':0}

def before_executor(c):
 core.install_fault(c)
 underlying=c['backend'].process_handler
 def boundary(method,identifier,body):
  if method=='GET' and identifier and STATE['hold'] and not STATE['held']:
   STATE['held']=True;STATE['entered'].set()
   if not STATE['release'].wait(100):raise TimeoutError('Owned collector inspection barrier expired')
  status,value=underlying(method,identifier,body)
  if method=='GET' and identifier and STATE['wrong_pid'] and status==200:
   STATE['wrong_pid_served']+=1;value=dict(value,pid=str(int(value['pid'])+1))
  return status,value
 c['backend'].process_handler=boundary

class Actor:
 def __init__(self,c):
  f=c['f'];components=c['owned']/'collection-actor-components';components.mkdir(mode=0o700)
  for name in fixture.archive.components(['8.3','10.3']):(components/(name+'.json')).write_bytes((ROOT/'core/control-plane/components'/(name+'.json')).read_bytes())
  self.log=(c['owned']/'collection-actor.stderr').open('w+')
  self.p=subprocess.Popen(['node',str(SUPPORT/'runner_collection_actor.mjs'),str(ROOT/'core/control-plane/dist'),str(components),str(f.policy)],cwd=ROOT,env=f.env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=self.log,text=True)
  assert self.read()=={'ready':True},'Actual capability actor did not start'
 def read(self):
  ready,_,_=select.select([self.p.stdout],[],[],20)
  assert ready,('Private capability response timeout',self.p.poll())
  line=self.p.stdout.readline();assert line,('Private capability actor exited',self.p.poll());return json.loads(line)
 def invoke(self,c,request,lease,key='provisioner',action='provider.remote.execute-bound',signed_input=None):
  f=c['f'];body=fixture.canonical(f.operation('8.3',action,request if signed_input is None else signed_input));seconds=str(int(time.time()));nonce=fixture.uid();identity=f.ids[key]
  signature=f.sign(key,('\n'.join(('HYPERFIDE-REQUEST-V1','POST','/v1/invoke',f.origin,identity,seconds,nonce,fixture.sha(body),''))).encode())
  value={'id':fixture.uid(),'body':base64.b64encode(body).decode(),'headers':['hf-credential-id',identity,'hf-request-time',seconds,'hf-request-nonce',nonce,'hf-request-signature',signature],'input':request,'lease_id':lease}
  self.p.stdin.write(json.dumps(value)+'\n');self.p.stdin.flush();return self.read()
 def close(self):
  if self.p.stdin and not self.p.stdin.closed:self.p.stdin.close()
  try:self.p.wait(timeout=10)
  except subprocess.TimeoutExpired:self.p.kill();self.p.wait(timeout=5)
  self.log.close()

def scenario(c):
 f=c['f'];i=c['i'];operation=c['logical'];executor=c['executor'];actor=None;checks=[]
 def wait(call,seconds=40):
  deadline=time.monotonic()+seconds
  while time.monotonic()<deadline:
   c['heartbeat']();value=call()
   if value:return value
   time.sleep(.15)
  raise AssertionError({'wait_timeout':seconds,'executor_log':(c['owned']/'executor.stderr').read_text()[-4000:]})
 def job():return f.sql('SELECT * FROM hyperfide.runner_remote_jobs WHERE organisation_id=$1 AND run_id=$2 AND operation_id=$3',[i['organisation'],i['run'],operation])[0]
 def lease():
  rows=f.sql('SELECT * FROM hyperfide.runner_result_collections WHERE organisation_id=$1 AND run_id=$2 AND operation_id=$3',[i['organisation'],i['run'],operation]);return rows[0] if rows else None
 def sdk():return len(c['backend'].requests)
 def refused(label,request,lease_id,code,**kwargs):
  before=sdk();result=actor.invoke(c,request,lease_id,**kwargs)
  assert result.get('ok') is False and result['error']['code']==code,(label,result,code)
  assert sdk()==before,(label,'refusal touched SDK',c['backend'].requests[before:])
  assert job()==original,(label,'original execution changed')
  checks.append({'case':label,'code':code,'sdk_requests':0});print('COLLECTION_FENCE '+json.dumps(checks[-1]),flush=True)
 try:
  original=wait(lambda:(row if row['state']=='UNKNOWN' and row['native_claimed_at'] else None) if (row:=job()) else None,65)
  assert 'TX_RETRY_EXHAUSTED' in original['failure_code'] and original['claim_id'] and original['result'] is None,original
  remote=f.sql('SELECT * FROM hyperfide.provider_remote_operations WHERE organisation_id=$1 AND run_id=$2 AND id=$3',[i['organisation'],i['run'],operation])[0]
  assert remote['process_claimed'] and remote['native_process_ref'] and len(c['handlers'].processes)==1,remote
  parameters=remote['operation']['parameters'];request={'binding':{k:original['plan']['binding'][k] for k in ['organisation_id','run_id','session_id','pool_id','sandbox_id','external_sandbox_id','boot_generation']},'operation_id':operation,'argv':parameters['argv'],'cwd':parameters['cwd'],'env_refs':parameters['env_refs'],'timeout_ms':parameters['process_timeout_ms']}
  request['binding']['boot_generation']=str(request['binding']['boot_generation']);request['binding']['preparation_digest']=original['plan']['binding']['boot_preparation_digest']
  if 'env_ref_versions' in parameters:request['env_ref_versions']=parameters['env_ref_versions']
  assert fixture.sha(request)==remote['request_digest'],(request,remote)
  STATE['hold']=True
  f.sql('DROP TRIGGER component_collection_serialization_fault ON hyperfide.provider_remote_observations');f.sql('DROP FUNCTION hyperfide.component_collection_serialization_fault()')
  wait(lambda:STATE['entered'].is_set());held=lease();assert held and held['claim_id']==original['claim_id'] and held['executor_credential_id']==original['executor_credential_id'],held
  actor=Actor(c)
  refused('wrong lease cannot borrow original claim',request,fixture.uid(),'REMOTE_COLLECTION_FENCED')
  wrong=copy.deepcopy(request);wrong['argv']=[*wrong['argv'],'wrong-request']
  refused('signed changed request digest',wrong,held['lease_id'],'REMOTE_COLLECTION_BINDING')
  wrong=copy.deepcopy(request);wrong['binding']['boot_generation']=str(int(wrong['binding']['boot_generation'])+1)
  refused('signed different physical boot',wrong,held['lease_id'],'REMOTE_COLLECTION_BINDING')
  wrong=copy.deepcopy(request);wrong['operation_id']=fixture.uid()
  refused('different operation cannot borrow claim lease',wrong,held['lease_id'],'REMOTE_COLLECTION_FENCED')
  refused('authenticated payload differs from request',request,held['lease_id'],'AUTH_SCOPE_DENIED',signed_input={'wrong':'request'})
  refused('operator cannot collect provisioner result',request,held['lease_id'],'AUTH_SCOPE_DENIED',key='operator')
  restricted_key=c['owned']/'restricted-provisioner.pem'
  subprocess.run(['openssl','genpkey','-algorithm','Ed25519','-out',str(restricted_key)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);restricted_key.chmod(0o600)
  public=subprocess.check_output(['openssl','pkey','-in',str(restricted_key),'-pubout','-outform','DER'],stderr=subprocess.DEVNULL)
  f.ids['restricted_collector']=fixture.uid();f.keys['restricted_collector']={'path':restricted_key}
  c['ok']('identity.service.issue',{'credential_id':f.ids['restricted_collector'],'actor_id':fixture.uid(),'role':'PROVISIONER','public_key_b64':base64.urlsafe_b64encode(public[-32:]).decode().rstrip('='),'allowed_actions':['identity.describe'],'ttl_seconds':300},component='14.1',key='operator')
  refused('current provisioner without execute-bound grant',request,held['lease_id'],'AUTH_SCOPE_DENIED',key='restricted_collector')
  observations_before={row['id'] for row in f.sql('SELECT id FROM hyperfide.provider_remote_observations WHERE organisation_id=$1 AND run_id=$2 AND remote_operation_id=$3',[i['organisation'],i['run'],operation])}
  sdk_before=sdk();STATE['wrong_pid']=True
  mismatch=actor.invoke(c,request,held['lease_id']);STATE['wrong_pid']=False
  assert STATE['wrong_pid_served']>=1,'PID refusal did not reach actual owned SDK GET'
  observed=[row for row in f.sql('SELECT id,observation FROM hyperfide.provider_remote_observations WHERE organisation_id=$1 AND run_id=$2 AND remote_operation_id=$3',[i['organisation'],i['run'],operation]) if row['id'] not in observations_before]
  assert mismatch.get('ok') is True and mismatch.get('result') is None,('identity mismatch cannot produce captured completion',mismatch)
  assert len(observed)==1 and observed[0]['observation']['operation']['kind']=='inspect' and observed[0]['observation']['outcome']['status']=='UNKNOWN' and observed[0]['observation']['outcome']['result'] is None,('mismatched running PID must retain UNKNOWN, never successful STARTED',observed)
  assert not any('/filesystem' in row['path'] for row in c['backend'].requests[sdk_before:]),('mismatched PID attempted capture',c['backend'].requests[sdk_before:])
  assert job()==original,'Wrong SDK PID changed job'
  checks.append({'case':'owned SDK running process PID mismatch','outcome':'UNKNOWN','captured_result':None,'capture_file_reads':0});print('COLLECTION_FENCE '+json.dumps(checks[-1]),flush=True)
  STATE['release'].set()
  wait(lambda:(row if row and f.sql('SELECT $1::timestamptz<=clock_timestamp() AS expired',[row['lease_until']])[0]['expired'] else None) if (row:=lease()) else None)
  executor.stdin.write(json.dumps({'operation':'close'})+'\n');executor.stdin.flush();executor.stdin.close();executor.wait(timeout=110)
  assert executor.returncode==0,executor.returncode
  released=lease();assert released['lease_id']==held['lease_id'] and f.sql('SELECT $1::timestamptz<=clock_timestamp() AS expired',[released['lease_until']])[0]['expired'],released
  refused('naturally released collection lease cannot collect',request,held['lease_id'],'REMOTE_COLLECTION_FENCED')
  version=f.sql('SELECT credential_version::text FROM hyperfide.identity_principals WHERE credential_id=$1',[i['provisioner']])[0]['credential_version']
  c['ok']('identity.principal.revoke',{'credential_id':i['provisioner'],'expected_version':version},component='14.1',key='operator')
  result=actor.invoke(c,request,held['lease_id'])
  assert result.get('ok') is False and result['error']['code']=='AUTH_REVOKED',result
  assert job()==original and len(c['handlers'].processes)==1,'Authority refusal changed original execution'
  checks.append({'case':'revoked current signer','code':result['error']['code']})
  posts=[row for row in c['backend'].requests if row['method']=='POST' and row['path'].rstrip('/').endswith('/process')];assert len(posts)==1,posts
  c['checks'].extend(['actual native unknown claim and real collector lease fenced: '+row['case'] for row in checks])
  print(json.dumps({'status':'PASS','scope':'actual signed private capability/PG/SDK existing-process observation fences','checks':checks,'sdk_process_posts':len(posts),'original_claim':original['claim_id'],'original_native_process':remote['native_process_ref'],'positive_terminal_capture':'separate sealed core gate'}),flush=True)
  return 0
 finally:
  STATE['release'].set()
  if actor:actor.close()

if __name__=='__main__':
 if not os.environ.get('DATABASE_URL'):raise SystemExit(subprocess.run([sys.executable,str(SUPPORT/'withpg.py'),'--',sys.executable,str(Path(__file__).resolve()),*sys.argv[1:]],cwd=ROOT).returncode)
 raise SystemExit(fixture.main(before_executor=before_executor,scenario=scenario))
