#!/usr/bin/env python3
"""V-068 first activation through the shipped release fence driver and an off-box signed permit.
The Railway admin API is a recorded test transport; this is component evidence, not live provider qualification."""
import base64,hashlib,importlib.util,json,os,shutil,subprocess,sys,tempfile,time,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4]
# The migration job's authority grants come from the shipped control policy, never from the test; a policy that
# drops them must make the activation and adoption probes fail.
SHIPPED_AUTHORITY=[a for a in json.loads((ROOT/'deploy/hyperfide/policies/control.example.json').read_text())['allowed_actions'] if a.startswith('storage.authority.')]
spec=importlib.util.spec_from_file_location('binding_29_11',ROOT/'tests/hyperfide/cases/tasks/29_3.py')
binding=importlib.util.module_from_spec(spec);spec.loader.exec_module(binding)
m=binding.m
IDS=['bootstrap.topology-consistent','bootstrap.payload-canonical','bootstrap.seal-verified','bootstrap.unsigned-refused','bootstrap.forged-seal-refused','bootstrap.other-deployment-refused','bootstrap.other-topology-refused','bootstrap.other-operation-refused','bootstrap.expired-refused','bootstrap.tampered-digest-refused','bootstrap.no-epoch-before-activation','bootstrap.no-provider-effect-before-activation','bootstrap.activated','bootstrap.single-bootstrap-epoch','bootstrap.provider-destroyed','bootstrap.legacy-admission-disabled','bootstrap.control-adopts','bootstrap.provisioner-adopts','bootstrap.dispatch-adopts','bootstrap.followers-no-mint','bootstrap.no-signing-key-read']
WRITER='bootstrap-writer'
NATIVE='bootstrap-writer-resource'
RECORDER=r"""
import fs from 'node:fs';
// Test-only recorded Railway admin transport: answers the exact GraphQL admin
// endpoint from a local record and refuses every other network request.
const record=process.env.HF29_11_RECORD;
const destroyed=()=>fs.existsSync(record)&&fs.readFileSync(record,'utf8').split('\n').filter(Boolean).some(l=>JSON.parse(l).operation==='RailwayIsolationDestroy');
globalThis.fetch=async(input,init={})=>{
 const url=String(input instanceof Request?input.url:input);
 if(url!=='https://backboard.railway.com/graphql/v2'||init.method!=='POST')throw new TypeError('recorded transport refuses '+url);
 const body=JSON.parse(String(init.body)),operation=/^(?:mutation|query)\s+([A-Za-z0-9_]+)/.exec(body.query)?.[1]??'anonymous';
 const was=destroyed();
 fs.appendFileSync(record,JSON.stringify({operation,variables:body.variables,authorization:init.headers?.Authorization??null})+'\n',{mode:0o600});
 if(operation==='RailwayIsolationDestroy')return Response.json({data:{sandboxDestroy:true}});
 if(!was)return new Response('{}',{status:503});
 return Response.json({data:{sandbox:null}});
};
"""
ROLE_PROBE=r"""
import {createResourceContainer} from './services/dist/storage/runtime.js';
import {lookupAuthorityActivation,assertExternalAuthorityCurrent} from './services/dist/storage/durability.js';
import {FileExternalAuthorityJournal} from './services/dist/storage/authority_journal.js';
const r=createResourceContainer({role:process.env.HF29_11_ROLE,env:process.env,signal:new AbortController().signal}),deployment=process.env.HYPERFIDE_DEPLOYMENT_ID;
try{const journal=new FileExternalAuthorityJournal(process.env.HYPERFIDE_AUTHORITY_JOURNAL_DIR,i=>lookupAuthorityActivation(r,i));
 const a=await assertExternalAuthorityCurrent(r,journal,{deployment_id:deployment});console.log(JSON.stringify({epoch:a.epoch,uid:process.getuid()}));}
finally{await r.close()}
"""
def canonical(v):return json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=False)
def b64(b):return base64.urlsafe_b64encode(b).decode().rstrip('=')
def private(path,data):
 path=Path(path)
 if path.exists():path.unlink()
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,'wb') as h:h.write(data if isinstance(data,bytes) else data.encode())
def run(argv,env,log,cwd=None,**kw):
 p=subprocess.run(argv,cwd=cwd,env=env,text=True,capture_output=True,timeout=90,**kw)
 log.append({'argv':[str(a) for a in argv],'exit_code':p.returncode,'stdout':p.stdout,'stderr':p.stderr[-4000:]})
 return p
