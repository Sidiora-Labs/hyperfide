#!/usr/bin/env python3
"""Component-only authority activation; simulated backends do not qualify providers."""
import importlib.util,json,os,shutil,subprocess,tempfile,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4]
spec=importlib.util.spec_from_file_location('identity29',ROOT/'tests/hyperfide/support/identity_fixture.py')
identity=importlib.util.module_from_spec(spec);spec.loader.exec_module(identity)
IDS=['component-wired','bootstrap','replay','single-epoch','second-bootstrap','revoked-bootstrap','fixture-refused','unbranded-refused','expiry-bound','expired-refused','control-adopts','provisioner-adopts','dispatch-adopts','pending-refused','tamper-refused','proof-refused','owner-private','hardlink-refused','stored-active','stored-inactive','read-error','tooling-store-read','cli-activation','cli-adoption','cli-active','cli-inactive','cli-read-error','followers-no-mint']
DRIVER=r"""
import fs from 'node:fs/promises';
import {randomUUID,generateKeyPairSync} from 'node:crypto';
import {FileExternalFenceJournal,externalFenceTopologyDigest} from 'FENCE';
import {issueIsolationPermit,loadIsolationPermitVerifier} from 'CREDENTIALS';
export async function createBootstrapFenceArguments(){
 const root=process.env.HF29_ROOT,D='sha256:'+'a'.repeat(64),op=process.env.HF29_OPERATION;
 const config={schema_version:1,deployment_id:process.env.HYPERFIDE_DEPLOYMENT_ID,organisation_id:process.env.HF29_ORG,run_id:process.env.HF29_RUN,source_epoch:null,evidence_scope:process.env.HF29_SCOPE??'LIVE_PROVIDER',legacy_topology_digest:D,legacy_pid_namespace:await fs.readlink('/proc/self/ns/pid'),legacy_mount_namespace:await fs.readlink('/proc/self/ns/mnt'),required_writer_ids:['writer'],resources:[{reference_key:'writer',topology_digest:D,writer_ids:['writer'],backend:'PROVIDER'}]};
 const pair=generateKeyPairSync('ed25519'),key=root+'/key.pem',verifier=root+'/verifier.json';
 await fs.writeFile(key,pair.privateKey.export({format:'pem',type:'pkcs8'}),{mode:0o600});
 await fs.writeFile(verifier,JSON.stringify({schema_version:1,issuers:[{key_id:'test29',public_key_b64:pair.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64url')}]}),{mode:0o600});
 const now=Date.now(),claims={schema_version:1,purpose:'EXTERNAL_WRITER_ISOLATION_ONLY',deployment_id:config.deployment_id,operation_id:op,organisation_id:config.organisation_id,run_id:config.run_id,source_epoch:null,topology_digest:externalFenceTopologyDigest(config),resources:[{reference_key:'writer',topology_digest:D}],issued_at:new Date(now).toISOString(),expires_at:new Date(now+25000).toISOString(),nonce:randomUUID()};
 const permit=(await loadIsolationPermitVerifier(verifier)).verifySigned(await issueIsolationPermit(claims,{key_id:'test29',private_key_file:key}));
 const providers={isolateConfiguredResource:async(reference,operation,signal,slot)=>{
  const binding={schema_version:1,reference_key:reference,operation_id:operation,topology_digest:D,resource_identity_digest:D,destroy_operation:{operation_id:operation},authority_digest:permit.permit_digest,custody_evidence_digest:D,custody_expires_at:claims.expires_at};
  const old=await slot.prepare(binding),t=Date.now();
  const receipt={reference_key:reference,operation_id:operation,topology_digest:D,resource_identity_digest:D,status:'ISOLATED',observed_state:'ABSENT',evidence_scope:'LIVE_PROVIDER',evidence_digest:D,observed_at:new Date(t).toISOString(),expires_at:new Date(t+20000).toISOString()};
  await slot.record({binding:old.state.binding,receipt,observations:[]});return receipt;
 }};
 const legacyReceipt=(input,status)=>({...input,topology_digest:D,status,observed_at:new Date().toISOString(),expires_at:new Date(Date.now()+20000).toISOString(),evidence_digest:D,visibility:{scope:'CONFIGURED_PID_NAMESPACE',pid_namespace:config.legacy_pid_namespace,mount_namespace:config.legacy_mount_namespace},admission_disabled:true,writable_fds:0,writable_shared_mappings:0,read_only_aliases:1,isolated_writer:'writer'});
 const legacy={disableAdmission:async input=>legacyReceipt(input,'ADMISSION_DISABLED'),observeIsolation:async input=>legacyReceipt(input,'ISOLATED')};
 return [config,providers,legacy,new FileExternalFenceJournal(root+'/fences'),{kind:'ISOLATION_PERMIT',permit:process.env.HF29_UNBRANDED?{}:permit}];
}
"""
PROBE=r"""
import fs from 'node:fs/promises';import {randomUUID} from 'node:crypto';
import {createResourceContainer} from './services/hyperfide/dist/storage/runtime.js';
import {AuthorityStore,activateBootstrapAuthority,lookupAuthorityActivation,assertExternalAuthorityCurrent,readAuthorityActivated} from './services/hyperfide/dist/storage/durability.js';
import {FileExternalAuthorityJournal} from './services/hyperfide/dist/storage/authority_journal.js';
import {createExternalWriterFence} from './services/hyperfide/dist/recovery/fencing.js';
const r=createResourceContainer({role:process.env.HF29_ROLE??'control',env:process.env,signal:new AbortController().signal}),deployment=process.env.HYPERFIDE_DEPLOYMENT_ID,root=process.env.HF29_ROOT;
const journal=new FileExternalAuthorityJournal(process.env.HYPERFIDE_AUTHORITY_JOURNAL_DIR,i=>lookupAuthorityActivation(r,i));
const out={},refused=async(fn,code)=>{try{await fn();return false}catch(e){return e.code===code}};
try{
 if(process.env.HF29_FOLLOW){
  const document=await fs.readFile(root+'/snapshot.json','utf8');await journal.adoptCommitted({deployment_id:deployment,document});
  const a=await assertExternalAuthorityCurrent(r,journal,{deployment_id:deployment});console.log(JSON.stringify({epoch:a.epoch,uid:process.getuid()}));
 }else{
 const driver=await import(process.env.HF29_DRIVER),args=await driver.createBootstrapFenceArguments(),op=process.env.HF29_OPERATION;
 const activated=await activateBootstrapAuthority(r,deployment,journal,op,args);out.bootstrap=!activated.replayed;
 const replay=await activateBootstrapAuthority(r,deployment,journal,op,args);out.replay=replay.replayed&&replay.epoch===activated.epoch;
 out['second-bootstrap']=await refused(()=>activateBootstrapAuthority(r,deployment,journal,randomUUID(),args),'AUTHORITY_BOOTSTRAP_EXISTS');
 const epochs=(await r.observe({preferReplica:false},s=>s.query('SELECT activation_kind FROM hyperfide.authority_epochs WHERE deployment_id=$1',[deployment]))).value.rows;
 out['single-epoch']=epochs.length===1&&epochs[0].activation_kind==='BOOTSTRAP';
 out['stored-active']=await readAuthorityActivated(r,deployment);out['stored-inactive']=!(await readAuthorityActivated(r,randomUUID()));
 out['read-error']=await refused(()=>readAuthorityActivated(r,'invalid'),'AUTHORITY_CONFIG_INVALID');
 const store=new AuthorityStore(r,randomUUID(),journal),fresh=()=>({operation_id:randomUUID(),expected_previous_epoch:null});
 const fencer=ms=>({isolate:async i=>({...i,fence_id:randomUUID(),isolated_writer:'test-receipt-boundary',evidence_digest:'sha256:'+'b'.repeat(64),observed_at:new Date().toISOString(),expires_at:new Date(Date.now()+ms).toISOString()})});
 out['expiry-bound']=await refused(()=>store.activate(fresh(),fencer(30001)),'EXTERNAL_FENCE_INVALID');
 const stale={isolate:async i=>({...await fencer(10000).isolate(i),observed_at:new Date(Date.now()-20000).toISOString(),expires_at:new Date(Date.now()-10000).toISOString()})};
 out['expired-refused']=await refused(()=>store.activate(fresh(),stale),'EXTERNAL_FENCE_EXPIRED');
 process.env.HF29_SCOPE='COMPONENT_FIXTURE';out['fixture-refused']=await refused(async()=>activateBootstrapAuthority(r,randomUUID(),journal,randomUUID(),await driver.createBootstrapFenceArguments()),'EXTERNAL_FENCE_EVIDENCE_SCOPE_MISMATCH');delete process.env.HF29_SCOPE;
 process.env.HF29_UNBRANDED='1';out['unbranded-refused']=await refused(async()=>createExternalWriterFence(...await driver.createBootstrapFenceArguments()).isolate({deployment_id:deployment,operation_id:op,source_epoch:null}),'ISOLATION_PERMIT_REQUIRED');delete process.env.HF29_UNBRANDED;
 const file=process.env.HYPERFIDE_AUTHORITY_JOURNAL_DIR+'/'+deployment+'.authority.json',document=await fs.readFile(file,'utf8');await fs.writeFile(root+'/snapshot.json',document,{mode:0o644});
 out['tamper-refused']=await refused(()=>journal.adoptCommitted({deployment_id:deployment,document:JSON.stringify({...JSON.parse(document),epoch:randomUUID()})}),'EXTERNAL_AUTHORITY_CORRUPT');
 // A valid PENDING document from the actual prepare path must remain inadmissible.
 const pendingDeployment=randomUUID();await journal.prepareActivation({deployment_id:pendingDeployment,operation_id:randomUUID(),expected_previous_epoch:null,fence_evidence_digest:'sha256:'+'c'.repeat(64)});
 const pendingDocument=await fs.readFile(process.env.HYPERFIDE_AUTHORITY_JOURNAL_DIR+'/'+pendingDeployment+'.authority.json','utf8');
 out['pending-refused']=await refused(()=>journal.adoptCommitted({deployment_id:pendingDeployment,document:pendingDocument}), 'EXTERNAL_AUTHORITY_PENDING');
 const wrong=new FileExternalAuthorityJournal(process.env.HYPERFIDE_AUTHORITY_JOURNAL_DIR,async i=>({...await lookupAuthorityActivation(r,i),evidence_digest:'sha256:'+'d'.repeat(64)}));
 out['proof-refused']=await refused(()=>wrong.adoptCommitted({deployment_id:deployment,document}),'EXTERNAL_AUTHORITY_CONFLICT');
 await fs.chmod(file,0o644);out['owner-private']=await refused(()=>journal.current({deployment_id:deployment}),'EXTERNAL_AUTHORITY_PATH_UNSAFE');await fs.chmod(file,0o600);
 await fs.link(file,root+'/hardlink');out['hardlink-refused']=await refused(()=>journal.current({deployment_id:deployment}),'EXTERNAL_AUTHORITY_PATH_UNSAFE');await fs.unlink(root+'/hardlink');
 const revoked=randomUUID();await r.gateway.withPrimaryTransaction({},tx=>tx.query("INSERT INTO hyperfide.authority_epochs(deployment_id,epoch,previous_epoch,database_predecessor_epoch,activation_kind,state,fence_id,proof_digest) VALUES($1,$2,NULL,NULL,'BOOTSTRAP','REVOKED',$3,$4)",[revoked,randomUUID(),randomUUID(),'sha256:'+'e'.repeat(64)]));
 out['revoked-bootstrap']=await refused(()=>new AuthorityStore(r,revoked,journal).activate(fresh(),fencer(10000)),'AUTHORITY_BOOTSTRAP_EXISTS');
 console.log(JSON.stringify({out,epoch:activated.epoch}));
 }
}finally{await r.close()}
"""
def main():
 f=None;folder=Path(tempfile.mkdtemp(prefix='hf-authority29-'));observed={};complete=False
 base=Path(os.environ.get('HYPERFIDE_CAMPAIGN_DIR','/tmp/hyperfide/task29.1'));base.mkdir(parents=True,exist_ok=True)
 processes=[]
 def record(p):
  processes.append({'argv':p.args,'exit_code':p.returncode,'stdout':p.stdout,'stderr':p.stderr})
  (base/'authority-processes.json').write_text(json.dumps(processes,indent=2)+'\n')
 try:
  f=identity.IdentityFixture(extra_actions=['storage.durability.inspect','storage.migrations.inspect','storage.authority.activate','storage.authority.adopt'])
  status,response=f.invoke('storage.durability.inspect',{},component='4.4');observed['component-wired']=status==200 and response.get('ok') is True
  folder.chmod(0o755);shutil.copyfile(shutil.which('node'),folder/'node');(folder/'node').chmod(0o755);(folder/'leader').mkdir(mode=0o700);(folder/'fences').mkdir(mode=0o700)
  driver=folder/'driver.mjs';driver.write_text(DRIVER.replace('FENCE',(ROOT/'services/hyperfide/dist/recovery/fencing.js').as_uri()).replace('CREDENTIALS',(ROOT/'services/hyperfide/dist/identity/credentials.js').as_uri()));driver.chmod(0o600)
  env={**f.env,'HYPERFIDE_DEPLOYMENT_ID':str(uuid.uuid4()),'HYPERFIDE_AUTHORITY_JOURNAL_DIR':str(folder/'leader'),'HF29_ROOT':str(folder),'HF29_DRIVER':driver.as_uri(),'HF29_OPERATION':str(uuid.uuid4()),'HF29_ORG':f.ids['organisation'],'HF29_RUN':f.ids['run']}
  def run(js,environment,**kw):
   p=subprocess.run([str(folder/'node'),'--input-type=module'],input=js,text=True,capture_output=True,cwd=ROOT,env=environment,timeout=60,**kw)
   record(p)
   if p.returncode:raise RuntimeError(p.stderr[-2000:])
   return json.loads(p.stdout)
  result=run(PROBE,env);observed.update(result['out'])
  for n,role in enumerate(['control','provisioner','dispatch'],start=61001):
   directory=folder/role;directory.mkdir(mode=0o700);os.chown(directory,n,n)
   follower={**env,'HF29_ROLE':role,'HF29_FOLLOW':'1','HYPERFIDE_AUTHORITY_JOURNAL_DIR':str(directory)}
   value=run(PROBE,follower,user=n,group=n,extra_groups=[])
   observed[role+'-adopts']=value['epoch']==result['epoch'] and value['uid']==n
  observed['followers-no-mint']=f.sql('SELECT count(*)::int AS count FROM hyperfide.authority_epochs WHERE deployment_id=$1',[env['HYPERFIDE_DEPLOYMENT_ID']])[0]['count']==1
  # Exercise the real operator wrapper against a release-layout fixture.
  release=folder/'release';(release/'runtime').mkdir(parents=True);(release/'services').mkdir();shutil.copyfile(shutil.which('node'),release/'runtime/node');(release/'runtime/node').chmod(0o755)
  (release/'services/dist').symlink_to(ROOT/'services/hyperfide/dist');(release/'services/components').symlink_to(ROOT/'services/hyperfide/components')
  f.policy.chmod(0o600)
  common=['node','deploy/hyperfide/migrate.mjs','--release-root',str(release),'--policy-file',str(f.policy),'--spec-revision','fixture-identity-v1','--operation-id',env['HF29_OPERATION']]
  cli_env={**env,'HYPERFIDE_MIGRATION_DATABASE_URL':f.url}
  p=subprocess.run(common+['--activate-authority','--fence-driver',str(driver)],cwd=ROOT,env=cli_env,text=True,capture_output=True,timeout=60);record(p);v=json.loads(p.stdout);observed['cli-activation-response']=v;observed['cli-activation']=p.returncode==0 and v.get('receipt',{}).get('replayed') is True and v.get('authority_activated') is True
  adopt=folder/'adopt';adopt.mkdir(mode=0o700);snapshot=folder/'snapshot.json';snapshot.chmod(0o600)
  p=subprocess.run(common+['--adopt-authority','--journal-document',str(snapshot)],cwd=ROOT,env={**cli_env,'HYPERFIDE_AUTHORITY_JOURNAL_DIR':str(adopt)},text=True,capture_output=True,timeout=60);record(p);v=json.loads(p.stdout);observed['cli-adoption-response']=v;observed['cli-adoption']=p.returncode==0 and v.get('receipt',{}).get('epoch')==result['epoch']
  for name,deployment in [('cli-active',env['HYPERFIDE_DEPLOYMENT_ID']),('cli-inactive',str(uuid.uuid4())),('cli-read-error','invalid')]:
   p=subprocess.run(common+['--inspect'],cwd=ROOT,env={**cli_env,'HYPERFIDE_DEPLOYMENT_ID':deployment},text=True,capture_output=True,timeout=60);record(p);v=json.loads(p.stdout);observed[name+'-response']=v
   observed[name]=(p.returncode!=0 and v.get('authority_activated','missing') is None and v.get('ok') is False) if name=='cli-read-error' else p.returncode==0 and v.get('authority_activated') is (name=='cli-active')
  observed['tooling-store-read']=all('authority_activated:false' not in (ROOT/p).read_text() and 'readAuthorityActivated' in (ROOT/p).read_text() for p in ['deploy/hyperfide/migrate.mjs','deploy/hyperfide/install-service.mjs'])
 except Exception as e:observed['error']=str(e)
 finally:
  if f:
   database,role=f.database,f.runtime_role;f.close()
   state=f.sql('SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=$1) AS db,EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$2) AS role',[database,role],admin=True)[0]
   complete=not state['db'] and not state['role']
  shutil.rmtree(folder);complete=complete and not folder.exists()
 base=Path(os.environ.get('HYPERFIDE_CAMPAIGN_DIR','/tmp/hyperfide/task29.1'));base.mkdir(parents=True,exist_ok=True);(base/'authority-observations.json').write_text(json.dumps(observed,indent=2)+'\n')
 for name in IDS:print(json.dumps({'type':'assertion','id':'authority.'+name,'expected':True,'actual':observed.get(name) is True}),flush=True)
 print(json.dumps({'type':'cleanup','complete':complete,'resources':[]}),flush=True)
 if 'error' in observed:print(observed['error'],file=__import__('sys').stderr)
 return 0 if complete and all(observed.get(n) is True for n in IDS) else 1
if __name__=='__main__':raise SystemExit(main())
