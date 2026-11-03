import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {createNativeAcceptanceFixture} from './native_source_acceptance_fixture.mjs';
import {campaignManifest,machineIdentity,OperationLedger,logicalCorpus,executeWorkload,scheduleCampaignHooks,runCampaignHook} from '../source-control/workloads/campaign.mjs';
import {credential,deploymentConfig,observerCounters} from '../source-control/workloads/deployment.mjs';
const load=name=>import(pathToFileURL(path.join(process.env.SOURCE_CONTROL_MODULE_ROOT,name+'.js')));
const live=process.env.HF_SOURCE_WORKLOAD_LIVE==='1',machine=machineIdentity();
const serviceOptions={};
if(live)throw new Error('Full campaigns must use the explicit deployed-service driver');
const f=await createNativeAcceptanceFixture({serviceOptions}),checks=[];
const directory=path.resolve('build/source-control/6.2');await fs.mkdir(directory,{recursive:true});
const backend=serviceOptions.backend??f.service.objects.backend;
const manifest=process.env.HF_SOURCE_WORKLOAD_MANIFEST?campaignManifest(JSON.parse(await fs.readFile(process.env.HF_SOURCE_WORKLOAD_MANIFEST,'utf8'))):campaignManifest({schema_version:1,kind:'component',seed:42,file_counts:[100,1000],modified_files:10,modified_bytes:4096,clients:2,operations:8,rate_per_second:100,duration_seconds:1,hardware_digest:machine.digest,backend_identity:backend?.identity??'fixture',real_backend:false});
const {encodeFileDescriptor}=await load('objects');
const {SourceControlClient}=await import(pathToFileURL(path.join(process.env.SOURCE_CONTROL_SDK_MODULE_ROOT,'client.js')));
let sentBytes=0,receivedBytes=0;
const client=new SourceControlClient({endpoint:f.endpoint,scope:f.scope,token:()=>f.tokenFor('author'),fetch:async(input,init)=>{sentBytes+=init?.body?.byteLength??0;const response=await fetch(input,init);receivedBytes+=(await response.clone().arrayBuffer()).byteLength;return response;}});
const mutate=(action,input,options={})=>{const operation_id=options.operation_id??randomUUID();return client.call(action,input,{operation_id,idempotency_key:operation_id,...options});};
const blobHash=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const upload=async bytes=>{const blob=await client.call('source.objects.put',{kind:'blob',payload_base64:bytes.toString('base64')});const payload=encodeFileDescriptor({size_bytes:String(bytes.length),content_digest:blobHash(bytes),content:{kind:'blob',object_id:blob.object_id}});return f.client.call('source.objects.put',{kind:'file',payload_base64:payload.toString('base64')});};
try{
 if(manifest.hardware_digest!==machine.digest)throw new Error('Campaign hardware differs from pinned manifest');
 if(live&&manifest.backend_identity!==serviceOptions.backend.identity)throw new Error('Campaign backend differs from pinned manifest');
 if(!live&&manifest.kind!=='component')throw new Error('Full campaign needs actual configured storage');
 const results=[];
 const hooks=scheduleCampaignHooks(manifest,{scope:f.scope,outputDirectory:directory});
 for(const count of manifest.file_counts){
  const corpus=await logicalCorpus(f.service,f.scope,count,manifest.seed);
  const base=await f.createRevision({root_tree_id:corpus.root_tree_id,message:'Workload corpus preparation'});
  const workspaces=[];
  for(let n=0;n<manifest.clients;n++){
   const result=await mutate('source.workspaces.open',{workspace_id:randomUUID(),base_revision_id:base.revision_id,mode:'API_ONLY',read_paths:[''],write_paths:['']});workspaces.push(result.workspace);
  }
  const before=Number((await f.pool.query('SELECT count(*) FROM hyperfide.source_revisions WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3',Object.values(f.scope))).rows[0].count);
  const initialSent=sentBytes,initialReceived=receivedBytes;
  const ledger=new OperationLedger(path.join(directory,'operations-'+count+'-'+randomUUID()+'.jsonl'));
  const mutable=new Map(workspaces.map(w=>[w.workspace_id,w]));let first;
  const result=await executeWorkload({manifest,client,workspaces,ledger,openOnly:manifest.kind==='admission',edit:async({workspace,ordinal,operation_id,openOnly})=>{
   if(openOnly)return f.mutation('source.workspaces.open',{workspace_id:randomUUID(),base_revision_id:base.revision_id,mode:'API_ONLY',read_paths:[''],write_paths:[]},{operation_id});
   const current=mutable.get(workspace.workspace_id),changes=[];
   let remaining=manifest.modified_bytes;
   for(let n=0;n<manifest.modified_files;n++){
    const size=n===manifest.modified_files-1?remaining:Math.floor(manifest.modified_bytes/manifest.modified_files);remaining-=size;
    const bytes=Buffer.alloc(size,(manifest.seed+ordinal+n)%251);Buffer.from(String(ordinal)).copy(bytes);
    const file=await upload(bytes);changes.push({path:corpus.first_paths[n],operation:'put',kind:'file',mode:'100644',object_id:file.object_id});
   }
   const input={operation_id,workspace_id:current.workspace_id,expected_workspace_generation:current.workspace_generation,expected_scope_generation:current.scope_generation,base_revision_id:current.base_revision_id,overlay_generation:String(ordinal+1),changes};
   const checkpointStarted=performance.now();const receipt=await mutate('source.workspaces.checkpoint',input,{operation_id});const checkpoint_rpc_ms=performance.now()-checkpointStarted;mutable.set(workspace.workspace_id,receipt.workspace);
   if(!first)first={input,operation_id,receipt};
   const revision=await f.service.metadata.readRevision(f.context,receipt.revision_id);
   for(const change of changes){const entry=await f.service.trees.lookup(f.scope,revision.root_tree_id,change.path);assert.equal(entry.object_id,change.object_id);await f.service.objects.readFile(f.scope,entry.object_id);}
   return {...receipt,checkpoint_rpc_ms};
  }});
  assert.equal(result.rejected,0);assert.equal(result.completed_operations,manifest.operations);
  const after=Number((await f.pool.query('SELECT count(*) FROM hyperfide.source_revisions WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3',Object.values(f.scope))).rows[0].count);
  assert.equal(after-before,manifest.kind==='admission'?0:result.new_revisions);
  if(first){const replay=await mutate('source.workspaces.checkpoint',first.input,{operation_id:first.operation_id});assert.equal(replay.revision_id,first.receipt.revision_id);const afterReplay=Number((await f.pool.query('SELECT count(*) FROM hyperfide.source_revisions WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3',Object.values(f.scope))).rows[0].count);assert.equal(afterReplay,after);}
  results.push({corpus,measurements:result,independently_persisted_revisions:after-before,application_request_bytes:sentBytes-initialSent,application_response_bytes:receivedBytes-initialReceived,ledger:ledger.path});ledger.close();
 }
 checks.push('actual API checkpoints across increasing logical corpora are independently reconstructed and counted in PostgreSQL');
 checks.push('replayed acknowledgments do not increase new durable revision totals');
 for(const patch of [{kind:'unknown'},{operations:0},{kind:'growth'},{kind:'mixed'},{kind:'admission'},{kind:'endurance',real_backend:false}])assert.throws(()=>campaignManifest({...manifest,...patch}));
 checks.push('empty, undersized, unsupported and missing-live-backend full campaigns are rejected');
 const duplicate=new OperationLedger(path.join(directory,'counting-'+randomUUID()+'.jsonl')),id=randomUUID(),rev='sha256:'+'a'.repeat(64);
 await duplicate.record({operation_id:id,revision_id:rev,status:'ACKNOWLEDGED',elapsed_ms:1});await duplicate.record({operation_id:id,revision_id:rev,status:'ACKNOWLEDGED',elapsed_ms:1});assert.equal(duplicate.summary().new_revisions,1);assert.equal(duplicate.summary().replayed_acknowledgments,1);await duplicate.record({operation_id:randomUUID(),revision_id:rev,status:'ACKNOWLEDGED',elapsed_ms:1});assert.equal(duplicate.summary().new_revisions,1);assert.equal(duplicate.summary().daily_new_revisions[0],1);
 checks.push('operation ledger records request outcomes and distinguishes replay from new authored revisions');duplicate.close();
 const hookSource="const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');const target=process.env.HF_SOURCE_CAMPAIGN_RESULT;const data=Buffer.from('measured hook evidence');const evidence=target+'.data';fs.writeFileSync(evidence,data);fs.writeFileSync(target,JSON.stringify({schema_version:1,status:'PASS',scope:JSON.parse(process.env.HF_SOURCE_CAMPAIGN_SCOPE),evidence:[{path:path.basename(evidence),size:data.length,sha256:'sha256:'+crypto.createHash('sha256').update(data).digest('hex')}]}));";
 const testHook={argv:[process.execPath,'-e',hookSource],executable_digest:blobHash(await fs.readFile(process.execPath)),timeout_seconds:30,env_keys:[]};
 await runCampaignHook(testHook,{scope:f.scope,outputDirectory:directory,ordinal:'check'});
 const corrupt={...testHook,argv:[process.execPath,'-e',hookSource.replace("crypto.createHash('sha256').update(data).digest('hex')","'0'.repeat(64)")]};
 await assert.rejects(()=>runCampaignHook(corrupt,{scope:f.scope,outputDirectory:directory,ordinal:'corrupt'}),/hash differs/);
 checks.push('pinned external canary and fault commands execute and their bounded evidence bytes are independently verified');
 const credentialFile=path.join(directory,'credential-'+randomUUID()+'.json');
 const deployed={schema_version:1,endpoint:'https://source.example.invalid/api',scope:f.scope,isolated_scope:true,backend_identity:'measured',credential_file:credentialFile,output_directory:directory,budgets:{max_checkpoint_p95_ms:1000,max_growth_ratio:2},observer:{},corpora:[{logical_files:100,revision_id:'sha256:'+'a'.repeat(64),edit_paths:Array.from({length:10},(_,i)=>'file-'+i)}]};
 deploymentConfig(deployed,{...manifest,real_backend:true,backend_identity:'measured',file_counts:[100]});
 assert.throws(()=>deploymentConfig({...deployed,endpoint:'http://remote.example.invalid'}, {...manifest,real_backend:true,backend_identity:'measured',file_counts:[100]}));
 assert.throws(()=>observerCounters({backend_identity:'measured',real_s3:true},'measured'),/counter/);
 const writeToken=(token,expires_at=new Date(Date.now()+120000).toISOString())=>fs.writeFile(credentialFile,JSON.stringify({schema_version:1,endpoint:deployed.endpoint,scope:f.scope,token,expires_at}),{mode:0o600});
 try{await writeToken('first');assert.equal(await credential(deployed),'first');await writeToken('rotated');assert.equal(await credential(deployed),'rotated');await writeToken('expired','2000-01-01T00:00:00Z');await assert.rejects(()=>credential(deployed),/expires/);await writeToken('wrong-scope');await assert.rejects(()=>credential({...deployed,scope:{...f.scope,repository_id:randomUUID()}}));}finally{await fs.unlink(credentialFile);}
 checks.push('deployed API scope, measured observer completeness and renewable expiring credentials are enforced');
 const hookReceipts=await hooks;
 const elapsed=results.reduce((sum,item)=>sum+item.measurements.elapsed_ms,0);
 if(manifest.kind==='endurance'&&elapsed<manifest.duration_seconds*1000)throw new Error('Elapsed endurance coverage is incomplete');
 if(manifest.kind==='endurance'&&results.some(item=>item.measurements.daily_new_revisions.slice(0,3).some(count=>count<100000)))throw new Error('A full elapsed daily window missed 100000 distinct acknowledged revisions');
 const receipt={schema_version:1,status:'PASS',scope:manifest.kind==='component'?'bounded real API workload harness':'explicit live storage campaign',manifest,machine,checks,results,hook_receipts:hookReceipts,full_variants:manifest.kind==='component'?{growth:'UNRUN',mixed:'UNRUN',admission:'UNRUN',endurance:'UNRUN'}:undefined};
 await fs.writeFile(path.join(directory,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify({status:receipt.status,checks:checks.length,corpora:results.length,scope:receipt.scope}));
}finally{await f.close();}

for(const id of ["source-workload.api-corpus-checkpoints","source-workload.replay-accounting","source-workload.invalid-profiles","source-workload.durable-ledger","source-workload.pinned-hook-evidence","source-workload.deployed-credentials"])console.log(JSON.stringify({type:"assertion",id,expected:true,actual:true}));
console.log(JSON.stringify({type:"cleanup",complete:true,resources:[]}));
