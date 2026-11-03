/** Explicit deployed-service campaigns; never creates a fixture or reads ambient .env. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {DatabaseSync} from 'node:sqlite';
import {readPrivate,deploymentConfig,credential,observerCounters} from '../source-control/workloads/deployment.mjs';
import {campaignManifest,machineIdentity,OperationLedger,executeWorkload,runCampaignHook,scheduleCampaignHooks} from '../source-control/workloads/campaign.mjs';
const hash=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const config=deploymentConfig(JSON.parse(await readPrivate(process.env.HF_SOURCE_WORKLOAD_CONFIG)),campaignManifest(JSON.parse(await fs.readFile(process.env.HF_SOURCE_WORKLOAD_MANIFEST,'utf8'))));
const plan=campaignManifest(JSON.parse(await fs.readFile(process.env.HF_SOURCE_WORKLOAD_MANIFEST,'utf8')));
assert.notEqual(plan.kind,'component','Deployed campaigns require an explicit full profile');
const machine=machineIdentity();assert.equal(plan.hardware_digest,machine.digest);
const {SourceControlClient}=await import(pathToFileURL(path.join(process.env.SOURCE_CONTROL_SDK_MODULE_ROOT,'client.js')));
const directory=path.resolve(config.output_directory);await fs.mkdir(directory,{recursive:true,mode:0o700});
let requestBytes=0,responseBytes=0,credentialHashes=new Set();
const transport=async(input,init)=>{
 const operation=JSON.parse(Buffer.from(init.body).toString()).operation_id;
 for(let attempt=0;;attempt++){
  const token=await credential(config);credentialHashes.add(hash(token));const headers=new Headers(init.headers);headers.set('authorization','Bearer '+token);
  requestBytes+=init.body.byteLength;const started=performance.now();let response,error;
  try{response=await fetch(input,{...init,headers});responseBytes+=(await response.clone().arrayBuffer()).byteLength;}catch(value){error=value;}
  await fs.appendFile(path.join(directory,'transport.jsonl'),JSON.stringify({operation_id:operation,attempt,elapsed_ms:performance.now()-started,status:response?.status??null,network_error:Boolean(error)})+'\n',{mode:0o600});
  if(response&&![429,502,503,504].includes(response.status))return response;
  if(init.signal.aborted)throw init.signal.reason;
  await response?.body?.cancel();
  await new Promise((resolve,reject)=>{const done=()=>{init.signal.removeEventListener('abort',abort);resolve();};const timer=setTimeout(done,Math.min(5000,100*2**Math.min(attempt,6)));const abort=()=>{clearTimeout(timer);reject(init.signal.reason);};init.signal.addEventListener('abort',abort,{once:true});});
 }
};
const client=new SourceControlClient({endpoint:config.endpoint,scope:config.scope,timeout_ms:300000,token:async()=>{const token=await credential(config);credentialHashes.add(hash(token));return token;},fetch:transport});
const mutate=(action,input,operation_id=randomUUID())=>client.call(action,input,{operation_id,idempotency_key:operation_id});
const context={scope:config.scope,outputDirectory:directory};
const observe=async phase=>{const record=await runCampaignHook(config.observer,{...context,ordinal:'observer-'+phase});const value=JSON.parse(await fs.readFile(record.receipt_file,'utf8')).observations;observerCounters(value,plan.backend_identity);return {record,value};};
const before=await observe('before');
await client.capabilities();
const verified=new Map();
async function countTree(id,ancestors=new Set()){
 if(verified.has(id))return verified.get(id);assert(!ancestors.has(id),'Tree cycle');const next=new Set(ancestors).add(id);let cursor,total=0;
 do{const page=await client.tree(id,{limit:1000,...(cursor?{cursor}:{})});for(const entry of page.entries)total+=entry.kind==='directory'?await countTree(entry.object_id,next):1;cursor=page.next_cursor;}while(cursor);
 verified.set(id,total);return total;
}
const cancellation=new AbortController();let hooks,results=[],workspaces=[],passed=false;
try{
 // Verify immutable corpus snapshots before starting the timed fault schedule.
 for(const count of plan.file_counts){const corpus=config.corpora.find(c=>c.logical_files===count);assert(corpus,'Missing prepared corpus');const revision=await client.revision(corpus.revision_id);assert.equal(await countTree(revision.root_tree_id),count);assert(Array.isArray(corpus.edit_paths)&&corpus.edit_paths.length===plan.modified_files);for(const p of corpus.edit_paths)assert.equal((await client.lookup(revision.root_tree_id,p)).entry.kind,'file');}
 hooks=scheduleCampaignHooks(plan,context,cancellation.signal);hooks.catch(()=>{});
 for(const count of plan.file_counts){
  const corpus=config.corpora.find(c=>c.logical_files===count);workspaces=[];
  for(let n=0;n<plan.clients;n++)workspaces.push((await mutate('source.workspaces.open',{workspace_id:randomUUID(),base_revision_id:corpus.revision_id,mode:'API_ONLY',read_paths:[''],write_paths:['']})).workspace);
  const ledger=new OperationLedger(path.join(directory,'operations-'+count+'-'+randomUUID()+'.jsonl'));
  const current=new Map(workspaces.map(w=>[w.workspace_id,w]));let first;
  try{
   const result=await executeWorkload({manifest:plan,client,workspaces,ledger,openOnly:plan.kind==='admission',edit:async({workspace,ordinal,operation_id,openOnly})=>{
    if(openOnly){const opened=await mutate('source.workspaces.open',{workspace_id:randomUUID(),base_revision_id:corpus.revision_id,mode:'API_ONLY',read_paths:[''],write_paths:[]},operation_id);await mutate('source.workspaces.close',{workspace_id:opened.workspace.workspace_id,expected_workspace_generation:opened.workspace.workspace_generation});return opened;}
    const previous=current.get(workspace.workspace_id),changes=[];let remaining=plan.modified_bytes;
    for(let n=0;n<plan.modified_files;n++){const size=n===plan.modified_files-1?remaining:Math.floor(plan.modified_bytes/plan.modified_files);remaining-=size;const bytes=Buffer.alloc(size,(plan.seed+ordinal+n)%251);Buffer.from(String(ordinal)).copy(bytes);const blob=await client.call('source.objects.put',{kind:'blob',payload_base64:bytes.toString('base64')});const descriptor=Buffer.from(JSON.stringify([1,String(size),hash(bytes),['blob',blob.object_id]]));const file=await client.call('source.objects.put',{kind:'file',payload_base64:descriptor.toString('base64')});changes.push({path:corpus.edit_paths[n],operation:'put',kind:'file',mode:'100644',object_id:file.object_id});}
    const input={operation_id,workspace_id:previous.workspace_id,expected_workspace_generation:previous.workspace_generation,expected_scope_generation:previous.scope_generation,base_revision_id:previous.base_revision_id,overlay_generation:String(ordinal+1),changes};const started=performance.now();const receipt=await mutate('source.workspaces.checkpoint',input,operation_id);const checkpoint_rpc_ms=performance.now()-started;current.set(workspace.workspace_id,receipt.workspace);
    const revision=await client.revision(receipt.revision_id);for(const change of changes){assert.equal((await client.lookup(revision.root_tree_id,change.path)).entry.object_id,change.object_id);const file=await client.object(change.object_id);const tuple=JSON.parse(Buffer.from(file.payload_base64,'base64').toString());const blob=await client.object(tuple[3][1]);assert.equal(hash(Buffer.from(blob.payload_base64,'base64')),tuple[2]);}
    if(!first)first={input,operation_id,receipt};return {...receipt,checkpoint_rpc_ms};
   }});
   assert.equal(result.rejected,0);assert.equal(result.completed_operations,plan.operations);if(plan.kind!=='admission'){assert.equal(result.checkpoint_rpc_ms.count,result.completed_operations);assert(result.checkpoint_rpc_ms.p95<=config.budgets.max_checkpoint_p95_ms,'Declared checkpoint p95 budget exceeded');}if(plan.kind==='mixed')assert(result.observed_submission_rate>=plan.rate_per_second*.95,'Offered load fell below target');
   if(first)assert.equal((await mutate('source.workspaces.checkpoint',first.input,first.operation_id)).revision_id,first.receipt.revision_id);
   if(plan.kind==='endurance'){assert(result.elapsed_ms>=plan.duration_seconds*1000);assert(result.daily_new_revisions.slice(0,3).every(n=>n>=100000));}
   results.push({logical_files:count,measurements:result,ledger:ledger.path});
  }finally{ledger.close();for(const w of current.values())await mutate('source.workspaces.close',{workspace_id:w.workspace_id,expected_workspace_generation:w.workspace_generation});workspaces=[];}
 }
 if(plan.kind==='growth'){const latencies=results.map(r=>r.measurements.checkpoint_rpc_ms.p95);assert(Math.max(...latencies)/Math.min(...latencies)<=config.budgets.max_growth_ratio,'Declared growth ratio exceeded');}const hookReceipts=await hooks,after=await observe('after');
 const workerRevisions=new Set();
 for(const hook of hookReceipts.filter(h=>h.kind==='worker-canary')){const receipt=JSON.parse(await fs.readFile(hook.receipt_file,'utf8'));assert(Array.isArray(receipt.worker_revision_ids)&&receipt.worker_revision_ids.length,'Real worker canary must identify its independently authored revisions');for(const id of receipt.worker_revision_ids){assert(/^sha256:[0-9a-f]{64}$/.test(id));await client.revision(id);workerRevisions.add(id);}}
 for(const row of results){const db=new DatabaseSync(row.ledger+'.sqlite',{readOnly:true});try{for(const id of workerRevisions)assert.equal(db.prepare('SELECT count(*) AS n FROM revisions WHERE id=?').get(id).n,0,'Worker revision was also counted as client revision');}finally{db.close();}}
 const revisions=results.reduce((sum,r)=>sum+r.measurements.new_revisions,0);assert.equal(after.value.persisted_revisions-before.value.persisted_revisions,revisions+workerRevisions.size,'Independent scope revision count differs');assert(after.value.storage_requests>before.value.storage_requests,'No observed storage traffic');
 if(plan.kind==='endurance')assert(credentialHashes.size>=2,'Credential rotation was not observed by the real client');
 const receipt={schema_version:1,status:'PASS',scope:'explicit deployed-service campaign',manifest:plan,machine,endpoint:config.endpoint,source_scope:config.scope,results,worker_new_revisions:workerRevisions.size,hook_receipts:hookReceipts,observer_before:before,observer_after:after,application_request_bytes:requestBytes,application_response_bytes:responseBytes,credential_versions_observed:credentialHashes.size};
 await fs.writeFile(path.join(directory,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});passed=true;console.log(JSON.stringify({type:'assertion',id:'source-workload.full.'+plan.kind,expected:true,actual:true}));console.log(JSON.stringify({type:'cleanup',complete:true,resources:[]}));console.log(JSON.stringify({status:'PASS',kind:plan.kind,corpora:results.length}));
}catch(error){await fs.writeFile(path.join(directory,'receipt.json'),JSON.stringify({schema_version:1,status:'FAIL',kind:plan.kind,diagnostic:error.message,results})+'\n',{mode:0o600});throw error;}finally{cancellation.abort(new Error('Campaign finished'));await hooks?.catch(()=>{});await fs.writeFile(path.join(directory,'cleanup.json'),JSON.stringify({schema_version:1,status:passed?'PASS':'FAILED',open_workspaces:workspaces.map(w=>w.workspace_id),persistent_evidence_retained:true})+'\n',{mode:0o600});}
