#!/usr/bin/env python3
"""Native protected staging and actual TLS/PG enrollment boundary, without provider claims."""
import base64,copy,hashlib,json,os,shutil,subprocess,sys,tempfile,uuid,pwd,grp
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4]
sys.path.insert(0,str(ROOT/'tests/hyperfide/support'))
from identity_fixture import IdentityFixture
OUT=ROOT/'build/fleet/native-bootstrap'
BIN=ROOT/'build/hyperfide-native'
def uid():return str(uuid.uuid4())
def pin(path):return 'sha256:'+hashlib.sha256(Path(path).read_bytes()).hexdigest()
def write(path,data):path.write_text(json.dumps(data));path.chmod(0o600)
def main():
 OUT.mkdir(parents=True,exist_ok=True)
 if not os.environ.get('DATABASE_URL'):return subprocess.run([sys.executable,str(ROOT/'tests/hyperfide/support/withpg.py'),'--',sys.executable,str(Path(__file__).resolve())],cwd=ROOT).returncode
 f=None;checks=[];created_accounts=[];base=Path('/var/lib/hyperfide/bootstrap-boundary-'+uuid.uuid4().hex)
 try:
  f=IdentityFixture(extra_actions=('placement.runner.authorize',))
  if not f.bind()[1].get('ok'):raise AssertionError('Actual fixture provisioning binding refused')
  actions=['identity.describe','placement.runner.authorize']
  if not f.issue(grant=f.grant,actions=actions)[1].get('ok'):raise AssertionError('Actual finite enrollment grant refused')
  original_node=Path(shutil.which('node')).resolve();node=f.path/'root-owned-node';shutil.copyfile(original_node,node);node.chmod(0o555);binary=f.path/'hyperfide-native';shutil.copyfile(BIN,binary);binary.chmod(0o555);recipe=f.path/'fleet_install.js';shutil.copyfile(ROOT/'core/control-plane/dist/preparation/fleet_install.js',recipe);recipe.chmod(0o444);ids=f.ids
  manifest={'schema_version':1,'kind':'FLEET_NATIVE_BOOTSTRAP_V1','bootstrap_id':ids['intent'],'binding':{'organisation_id':ids['organisation'],'run_id':ids['run'],'provisioning_intent_id':ids['intent'],'sandbox_id':ids['sandbox'],'native_sandbox_id':'fixture-resource','boot_id':ids['boot'],'boot_generation':'1','configuration_digest':'sha256:'+hashlib.sha256(b'boundary-configuration').hexdigest(),'profile_id':ids['pool'],'preparation_digest':f.preparation},'enrollment':{'grant_id':f.grant,'secret_file':str(base/'state'/ids['sandbox']/ids['boot']/'enrollment-grant.json'),'operation_id':uid(),'idempotency_key':uid(),'allowed_actions':actions},'template':{'origin':f.origin,'ca_file':str(f.ca),'state_root':str(base/'state'),'slot_root':str(base/'slots'),'workspace_root':str(base/'workspaces'),'environment_root':str(base/'workspaces/project/workspace'),'runner_binary':str(binary),'runner_binary_digest':pin(binary),'repository_id':ids['project'],'files':[{'path':str(binary),'digest':pin(binary)},{'path':str(node),'digest':pin(node)},{'path':str(recipe),'digest':pin(recipe)}],'preparation_recipes':{'environment.prepare.v1':{'node_path':str(node),'node_digest':pin(node),'recipe_path':str(recipe),'recipe_digest':pin(recipe),'native_path':str(binary),'native_digest':pin(binary),'readiness_verifier':{'module_closure':[]}}},'slots':[{'name':'preparer','kind':'PREPARATION','slot_id':uid(),'session_id':uid(),'uid':65534,'gid':65534,'isolation_profile':'distinct_uid','credential_sensitive':False,'storage_bytes':1048576},{'name':'worker','kind':'AGENT','slot_id':uid(),'session_id':uid(),'uid':1,'gid':1,'isolation_profile':'distinct_uid','credential_sensitive':False,'storage_bytes':1048576,'ordinal':0,'worker_paths':{n:str(base/'workspaces/project/workspace/workers/0'/n) for n in ['source','home','build','temporary','dirty']}}]}}
  with tempfile.TemporaryDirectory(prefix='hf-native-bootstrap-manifest-') as directory:
   file=Path(directory)/'manifest.json';write(file,manifest)
   def run(action,path=file,digest=None):
    p=subprocess.run([str(binary),'--component','12.1','--action',action],input=json.dumps({'manifest_path':str(path),'manifest_digest':digest or pin(path)}),text=True,capture_output=True,env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'},timeout=35)
    return p,json.loads(p.stdout) if p.stdout.strip() else None
   p,r=run('supervisor.bootstrap.stage',digest='sha256:'+'0'*64)
   if p.returncode==0 or base.exists():raise AssertionError('Bad digest caused staging effects')
   checks.append('bad-manifest-digest-refused-before-effects')
   file.chmod(0o644);p,r=run('supervisor.bootstrap.stage');file.chmod(0o600)
   if p.returncode==0 or base.exists():raise AssertionError('Public manifest caused staging effects')
   checks.append('public-manifest-refused-before-effects')
   link=Path(directory)/'manifest-link.json';link.symlink_to(file);p,r=run('supervisor.bootstrap.stage',link,pin(file))
   if p.returncode==0 or base.exists():raise AssertionError('Symlink manifest accepted')
   checks.append('symlink-manifest-refused')
   p,r=run('supervisor.bootstrap.stage')
   if p.returncode or r.get('result',{}).get('kind')!='FLEET_NATIVE_BOOTSTRAP_STAGE_V1':raise AssertionError('Protected stage refused '+p.stderr)
   secret=Path(manifest['enrollment']['secret_file']);st=secret.parent.stat()
   if st.st_uid!=0 or st.st_mode&0o777!=0o700:raise AssertionError('Enrollment parent not root-private')
   checks.append('actual-root-private-enrollment-stage')
   write(secret,{'grant_id':f.grant,'secret_b64':base64.urlsafe_b64encode(f.secret).decode().rstrip('=')})
   # Existing nobody/daemon identities must never be reassigned. Enrollment
   # is genuine; the account collision must stop before allocation/READY claims.
   p,r=run('supervisor.bootstrap')
   if p.returncode==0 or 'BOOTSTRAP_OS_ACCOUNT_COLLISION' not in p.stderr:raise AssertionError('Expected actual OS-account collision refusal '+p.stderr)
   state=secret.parent;transport=json.loads((state/'transport.json').read_text());enrollment=json.loads((state/'runner.pem.enrollment.json').read_text())
   if secret.exists() or 'grant_path' in transport or enrollment.get('ok') is not True:raise AssertionError('Actual native enrollment persistence/secret cleanup failed')
   actual=f.sql('SELECT role,state,allowed_actions FROM hyperfide.identity_principals WHERE credential_id=$1',[transport['credential_id']])
   if len(actual)!=1 or actual[0]['role']!='RUNNER' or actual[0]['state']!='ACTIVE' or actual[0]['allowed_actions']!=actions:raise AssertionError('Actual DB runner scope differs')
   if (state/'bootstrap-receipt.json').exists():raise AssertionError('OS-account collision produced success receipt')
   checks.extend(['actual-tls-pg-enrollment-and-secret-cleanup','actual-os-account-collision-without-success-receipt'])
   positive=copy.deepcopy(manifest);positive['template']['state_root']=str(base/'positive-state');positive['template']['slot_root']=str(base/'positive-slots');positive['template']['account_tools']={name:{'path':'/usr/sbin/'+name,'digest':pin('/usr/sbin/'+name)} for name in ['groupadd','useradd']}
   for offset,slot in enumerate(positive['template']['slots']):
    ident=61871+offset
    try:pwd.getpwuid(ident);raise AssertionError('Focused account UID already exists')
    except KeyError:pass
    try:grp.getgrgid(ident);raise AssertionError('Focused account GID already exists')
    except KeyError:pass
    slot['uid']=ident;slot['gid']=ident;created_accounts.append(ident)
   if not f.invoke('identity.principal.revoke',{'credential_id':transport['credential_id'],'expected_version':'1'})[1].get('ok'):raise AssertionError('Actual predecessor runner revoke refused')
   grant_id=uid();positive['enrollment'].update(grant_id=grant_id,operation_id=uid(),idempotency_key=uid(),secret_file=str(base/'positive-state'/ids['sandbox']/ids['boot']/'enrollment-grant.json'))
   if not f.issue(grant=grant_id,actions=actions)[1].get('ok'):raise AssertionError('Fresh scoped actual enrollment grant refused')
   positive_file=Path(directory)/'positive-manifest.json';write(positive_file,positive);p,r=run('supervisor.bootstrap.stage',positive_file)
   if p.returncode:raise AssertionError('Pinned account template staging refused '+p.stderr)
   write(Path(positive['enrollment']['secret_file']),{'grant_id':grant_id,'secret_b64':base64.urlsafe_b64encode(f.secret).decode().rstrip('=')})
   p,r=run('supervisor.bootstrap',positive_file)
   if p.returncode==0 or 'BOOTSTRAP_SLOT_ALLOCATION_REFUSED' not in p.stderr:raise AssertionError('Actual placement refusal expected after account creation '+p.stderr)
   account=pwd.getpwuid(61871);group=grp.getgrgid(61871)
   if account.pw_name!='hf-slot-61871' or account.pw_gid!=61871 or group.gr_name!='hf-slot-61871':raise AssertionError('Native pinned account provisioner identity mismatch')
   if (base/'positive-state'/ids['sandbox']/ids['boot']/'bootstrap-receipt.json').exists():raise AssertionError('Placement refusal fabricated bootstrap success')
   checks.append('actual-pinned-os-account-creation-then-placement-refusal')
   activation={'manifest_path':str(file),'manifest_digest':pin(file),'activation_path':str(state/'activation-permit.json'),'activation_digest':'sha256:'+'0'*64}
   refused=subprocess.run([str(binary),'--component','12.1','--action','supervisor.bootstrap.activate'],input=json.dumps(activation),text=True,capture_output=True,env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'},timeout=10)
   if refused.returncode==0 or 'ACTIVATION_PERMIT_REFUSED' not in refused.stderr or (state/'activation-receipt.json').exists():raise AssertionError('Unissued activation permit accepted '+refused.stderr)
   checks.append('activation-without-protected-permit-refused')
   broker_state=Path(directory)/'broker-state';broker_state.mkdir(mode=0o700)
   relaunch={'state_dir':str(broker_state),'launch_id':uid(),'attempt_id':uid(),'attempt_generation':'1','sandbox_id':ids['sandbox'],'boot_id':ids['boot'],'boot_generation':'1','command_id':uid(),'env_refs':{'UNAVAILABLE_NATIVE_GUARD_PROBE':'secret-ref:unissued-negative-probe'}}
   refused=subprocess.run([str(binary),'--component','12.2','--action','launch.relaunch'],input=json.dumps(relaunch),text=True,capture_output=True,env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'},timeout=10)
   if refused.returncode==0 or 'CREDENTIAL_ISOLATION_REQUIRED' not in refused.stderr:raise AssertionError('Relaunch read missing secret before authorization '+refused.stderr)
   checks.append('direct-relaunch-authorization-before-secret-resolution')


  report={'status':'PASS','scope':'native-bootstrap-stage-and-enrollment-boundary','checks':checks};(OUT/'receipt.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report));return 0
 finally:
  if f:f.close()
  for ident in created_accounts:
   try:
    entry=pwd.getpwuid(ident)
    if entry.pw_name!='hf-slot-'+str(ident):raise AssertionError('Unexpected account identity during cleanup')
    subprocess.run(['/usr/sbin/userdel','--',entry.pw_name],check=True,capture_output=True)
   except KeyError:pass
   try:
    entry=grp.getgrgid(ident)
    if entry.gr_name!='hf-slot-'+str(ident):raise AssertionError('Unexpected group identity during cleanup')
    subprocess.run(['/usr/sbin/groupdel','--',entry.gr_name],check=True,capture_output=True)
   except KeyError:pass
  if base.exists():shutil.rmtree(base)
if __name__=='__main__':raise SystemExit(main())