def outcome(p):
 try:return json.loads(p.stdout.strip().splitlines()[-1])
 except (ValueError,IndexError):return {'ok':False,'error':{'code':'UNPARSEABLE'}}
def sign(key,signing_input,folder):
 source=folder/'signing-input';private(source,signing_input);target=folder/'signature'
 if target.exists():target.unlink()
 subprocess.run(['openssl','pkeyutl','-sign','-rawin','-inkey',str(key),'-in',str(source),'-out',str(target)],check=True,capture_output=True,timeout=30)
 return target.read_bytes()
def signing_input(key_id,payload):return ('HYPERFIDE-ISOLATION-PERMIT-V1\n'+key_id+'\n'+'sha256:'+hashlib.sha256(payload).hexdigest()+'\n').encode()
def envelope(key_id,payload,signature):return canonical({'schema_version':1,'key_id':key_id,'payload_b64':b64(payload),'signature_b64':b64(signature)}).encode()

def activation(context_file):
 """Runs inside a private user, mount and pid namespace that is the configured legacy writer boundary."""
 c=json.loads(Path(context_file).read_text());env=c['env'];folder=Path(c['folder']);release=Path(c['release']);log=[];o={}
 data=Path(c['workspace'])/'data';node=str(release/'runtime/node');fence=[node,str(release/'deploy/hyperfide/bootstrap-fence.mjs')]
 subprocess.run(['mount','--bind',str(data),str(data)],check=True);subprocess.run(['mount','-o','remount,bind,ro',str(data)],check=True)
 try:
  legacy={'schema_version':1,'deployment_id':env['HYPERFIDE_DEPLOYMENT_ID'],'source_epoch':None,'workspace_root':c['workspace'],'data_roots':['data'],'legacy_writer_id':WRITER,'expected_pid_namespace':os.readlink('/proc/self/ns/pid'),'expected_mount_namespace':os.readlink('/proc/self/ns/mnt')}
  private(env['HF_LEGACY_WRITER_CONFIG_FILE'],json.dumps(legacy))
  isolation=c['isolation']
  def write_isolation(digest,resource_digest=None):
   value=json.loads(json.dumps(isolation));value['topology_digest']=digest
   for r in value['resources']:r['resource_topology_digest']=resource_digest or digest
   private(env['HYPERFIDE_WRITER_ISOLATION_CONFIG'],json.dumps(value))
  write_isolation('sha256:'+'0'*64)
  first=outcome(run(fence+['--topology'],env,log,cwd=release));D=first.get('topology_digest','')
  write_isolation(D);second=outcome(run(fence+['--topology'],env,log,cwd=release))
  o['topology-consistent']=first.get('consistent') is False and second.get('consistent') is True and second.get('topology_digest')==D and second['topology']['evidence_scope']=='LIVE_PROVIDER' and all(r['topology_digest']==D and r['backend']=='PROVIDER' for r in second['topology']['resources'])
  operation=c['operation'];key_id=c['key_id'];key=Path(c['signing_key'])
  out=folder/'permit-out';out.mkdir(mode=0o700)
  payload_result=outcome(run(fence+['--permit-payload','--operation-id',operation,'--key-id',key_id,'--ttl-seconds','600','--output-dir',str(out)],env,log,cwd=release))
  payload=(out/'permit.payload').read_bytes();claims=json.loads(payload)
  o['payload-canonical']=payload_result.get('ok') is True and canonical(claims).encode()==payload and (out/'permit.signing-input').read_bytes()==signing_input(key_id,payload) and claims['topology_digest']==D and claims['operation_id']==operation and claims['deployment_id']==env['HYPERFIDE_DEPLOYMENT_ID'] and claims['source_epoch'] is None and claims['resources']==[{'reference_key':WRITER,'topology_digest':D}] and (out/'permit.payload').stat().st_mode&0o777==0o600
  # Off-box operator signature over the printed signing input.
  sig=folder/'operator';sig.mkdir(mode=0o700)
  signature=sign(key,(out/'permit.signing-input').read_bytes(),sig);(sig/'permit.sig').write_bytes(signature)
  permit=Path(env['HYPERFIDE_ISOLATION_PERMIT_FILE'])
  sealed=outcome(run(fence+['--seal-permit','--operation-id',operation,'--key-id',key_id,'--payload',str(out/'permit.payload'),'--signature',str(sig/'permit.sig'),'--output',str(permit)],env,log,cwd=release))
  verified=outcome(run(fence+['--verify-permit','--operation-id',operation],env,log,cwd=release))
  o['seal-verified']=sealed.get('ok') is True and verified.get('ok') is True and permit.read_bytes()==envelope(key_id,payload,signature) and permit.stat().st_mode&0o777==0o600
  good=permit.read_bytes()
  migrate=[node,'--import',Path(c['recorder']).as_uri(),str(release/'deploy/hyperfide/migrate.mjs'),'--release-root',str(release),'--policy-file',c['policy'],'--spec-revision','fixture-identity-v1','--activate-authority','--fence-driver','deploy/hyperfide/bootstrap-fence.mjs','--operation-id']
  epochs=lambda:c_sql(c,env)
  record=Path(env['HF29_11_RECORD'])
  def refused(name,permit_bytes,code,op=operation,isolation_digest=None):
   private(permit,permit_bytes)
   if isolation_digest:write_isolation(isolation_digest,D)
   try:p=run(migrate+[op],env,log,cwd=release);v=outcome(p)
   finally:
    if isolation_digest:write_isolation(D)
   o[name+'-response']=v
   o[name]=p.returncode==1 and v.get('ok') is False and v.get('error',{}).get('code')==code and epochs()==[] and not record.exists()
  def resigned(change):
   value={**claims,**change,'nonce':str(uuid.uuid4())};body=canonical(value).encode()
   return envelope(key_id,body,sign(key,signing_input(key_id,body),sig))
  refused('unsigned-refused',payload,'ISOLATION_PERMIT_INVALID')
  private(sig/'forged.sig',bytes(64))
  forged=outcome(run(fence+['--seal-permit','--operation-id',operation,'--key-id',key_id,'--payload',str(out/'permit.payload'),'--signature',str(sig/'forged.sig'),'--output',str(sig/'forged.permit')],env,log,cwd=release))
  refused('forged-seal-refused',envelope(key_id,payload,bytes(64)),'ISOLATION_PERMIT_INVALID')
  o['forged-seal-refused']=o['forged-seal-refused'] and forged.get('error',{}).get('code')=='ISOLATION_PERMIT_INVALID' and not (sig/'forged.permit').exists()
  refused('other-deployment-refused',resigned({'deployment_id':str(uuid.uuid4())}),'ISOLATION_PERMIT_SCOPE')
  refused('other-topology-refused',resigned({'topology_digest':'sha256:'+hashlib.sha256(b'other topology').hexdigest()}),'ISOLATION_PERMIT_SCOPE')
  refused('other-operation-refused',good,'ISOLATION_PERMIT_SCOPE',op=str(uuid.uuid4()))
  now=time.time()
  refused('expired-refused',resigned({'issued_at':time.strftime('%Y-%m-%dT%H:%M:%S.000Z',time.gmtime(now-180)),'expires_at':time.strftime('%Y-%m-%dT%H:%M:%S.000Z',time.gmtime(now-60))}),'ISOLATION_PERMIT_EXPIRED')
  refused('tampered-digest-refused',good,'EXTERNAL_FENCE_TOPOLOGY_DIGEST_MISMATCH',isolation_digest='sha256:'+hashlib.sha256(b'tampered').hexdigest())
  o['no-epoch-before-activation']=epochs()==[]
  o['no-provider-effect-before-activation']=not record.exists()
  private(permit,good)
  p=run(migrate+[operation],env,log,cwd=release);v=outcome(p);o['activation-response']=v
  o['activated']=p.returncode==0 and v.get('ok') is True and v.get('receipt',{}).get('replayed') is False and v.get('authority_activated') is True
  rows=epochs();o['epoch']=rows[0]['epoch'] if rows else None
  o['single-bootstrap-epoch']=len(rows)==1 and rows[0]['activation_kind']=='BOOTSTRAP' and rows[0]['state']=='ACTIVE' and rows[0]['epoch']==v.get('receipt',{}).get('epoch')
  calls=[json.loads(l) for l in record.read_text().splitlines()] if record.exists() else []
  o['recorded-calls']=calls
  o['provider-destroyed']=[x['operation'] for x in calls].count('RailwayIsolationDestroy')==1 and all(x['variables']=={'environmentId':'fixture-env','id':NATIVE} and x['authorization']=='Bearer '+env['HF_RAILWAY_TOKEN'] for x in calls) and len(calls)>=2
  marker=Path(c['workspace'])/'.hyperfide/authority.json'
  o['legacy-admission-disabled']=marker.exists() and json.loads(marker.read_text())=={'schema_version':1,'mode':'distributed','authority_epoch':operation}
 finally:
  subprocess.run(['umount',str(data)],check=False)
  Path(c['result']).write_text(json.dumps({'observed':o,'processes':log}))
