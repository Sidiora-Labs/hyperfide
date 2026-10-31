#!/usr/bin/env python3
"""V-065 component: bound Railway execution through the actual 8.3 execution capability.

Persistence is the migrated PostgreSQL fixture on its runtime role, authentication is the
actual 14.1 Ed25519 request proof, and the Railway SDK/WebSocket endpoints are the recorded
transport fixtures. No provider API is contacted.
"""
import importlib,importlib.util,json,shutil,subprocess,sys,tempfile
from pathlib import Path
c=importlib.import_module('9_1')
IDS=['railway.bound.durable-session','railway.bound.exact-binding','railway.bound.complete-output',
 'railway.bound.replay-refused','railway.bound.stale-refused','railway.bound.public-live-refused',
 'railway.bound.capabilities-refused','railway.bound.prepare-refused','railway.bound.transfer-refused',
 'railway.bound.typed-error-recorded','railway.bound.ambiguous-remains-unknown','railway.bound.component-wired','railway.bound.rejection-not-overwritten','railway.bound.generic-code-recorded','railway.bound.post-dispatch-rejection-unknown']
JS=r"""
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createPrivateKey,sign} from 'node:crypto';
import {createRequire} from 'node:module';
import {ComponentRegistry} from './core/control-plane/dist/components/registry.js';
import {validatePolicy} from './core/control-plane/dist/policy/programme.js';
import {isIdentityAuthority} from './core/control-plane/dist/identity/enrollment.js';
import {hash,signingBytes} from './core/control-plane/dist/transport/protocol.js';
import {RailwayClient,RailwayRequestError} from './core/control-plane/dist/providers/railway/preparation.js';
import {RailwaySessionSpool,createComponent} from './core/control-plane/dist/providers/railway/processes.js';
import {createRailwayAdapter,registerRailwayProvider} from './core/control-plane/dist/providers/railway/reconciliation.js';
import {validateDeployment,configuredScope,digestDocument} from './core/control-plane/dist/providers/pools.js';
import {validateProviderOutcome} from './core/control-plane/dist/providers/contract.js';
const pg=createRequire(process.cwd()+'/core/control-plane/package.json')('pg');
const data=JSON.parse(fs.readFileSync(process.argv[1])),org=data.ids.organisation,run=data.ids.run,controller=new AbortController();
// Fixture rows are seeded through the owner connection; every exercised read and write runs on the runtime role.
const admin=async(sql,values=[])=>{const c=new pg.Client({connectionString:data.admin_url});await c.connect();
 try{await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE');const r=await c.query(sql,values);await c.query('COMMIT');return r.rows;}
 catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{await c.end();}};
const limits={SANDBOX:'1',PROVISIONING:'1'},pool=randomUUID(),sandbox=randomUUID();
const deployment={schema_version:1,organisation_id:org,revision:'component-29.8',
 accounts:[{provider:'railway',account_key:data.config.account_id,approved_limits:limits,planning_limits:{SANDBOX:'1'}}],
 pools:[{id:pool,provider:'railway',account_key:data.config.account_id,environment_key:data.config.environment_id,region:data.config.region,profile_id:null,
  preparation_digest:data.digest,approved_limits:limits,planning_limits:{SANDBOX:'1'},create_policy:{seed_reference:'fixture',network:'ISOLATED',stdin_required:false}}],
 maximum_operation_ms:30000};
fs.writeFileSync(process.env.HYPERFIDE_POOL_CONFIG,JSON.stringify(deployment),{mode:0o600});
const config=validateDeployment(deployment),scope=configuredScope(config,config.pools[0]);
await admin("INSERT INTO hyperfide.provider_pools(organisation_id,id,provider,account_key,environment_key,region) VALUES($1,$2,'railway',$3,$4,$5)",
 [org,pool,data.config.account_id,data.config.environment_id,data.config.region]);
await admin('INSERT INTO hyperfide.provider_pool_configurations(organisation_id,pool_id,configuration_digest,document) VALUES($1,$2,$3,$4)',[org,pool,scope.configuration_digest,deployment.pools[0]]);
await admin("INSERT INTO hyperfide.sandboxes(organisation_id,id,pool_id,native_sandbox_id,observed_state,preparation_digest) VALUES($1,$2,$3,'sandbox-1','RUNNING',$4)",[org,sandbox,pool,data.digest]);
const registry=new ComponentRegistry({role:'provisioner',policy:validatePolicy(JSON.parse(fs.readFileSync(data.policy,'utf8')),'fixture-identity-v1','provisioner'),signal:controller.signal,env:process.env});
const spool=new RailwaySessionSpool(data.spool);
let output;
try{
 await registry.load(data.components,path.join(process.cwd(),'core/control-plane/dist'));
 const authority=registry.resolveCapability('14.1','identity.authority',isIdentityAuthority);
 registry.installInvocationAuthorizer(i=>authority.authorize(i));
 const execution=registry.resolveCapability('8.3','provider.execution.v1',v=>!!v&&typeof v.executeBound==='function'&&typeof v.registerRunnerBindingVerifier==='function');
 const providers=registry.resolveCapability('8.2','provider.registry.v1',v=>!!v&&typeof v.registerProviderAdapter==='function');
 // The registered runner reader observes the current sandbox boot row; runner enrollment itself is outside V-065.
 execution.registerRunnerBindingVerifier(async(tx,b)=>{
  const r=(await tx.query("SELECT b.boot_id,clock_timestamp() AS db_now FROM hyperfide.sandboxes s JOIN hyperfide.sandbox_boots b ON b.organisation_id=s.organisation_id AND b.sandbox_id=s.id AND b.boot_generation=s.boot_generation WHERE s.organisation_id=$1 AND s.id=$2 AND s.pool_id=$3 AND s.native_sandbox_id=$4 AND s.boot_generation=$5 AND s.preparation_digest=$6 AND s.observed_state='RUNNING'",
   [b.organisation_id,b.sandbox_id,b.pool_id,b.external_sandbox_id,b.boot_generation,b.preparation_digest])).rows[0];
  return r?{evidence_digest:digestDocument({binding:b,boot_id:r.boot_id}),observed_at:new Date(r.db_now).toISOString()}:null;
 });
 const key=createPrivateKey(fs.readFileSync(data.key));
 const invocation=async input=>{
  const payload=Buffer.from(JSON.stringify({run_id:run,component:'8.3',action:'provider.remote.execute-bound',input,expected_version:null,authority:null}));
  const body=Buffer.from(JSON.stringify({protocol_version:1,operation_id:randomUUID(),idempotency_key:randomUUID(),payload_digest:hash(payload),
   correlation_id:randomUUID(),causation_id:null,payload_b64:payload.toString('base64url')}));
  const item={id:data.ids.provisioner,time:String(Math.floor(Date.now()/1000)),nonce:randomUUID()};
  const signature=sign(null,signingBytes(data.origin,'/v1/invoke',item,body),key).toString('base64url');
  return authority.authenticate(body,['hf-credential-id',item.id,'hf-request-time',item.time,'hf-request-nonce',item.nonce,'hf-request-signature',signature],controller.signal);
 };
 const bound=async input=>execution.executeBound(input,controller.signal,await invocation(input));
 const client=new RailwayClient(data.config,{HF_RAILWAY_FIXTURE_TOKEN:'not-real'});
 const unused=async()=>{throw new Error('Railway create is outside bound execution');};
 const install=(wrap=hooks=>hooks)=>registerRailwayProvider(providers.registerProviderAdapter,client,(s,hooks)=>({persistence:wrap(hooks),sessions:spool,
  requireTrustedBindings:true,credentials:async()=>({}),runtimeProfile:unused,preparedBase:unused}));
 const binding={organisation_id:org,run_id:run,session_id:randomUUID(),pool_id:pool,sandbox_id:sandbox,external_sandbox_id:'sandbox-1',boot_generation:'1',preparation_digest:data.digest};
 const request=(b=binding)=>({binding:b,operation_id:randomUUID(),argv:['python3','-c',"import time;time.sleep(.2);print('durable-29.8')"],cwd:'/tmp',env_refs:{},timeout_ms:15000});
 const rejected=async fn=>{try{await fn();return null;}catch(e){return e.code??e.message;}};
 const row=async id=>(await admin('SELECT * FROM hyperfide.provider_remote_operations WHERE organisation_id=$1 AND id=$2',[org,id]))[0]??null;
 const observations=async id=>(await admin('SELECT observation FROM hyperfide.provider_remote_observations WHERE organisation_id=$1 AND remote_operation_id=$2 ORDER BY observed_at,created_at',[org,id])).map(r=>r.observation);
 let unregister=install();
 const input=request(),result=await bound(input),saved=await row(input.operation_id);
 const replay=await rejected(()=>bound(input));
 // A new boot makes the registered runner binding stale before any journal row exists.
 await admin('UPDATE hyperfide.sandboxes SET boot_generation=2,state_version=state_version+1 WHERE organisation_id=$1 AND id=$2',[org,sandbox]);
 const staleInput=request(),staleResult=await rejected(()=>bound(staleInput)),staleRow=await row(staleInput.operation_id);
 unregister();
 unregister=install(hooks=>({...hooks,assertResourceBinding:async o=>{await hooks.assertResourceBinding(o);throw new RailwayRequestError('REJECTED','BOUND_FIXTURE_DENIED');}}));
 const rejectInput=request({...binding,boot_generation:'2'});
 const boundRejection=await rejected(()=>bound(rejectInput));
 const rejectedRow=await row(rejectInput.operation_id),rejectedObservations=await observations(rejectInput.operation_id);
 unregister();
 const op=(kind,parameters,res=null)=>{const o={...result.operation,kind,resource:res,parameters,preparation_digest:kind==='prepare'?data.digest:null};
  o.identity={...o.identity,operation_id:randomUUID()};o.identity.payload_digest=digestDocument(Object.fromEntries(['kind','scope','resource','preparation_digest','deadline_at','parameters'].map(k=>[k,o[k]])));return o;};
 let inject=null;const records=[],recorder={recordObservation:async(o,outcome)=>records.push(outcome)};
 const adapter=createRailwayAdapter(client,{sessions:spool,credentials:async()=>({}),persistence:recorder,runtimeProfile:unused,preparedBase:unused});
 const unsupported=[];
 for(const o of [op('capabilities',{}),op('prepare',{image_reference:'fixture-image',recipe_digest:data.digest,os:{distribution:'ubuntu',version:'24.04',architecture:'x86_64'}}),
  op('transfer',{direction:'UPLOAD',path:'/tmp/test',artifact_digest:data.digest,byte_count:'1'},result.operation.resource)]){
  const out=await adapter[o.kind](o);unsupported.push({kind:o.kind,outcome:out,admission:validateProviderOutcome({operation:o,outcome:out})});
 }
 const injected=createRailwayAdapter(client,{sessions:spool,credentials:async()=>({}),persistence:recorder,capabilities:async()=>{throw inject;},runtimeProfile:unused,preparedBase:unused});
 inject=new RailwayRequestError('REJECTED','FIXTURE_DENIED');const typed=await injected.capabilities(op('capabilities',{}));
 inject=new RailwayRequestError('UNKNOWN','FIXTURE_LOST_REPLY');const ambiguous=await injected.capabilities(op('capabilities',{}));
 inject=Object.assign(new Error('fixture diagnosis'),{code:'AUTHORIZATION'});const generic=await injected.capabilities(op('capabilities',{}));
 const afterDispatch=createRailwayAdapter(client,{sessions:spool,persistence:recorder,prepare:async()=>{throw new RailwayRequestError('REJECTED','LATER_REQUEST_REJECTED');},
  credentials:async()=>({}),runtimeProfile:unused,preparedBase:unused});
 const uncertain=await afterDispatch.prepare(op('prepare',{image_reference:'fixture-image',recipe_digest:data.digest,os:{distribution:'ubuntu',version:'24.04',architecture:'x86_64'}}));
 fs.writeFileSync(data.live,JSON.stringify({...data.config,mode:'live',endpoint:'https://backboard.railway.com/graphql/v2',exec_ws_endpoint:null}),{mode:0o600});
 const context={env:{HF_RAILWAY_CONFIG:data.live,HF_RAILWAY_FIXTURE_TOKEN:'not-real'},signal:controller.signal};
 const publicRefusal=await rejected(()=>createComponent(context).actions['railway.process.start']({operation:result.operation},context));
 output={session:binding.session_id,result,saved,replay,staleResult,staleRow,unsupported,typed,ambiguous,records,publicRefusal,generic,boundRejection,rejectedRow,rejectedObservations,uncertain};
}finally{await spool.detachAll();controller.abort();await registry.close();}
process.stdout.write(JSON.stringify(output));
"""
class Service:
 def __init__(self,folder,fixture):
  spec=importlib.util.spec_from_file_location('bound_identity',c.ROOT/'tests/hyperfide/support/identity_fixture.py')
  identity=importlib.util.module_from_spec(spec);spec.loader.exec_module(identity)
  names=set()
  def include(name):
   if name in names:return
   names.add(name)
   for dep in json.loads((c.ROOT/('core/control-plane/components/'+name+'.json')).read_text())['requires']:include(dep)
  for name in ('9.4','14.1'):include(name)
  def setup(f):
   secrets=f.path/'secrets';secrets.mkdir(mode=0o700)
   attachments=f.path/'attachments';attachments.mkdir(mode=0o700)
   config=f.path/'credentials.json';config.write_text(json.dumps({'schema_version':1,'secret_root':str(secrets),'attachment_root':str(attachments),'sources':[],'targets':[]}));config.chmod(0o600)
   f.env.update(HF_CREDENTIAL_CONFIG_FILE=str(config),HF_ARTIFACT_S3_ENDPOINT='http://127.0.0.1:1',HF_ARTIFACT_ALLOW_LOOPBACK_HTTP='1',
    HF_ARTIFACT_S3_REGION='fixture',HF_ARTIFACT_S3_BUCKET='fixture-bucket',HF_ARTIFACT_S3_ACCESS_KEY_ID='fixture',HF_ARTIFACT_S3_SECRET_ACCESS_KEY='fixture',
    HF_ARTIFACT_ORGANISATION_ID=f.ids['organisation'],HF_ARTIFACT_ALLOWED_RUN_IDS=json.dumps([f.ids['run']]))
  self.actual=identity.IdentityFixture(components=tuple(sorted(names)),service_role='provisioner',extra_setup=setup,extra_actions=('provider.remote.execute-bound',),
   extra_env={'HF_RAILWAY_CONFIG':str(fixture.config_path),'HF_RAILWAY_FIXTURE_TOKEN':'not-real','HF_RAILWAY_PROCESS_ROOT':str(Path(folder)/'service-spool')})
 def call(self,component,action,payload):
  status,row=self.actual.invoke(action,payload,component=component,key='provisioner');c.expect(status==200,row);return row
 def bound(self,folder,fixture):
  """Run the bound-execution script in its own provisioner registry over this fixture's database."""
  a=self.actual;folder=Path(folder);components=folder/'bound-components';components.mkdir()
  actions=list(a.actions)
  for name in ('4.2','4.4','14.1','8.2','8.3'):
   source=c.ROOT/'core/control-plane/components'/(name+'.json');shutil.copyfile(source,components/source.name)
   actions+=json.loads(source.read_text())['actions']
  policy=json.loads(a.policy.read_text());policy['allowed_actions']=list(dict.fromkeys(actions))
  policy_path=folder/'bound-policy.json';policy_path.write_text(json.dumps(policy))
  data={'config':fixture.config,'digest':c.DIGEST,'spool':str(folder/'bound-spool'),'live':str(folder/'live.json'),'admin_url':a.url,
   'ids':{k:a.ids[k] for k in ('organisation','run','provisioner')},'origin':a.origin,'key':str(a.keys['provisioner']['path']),
   'policy':str(policy_path),'components':str(components)}
  path=folder/'input.json';path.write_text(json.dumps(data))
  env=dict(a.env,HYPERFIDE_POOL_CONFIG=str(folder/'bound-pools.json'));env.pop('HF_PROVISIONER_EXECUTOR_CONFIG_FILE',None)
  run=subprocess.run(['node','--input-type=module','-e',JS,str(path)],cwd=c.ROOT,env=env,capture_output=True,text=True,timeout=120)
  c.expect(run.returncode==0,run.stderr[-4000:]);return json.loads(run.stdout)
 def close(self):self.actual.close()

