#!/usr/bin/env python3
"""Bound execution with real SDK/OS sessions and explicit in-memory persistence fake.
Public component wiring is exercised over the existing HTTPS/PostgreSQL fixture.
No provider API is contacted.
"""
import importlib,importlib.util,json,subprocess,sys,tempfile
from pathlib import Path
c=importlib.import_module('9_1')
IDS=['railway.bound.durable-session','railway.bound.exact-binding','railway.bound.complete-output',
 'railway.bound.replay-refused','railway.bound.stale-refused','railway.bound.public-live-refused',
 'railway.bound.capabilities-refused','railway.bound.prepare-refused','railway.bound.transfer-refused',
 'railway.bound.typed-error-recorded','railway.bound.ambiguous-remains-unknown','railway.bound.component-wired','railway.bound.rejection-not-overwritten','railway.bound.generic-code-recorded','railway.bound.post-dispatch-rejection-unknown']
JS=r"""
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {RailwayClient,RailwayRequestError} from './services/hyperfide/dist/providers/railway/preparation.js';
import {RailwaySessionSpool,createComponent} from './services/hyperfide/dist/providers/railway/processes.js';
import {createRailwayAdapter} from './services/hyperfide/dist/providers/railway/reconciliation.js';
import {executeBound} from './services/hyperfide/dist/providers/reconcile.js';
import {authenticatedInvocation} from './services/hyperfide/dist/transport/protocol.js';
import {createProviderRuntimeRegistry,configuredScope,digestDocument} from './services/hyperfide/dist/providers/pools.js';
import {validateProviderOutcome} from './services/hyperfide/dist/providers/contract.js';
const data=JSON.parse(fs.readFileSync(process.argv[1])),runtime=createProviderRuntimeRegistry();
const config={schema_version:1,organisation_id:randomUUID(),revision:'simulated-29.8',accounts:[{provider:'railway',account_key:data.config.account_id}],
 pools:[{id:randomUUID(),provider:'railway',account_key:data.config.account_id,environment_key:data.config.environment_id,region:data.config.region}],maximum_operation_ms:30000};
const scope=configuredScope(config,config.pools[0]),run=randomUUID(),sandbox=randomUUID(),session=randomUUID();
let row=null,observations=[],stale=false,inject=null;
const resource={native_sandbox_id:'sandbox-1',sandbox_boot_generation:'17'};
// This persistence fake fails on unknown SQL, keeping the exercised protocol explicit.
const query=async(sql,v=[])=>{
 let rows=[];
 if(sql.startsWith('SELECT p.state'))rows=[{state:'ACTIVE'}];
 else if(sql.startsWith('SELECT native_sandbox_id'))rows=[{...resource,native_sandbox_id:resource.native_sandbox_id,boot_generation:'17',preparation_digest:data.digest,desired_state:'RUNNING'}];
 else if(sql.startsWith('SELECT request_digest'))rows=row?[row]:[];
 else if(sql.startsWith('INSERT INTO hyperfide.provider_remote_operations'))row={operation:v[7],session_id:v[3],request_digest:v[6],outcome:null,process_record:null,process_claimed:false};
 else if(sql.startsWith('SELECT * FROM hyperfide.provider_remote_operations')||sql.startsWith('SELECT outcome,process_record'))rows=row?[row]:[];
 else if(sql.startsWith('SELECT operation,process_record,native_process_ref'))rows=row?.process_claimed?[row]:[];
 else if(sql.includes('SET process_claimed=true')){row.process_claimed=true;row.process_record=v[3];}
 else if(sql.includes('SET native_process_ref=$3'))row.native_process_ref=v[2];
 else if(sql.startsWith('INSERT INTO hyperfide.provider_remote_observations'))observations.push(v[4]);
 else if(sql.includes('SET state=$3,outcome=$4')){row.outcome=v[3];if(row.process_record)row.process_record={...row.process_record,state:v[4]};}
 else if(sql.startsWith('UPDATE hyperfide.sandboxes SET work_admitted')||sql.startsWith('INSERT INTO hyperfide.provider_process_candidates')){}
 else throw new Error('Unexpected fixture SQL: '+sql);
 return {rows};
};
const db={runtime,query,gateway:{withPrimaryTransaction:async(options,body)=>body({query})}};
runtime.runnerBindingVerifier=async()=>stale?null:{evidence_digest:data.digest,observed_at:new Date().toISOString()};
const client=new RailwayClient(data.config,{HF_RAILWAY_FIXTURE_TOKEN:'not-real'}),spool=new RailwaySessionSpool(data.spool);
runtime.adapters.set('railway',(s,hooks)=>createRailwayAdapter(client,{persistence:hooks,sessions:spool,boundScope:s,requireTrustedBindings:true,
 credentials:async()=>({}),runtimeProfile:async()=>{throw Error('unused')},preparedBase:async()=>{throw Error('unused')}}));
const input={binding:{organisation_id:config.organisation_id,run_id:run,session_id:session,pool_id:scope.pool_id,sandbox_id:sandbox,
 external_sandbox_id:resource.native_sandbox_id,boot_generation:'17',preparation_digest:data.digest},operation_id:randomUUID(),
 argv:['python3','-c',"import time;time.sleep(.2);print('durable-29.8')"],cwd:'/tmp',env_refs:{},timeout_ms:15000};
const bind=()=>{db.invocation=authenticatedInvocation({principal:{organisation_id:config.organisation_id,run_id:run,role:'PROVISIONER'},
 payload:{component:'8.3',action:'provider.remote.execute-bound',input},signal:new AbortController().signal});};
bind();
const result=await executeBound(db,config,input,new AbortController().signal);
const saved=JSON.parse(JSON.stringify(row)),rejected=async fn=>{try{await fn();return null}catch(e){return e.code??e.message}};
const replay=await rejected(()=>executeBound(db,config,input,new AbortController().signal));
stale=true;const staleResult=await rejected(()=>executeBound(db,config,input,new AbortController().signal));stale=false;
const op=(kind,parameters,res=null)=>{const o={...saved.operation,kind,resource:res,parameters,preparation_digest:kind==='prepare'?data.digest:null};
 o.identity={...o.identity,operation_id:randomUUID()};o.identity.payload_digest=digestDocument(Object.fromEntries(['kind','scope','resource','preparation_digest','deadline_at','parameters'].map(k=>[k,o[k]])));return o;};
const records=[],adapter=createRailwayAdapter(client,{sessions:spool,credentials:async()=>({}),persistence:{recordObservation:async(o,outcome)=>records.push(outcome)},
 runtimeProfile:async()=>{throw Error('unused')},preparedBase:async()=>{throw Error('unused')}});
const unsupported=[];
for(const o of [op('capabilities',{}),op('prepare',{image_reference:'fixture-image',recipe_digest:data.digest,os:{distribution:'ubuntu',version:'24.04',architecture:'x86_64'}}),
 op('transfer',{direction:'UPLOAD',path:'/tmp/test',artifact_digest:data.digest,byte_count:'1'},resource)]){
 const out=await adapter[o.kind](o);unsupported.push({kind:o.kind,outcome:out,admission:validateProviderOutcome({operation:o,outcome:out})});
}
const injected=createRailwayAdapter(client,{sessions:spool,credentials:async()=>({}),persistence:{recordObservation:async(o,outcome)=>records.push(outcome)},
 capabilities:async()=>{throw inject},runtimeProfile:async()=>{throw Error('unused')},preparedBase:async()=>{throw Error('unused')}});
inject=new RailwayRequestError('REJECTED','FIXTURE_DENIED');const typed=await injected.capabilities(op('capabilities',{}));
inject=new RailwayRequestError('UNKNOWN','FIXTURE_LOST_REPLY');const ambiguous=await injected.capabilities(op('capabilities',{}));
inject=Object.assign(new Error('fixture diagnosis'),{code:'AUTHORIZATION'});const generic=await injected.capabilities(op('capabilities',{}));
row=null;observations=[];input.operation_id=randomUUID();bind();
runtime.adapters.set('railway',(s,hooks)=>createRailwayAdapter(client,{persistence:{...hooks,assertResourceBinding:async o=>{await hooks.assertResourceBinding(o);throw new RailwayRequestError('REJECTED','BOUND_FIXTURE_DENIED')}},sessions:spool,boundScope:s,requireTrustedBindings:true,
 credentials:async()=>({}),runtimeProfile:async()=>{throw Error('unused')},preparedBase:async()=>{throw Error('unused')}}));
const boundRejection=await rejected(()=>executeBound(db,config,input,new AbortController().signal));
const rejectedRow=JSON.parse(JSON.stringify(row)),rejectedObservations=observations;
const afterDispatch=createRailwayAdapter(client,{sessions:spool,persistence:{recordObservation:async(o,outcome)=>records.push(outcome)},
 prepare:async()=>{throw new RailwayRequestError('REJECTED','LATER_REQUEST_REJECTED')},credentials:async()=>({}),runtimeProfile:async()=>{throw Error('unused')},preparedBase:async()=>{throw Error('unused')}});
const uncertain=await afterDispatch.prepare(op('prepare',{image_reference:'fixture-image',recipe_digest:data.digest,os:{distribution:'ubuntu',version:'24.04',architecture:'x86_64'}}));
const publicConfig={...data.config,mode:'live',endpoint:'https://backboard.railway.com/graphql/v2',exec_ws_endpoint:null};
fs.writeFileSync(data.live,JSON.stringify(publicConfig),{mode:0o600});
const context={env:{HF_RAILWAY_CONFIG:data.live,HF_RAILWAY_FIXTURE_TOKEN:'not-real'},signal:new AbortController().signal};
const component=createComponent(context);
const publicRefusal=await rejected(()=>component.actions['railway.process.start']({operation:saved.operation},context));
await spool.detachAll();
process.stdout.write(JSON.stringify({result,saved,replay,staleResult,unsupported,typed,ambiguous,records,publicRefusal,generic,boundRejection,rejectedRow,rejectedObservations,uncertain}));
"""
class Service:
 def __init__(self,folder,fixture):
  spec=importlib.util.spec_from_file_location('bound_identity',c.ROOT/'tests/hyperfide/support/identity_fixture.py')
  identity=importlib.util.module_from_spec(spec);spec.loader.exec_module(identity)
  names=set()
  def include(name):
   if name in names:return
   names.add(name)
   for dep in json.loads((c.ROOT/('services/hyperfide/components/'+name+'.json')).read_text())['requires']:include(dep)
  for name in ('9.4','14.1'):include(name)
  def setup(f):
   secrets=f.path/'secrets';secrets.mkdir(mode=0o700)
   attachments=f.path/'attachments';attachments.mkdir(mode=0o700)
   config=f.path/'credentials.json';config.write_text(json.dumps({'schema_version':1,'secret_root':str(secrets),'attachment_root':str(attachments),'sources':[],'targets':[]}));config.chmod(0o600)
   f.env.update(HF_CREDENTIAL_CONFIG_FILE=str(config),HF_ARTIFACT_S3_ENDPOINT='http://127.0.0.1:1',HF_ARTIFACT_ALLOW_LOOPBACK_HTTP='1',
    HF_ARTIFACT_S3_REGION='fixture',HF_ARTIFACT_S3_BUCKET='fixture-bucket',HF_ARTIFACT_S3_ACCESS_KEY_ID='fixture',HF_ARTIFACT_S3_SECRET_ACCESS_KEY='fixture',
    HF_ARTIFACT_ORGANISATION_ID=f.ids['organisation'],HF_ARTIFACT_ALLOWED_RUN_IDS=json.dumps([f.ids['run']]))
  self.actual=identity.IdentityFixture(components=tuple(sorted(names)),service_role='provisioner',extra_setup=setup,
   extra_env={'HF_RAILWAY_CONFIG':str(fixture.config_path),'HF_RAILWAY_FIXTURE_TOKEN':'not-real','HF_RAILWAY_PROCESS_ROOT':str(Path(folder)/'service-spool')})
 def call(self,component,action,payload):
  status,row=self.actual.invoke(action,payload,component=component,key='provisioner');c.expect(status==200,row);return row
 def close(self):self.actual.close()