def c_sql(c,env):
 p=subprocess.run([str(Path(c['release'])/'runtime/node'),'--input-type=commonjs','-e',m.identity.SQL_JS],cwd=ROOT,env={**env,'DATABASE_URL':c['owner_url']},input=json.dumps({'sql':'SELECT epoch::text AS epoch,activation_kind,state FROM hyperfide.authority_epochs WHERE deployment_id=$1','values':[env['HYPERFIDE_DEPLOYMENT_ID']],'serial':False}),capture_output=True,text=True,timeout=20)
 if p.returncode:raise RuntimeError(p.stderr[-1000:])
 return json.loads(p.stdout)

def main():
 if sys.argv[1:2]==['--activation']:activation(sys.argv[2]);return 0
 if sys.argv[1:]:raise SystemExit('unsupported argument')
 base=Path(os.environ.get('HYPERFIDE_CAMPAIGN_DIR','/tmp/hyperfide/task29.11'));base.mkdir(parents=True,exist_ok=True)
 f=None;observed={};processes=[];complete=False;folder=Path(tempfile.mkdtemp(prefix='hf-bootstrap-fence-'))
 try:
  f=m.ProvisionerFixture(extra_components=['8.2'],extra_setup=binding.setup,extra_actions=SHIPPED_AUTHORITY)
  status,response=f.invoke('provider.pools.configure',{},component='8.2',key='operator');m.expect(status==200 and response.get('ok') is True,response)
  org=f.ids['organisation'];sandbox=str(uuid.uuid4())
  f.sql("INSERT INTO hyperfide.sandboxes(organisation_id,id,pool_id,native_sandbox_id,observed_state,preparation_digest) VALUES($1,$2,$3,$4,'RUNNING',$5)",[org,sandbox,f.pool,NATIVE,f.preparation])
  boot=f.sql('SELECT boot_id FROM hyperfide.sandbox_boots WHERE organisation_id=$1 AND sandbox_id=$2',[org,sandbox])[0]['boot_id']
  configured=f.sql('SELECT configuration_digest FROM hyperfide.provider_pool_configurations WHERE organisation_id=$1 AND pool_id=$2 AND active',[org,f.pool])[0]['configuration_digest']
  scope={'organisation_id':org,'pool_id':f.pool,'provider':'railway','provider_account_id':'fixture-account','environment_id':'fixture-env','region':'fixture-region','configuration_digest':configured}
  folder.chmod(0o755)
  # Release-layout copy: root-owned files without group or world write, traversable by the follower uids.
  release=folder/'release';(release/'runtime').mkdir(parents=True);(release/'deploy/hyperfide').mkdir(parents=True);(release/'services').mkdir()
  shutil.copyfile(shutil.which('node'),release/'runtime/node');(release/'runtime/node').chmod(0o755)
  for name in ['dist','components','node_modules']:shutil.copytree(ROOT/'core/control-plane'/name,release/'services'/name,symlinks=True)
  shutil.copyfile(ROOT/'core/control-plane/package.json',release/'services/package.json')
  for name in ['migrate.mjs','bootstrap-fence.mjs']:shutil.copyfile(ROOT/'deploy/hyperfide'/name,release/'deploy/hyperfide'/name);(release/'deploy/hyperfide'/name).chmod(0o644)
  control=folder/'control';control.mkdir(mode=0o700)
  for name in ['leader','fences','workspace','preparation']:(control/name).mkdir(mode=0o700)
  (control/'workspace/data').mkdir(mode=0o700);(control/'workspace/data/state.db').write_text('legacy state\n')
  recorder=control/'recorded-railway.mjs';private(recorder,RECORDER)
  railway=control/'railway.json';private(railway,json.dumps({'schema_version':1,'mode':'live','endpoint':'https://backboard.railway.com/graphql/v2','environment_id':'fixture-env','region':'fixture-region','account_id':'fixture-account','token_env':'HF_RAILWAY_TOKEN','auth_type':'bearer','preparation_root':str(control/'preparation'),'request_timeout_ms':5000,'exec_ws_endpoint':None}))
  key_id='bootstrap-operator';verifier=control/'verifier.json';private(verifier,json.dumps({'schema_version':1,'issuers':[{'key_id':key_id,'public_key_b64':f.keys['operator']['public_key_b64']}]}))
  policy=control/'policy.json';shutil.copyfile(f.policy,policy);policy.chmod(0o600)
  deployment=str(uuid.uuid4());operation=str(uuid.uuid4())
  isolation={'schema_version':1,'deployment_id':deployment,'organisation_id':org,'run_id':f.ids['run'],'source_epoch':None,'topology_digest':'','evidence_scope':'LIVE_PROVIDER','maximum_operation_ms':20000,'proof_max_age_ms':20000,
   'resources':[{'reference_key':WRITER,'scope':scope,'resource':{'native_sandbox_id':NATIVE,'sandbox_boot_generation':'1'},'boot_id':boot,'preparation_digest':f.preparation,'resource_topology_digest':''}]}
  env={**f.env,'HYPERFIDE_DEPLOYMENT_ID':deployment,'HYPERFIDE_AUTHORITY_JOURNAL_DIR':str(control/'leader'),'HYPERFIDE_MIGRATION_DATABASE_URL':f.url,
   'HYPERFIDE_WRITER_ISOLATION_CONFIG':str(control/'isolation.json'),'HF_LEGACY_WRITER_CONFIG_FILE':str(control/'legacy.json'),'HF_RAILWAY_CONFIG':str(railway),'HF_RAILWAY_TOKEN':'recorded-transport-'+uuid.uuid4().hex,
   'HYPERFIDE_EXTERNAL_FENCE_JOURNAL_DIR':str(control/'fences'),'HYPERFIDE_ISOLATION_PERMIT_VERIFIER_FILE':str(verifier),'HYPERFIDE_ISOLATION_PERMIT_FILE':str(control/'permit.json'),'HF29_11_RECORD':str(control/'railway-calls.jsonl')}
  context=control/'context.json';result=control/'result.json'
  # The signing key path is handed only to the operator-side openssl step, never to a release command's environment.
  private(context,json.dumps({'env':env,'folder':str(control),'release':str(release),'workspace':str(control/'workspace'),'isolation':isolation,'operation':operation,'key_id':key_id,'signing_key':str(f.keys['operator']['path']),'recorder':str(recorder),'policy':str(policy),'owner_url':f.url,'result':str(result)}))
  p=subprocess.run(['unshare','--user','--map-root-user','--mount','--pid','--fork','--mount-proc','--propagation','private',sys.executable,str(Path(__file__).resolve()),'--activation',str(context)],env=os.environ.copy(),text=True,capture_output=True,timeout=420)
  processes.append({'argv':p.args,'exit_code':p.returncode,'stdout':p.stdout[-4000:],'stderr':p.stderr[-4000:]})
  inner=json.loads(result.read_text());observed.update(inner['observed']);processes.extend(inner['processes'])
  # Release commands receive no signing key: neither their arguments nor their environment name it, and the shipped driver has no issuing path.
  key=str(f.keys['operator']['path']);shipped=[(release/'deploy/hyperfide/bootstrap-fence.mjs').read_text(),(release/'services/dist/recovery/bootstrap_fence.js').read_text()]
  observed['no-signing-key-read']=all(key not in v for v in env.values()) and all(key not in json.dumps(x['argv']) for x in inner['processes']) and all('issueIsolationPermit' not in t and 'private_key_file' not in t for t in shipped)
  document=control/'leader'/(deployment+'.authority.json')
  for n,role in enumerate(['control','provisioner','dispatch'],start=61001):
   home=folder/('follower-'+role);home.mkdir(mode=0o700);os.chown(home,n,n);journal=home/'journal';journal.mkdir(mode=0o700);os.chown(journal,n,n)
   copy=home/'authority.json';shutil.copyfile(document,copy);copy.chmod(0o600);os.chown(copy,n,n)
   own_policy=home/'policy.json';shutil.copyfile(f.policy,own_policy);own_policy.chmod(0o600);os.chown(own_policy,n,n)
   follower={k:v for k,v in env.items() if not k.startswith(('HF_RAILWAY','HYPERFIDE_ISOLATION','HYPERFIDE_EXTERNAL_FENCE','HF29_11'))};follower['HYPERFIDE_AUTHORITY_JOURNAL_DIR']=str(journal)
   q=run([str(release/'runtime/node'),str(release/'deploy/hyperfide/migrate.mjs'),'--release-root',str(release),'--policy-file',str(own_policy),'--spec-revision','fixture-identity-v1','--adopt-authority','--journal-document',str(copy),'--operation-id',operation],follower,processes,cwd=release,user=n,group=n,extra_groups=[])
   v=outcome(q);observed[role+'-adoption-response']=v
   probe=run([str(release/'runtime/node'),'--input-type=module','-e',ROLE_PROBE],{**follower,'HF29_11_ROLE':role},processes,cwd=release,user=n,group=n,extra_groups=[])
   current=outcome(probe)
   observed[role+'-adopts']=q.returncode==0 and v.get('ok') is True and observed.get('epoch') is not None and v.get('receipt',{}).get('epoch')==observed.get('epoch') and v.get('authority_activated') is True and probe.returncode==0 and current.get('epoch')==observed.get('epoch') and current.get('uid')==n
  rows=f.sql('SELECT activation_kind FROM hyperfide.authority_epochs WHERE deployment_id=$1',[deployment])
  observed['followers-no-mint']=rows==[{'activation_kind':'BOOTSTRAP'}]
 except Exception as e:observed['error']=repr(e)
 finally:
  if f:
   database,role=f.database,f.runtime_role
   try:f.close()
   except Exception as e:observed['cleanup-error']=repr(e)
   state=f.sql('SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=$1) AS db,EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$2) AS role',[database,role],admin=True)[0]
   complete=not state['db'] and not state['role']
  shutil.rmtree(folder,ignore_errors=True);complete=complete and not folder.exists()
 (base/'bootstrap-processes.json').write_text(json.dumps(processes,indent=2,default=str)+'\n')
 (base/'bootstrap-observations.json').write_text(json.dumps(observed,indent=2)+'\n')
 for name in IDS:print(json.dumps({'type':'assertion','id':name,'expected':True,'actual':observed.get(name.removeprefix('bootstrap.')) is True}),flush=True)
 print(json.dumps({'type':'cleanup','complete':complete,'resources':[]}),flush=True)
 if 'error' in observed:print(observed['error'],file=sys.stderr)
 return 0 if complete and all(observed.get(n.removeprefix('bootstrap.')) is True for n in IDS) else 1
if __name__=='__main__':raise SystemExit(main())
