#!/usr/bin/env python3
"""V-060 registered component composition; simulated provider, no live qualification."""
from __future__ import annotations
import importlib.util,json,os,re,shutil,socket,subprocess,sys,tempfile,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4]
spec=importlib.util.spec_from_file_location('isolation_fixture_29_3',ROOT/'tests/hyperfide/cases/tasks/8_2.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
IDS=['fence.binding.registered-component','fence.binding.non-circular','fence.binding.missing-preflight','fence.binding.first-isolation','fence.binding.preflight-exact-resource','fence.binding.resource-tamper','fence.binding.topology-tamper','fence.binding.permit-topology-tamper','fence.binding.permit-signature-tamper','fence.binding.target-digest-tamper','fence.binding.binding-tamper','fence.binding.no-repeat-destruction','fence.binding.observation-agrees','fence.binding.observation-tamper','fence.binding.preflight-unregistered']
SCRIPT=r"""
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {ComponentRegistry} from './services/hyperfide/dist/components/registry.js';
import {digestDocument} from './services/hyperfide/dist/providers/pools.js';
import {issueIsolationPermit,loadIsolationPermitVerifier,issueWriterObservationPermit,loadWriterObservationPermitVerifier} from './services/hyperfide/dist/identity/credentials.js';
import {externalFenceTopologyDigest,createExternalWriterFence,createExternalWriterObserver,FileExternalFenceJournal,bindProviderIsolation} from './services/hyperfide/dist/recovery/fencing.js';
import {startExternalFencingService} from './services/hyperfide/dist/recovery/fencing_service.js';
import {createIsolationHttpClient} from './services/hyperfide/dist/transport/isolation.js';
const c=JSON.parse(process.env.HF_BINDING_CONTEXT),controller=new AbortController(),signal=controller.signal;
const registry=new ComponentRegistry({role:'provisioner',policy:c.policy,env:process.env,signal});
const results={},check=async(name,body)=>{try{await body();results[name]=true}catch(e){results[name]=String(e.stack??e)}};
const reject=(fn,code)=>assert.rejects(fn,e=>e.code===code);
const clone=v=>structuredClone(v),D=digestDocument({wrong:true}),privateWrite=(file,v)=>fs.writeFile(file,JSON.stringify(v),{mode:0o600});
let service,unregister,destroyCalls=0,preflightCalls=0,present=true;
try{
 await registry.load(c.components,ROOT_DIST());
 const pools=registry.resolveCapability('8.2','provider.pools.v1',v=>!!v.runtime),intents=registry.resolveCapability('8.3','provider.intents.v1',v=>typeof v.registerDestructionPreflight==='function');
 const capability=registry.resolveCapability('8.4','provider.isolation.v1',v=>typeof v.isolateConfiguredResource==='function');
 await check('registered-component',()=>assert(capability&&intents));
 const configured=(await pools.query('SELECT configuration_digest FROM hyperfide.provider_pool_configurations WHERE organisation_id=$1 AND pool_id=$2 AND active',[c.org,c.pool])).rows[0];
 const scope={organisation_id:c.org,pool_id:c.pool,provider:'railway',provider_account_id:'fixture-account',environment_id:'fixture-env',region:'fixture-region',configuration_digest:configured.configuration_digest};
 const topology={schema_version:1,deployment_id:c.deployment,organisation_id:c.org,run_id:c.run,source_epoch:c.epoch,evidence_scope:'LIVE_PROVIDER',legacy_topology_digest:D,legacy_pid_namespace:await fs.readlink('/proc/self/ns/pid'),legacy_mount_namespace:await fs.readlink('/proc/self/ns/mnt'),required_writer_ids:['writer'],resources:[{reference_key:'writer-node',topology_digest:D,writer_ids:['writer'],backend:'PROVIDER'}]};
 // LIVE_PROVIDER is required by the production composition. All provider/legacy
 // observations below are explicitly simulated and establish component evidence only.
 const topologyDigest=externalFenceTopologyDigest(topology);topology.resources[0].topology_digest=topologyDigest;
 await check('non-circular',()=>assert.equal(externalFenceTopologyDigest(topology),topologyDigest));
 const target={reference_key:'writer-node',scope,resource:{native_sandbox_id:c.native,sandbox_boot_generation:'1'},boot_id:c.boot,preparation_digest:c.preparation,resource_topology_digest:topologyDigest};
 const config={schema_version:1,deployment_id:c.deployment,organisation_id:c.org,run_id:c.run,source_epoch:c.epoch,topology_digest:topologyDigest,evidence_scope:'LIVE_PROVIDER',maximum_operation_ms:5000,proof_max_age_ms:5000,resources:[target]};
 await privateWrite(process.env.HYPERFIDE_WRITER_ISOLATION_CONFIG,config);
 const issuer={key_id:'binding-fixture',private_key_file:c.signer},verifier=await loadIsolationPermitVerifier(c.verifier),operationId=randomUUID();
 const claims={schema_version:1,purpose:'EXTERNAL_WRITER_ISOLATION_ONLY',deployment_id:c.deployment,organisation_id:c.org,run_id:c.run,source_epoch:c.epoch,operation_id:operationId,topology_digest:topologyDigest,resources:[{reference_key:'writer-node',topology_digest:topologyDigest}],issued_at:new Date().toISOString(),expires_at:new Date(Date.now()+60000).toISOString(),nonce:randomUUID()};
 const signed=await issueIsolationPermit(claims,issuer),permit=verifier.verifySigned(signed),journal=new FileExternalFenceJournal(c.journal);
 const legacyReceipt=(input,isolated)=>({...input,status:isolated?'ISOLATED':'ADMISSION_DISABLED',topology_digest:D,observed_at:new Date().toISOString(),expires_at:new Date(Date.now()+5000).toISOString(),evidence_digest:D,visibility:{scope:'CONFIGURED_PID_NAMESPACE',pid_namespace:topology.legacy_pid_namespace,mount_namespace:topology.legacy_mount_namespace},admission_disabled:true,writable_fds:0,writable_shared_mappings:0,read_only_aliases:1,isolated_writer:'writer'});
 const legacy={disableAdmission:async i=>legacyReceipt(i,false),observeIsolation:async i=>legacyReceipt(i,true)};
 const fence=(t=topology,p=permit)=>createExternalWriterFence(t,bindProviderIsolation(capability,p),legacy,journal,{kind:'ISOLATION_PERMIT',permit:p});
 const input={deployment_id:c.deployment,operation_id:operationId,source_epoch:c.epoch};
 await check('missing-preflight',()=>reject(()=>fence().isolate(input),'DESTRUCTION_PREFLIGHT_UNAVAILABLE'));
 unregister=intents.registerDestructionPreflight(async(tx,request)=>{
  assert.deepEqual(request,{organisation_id:c.org,run_id:c.run,sandbox_id:c.sandbox,boot_generation:'1',operation_id:operationId});
  const rows=await tx.query('SELECT id FROM hyperfide.sandboxes WHERE organisation_id=$1 AND id=$2',[c.org,c.sandbox]);assert.equal(rows.rows.length,1);
  assert.deepEqual(await fs.readdir(c.workspace),[]);preflightCalls++;
  return {evidence_digest:digestDocument({component_fixture:'empty-workspace',request}),observed_at:new Date().toISOString()};
 });
 const outcome=(op,result)=>({schema_version:1,status:'SUCCEEDED',acceptance:'CONFIRMED_ACCEPTED',operation_id:op.identity.operation_id,payload_digest:op.identity.payload_digest,scope:op.scope,observed_at:new Date().toISOString(),provider_request_id:'SIMULATED_COMPONENT_ONLY',resource:op.resource,result,error:null,reconcile_required:false,retry:'NEVER'});
 pools.runtime.isolation.set('railway',()=>({destroy:async op=>{destroyCalls++;assert.equal(preflightCalls,1);const doc=JSON.parse(await fs.readFile(c.journal+'/'+operationId+'.json'));assert.equal(doc.resources['writer-node'].state,'PREPARED');present=false;return outcome(op,{deletion:'CONFIRMED'})},observe:async op=>outcome(op,{provider_state:present?'RUNNING':'DESTROYED',health:present?'HEALTHY':'ABSENT'})}));
 const serverConfig={schema_version:1,topology,journal_directory:c.journal,verifier_file:c.verifier,transport:{origin:c.origin,host:'127.0.0.1',port:c.port,certificate:c.certificate,private_key:c.tlskey}};
 await privateWrite(c.serverConfig,serverConfig);
 service=await startExternalFencingService({env:{...process.env,HYPERFIDE_EXTERNAL_FENCE_CONFIG_FILE:c.serverConfig},signal,providers:capability,legacy});
 const client=await createIsolationHttpClient({origin:c.origin,caFile:c.certificate,deadlineMs:10000});
 await check('first-isolation',async()=>{const result=await client.isolate(signed,signal);assert.equal(result.outcome,'SUCCEEDED',JSON.stringify(result));assert.equal(destroyCalls,1);assert.equal(present,false)});
 await check('preflight-exact-resource',()=>assert.equal(preflightCalls,1));
 await check('resource-tamper',async()=>{const t=clone(topology);t.resources[0].topology_digest=D;await reject(()=>fence(t).isolate(input),'EXTERNAL_FENCE_AUTHORITY_DENIED')});
 await check('topology-tamper',async()=>{const t=clone(topology);t.legacy_topology_digest=digestDocument({changed:true});await reject(()=>fence(t).isolate(input),'ISOLATION_PERMIT_SCOPE')});
 await check('permit-topology-tamper',async()=>{const p=verifier.verifySigned(await issueIsolationPermit({...claims,topology_digest:D},issuer));await reject(()=>fence(topology,p).isolate(input),'ISOLATION_PERMIT_SCOPE')});
 await check('permit-signature-tamper',async()=>{const envelope=JSON.parse(signed),body=JSON.parse(Buffer.from(envelope.payload_b64,'base64url'));body.topology_digest=D;envelope.payload_b64=Buffer.from(JSON.stringify(body)).toString('base64url');assert.throws(()=>verifier.verifySigned(JSON.stringify(envelope)),e=>e.code==='ISOLATION_PERMIT_INVALID')});
 await check('target-digest-tamper',async()=>{const changed=clone(config);changed.resources[0].resource_topology_digest=D;await privateWrite(process.env.HYPERFIDE_WRITER_ISOLATION_CONFIG,changed);try{await reject(()=>fence().isolate(input),'ISOLATION_PERMIT_SCOPE')}finally{await privateWrite(process.env.HYPERFIDE_WRITER_ISOLATION_CONFIG,config)}});
 await check('binding-tamper',async()=>{const file=c.journal+'/'+operationId+'.json',saved=await fs.readFile(file,'utf8'),changed=JSON.parse(saved);changed.resources['writer-node'].binding.topology_digest=D;await privateWrite(file,changed);try{await reject(()=>fence().isolate(input),'EXTERNAL_FENCE_INVALID')}finally{await fs.writeFile(file,saved)}});
 await check('no-repeat-destruction',async()=>{await fence().isolate(input);assert.equal(destroyCalls,1);assert.equal(preflightCalls,1)});
 const observationVerifier=await loadWriterObservationPermitVerifier(c.verifier),observing=registry.resolveCapability('8.4','provider.observation.v1',v=>typeof v.observeConfiguredResource==='function');
 const observer=(t=topology)=>createExternalWriterObserver(t,observing,legacy,journal);
 const observationPermit=async extra=>{const now=Date.now();return observationVerifier.verifySigned(await issueWriterObservationPermit({...claims,purpose:'EXTERNAL_WRITER_OBSERVATION_ONLY',issued_at:new Date(now).toISOString(),expires_at:new Date(now+60000).toISOString(),nonce:randomUUID(),...extra},issuer))};
 await check('observation-agrees',async()=>{const result=await observer().observe(await observationPermit({}),signal);assert.equal(result.topology_digest,topologyDigest);assert.equal(result.status,'OBSERVED',JSON.stringify(result));assert.equal(result.isolated_count,1);assert.equal(result.destruction_authority,false);assert.equal(destroyCalls,1)});
 await check('observation-tamper',async()=>{
  await reject(async()=>observer().observe(await observationPermit({topology_digest:D}),signal),'OBSERVATION_PERMIT_SCOPE');
  await reject(async()=>observer().observe(await observationPermit({resources:[{reference_key:'writer-node',topology_digest:D}]}),signal),'EXTERNAL_FENCE_AUTHORITY_DENIED');
  const t=clone(topology);t.resources[0].topology_digest=D;await reject(async()=>observer(t).observe(await observationPermit({}),signal),'EXTERNAL_FENCE_AUTHORITY_DENIED');
  assert.equal(destroyCalls,1);
 });
 unregister();unregister=undefined;
 await check('preflight-unregistered',async()=>{const p=verifier.verifySigned(await issueIsolationPermit({...claims,operation_id:randomUUID(),nonce:randomUUID()},issuer));await reject(()=>fence(topology,p).isolate({...input,operation_id:p.operation_id}),'DESTRUCTION_PREFLIGHT_UNAVAILABLE');assert.equal(destroyCalls,1)});
 console.log(JSON.stringify(results));
}finally{unregister?.();await service?.close();controller.abort();await registry.close()}
function ROOT_DIST(){return new URL('./services/hyperfide/dist/',import.meta.url).pathname}
"""
def setup(f):
 executor=f.path/'worker.json'
 executor.write_text(json.dumps({'schema_version':1,'principals':[{'credential_id':f.ids['provisioner'],'key_path':str(f.keys['provisioner']['path'])}],'concurrency':1}));executor.chmod(0o600)
 f.env['HF_PROVISIONER_EXECUTOR_CONFIG_FILE']=str(executor)
 limits={'SANDBOX':'100','PROVISIONING':'10','CPU_MILLIS':'1000000','MEMORY_BYTES':'107374182400','DISK_BYTES':'1073741824000'}
 f.pool=str(uuid.uuid4())
 config={'schema_version':1,'organisation_id':f.ids['organisation'],'revision':'29.3-component-fixture','accounts':[{'provider':'railway','account_key':'fixture-account','approved_limits':limits,'planning_limits':limits}],'pools':[{'id':f.pool,'provider':'railway','account_key':'fixture-account','environment_key':'fixture-env','region':'fixture-region','profile_id':None,'preparation_digest':f.preparation,'approved_limits':limits,'planning_limits':limits,'create_policy':{'seed_reference':'fixture-seed','network':'ISOLATED','stdin_required':False}}],'maximum_operation_ms':10000}
 file=f.path/'pools.json';file.write_text(json.dumps(config));file.chmod(0o600);f.env['HYPERFIDE_POOL_CONFIG']=str(file)
 f.env['HYPERFIDE_WRITER_ISOLATION_CONFIG']=str(f.path/'isolation.json')
def evidence_dir():
 campaign=os.environ.get('HYPERFIDE_CAMPAIGN_DIR')
 if not campaign:return None
 base=Path(campaign)/'binding';base.mkdir(parents=True,exist_ok=True);return base
def record_fixture(f,ports):
 base=evidence_dir()
 if base:(base/'resources.json').write_text(json.dumps({'database':f.database,'runtime_role':f.runtime_role,'path':str(f.path),'ports':ports})+'\n')
def cleanup():
 base=evidence_dir()
 if base is None:raise RuntimeError('Campaign directory required for independent cleanup')
 row=json.loads((base/'resources.json').read_text());database=row['database'];role=row['runtime_role'];directory=Path(row['path'])
 m.expect(re.fullmatch(r'hf_identity_[0-9a-f]{32}',database) and re.fullmatch(r'hf_ir_[0-9a-f]{32}',role) and directory.parent==Path(tempfile.gettempdir()) and directory.name.startswith('hyperfide-identity-'),'Owned fixture identity required')
 def admin(sql,values=()):
  result=subprocess.run(['node','--input-type=commonjs','-e',m.identity.SQL_JS],cwd=ROOT,env=os.environ.copy(),input=json.dumps({'sql':sql,'values':list(values),'serial':False}),capture_output=True,text=True,timeout=20)
  m.expect(result.returncode==0,result.stderr);return json.loads(result.stdout)
 admin('DROP DATABASE IF EXISTS "'+database+'" WITH (FORCE)');admin('DROP ROLE IF EXISTS "'+role+'"')
 if directory.exists():shutil.rmtree(directory)
 state=admin('SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=$1) AS database_present,EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$2) AS role_present',[database,role])[0]
 ports=[]
 for port in row['ports']:
  m.expect(isinstance(port,int) and 1<=port<=65535,'Bounded fixture port required')
  with socket.socket() as probe:probe.settimeout(.2);ports.append({'port':port,'absent':probe.connect_ex(('127.0.0.1',port))!=0})
 complete=not state['database_present'] and not state['role_present'] and not directory.exists() and all(p['absent'] for p in ports)
 (base/'resource-absence.json').write_text(json.dumps({'complete':complete,'database':database,'role':role,'state':state,'private_path_absent':not directory.exists(),'listeners':ports})+'\n')
 print(json.dumps({'type':'cleanup','complete':complete,'resources':[{'id':'hf-task-29.3-fixtures','status':'deleted' if complete else 'unknown','observed_absent':complete,'evidence_artifact':'binding/resource-absence.json'}]}),flush=True)
 return 0 if complete else 1
def main():
 if sys.argv[1:]==['--cleanup']:return cleanup()
 if sys.argv[1:]:raise SystemExit('unsupported argument')
 f=None;failed=False
 try:
  f=m.ProvisionerFixture(extra_components=['8.2','8.3','8.4'],extra_setup=setup)
  record_fixture(f,[f.port])
  status,response=f.invoke('provider.pools.configure',{},component='8.2',key='operator');m.expect(status==200 and response.get('ok') is True,response)
  org=f.ids['organisation'];sandbox=str(uuid.uuid4())
  f.sql("INSERT INTO hyperfide.sandboxes(organisation_id,id,pool_id,native_sandbox_id,observed_state,preparation_digest) VALUES($1,$2,$3,'binding-fixture-resource','RUNNING',$4)",[org,sandbox,f.pool,f.preparation])
  boot=f.sql('SELECT boot_id FROM hyperfide.sandbox_boots WHERE organisation_id=$1 AND sandbox_id=$2',[org,sandbox])[0]['boot_id']
  for name in ['journal','workspace']:(f.path/name).mkdir(mode=0o700)
  verifier=f.path/'verifier.json';verifier.write_text(json.dumps({'schema_version':1,'issuers':[{'key_id':'binding-fixture','public_key_b64':f.keys['operator']['public_key_b64']}]}));verifier.chmod(0o600)
  with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
  record_fixture(f,[f.port,port])
  context={'policy':json.loads(f.policy.read_text()),'components':str(f.components),'org':org,'run':f.ids['run'],'deployment':f.ids['deployment'],'epoch':f.ids['epoch'],'sandbox':sandbox,'pool':f.pool,'boot':boot,'native':'binding-fixture-resource','preparation':f.preparation,'signer':str(f.keys['operator']['path']),'verifier':str(verifier),'journal':str(f.path/'journal'),'workspace':str(f.path/'workspace'),'serverConfig':str(f.path/'service.json'),'origin':'https://127.0.0.1:'+str(port),'port':port,'certificate':str(f.ca),'tlskey':str(f.tlskey)}
  result=subprocess.run(['node','--input-type=module','-e',SCRIPT],cwd=ROOT,env={**f.env,'HF_BINDING_CONTEXT':json.dumps(context)},capture_output=True,text=True,timeout=60)
  try:observed=json.loads(result.stdout) if result.returncode==0 else {}
  except ValueError:observed={}
  for name in IDS:
   actual='observed' if observed.get(name.removeprefix('fence.binding.')) is True else str(observed.get(name.removeprefix('fence.binding.'),result.stderr or result.stdout))
   failed=failed or actual!='observed';print(json.dumps({'type':'assertion','id':name,'expected':'observed','actual':actual}),flush=True)
 finally:
  if f:f.close()
 return 1 if failed else 0
if __name__=='__main__':sys.exit(main())