def main():
 if sys.argv[1:]==['--inventory']:print(json.dumps(IDS));return 0
 complete=False
 with tempfile.TemporaryDirectory(prefix='hyperfide-298-') as folder:
  fixture=c.Fixture(folder);ws=c.WebSocketFixture(folder,fixture);service=None
  try:
   service=Service(folder,fixture);r=service.bound(folder,fixture)
   c.check(IDS[0],lambda:c.expect(r['saved']['operation']['parameters']['durable'] is True and r['saved']['state']=='OBSERVED' and r['result']['outcome']['status']=='SUCCEEDED' and r['saved']['native_process_ref'] in ws.snapshot()['sessions'],'no definite durable SDK session'))
   c.check(IDS[1],lambda:c.expect(r['saved']['session_id']==r['session'] and r['saved']['process_claimed'] and r['saved']['process_record']['resource']==r['saved']['operation']['resource'],'lost durable binding'))
   c.check(IDS[2],lambda:c.expect(r['result']['outcome']['result']['exit_code']==0 and r['result']['captured']['complete'] is True and r['result']['outcome']['result']['output']['byte_count']=='13','incomplete output'))
   c.check(IDS[3],lambda:c.expect(r['replay']=='REMOTE_OPERATION_RECONCILIATION_REQUIRED' and len(ws.snapshot()['sessions'])==1,'replayed start'))
   c.check(IDS[4],lambda:c.expect(r['staleResult']=='RUNNER_BINDING_STALE' and r['staleRow'] is None,'stale runner accepted'))
   c.check(IDS[5],lambda:c.expect(r['publicRefusal']=='Railway live process operations require trusted bound provider execution','public live execution allowed'))
   for idx,item in enumerate(r['unsupported'],6):
    c.check(IDS[idx],lambda item=item:c.expect(item['outcome']['status']=='UNSUPPORTED' and item['outcome']['error']['provider_code']=='RAILWAY_'+item['kind'].upper()+'_UNQUALIFIED' and item['outcome']['error']['message'] and item['admission']['disposition']=='REFUSE_UNSUPPORTED','unsupported reason/admission lost: '+str(item)))
   c.check(IDS[9],lambda:c.expect(r['typed']['status']=='FAILED' and r['typed']['error']['provider_code']=='FIXTURE_DENIED' and r['typed'] in r['records'],'typed exception lost'))
   c.check(IDS[10],lambda:c.expect(r['ambiguous']['status']=='UNKNOWN' and r['ambiguous']['acceptance']=='UNKNOWN' and r['ambiguous']['error']['provider_code']=='FIXTURE_LOST_REPLY' and r['ambiguous']['reconcile_required'],'ambiguous response became definite'))
   c.check(IDS[11],lambda:c.expect(c.result(service.call('9.3','railway.process.describe',{}))['transport']=='DURABLE_WEBSOCKET' and c.result(service.call('9.4','railway.inventory.list',{'scope':c.SCOPE,'max_pages':2}))['enumeration_complete'],'components not wired'))
   c.check(IDS[12],lambda:c.expect(r['boundRejection']=='REMOTE_OUTPUT_INCOMPLETE' and r['rejectedRow']['outcome']['status']=='FAILED' and r['rejectedRow']['outcome']['error']['provider_code']=='BOUND_FIXTURE_DENIED' and r['rejectedObservations'] and all(o['outcome']['status']=='FAILED' for o in r['rejectedObservations']),'bound rejection overwritten with UNKNOWN'))
   c.check(IDS[13],lambda:c.expect(r['generic']['status']=='UNKNOWN' and r['generic']['error']['code']=='AUTHORIZATION' and r['generic']['error']['provider_code']=='AUTHORIZATION' and r['generic'] in r['records'],'generic code lost'))
   c.check(IDS[14],lambda:c.expect(r['uncertain']['status']=='UNKNOWN' and r['uncertain']['error']['provider_code']=='LATER_REQUEST_REJECTED' and r['uncertain']['reconcile_required'],'later rejection erased possible earlier effect'))
   service.close();service=None;ws.close();fixture.close();complete=True
  finally:
   if not complete:
    if service:service.close()
    ws.close();fixture.close()
   print(json.dumps({'type':'cleanup','resources':[],'complete':complete}),flush=True)
 return 1 if c.FAILED or not complete else 0
if __name__=='__main__':sys.exit(main())
