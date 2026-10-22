#!/usr/bin/env python3
"""V-063 component: signed configuration/observations and actual scheduler admission.

Provider observations are SIMULATED, with no cloud or frontier calls.
"""
from __future__ import annotations
import importlib.util,json,os,shutil,socket,subprocess,sys,tempfile,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4]
def load(name,path):
 s=importlib.util.spec_from_file_location(name,ROOT/path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
p=load('capacity_provider_fixture','tests/hyperfide/cases/tasks/8_3.py')
s=load('capacity_scheduler_fixture','tests/hyperfide/cases/tasks/5_1.py')
expect=p.expect
IDS=['capacity.seed.claim-before-configure-refused','capacity.seed.unqualified-zero','capacity.seed.policy-provenance','capacity.seed.qualified-dimensions','capacity.seed.idempotent','capacity.seed.over-limit-refused','capacity.seed.atomic-running','capacity.seed.ready-current-boot','capacity.seed.observation-idempotent','capacity.seed.claim-admits','capacity.seed.allocated-not-revived','capacity.seed.stopped-retired','capacity.seed.replaced-retired','capacity.seed.old-observation-no-ready']
FAILED=[]
IDS+=['capacity.seed.reconfigure-held','capacity.seed.unqualified-admission-refused']
def check(name,fn):
 try:fn();actual='observed'
 except Exception as e:FAILED.append(name);actual=type(e).__name__+': '+str(e)
 print(json.dumps({'type':'assertion','id':name,'expected':'observed','actual':actual}),flush=True)
def main():
 if sys.argv[1:]==['--inventory']:print(json.dumps(IDS));return 0
 expect(not sys.argv[1:],'unknown arguments')
 f=None;prov=None;folder=tempfile.mkdtemp(prefix='hyperfide-capacity-');complete=False
 state=Path(folder)/'provider.json';state.write_text(json.dumps({'calls':[],'resources':{'capacity-native':{'owned':True,'state':'RUNNING'}},'create_mode':'normal'}))
 def setup(f):
  i=f.ids;f.pool=str(uuid.uuid4())
  limits={'SANDBOX':'10','PROVISIONING':'2','CPU_MILLIS':'8000','MEMORY_BYTES':'17179869184','DISK_BYTES':'34359738368','AGENT':'2','BUILD':'2','TEST':'2','INDEX':'2'}
  f.config={'schema_version':1,'organisation_id':i['organisation'],'revision':'COMPONENT_ONLY_CAPACITY_SEEDING','accounts':[{'provider':'railway','account_key':'capacity-account','approved_limits':limits,'planning_limits':{'SANDBOX':'9999'}}],'pools':[{'id':f.pool,'provider':'railway','account_key':'capacity-account','environment_key':'capacity-env','region':'fixture','profile_id':i['profile'],'preparation_digest':f.preparation,'approved_limits':limits,'planning_limits':{'SANDBOX':'9999'},'create_policy':{'seed_reference':'fixture','network':'ISOLATED','stdin_required':False}}],'maximum_operation_ms':10000}
  f.config['pools'][0]['scheduling_policy']={'aging_seconds':7,'max_bypass_seconds':45,'rate_window_ms':2000,'max_waiters':100}
  f.configfile=f.path/'capacity.json';f.configfile.write_text(json.dumps(f.config));f.configfile.chmod(0o600)
  f.env['HYPERFIDE_POOL_CONFIG']=str(f.configfile);f.env['HF_SIMULATED_PROVIDER_STATE']=str(state)
  executor=f.path/'executor.json';executor.write_text(json.dumps({'schema_version':1,'concurrency':1,'principals':[{'credential_id':i['provisioner'],'key_path':str(f.keys['provisioner']['path'])}]}));executor.chmod(0o600)
  f.env['HF_PROVISIONER_EXECUTOR_CONFIG_FILE']=str(executor)
 try:
  module_root=p.simulated_module_root(Path(folder)/'runtime')
  adapter=p.SIMULATED_ADAPTER.replace("r?{provider_state:'RUNNING',health:'HEALTHY'}","r?{provider_state:r.state,health:'HEALTHY'}")
  expect(adapter!=p.SIMULATED_ADAPTER,'simulated observation fixture changed')
  (module_root/'fixtures/simulated-provider.js').write_text(adapter)
  f=s.SchedulerFixture(extra_components=('8.2','8.3'),extra_setup=setup)
  (f.components/'8.3-simulated-adapter.json').write_text(json.dumps(p.SIMULATED_FRAGMENT))
  with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
  prov=p.spawn_service(f,'provisioner',port,f.components,module_root)
  control_port=f.port
  def invoke(action,input=None,ok=True):
   f.port=port
   try:status,response=f.invoke(action,input or {},component='8.2' if action.startswith('provider.pools.') else '8.3',key='provisioner')
   finally:f.port=control_port
   if ok:expect(status==200 and response.get('ok') is True,response);return response['result']
   return response
  org=f.ids['organisation'];run=f.ids['run']
  invoke('provider.worker.stop')
  def accounts():return f.sql('SELECT * FROM hyperfide.capacity_accounts WHERE organisation_id=$1 AND pool_id=$2 ORDER BY id',[org,f.pool])
  def before_configure():
   # A pool that was never configured has no policy, accounts or slots; claims refuse with the exact codes.
   expect(not accounts() and not f.sql('SELECT 1 FROM hyperfide.scheduling_policies WHERE organisation_id=$1 AND pool_id=$2',[org,f.pool]),'capacity seeded before configure')
   request=f.prepare_claim('b');unconfigured=str(uuid.uuid4());sandbox=str(uuid.uuid4())
   f.sql("INSERT INTO hyperfide.provider_pools(organisation_id,id,provider,account_key,environment_key,region,profile_id) VALUES($1,$2,'railway','unconfigured-account','unconfigured-env','fixture',$3)",[org,unconfigured,f.ids['profile']])
   f.sql("INSERT INTO hyperfide.sandboxes(organisation_id,id,pool_id,native_sandbox_id,observed_state,preparation_digest) VALUES($1,$2,$3,'unconfigured-native','RUNNING',$4)",[org,sandbox,unconfigured,f.preparation])
   s.refused_unchanged(f,{**request,'request_id':str(uuid.uuid4()),'sandbox_id':str(uuid.uuid4())},'SLOT_UNAVAILABLE',key='manager2',message='not registered')
   s.refused_unchanged(f,{**request,'request_id':str(uuid.uuid4()),'sandbox_id':sandbox},'SCHEDULING_POLICY_MISSING',key='manager2')
   s.refused_unchanged(f,{**request,'request_id':str(uuid.uuid4()),'capacity':[{'capacity_account_id':str(uuid.uuid4()),'quantity':'1'}]},'CAPACITY_ACCOUNT_MISSING',key='manager2')
  check(IDS[0],before_configure)
  invoke('provider.pools.configure')
  check(IDS[1],lambda:expect(len(accounts())==11 and all(a['configured_limit']=='0' and a['qualification_state']=='UNQUALIFIED' for a in accounts()),accounts()))
  cfg=f.sql('SELECT configuration_digest FROM hyperfide.provider_pool_configurations WHERE organisation_id=$1 AND pool_id=$2 AND active',[org,f.pool])[0]['configuration_digest']
  check(IDS[2],lambda:expect(f.sql('SELECT provenance_digest,qualification_state,aging_seconds,max_bypass_seconds,rate_window_ms,max_waiters FROM hyperfide.scheduling_policies WHERE organisation_id=$1 AND pool_id=$2',[org,f.pool])==[{'provenance_digest':cfg,'qualification_state':'QUALIFIED',**f.config['pools'][0]['scheduling_policy']}],'policy provenance absent'))
  for dimension,limit in f.config['pools'][0]['approved_limits'].items():
   for kind,key in [('ACCOUNT','capacity-account'),('ENVIRONMENT','capacity-env')]:
    f.sql("INSERT INTO hyperfide.provider_quota_observations(organisation_id,id,pool_id,configuration_digest,provider,account_key,scope_kind,scope_key,dimension,quota_limit,observed_at,expires_at,evidence_digest,basis,evidence_reference) VALUES($1,$2,$3,$4,'railway','capacity-account',$5,$6,$7,$8,clock_timestamp(),clock_timestamp()+interval '10 minutes',$9,'VERIFIED_OPERATOR_ATTESTATION','COMPONENT_FIXTURE_NOT_LIVE')",[org,str(uuid.uuid4()),f.pool,cfg,kind,key,dimension,limit,p.sha(b'capacity-component-qualified-envelope')])
  invoke('provider.pools.configure')
  check(IDS[3],lambda:expect(all(a['qualification_state']=='QUALIFIED' and a['provenance_digest']!=cfg and a['configured_limit']==f.config['pools'][0]['approved_limits'][a['dimension']] for a in accounts()),accounts()))
  before=accounts();policy=f.sql('SELECT * FROM hyperfide.scheduling_policies WHERE organisation_id=$1 AND pool_id=$2',[org,f.pool])
  invoke('provider.pools.configure')
  check(IDS[4],lambda:expect(before==accounts() and policy==f.sql('SELECT * FROM hyperfide.scheduling_policies WHERE organisation_id=$1 AND pool_id=$2',[org,f.pool]),'reseed changed rows'))
  def overlimit():
   f.sql("UPDATE hyperfide.provider_quota_observations SET quota_limit=1 WHERE organisation_id=$1 AND pool_id=$2 AND dimension='AGENT'",[org,f.pool])
   try:
    answer=invoke('provider.pools.configure',ok=False);expect(answer.get('error',{}).get('code')=='CAPACITY_SEED_LIMIT_EXCEEDED',answer);expect(accounts()==before,'refusal mutated accounts')
   finally:f.sql("UPDATE hyperfide.provider_quota_observations SET quota_limit=2 WHERE organisation_id=$1 AND pool_id=$2 AND dimension='AGENT'",[org,f.pool])
  check(IDS[5],overlimit)
  sandbox=str(uuid.uuid4());iid=str(uuid.uuid4())
  f.sql("INSERT INTO hyperfide.sandboxes(organisation_id,id,pool_id,native_sandbox_id,observed_state,preparation_digest) VALUES($1,$2,$3,'capacity-native','CREATING',$4)",[org,sandbox,f.pool,f.preparation])
  scope={'organisation_id':org,'pool_id':f.pool,'provider':'railway','provider_account_id':'capacity-account','environment_id':'capacity-env','region':'fixture','configuration_digest':cfg}
  # This durable owned fixture establishes provider ownership; the registered
  # inventory action performs the real observation and transaction under test.
  operation={'kind':'create','scope':scope,'deadline_at':p.utc(),'resource':None,'preparation_digest':f.preparation,'parameters':{'preparation_reference':'fixture','resources':{'cpu_millis':1000,'memory_bytes':'2147483648','disk_bytes':'4294967296','persistent_volume_bytes':'0'},'network':'ISOLATED','stdin_required':False}}
  payload=p.sha(json.dumps(operation,sort_keys=True,separators=(',',':')).encode())
  operation.update(schema_version=1,identity={'operation_id':iid,'idempotency_key':iid,'payload_digest':payload,'correlation_id':iid,'causation_id':iid})
  f.sql("INSERT INTO hyperfide.provisioning_intents(organisation_id,run_id,id,pool_id,sandbox_id,configuration_digest,kind,request_key,request_digest,payload_digest,operation,boot_generation,native_sandbox_id,state,preparation_purpose,profile_id) VALUES($1,$2,$3,$4,$5,$6,'CREATE',$3::uuid::text,$7,$7,$8,1,'capacity-native','ID_KNOWN','EXECUTION',$9)",[org,run,iid,f.pool,sandbox,cfg,payload,operation,f.ids['profile']])
  def observe(ok=True):return invoke('provider.inventory.observe-known',{'sandbox_id':sandbox,'boot_generation':'1'},ok)
  def slots():return f.sql('SELECT * FROM hyperfide.worker_slots WHERE organisation_id=$1 AND sandbox_id=$2 ORDER BY id',[org,sandbox])
  def atomic():
   f.sql("CREATE FUNCTION hyperfide.fixture_refuse_slot() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture slot refusal'; END $$; CREATE TRIGGER fixture_refuse_slot BEFORE INSERT ON hyperfide.worker_slots FOR EACH ROW EXECUTE FUNCTION hyperfide.fixture_refuse_slot()")
   try:
    expect(observe(False).get('ok') is False,'slot failure accepted');expect(not slots() and f.sql('SELECT observed_state FROM hyperfide.sandboxes WHERE id=$1',[sandbox])[0]['observed_state']=='CREATING','RUNNING committed without slot')
   finally:f.sql('DROP TRIGGER fixture_refuse_slot ON hyperfide.worker_slots; DROP FUNCTION hyperfide.fixture_refuse_slot()')
  check(IDS[6],atomic)
  observe();rows=slots()
  check(IDS[7],lambda:expect(len(rows)==1 and rows[0]['state']=='READY' and rows[0]['boot_generation']=='1',rows))
  observe();check(IDS[8],lambda:expect(slots()==rows,'observation duplicated/revived slot'))
  f.ids['sandbox']=sandbox;f.ids['slot_a']=rows[0]['id'];f.ids['boot']=f.sql('SELECT boot_id FROM hyperfide.sandbox_boots WHERE sandbox_id=$1',[sandbox])[0]['boot_id']
  f.accounts={a['dimension']:a['id'] for a in accounts() if a['capacity_class']=='EXECUTION'}
  budget=f.primary("return claims.qualifySandboxBudget(tx,data.qualification);",{'qualification':{'organisation_id':org,'sandbox_id':sandbox,'sandbox_boot_generation':'1','qualification_id':str(uuid.uuid4()),'evidence_digest':p.sha(b'component-fixed-boot-envelope'),'source':'OPERATOR_FIXED','hard_limits':{'cpu_millis':'8000','memory_bytes':'17179869184','disk_bytes':'34359738368'},'headroom':{'cpu_millis':'1000','memory_bytes':'1073741824','disk_bytes':'0'}}})
  expect('result' in budget,budget)
  check(IDS[9],lambda:expect(bool(f.claim('a')),'claim refused seeded slot/accounts/policy'))
  allocated=slots();observe();check(IDS[10],lambda:expect(allocated[0]['state']=='ALLOCATED' and slots()==allocated,'allocated slot revived'))
  simulated=json.loads(state.read_text());simulated['resources']['capacity-native']['state']='STOPPED';state.write_text(json.dumps(simulated))
  observe()
  check(IDS[11],lambda:expect(all(w['state']=='RETIRED' for w in slots()),'stopped slot remains ready'))
  # Replacement retires an independently READY boot as well as allocated boots.
  other=str(uuid.uuid4());slot=str(uuid.uuid4())
  f.sql("INSERT INTO hyperfide.sandboxes(organisation_id,id,pool_id,native_sandbox_id,observed_state,preparation_digest) VALUES($1,$2,$3,'replacement-native','RUNNING',$4)",[org,other,f.pool,f.preparation])
  f.sql("INSERT INTO hyperfide.worker_slots(organisation_id,id,sandbox_id,slot_key,boot_generation,capacity_kind) VALUES($1,$2,$3,'replacement',1,'AGENT')",[org,slot,other])
  f.sql('UPDATE hyperfide.sandboxes SET boot_generation=2,state_version=state_version+1 WHERE id=$1',[other])
  check(IDS[12],lambda:expect(f.sql('SELECT state FROM hyperfide.worker_slots WHERE id=$1',[slot])[0]['state']=='RETIRED','replaced READY boot survived'))
  f.sql("UPDATE hyperfide.sandboxes SET boot_generation=2,observed_state='CREATING',state_version=state_version+1 WHERE id=$1",[sandbox])
  observe();check(IDS[13],lambda:expect(all(w['state']=='RETIRED' for w in slots()),'old observation created ready slot'))
  held_request={'request_id':str(uuid.uuid4()),'dimensions':[{'capacity_account_id':f.accounts['AGENT'],'quantity':'1'}],'expires_at':p.utc()}
  held=f.primary('return claims.reserveCapacity(tx,{...data.scope,...data.request});',{'request':held_request})
  expect('result' in held,held)
  def reservations():return f.sql('SELECT r.* FROM hyperfide.reservations r JOIN hyperfide.capacity_accounts a ON a.organisation_id=r.organisation_id AND a.id=r.capacity_account_id WHERE a.organisation_id=$1 AND a.pool_id=$2 ORDER BY r.id',[org,f.pool])
  held_rows=reservations();held_accounts=accounts()
  expect(any(a['reserved']!='0' for a in held_accounts) and any(a['allocated']!='0' for a in held_accounts),'fixture needs reserved and allocated capacity')
  def reconfigure_held():
   f.config['revision']='COMPONENT_ONLY_CAPACITY_RECONFIGURED';f.configfile.write_text(json.dumps(f.config))
   invoke('provider.pools.configure')
   current=accounts()
   expect(reservations()==held_rows,'reconfigure mutated held reservation rows')
   for old,new in zip(held_accounts,current):
    expect(new['id']==old['id'] and new['reserved']==old['reserved'] and new['allocated']==old['allocated'],(old,new))
    expect(new['qualification_state']=='UNQUALIFIED' and new['provenance_digest']!=old['provenance_digest'],new)
    expect(int(new['configured_limit'])==int(old['reserved'])+int(old['allocated'])<=int(old['configured_limit']),new)
   invoke('provider.pools.configure');expect(accounts()==current and reservations()==held_rows,'unqualified reseed is not idempotent')
  check(IDS[14],reconfigure_held)
  def admission_refused():
   before=accounts()
   request={**held_request,'request_id':str(uuid.uuid4())}
   answer=f.primary('return claims.reserveCapacity(tx,{...data.scope,...data.request});',{'request':request})
   expect(answer.get('error',{}).get('code')=='CAPACITY_UNQUALIFIED',answer)
   expect(accounts()==before and reservations()==held_rows,'refused admission mutated held capacity')
  check(IDS[15],admission_refused)
  complete=True
 finally:
  if prov:
   prov.terminate()
   try:prov.wait(timeout=10)
   except subprocess.TimeoutExpired:prov.kill();prov.wait();complete=False
   prov.stderr.close()
  if f:f.close()
  shutil.rmtree(folder)
  print(json.dumps({'type':'cleanup','resources':[],'complete':complete}),flush=True)
 return 1 if FAILED or not complete else 0
if __name__=='__main__':sys.exit(main())
