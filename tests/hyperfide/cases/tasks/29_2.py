#!/usr/bin/env python3
"""V-059 task component: actual HTTPS, PostgreSQL and a local simulated provider."""
from __future__ import annotations
import concurrent.futures,importlib.util,json,os,shutil,subprocess,sys,tempfile,time,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4]
spec=importlib.util.spec_from_file_location('provider_intents',ROOT/'tests/hyperfide/cases/tasks/8_3.py')
base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)
expect=base.expect
IDS=['provisioner.unit.https','provisioner.boot.running','provisioner.https.configure','provisioner.https.attest-capacity','provisioner.https.observe','provisioner.https.execute','provisioner.https.reconcile','provisioner.boot.consumes-intent','provisioner.start.concurrent-idempotent','provisioner.restart.no-duplicate-effects']
ACTIONS=[('8.2','provider.pools.configure'),('8.2','provider.pools.attest-capacity'),('8.2','provider.pools.observe'),('8.3','provider.intents.execute'),('8.3','provider.intents.reconcile')]
IDS+=['provisioner.scope.'+a for _,a in ACTIONS]
UNSAFE=['missing','group-readable','world-readable','symlink','hardlink']
IDS+=['provisioner.credentials.'+target+'.'+variant for target in ['config','key'] for variant in UNSAFE]
IDS+=['provisioner.credentials.wrong-role','provisioner.credentials.wrong-key']
FAILED=[]
def check(name,fn):
 try:fn();actual='observed'
 except Exception as error:FAILED.append(name);actual=type(error).__name__+': '+str(error)
 print(json.dumps({'type':'assertion','id':name,'expected':'observed','actual':actual}),flush=True)
