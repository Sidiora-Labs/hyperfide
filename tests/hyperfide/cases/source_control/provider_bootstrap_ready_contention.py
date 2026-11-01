#!/usr/bin/env python3
"""Real PG journal and signed identity RPC; controlled prerequisites and transport loss."""
import base64,threading,time,hashlib,importlib.util,json,os,subprocess,sys,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4]
s=importlib.util.spec_from_file_location('bootstrap_provider_fixture',ROOT/'tests/hyperfide/cases/tasks/8_3.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
def uid():return str(uuid.uuid4())
def main():
 if not os.environ.get('DATABASE_URL'):return subprocess.run([sys.executable,str(ROOT/'tests/hyperfide/support/withpg.py'),'--',sys.executable,str(Path(__file__).resolve())],cwd=ROOT).returncode
 f=m.pools.ProvisionerFixture(extra_components=['8.2','8.3','15.2'],extra_setup=m.prepare_provider_intent_fixture)
 try:
  f.sql('REVOKE UPDATE,DELETE,TRUNCATE ON hyperfide.provider_bootstrap_grant_rejections,hyperfide.provider_bootstrap_grant_corrections FROM "'+f.runtime_role+'"')
  def ok(action,value=None,key='operator',component='8.3'):
   response=f.invoke(action,value or {},component=component,key=key)[1];assert response.get('ok'),response;return response['result']
  ok('provider.worker.stop',key='provisioner');ok('provider.pools.configure',component='8.2');m.seed_provider_capacity(f)
  sandbox=uid();intent=ok('provider.intents.prepare-create',dict(run_id=f.ids['run'],pool_id=f.pool,sandbox_id=sandbox,request_key=uid(),deadline_at=m.utc(120000),reservation_ids=f.reservations,profile_id=f.profile,preparation_digest=f.preparation,purpose='PREPARATION'))['intent']
  iid=intent['id'];org=f.ids['organisation'];run=f.ids['run'];pin=m.sha(b'controlled bootstrap prerequisite');native='component-acknowledged-resource'
  f.sql("UPDATE hyperfide.provisioning_intents SET state='ACKNOWLEDGED',native_sandbox_id=$2,state_version=state_version+1 WHERE id=$1",[iid,native])
  f.sql("UPDATE hyperfide.sandboxes SET native_sandbox_id=$2,observed_state='RUNNING',desired_state='RUNNING',state_version=state_version+1 WHERE id=$1",[sandbox,native])
  f.sql("INSERT INTO hyperfide.provider_observations(organisation_id,id,intent_id,operation_id,payload_digest,observation,observed_at,evidence_digest) VALUES($1,$2,$3,$3::uuid::text,$4,$5,clock_timestamp(),$6)",[org,uid(),iid,intent['payload_digest'],json.dumps({'outcome':{'status':'SUCCEEDED','resource':{'native_sandbox_id':native}}}),pin])
  manager,observation,reason,decision,operation=[uid() for _ in range(5)]
  f.sql("INSERT INTO hyperfide.agent_sessions(organisation_id,run_id,id,role,connector,account_key,native_session_id) VALUES($1,$2,$3,'FEATURE_MANAGER','fixture','fixture',$3::uuid::text)",[org,run,manager])
  f.sql("INSERT INTO hyperfide.fleet_observations(organisation_id,run_id,id,actor_id,cohort_generation,context_digest,body) VALUES($1,$2,$3,$4,1,$5,'{}')",[org,run,observation,manager,pin])
  f.sql("INSERT INTO hyperfide.fleet_reasoning(organisation_id,run_id,id,actor_id,request_digest,observation_id,state) VALUES($1,$2,$3,$4,$5,$6,'COMPLETED')",[org,run,reason,manager,pin,observation])
  f.sql("INSERT INTO hyperfide.fleet_decisions(organisation_id,run_id,id,operation_id,actor_id,action,context_digest,payload_digest,reasoning_id,body) VALUES($1,$2,$3,$4,$5,'PROVISION_SANDBOX',$6,$6,$7,'{}')",[org,run,decision,operation,manager,pin,reason])
  f.sql("INSERT INTO hyperfide.fleet_effect_receipts(organisation_id,run_id,operation_id,decision_id,payload_digest,result) VALUES($1,$2,$3,$4,$5,$6)",[org,run,operation,decision,pin,json.dumps(dict(kind='PROVISION_SANDBOX',provider_intent_id=iid,sandbox_id=sandbox))])
  retained=ROOT/'build/hyperfide-native';data=retained.read_bytes();digest=m.sha(data);artifact=uid();state=f.path/'bootstrap-state';state.mkdir(mode=0o700)
  ca=f.path/'bootstrap-ca.pem';ca.write_bytes(f.ca.read_bytes());ca.chmod(0o600)
  target='/component/native';remote_state='/component/state';configuration=f.sql('SELECT configuration_digest FROM hyperfide.provider_pool_configurations WHERE organisation_id=$1 AND pool_id=$2 AND active',[org,f.pool])[0]['configuration_digest']
  recipe=dict(pool_id=f.pool,configuration_digest=configuration,profile_id=f.profile,preparation_digest=f.preparation,native_path=target,native_digest=digest,manifest_path='/component/manifest.json',secret_path=remote_state+'/{sandbox_id}/{boot_id}/enrollment-grant.json',files=[dict(artifact_id=artifact,storage_kind='object',digest=digest,size_bytes=str(len(data)),target=target,mode='0500')],allowed_actions=['identity.describe','identity.runner.register','identity.runner.heartbeat'],grant_ttl_seconds=300,native_template=dict(origin=f.origin,state_root=remote_state,runner_binary=target,runner_binary_digest=digest,slots=[dict(name='worker',uid=62042,gid=62042)]),install_template={})
  descriptor=f.path/'bootstrap.json';descriptor.write_text(json.dumps(dict(schema_version=1,origin=f.origin,ca_file=str(ca),state_root=str(state),pools=[recipe])));descriptor.chmod(0o600);f.env['HF_PROVIDER_BOOTSTRAP_CONFIG_FILE']=str(descriptor)
  principal=next(p for p in json.loads(f.identity_config.read_text())['principals'] if p['credential_id']==f.ids['provisioner'])
  payload=dict(org=org,run=run,epoch=f.ids['epoch'],credential=f.ids['provisioner'],principal=principal,intent=iid,sandbox=sandbox,native_file=str(retained),artifact=artifact,digest=digest,runtime_role=f.runtime_role)
  bridge=f.path/'signed-heartbeat-bridge';bridge.mkdir(mode=0o700);payload['bridge']=str(bridge)
  errors=[];stop=threading.Event();credential=None;version=1
  def respond():
   nonlocal credential,version
   seen=set()
   while not stop.wait(.005):
    for request in bridge.glob('*.request.json'):
     if request.name in seen:continue
     seen.add(request.name)
     try:
      item=json.loads(request.read_text())
      if item['kind']=='enroll':
       manifest=item['manifest'];binding=manifest['binding'];secret=json.loads(Path(item['secret_ref']).read_text());f.secret=base64.urlsafe_b64decode(secret['secret_b64']+'='*(-len(secret['secret_b64'])%4));f.grant=secret['grant_id'];f.ids.update(intent=iid,sandbox=sandbox,boot=binding['boot_id'])
       result=f.request(f.enrollment(),key='runner',endpoint='/v1/enroll',credential=f.grant)[1];assert result.get('ok'),result;credential=result['result']['credential_id']
       result=f.invoke('identity.runner.register',{'preparation_digest':f.preparation,'inventory':[]},key='runner',credential=credential)[1];assert result.get('ok'),result
       for slot in manifest['template']['slots']:
        root='/controlled-historical-slot/'+slot['slot_id'];f.sql("INSERT INTO hyperfide.worker_slots(organisation_id,id,sandbox_id,slot_key,boot_generation,capacity_kind,state) VALUES($1,$2,$3,$4,1,'AGENT','READY')",[org,slot['slot_id'],sandbox,slot['name']]);f.sql("INSERT INTO hyperfide.runner_registry(organisation_id,run_id,session_id,credential_id,sandbox_id,boot_generation,boot_id,slot_id,state_dir,runner_binary,workspace_path,home_path,tmp_path,runner_binary_digest,boot_preparation_digest,preparation_digest,readiness_digest,source_digest,source_object_id,source_tree_id,slot_generation,uid,gid,observation_digest,state) VALUES($1,$2,$3,$4,$5,1,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,$13,$13,$15,$16,1,$17,$18,$13,'PREPARING')",[org,run,slot['session_id'],credential,sandbox,binding['boot_id'],slot['slot_id'],root+'/state',target,root+'/source',root+'/home',root+'/tmp',digest,f.preparation,'a'*40,'b'*40,slot['uid'],slot['gid']])
       response={'credential_id':credential}
      else:
       assert item['kind']=='heartbeat' and credential
       result=f.request(f.operation('14.1','identity.runner.heartbeat',{'expected_version':str(version)},expected_version=str(version)),key='runner',credential=credential)[1];assert result.get('ok'),result;version+=1;response={'heartbeat_version':version}
      output=request.with_name(request.name.replace('.request.json','.response.json'));temporary=output.with_suffix('.tmp');temporary.write_text(json.dumps(response));temporary.chmod(0o600);temporary.rename(output)
     except BaseException as error:errors.append(str(error));return
  watcher=threading.Thread(target=respond,daemon=True);watcher.start()
  script=r"""
import fs from 'node:fs';import path from 'node:path';import pg from './core/control-plane/node_modules/pg/lib/index.js';
import {setTimeout as delay} from 'node:timers/promises';
import {createResourceContainer} from './core/control-plane/dist/storage/runtime.js';
import {authenticatedInvocation} from './core/control-plane/dist/transport/protocol.js';
import {readSemanticDisposition} from './core/control-plane/dist/storage/dispositions.js';
import {createProviderDatabase,bindProviderInvocation,readDeployment} from './core/control-plane/dist/providers/pools.js';
import {createProviderBootstrap} from './core/control-plane/dist/providers/bootstrap.js';
const d=JSON.parse(fs.readFileSync(0,'utf8')),signal=new AbortController().signal,r=createResourceContainer({role:'provisioner',env:process.env,signal});
const assert=(v,m)=>{if(!v)throw Error(m)};let exchanges=0,barriers=0;
async function bridge(value){const id=String(++exchanges),file=path.join(d.bridge,id+'.request.json'),out=path.join(d.bridge,id+'.response.json');fs.writeFileSync(file+'.tmp',JSON.stringify(value),{mode:0o600});fs.renameSync(file+'.tmp',file);for(let n=0;n<1000;n++){if(fs.existsSync(out))return JSON.parse(fs.readFileSync(out));await delay(10)}throw Error('SIGNED_HEARTBEAT_BRIDGE_TIMEOUT')}
const guard=async tx=>{await readSemanticDisposition(tx,{organisation_id:d.org,run_id:d.run});const p=(await tx.query("SELECT credential_id FROM hyperfide.identity_principals WHERE credential_id=$1 AND organisation_id=$2 AND run_id=$3 AND state='ACTIVE' AND expires_at>clock_timestamp()",[d.credential,d.org,d.run])).rows[0];assert(p,'Actual provisioner authority missing')};
const i=authenticatedInvocation({principal:d.principal,signal,guard}),bytes=fs.readFileSync(d.native_file);
const store={invoke:async(action,input)=>{assert(action==='artifact.object.read'&&input.artifact_id===d.artifact,'Unexpected artifact request');return {outcome:'SUCCEEDED',availability:'VERIFIED',artifact:{artifact_id:d.artifact,organisation_id:d.org,run_id:d.run,status:'COMPLETE',digest:d.digest,size_bytes:String(bytes.length)},receipt:{receipt_id:d.digest},data_base64:bytes.toString('base64')}}};
// Interleave at the owned PostgreSQL client boundary, preserving original branded transactions.
const originalQuery=pg.Client.prototype.query;pg.Client.prototype.query=function(q,...args){if(typeof q==='string'&&q.includes('JOIN hyperfide.identity_runner_status st')&&q.includes('FROM hyperfide.identity_enrollment_grants g')){barriers++;return bridge({kind:'heartbeat'}).then(()=>originalQuery.call(this,q,...args))}return originalQuery.call(this,q,...args)};
const context={env:process.env,signal,resources:r,dependencies:{require:(component,name,validate)=>{assert(component==='15.2'&&name==='artifact.store.v1'&&validate(store),'Unexpected dependency');return store}}};
try{
 const config=await readDeployment(process.env),db=bindProviderInvocation(createProviderDatabase(context),config,i),bootstrap=createProviderBootstrap(context);let deliveries=0;
 const transport={deliverBootstrap:async input=>{deliveries++;await input.markSubmitting();const manifest=JSON.parse(input.manifest),enrolled=await bridge({kind:'enroll',manifest,secret_ref:path.join(process.env.HF_PROVIDER_BOOTSTRAP_CONFIG_FILE.replace(/\/[^/]+$/,''),'bootstrap-state',d.intent+'.enrollment.json')});return {state:'COMPLETED',receipt:{kind:'FLEET_NATIVE_BOOTSTRAP_RECEIPT_V1',bootstrap_id:d.intent,binding:input.binding,manifest_digest:input.manifest_digest,credential_id:enrolled.credential_id,slots:manifest.template.slots.map(s=>({...s,slot_generation:'1'})),provenance:'CONTROLLED_PRIOR_REGISTERED_NATIVE_METADATA_INPUT_NO_PHYSICAL_CLAIM'}}}};
 const result=await bootstrap(db,config,d.intent,signal,transport);assert(result.bootstrap==='READY'&&deliveries===1&&barriers===1,'Actual READY continuation did not survive concurrent signed heartbeat');
 const row=(await db.query('SELECT state,receipt_digest,receipt FROM hyperfide.provider_native_bootstraps WHERE intent_id=$1',[d.intent])).rows[0];assert(row.state==='READY'&&row.receipt_digest&&row.receipt.credential_id,'Production READY receipt not retained');
 console.log(JSON.stringify({status:'PASS',scope:'actual PostgreSQL full bootstrap continuation with signed TLS enrollment/register/heartbeat; controlled historical native slot receipt input only',barriers,deliveries,signed_heartbeat_version:2,physical_native_enrollment:'UNRUN',assertions:['Concurrent signed heartbeat commits after READY transaction snapshot','Exact consumed grant/principal/fresh heartbeat and registered slot receipt admit READY','One native delivery and no duplicate submission']}));
}finally{pg.Client.prototype.query=originalQuery;await r.close()}
"""
  try:
   p=subprocess.run(['node','--input-type=module','-e',script],input=json.dumps(payload),text=True,capture_output=True,cwd=ROOT,env=f.env,timeout=90)
  finally:stop.set();watcher.join(timeout=2)
  assert not errors,errors
  print(p.stdout,end='');print(p.stderr,end='',file=sys.stderr);return p.returncode
 finally:f.close()
if __name__=='__main__':raise SystemExit(main())