def main():
 if sys.argv[1:]==['--inventory']:print(json.dumps(IDS));return 0
 complete=False
 with tempfile.TemporaryDirectory(prefix='hyperfide-298-') as folder:
  fixture=c.Fixture(folder);ws=c.WebSocketFixture(folder,fixture);service=None
  try:
   data={'config':fixture.config,'digest':c.DIGEST,'spool':str(Path(folder)/'bound-spool'),'live':str(Path(folder)/'live.json')}
   path=Path(folder)/'input.json';path.write_text(json.dumps(data))
   run=subprocess.run(['node','--input-type=module','-e',JS,str(path)],cwd=c.ROOT,capture_output=True,text=True,timeout=60)
   c.expect(run.returncode==0,run.stderr);r=json.loads(run.stdout)
   c.check(IDS[0],lambda:c.expect(r['saved']['operation']['parameters']['durable'] is True and r['result']['outcome']['status']=='SUCCEEDED' and r['saved']['native_process_ref'] in ws.snapshot()['sessions'],'no definite durable SDK session'))
   c.check(IDS[1],lambda:c.expect(r['saved']['session_id'] and r['saved']['process_claimed'] and r['saved']['process_record']['resource']==r['saved']['operation']['resource'],'lost durable binding'))
   c.check(IDS[2],lambda:c.expect(r['result']['outcome']['result']['exit_code']==0 and r['result']['captured']['complete'] is True and r['result']['outcome']['result']['output']['byte_count']=='13','incomplete output'))
   c.check(IDS[3],lambda:c.expect(r['replay']=='REMOTE_OPERATION_RECONCILIATION_REQUIRED' and len(ws.snapshot()['sessions'])==1,'replayed start'))
   c.check(IDS[4],lambda:c.expect(r['staleResult']=='RUNNER_BINDING_STALE','stale runner accepted'))
   c.check(IDS[5],lambda:c.expect(r['publicRefusal']=='Railway live process operations require trusted bound provider execution','public live execution allowed'))
   for idx,item in enumerate(r['unsupported'],6):
    c.check(IDS[idx],lambda item=item:c.expect(item['outcome']['status']=='UNSUPPORTED' and item['outcome']['error']['provider_code']=='RAILWAY_'+item['kind'].upper()+'_UNQUALIFIED' and item['outcome']['error']['message'] and item['admission']['disposition']=='REFUSE_UNSUPPORTED','unsupported reason/admission lost: '+str(item)))
   c.check(IDS[9],lambda:c.expect(r['typed']['status']=='FAILED' and r['typed']['error']['provider_code']=='FIXTURE_DENIED' and r['typed'] in r['records'],'typed exception lost'))
   c.check(IDS[10],lambda:c.expect(r['ambiguous']['status']=='UNKNOWN' and r['ambiguous']['acceptance']=='UNKNOWN' and r['ambiguous']['error']['provider_code']=='FIXTURE_LOST_REPLY' and r['ambiguous']['reconcile_required'],'ambiguous response became definite'))
   service=Service(folder,fixture)
   c.check(IDS[11],lambda:c.expect(c.result(service.call('9.3','railway.process.describe',{}))['transport']=='DURABLE_WEBSOCKET' and c.result(service.call('9.4','railway.inventory.list',{'scope':c.SCOPE,'max_pages':2}))['enumeration_complete'],'components not wired'))
   c.check(IDS[12],lambda:c.expect(r['boundRejection']=='REMOTE_OUTPUT_INCOMPLETE' and r['rejectedRow']['outcome']['status']=='FAILED' and r['rejectedRow']['outcome']['error']['provider_code']=='BOUND_FIXTURE_DENIED' and all(o['outcome']['status']=='FAILED' for o in r['rejectedObservations']),'bound rejection overwritten with UNKNOWN'))
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