def main():
 if sys.argv[1:]==['--inventory']:print(json.dumps(IDS));return 0
 expect(not sys.argv[1:],'unknown argument')
 f=None;complete=False
 folder=tempfile.mkdtemp(prefix='hyperfide-29-2-')
 try:
  module=base.simulated_module_root(folder)
  state=Path(folder)/'provider-state.json';state.write_text(json.dumps({'resources':{},'calls':[],'create_mode':'succeed','incompatible':False}))
  def setup(fx):
   base.prepare_provider_intent_fixture(fx)
   (fx.components/'8.3-simulated-adapter.json').write_text(json.dumps(base.SIMULATED_FRAGMENT))
   fx.executor=fx.path/'worker.json'
   fx.executor.write_text(json.dumps({'schema_version':1,'principals':[{'credential_id':fx.ids['provisioner'],'key_path':str(fx.keys['provisioner']['path'])}],'concurrency':1}));fx.executor.chmod(0o600)
   fx.env.update(HF_PROVISIONER_EXECUTOR_CONFIG_FILE=str(fx.executor),HF_SIMULATED_PROVIDER_STATE=str(state),HYPERFIDE_PROVISIONER_POLL_MS='100',HYPERFIDE_PROVISIONER_RETRY_MS='200',HYPERFIDE_PROVISIONER_LEASE_MS='1000')
   fx.declarations=fx.path/'declarations.json';fx.env['HYPERFIDE_CAPACITY_ATTESTATIONS']=str(fx.declarations)
  f=base.SimulatedProvisionerFixture(module,extra_components=['8.2','8.3'],extra_setup=setup,extra_actions=['provider.simulated.describe'])
  def result(action,input=None,key='operator',component='8.3'):
   status,r=f.invoke(action,input or {},key=key,component=component)
   expect(status==200 and r.get('ok') is True,(status,r));return r['result']
  def refused(action,input,code,key='operator',component='8.3'):
   status,r=f.invoke(action,input,key=key,component=component)
   expect((status>=400 or r.get('ok') is False) and r.get('error',{}).get('code')==code,(status,r))
  def unit():
   text=(ROOT/'deploy/hyperfide/provisioner.service').read_text()
   for token in ['--mode https','${HYPERFIDE_PROVISIONER_LISTEN_HOST}','${HYPERFIDE_PROVISIONER_LISTEN_PORT}','--tls-cert /etc/hyperfide/provisioner.crt','--tls-key /etc/hyperfide/provisioner.key','HF_PROVISIONER_EXECUTOR_CONFIG_FILE=','HF_IDENTITY_CONFIG_FILE=']:expect(token in text,token)
   expect('--mode daemon' not in text,'unit still uses daemon')
  check(IDS[0],unit)
  def running():
   s=result('provider.worker.status');expect(s['running'] is True and s['owner_credential_id']==f.ids['provisioner'],s)
  check(IDS[1],running)
  check(IDS[2],lambda:expect(result('provider.pools.configure',component='8.2')['configured']==1,'pool not configured'))
  org,run=f.ids['organisation'],f.ids['run']
  def attest():
   raw=b'Owned V-059 component declaration';aid=str(uuid.uuid4());proof=f.path/'capacity-proof';proof.write_bytes(raw);digest=base.sha(raw)
   f.sql("INSERT INTO hyperfide.artifacts(organisation_id,run_id,id,digest,size_bytes,storage_backend,storage_key,status,completed_at) VALUES($1,$2,$3,$4,$5,'COMPONENT_FIXTURE',$6,'COMPLETE',clock_timestamp())",[org,run,aid,digest,str(len(raw)),str(proof)])
   cfg=f.sql('SELECT configuration_digest FROM hyperfide.provider_pool_configurations WHERE organisation_id=$1 AND pool_id=$2 AND active',[org,f.pool])[0]['configuration_digest']
   document={'schema_version':1,'organisation_id':org,'attestations':[{'id':str(uuid.uuid4()),'pool_id':f.pool,'configuration_digest':cfg,'scope_kind':'ACCOUNT','scope_key':'fixture-account','dimension':'SANDBOX','limit':'10','declared_at':base.utc(-1000),'expires_at':base.utc(60000),'provenance':{'run_id':run,'artifact_id':aid,'digest':digest}}]}
   f.declarations.write_text(json.dumps(document));f.declarations.chmod(0o600)
   r=result('provider.pools.attest-capacity',component='8.2');expect(r is not None,r)
   expect(len(f.sql('SELECT id FROM hyperfide.provider_capacity_attestations WHERE organisation_id=$1',[org]))==1,'declaration not retained')
  check(IDS[3],attest)
  # No real quota observer is installed: the authenticated route must reach its domain refusal.
  check(IDS[4],lambda:refused('provider.pools.observe',{'pool_id':f.pool},'QUOTA_UNQUALIFIED','provisioner','8.2'))
  missing=str(uuid.uuid4())
  check(IDS[5],lambda:refused('provider.intents.execute',{'intent_id':missing},'PROVISIONING_INTENT_UNKNOWN','provisioner'))
  check(IDS[6],lambda:refused('provider.intents.reconcile',{'intent_id':missing},'PROVISIONING_INTENT_UNKNOWN','provisioner'))
  intent={}
  def consume():
   base.seed_provider_capacity(f)
   request={'run_id':run,'pool_id':f.pool,'sandbox_id':str(uuid.uuid4()),'request_key':str(uuid.uuid4()),'deadline_at':base.utc(),'reservation_ids':f.reservations,'profile_id':f.profile,'preparation_digest':f.preparation,'purpose':'PREPARATION'}
   row=result('provider.intents.prepare-create',request)['intent'];intent['id']=row['id']
   base.wait_for(lambda:result('provider.intents.get',{'intent_id':row['id']})['state']=='ACKNOWLEDGED','boot worker did not consume durable intent')
   expect(len([c for c in json.loads(state.read_text())['calls'] if c['method']=='create' and c['operation_id']==row['id']])==1,'create duplicated')
  check(IDS[7],consume)
  def concurrent_start():
   with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    replies=list(pool.map(lambda _:result('provider.worker.start',key='provisioner'),range(4)))
   expect(all(r['started'] is False and r['running'] is True for r in replies),replies)
  check(IDS[8],concurrent_start)
  def restart():
   f.stop();f.start();running();time.sleep(0.5)
   expect(result('provider.intents.get',{'intent_id':intent['id']})['state']=='ACKNOWLEDGED','restart lost durable state')
   expect(len([c for c in json.loads(state.read_text())['calls'] if c['method']=='create' and c['operation_id']==intent['id']])==1,'restart duplicated create')
   expect(result('provider.worker.start',key='provisioner')['started'] is False,'restart left worker stopped')
  check(IDS[9],restart)
  f.add_principal('denied','VERIFIER')
  f.sql('UPDATE hyperfide.identity_principals SET allowed_actions=$2 WHERE credential_id=$1',[f.ids['denied'],['identity.describe']])
  identities=json.loads(f.identity_config.read_text())
  for principal in identities['principals']:
   if principal['credential_id']==f.ids['denied']:principal['allowed_actions']=['identity.describe']
  f.identity_config.write_text(json.dumps(identities))
  for component,action in ACTIONS:
   check('provisioner.scope.'+action,lambda component=component,action=action:refused(action,{},'AUTH_SCOPE_DENIED','denied',component))
  f.stop()
  def boot_refusal(code):
   args=['node',str(module/'provisioner.js'),'--policy',str(f.policy),'--spec-revision','fixture-identity-v1','--components',str(f.components),'--module-root',str(module),'--mode','https','--host','127.0.0.1','--port',str(f.port),'--tls-cert',str(f.ca),'--tls-key',str(f.tlskey)]
   p=subprocess.run(args,cwd=ROOT,env=f.env,capture_output=True,text=True,timeout=20)
   expect(p.returncode!=0 and '"event":"ready"' not in p.stderr and code in p.stderr,(p.returncode,p.stderr))
  for target in ['config','key']:
   file=f.executor if target=='config' else f.keys['provisioner']['path']
   for variant in UNSAFE:
    def unsafe(file=file,variant=variant):
     raw=file.read_bytes();other=file.with_name(file.name+'.saved')
     try:
      if variant=='missing':file.unlink()
      elif variant=='group-readable':file.chmod(0o640)
      elif variant=='world-readable':file.chmod(0o604)
      elif variant=='symlink':file.rename(other);file.symlink_to(other)
      elif variant=='hardlink':os.link(file,other)
      boot_refusal('PROVISIONER_EXECUTOR_CONFIG_INVALID')
     finally:
      if file.exists() or file.is_symlink():file.unlink()
      if other.exists():other.unlink()
      file.write_bytes(raw);file.chmod(0o600)
    check('provisioner.credentials.'+target+'.'+variant,unsafe)
  original=f.executor.read_bytes()
  for label,principal,key in [('wrong-role','operator','operator'),('wrong-key','provisioner','operator')]:
   def mismatch(principal=principal,key=key):
    try:
     f.executor.write_text(json.dumps({'schema_version':1,'principals':[{'credential_id':f.ids[principal],'key_path':str(f.keys[key]['path'])}],'concurrency':1}))
     boot_refusal('PROVISIONER_EXECUTOR_IDENTITY_MISMATCH')
    finally:f.executor.write_bytes(original)
   check('provisioner.credentials.'+label,mismatch)
  f.close();f=None;complete=True
 finally:
  if f is not None:f.close()
  shutil.rmtree(folder)
  print(json.dumps({'type':'cleanup','resources':[],'complete':complete}),flush=True)
 return 1 if FAILED or not complete else 0
if __name__=='__main__':sys.exit(main())
