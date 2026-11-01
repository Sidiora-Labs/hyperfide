"""Actual bootstrap-owned configuration and signed native claim transport boundary."""
import base64,copy,hashlib,importlib.util,json,os,pwd,grp,select,shutil,subprocess,time,uuid
from pathlib import Path

def run(root,binary,test_mode=False):
 root=Path(root);binary=Path(binary);support=root/'tests/hyperfide/support'
 def load(name,file):
  s=importlib.util.spec_from_file_location(name,file);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
 identity=load('bootstrap_config_identity',support/'identity_fixture.py');objects=load('bootstrap_config_objects',root/'tests/hyperfide/cases/tasks/15_2.py');store=objects.ObjectFixture();f=None;created=[];base=Path('/var/lib/hyperfide/bootstrap-config-'+uuid.uuid4().hex);checks=[]
 pin=lambda p:'sha256:'+hashlib.sha256(Path(p).read_bytes()).hexdigest()
 def write(p,v):p.write_text(json.dumps(v));p.chmod(0o600)
 definitions={json.loads(p.read_text())['id']:(p.stem,json.loads(p.read_text())) for p in (root/'core/control-plane/components').glob('*.json') if 'id' in json.loads(p.read_text())};selected=set()
 def add(i):
  if i in selected:return
  selected.add(i)
  for d in definitions[i][1]['requires']:add(d)
 for i in ['6.3','1.1','12.4']:add(i)
 def setup(a):
  a.env.update(HF_ARTIFACT_S3_ENDPOINT=store.endpoint,HF_ARTIFACT_ALLOW_LOOPBACK_HTTP='1',HF_ARTIFACT_S3_REGION=objects.REGION,HF_ARTIFACT_S3_BUCKET=objects.BUCKET,HF_ARTIFACT_S3_ACCESS_KEY_ID=objects.KEY,HF_ARTIFACT_S3_SECRET_ACCESS_KEY=objects.SECRET,HF_ARTIFACT_S3_SESSION_TOKEN=objects.TOKEN,HF_ARTIFACT_ORGANISATION_ID=a.ids['organisation'],HF_ARTIFACT_ALLOWED_RUN_IDS=json.dumps([a.ids['run']]))
  policy=json.loads(a.policy.read_text());file=a.path/'placement.json';write(file,{**{k:policy[k] for k in ['schema_version','programme_id','repository','spec_revision','policy_revision']},'supervisory_host_id':'ISOLATED_BOOTSTRAP_COMPONENT','restrictions':{'profile_digest':'sha256:'+hashlib.sha256(b'declared-fixture-placement').hexdigest(),'evidence_digest':'sha256:'+hashlib.sha256(b'initial-placement-input-not-main-qualification').hexdigest(),'qualification':'QUALIFIED','expires_at':'2099-01-01T00:00:00.000Z'}});a.env['HF_PLACEMENT_POLICY_FILE']=str(file)
 try:
  f=identity.IdentityFixture(extra_components=[definitions[i][0] for i in sorted(selected)],extra_setup=setup)
  assert f.bind()[1].get('ok'),'Actual provisioning binding refused'
  actions=['identity.describe','instructions.consumer.register','placement.runner.authorize','runner.job.claim']
  assert f.issue(grant=f.grant,actions=actions)[1].get('ok'),'Actual scoped grant refused'
  consumer=str(uuid.uuid4());ids=f.ids;node=f.path/'node';shutil.copyfile(shutil.which('node'),node);node.chmod(0o555);native=f.path/'native';shutil.copyfile(binary,native);native.chmod(0o555);recipe=f.path/'recipe.js';recipe.write_text('throw Error("not an installer execution fixture");\n');recipe.chmod(0o444)
  slots=[]
  for index,kind in enumerate(['TEST'] if test_mode else ['PREPARATION','AGENT']):
   ident=61921+index
   try:pwd.getpwuid(ident);raise AssertionError('Dedicated fixture UID already exists')
   except KeyError:pass
   try:grp.getgrgid(ident);raise AssertionError('Dedicated fixture GID already exists')
   except KeyError:pass
   slot={'name':kind.lower(),'kind':kind,'slot_id':str(uuid.uuid4()),'session_id':str(uuid.uuid4()),'uid':ident,'gid':ident,'isolation_profile':'distinct_uid','credential_sensitive':False,'storage_bytes':1048576};created.append(ident)
   if kind=='AGENT':slot.update(ordinal=0,worker_paths={n:str(base/'workspaces/project/workspace/workers/0'/n) for n in ['source','home','build','temporary','dirty']})
   slots.append(slot)
  environment=str(base/'workspaces/project/workspace');manifest={'schema_version':1,'kind':'FLEET_NATIVE_TEST_BOOTSTRAP_V1' if test_mode else 'FLEET_NATIVE_BOOTSTRAP_V1','bootstrap_id':ids['intent'],'binding':{'organisation_id':ids['organisation'],'run_id':ids['run'],'provisioning_intent_id':ids['intent'],'sandbox_id':ids['sandbox'],'native_sandbox_id':'fixture-resource','boot_id':ids['boot'],'boot_generation':'1','configuration_digest':'sha256:'+hashlib.sha256(b'fixture-config').hexdigest(),'profile_id':ids['pool'],'preparation_digest':f.preparation},'enrollment':{'grant_id':f.grant,'secret_file':str(base/'state'/ids['sandbox']/ids['boot']/'enrollment-grant.json'),'operation_id':str(uuid.uuid4()),'idempotency_key':str(uuid.uuid4()),'allowed_actions':actions},'template':{'origin':f.origin,'ca_file':str(f.ca),'state_root':str(base/'state'),'slot_root':str(base/'slots'),'workspace_root':str(base/'workspaces'),'environment_root':environment,'runner_binary':str(native),'runner_binary_digest':pin(native),'repository_id':ids['project'],'files':[{'path':str(p),'digest':pin(p)} for p in [native,node,recipe]],'runner_config':{'schema_version':1,'consumer_id':consumer},'account_tools':{n:{'path':'/usr/sbin/'+n,'digest':pin('/usr/sbin/'+n)} for n in ['groupadd','useradd']},'preparation_recipes':{'environment.prepare.v1':{'node_path':str(node),'node_digest':pin(node),'recipe_path':str(recipe),'recipe_digest':pin(recipe),'native_path':str(native),'native_digest':pin(native),'readiness_verifier':{'module_closure':[]}}},'slots':slots}}
  if test_mode:manifest['template']['controller']={'node_path':str(node),'node_digest':pin(node),'module_path':str(recipe),'module_digest':pin(recipe)}
  file=f.path/'bootstrap-manifest.json';write(file,manifest)
  def call(action,input):return subprocess.run([str(native),'--component','12.1' if action.startswith('supervisor.') else '12.4','--action',action],input=json.dumps(input),capture_output=True,text=True,env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'},timeout=45)
  request={'manifest_path':str(file),'manifest_digest':pin(file)};p=call('supervisor.bootstrap.test.stage' if test_mode else 'supervisor.bootstrap.stage',request);assert p.returncode==0,p.stderr
  write(Path(manifest['enrollment']['secret_file']),{'grant_id':f.grant,'secret_b64':base64.urlsafe_b64encode(f.secret).decode().rstrip('=')})
  p=call('supervisor.bootstrap.test' if test_mode else 'supervisor.bootstrap',request)
  # Only configuration and transport are asserted; registry qualification is independently guarded.
  bindings=f.sql('SELECT c.state,b.consumer_id FROM hyperfide.event_runner_bindings b JOIN hyperfide.event_consumers c ON c.organisation_id=b.organisation_id AND c.run_id=b.run_id AND c.id=b.consumer_id WHERE b.sandbox_id=$1',[ids['sandbox']])
  assert len(bindings)==1 and bindings[0]['state']=='ACTIVE' and bindings[0]['consumer_id']==consumer,'Actual boot consumer registration absent'
  checks.append('actual-per-boot-consumer-registered-active')
  for slot in slots:
   config=base/'state'/ids['sandbox']/ids['boot']/slot['session_id']/'runner.json';assert config.is_file(),p.stderr
   st=config.stat();assert st.st_uid==0 and st.st_gid==0 and st.st_mode&0o777==0o600 and st.st_nlink==1
   data=json.loads(config.read_text());assert data['consumer_id']==consumer and data['state_dir']==str(config.parent) and data['boot_id']==ids['boot']
   os.set_blocking(f.child.stderr.fileno(),False)
   while True:
    try:
     if not os.read(f.child.stderr.fileno(),65536):break
    except BlockingIOError:break
   before=f.sql('SELECT count(*)::text AS n FROM hyperfide.identity_request_nonces')[0]['n'];refused=call('runner.job.execute',{'config_path':str(config),'operation_id':str(uuid.uuid4())});after=f.sql('SELECT count(*)::text AS n FROM hyperfide.identity_request_nonces')[0]['n'];assert refused.returncode and int(after)>int(before),'Bootstrap config did not carry signed request to actual TLS authority'
   deadline=time.monotonic()+3;events=[]
   while time.monotonic()<deadline:
    ready,_,_=select.select([f.child.stderr],[],[],0.1)
    if ready:
     line=os.read(f.child.stderr.fileno(),65536).decode();events.append(line)
     if 'REMOTE_JOB_NOT_CLAIMED' in line:break
   assert any('REMOTE_JOB_NOT_CLAIMED' in line for line in events),'Actual 12.4 missing-job guard not reached: '+''.join(events)
   checks.append(slot['kind'].lower()+'-bootstrap-config-reaches-actual-signed-claim-handler')
  return checks
 finally:
  if base.exists() and 'slots' in locals() and 'native' in locals():
   for slot in slots:subprocess.run([str(native),'--component','12.1','--action','supervisor.slot.release'],input=json.dumps({'root':str(base/'slots'/ids['sandbox']/ids['boot']),'slot_id':slot['slot_id']}),text=True,capture_output=True,timeout=10)
  if f:f.close()
  store.stop()
  for ident in created:
   try:
    name=pwd.getpwuid(ident).pw_name
    if name!='hf-slot-'+str(ident):raise AssertionError('Unexpected fixture identity')
    subprocess.run(['/usr/sbin/userdel','--',name],check=True,capture_output=True)
   except KeyError:pass
   try:subprocess.run(['/usr/sbin/groupdel','--',grp.getgrgid(ident).gr_name],check=True,capture_output=True)
   except KeyError:pass
  if base.exists():shutil.rmtree(base)
