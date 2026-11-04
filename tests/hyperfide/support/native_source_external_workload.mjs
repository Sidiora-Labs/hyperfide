/** Explicit deployed-service campaigns; never creates a fixture or reads ambient .env. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {DatabaseSync} from 'node:sqlite';
import {captureArtifacts} from '../source-control/workloads/artifacts.mjs';
import {CampaignState,executePersistentWorkload,stableOperation,isResumableInterruption} from '../source-control/workloads/durable.mjs';
import {reloadingSignedClient} from '../source-control/workloads/signed_client.mjs';
import {readPrivate,deploymentConfig,credential,observerCounters,WorkspaceCustody} from '../source-control/workloads/deployment.mjs';
import {coldEditBytes,campaignManifest,machineIdentity,OperationLedger,executeWorkload,runCampaignHook,scheduleCampaignHooks} from '../source-control/workloads/campaign.mjs';
if(process.env.HF_SOURCE_WORKLOAD_VERIFY_ONLY==='1'){await import('./native_source_campaign_verify.mjs');process.exit(0);}
const hash=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const config=deploymentConfig(JSON.parse(await readPrivate(process.env.HF_SOURCE_WORKLOAD_CONFIG)),campaignManifest(JSON.parse(await fs.readFile(process.env.HF_SOURCE_WORKLOAD_MANIFEST,'utf8'))));
const plan=campaignManifest(JSON.parse(await fs.readFile(process.env.HF_SOURCE_WORKLOAD_MANIFEST,'utf8')));
assert.notEqual(plan.kind,'component','Deployed campaigns require an explicit full profile');
const machine=machineIdentity();assert.equal(plan.hardware_digest,machine.digest);
const {SourceControlClient}=await import(pathToFileURL(path.join(process.env.SOURCE_CONTROL_SDK_MODULE_ROOT,'client.js')));
const directory=path.resolve(config.output_directory);await fs.mkdir(directory,{recursive:true,mode:0o700});
const state=new CampaignState(path.join(directory,'campaign-state.sqlite'),{plan,scope:config.scope,endpoint:config.endpoint,deployment_identity:config.deployment_identity,corpora:config.corpora});
const contentRun=state.run;
const cancellation=new AbortController();let cleanupPhase=false,paused=false,currentCorpus=null;
for(const name of ['SIGINT','SIGTERM'])process.once(name,()=>{paused=true;cancellation.abort(new Error('Campaign paused by '+name));});
const recoveredMetrics=state.get('transport_totals')??{};let requestBytes=recoveredMetrics.requestBytes??0,responseBytes=recoveredMetrics.responseBytes??0,unknownResponseBytes=recoveredMetrics.unknownResponseBytes??0,credentialHashes=new Set(state.get('credential_versions')??[]);
const saveTransport=()=>state.set('transport_totals',{requestBytes,responseBytes,unknownResponseBytes});
const rememberCredential=value=>{if(!credentialHashes.has(value)){credentialHashes.add(value);state.set('credential_versions',[...credentialHashes]);}};
const transport=async(input,init)=>{
 const operation=JSON.parse(Buffer.from(init.body).toString()).operation_id;
 const signal=cleanupPhase?init.signal:AbortSignal.any([init.signal,cancellation.signal]);
 init={...init,signal};
 for(let attempt=0;;attempt++){
  const token=await credential(config);rememberCredential(hash(token));const headers=new Headers(init.headers);headers.set('authorization','Bearer '+token);
  requestBytes+=init.body.byteLength;const started=performance.now();let response,error;
  try{response=await fetch(input,{...init,headers});responseBytes+=(await response.clone().arrayBuffer()).byteLength;}catch(value){error=value;}
  await fs.appendFile(path.join(directory,'transport.jsonl'),JSON.stringify({operation_id:operation,attempt,elapsed_ms:performance.now()-started,status:response?.status??null,network_error:Boolean(error)})+'\n',{mode:0o600});
  if(response&&![429,502,503,504].includes(response.status))return response;
  if(init.signal.aborted)throw init.signal.reason;
  await response?.body?.cancel();
  await new Promise((resolve,reject)=>{const done=()=>{init.signal.removeEventListener('abort',abort);resolve();};const timer=setTimeout(done,Math.min(5000,100*2**Math.min(attempt,6)));const abort=()=>{clearTimeout(timer);reject(init.signal.reason);};init.signal.addEventListener('abort',abort,{once:true});});
 }
};
const client=config.signed_config_file?await reloadingSignedClient(config,{sdkRoot:process.env.SOURCE_CONTROL_SDK_MODULE_ROOT,signal:()=>cleanupPhase?new AbortController().signal:cancellation.signal,credentialVersion:rememberCredential,observe:async value=>{requestBytes+=value.request_bytes;if(value.response_bytes===null)unknownResponseBytes++;else responseBytes+=value.response_bytes;await fs.appendFile(path.join(directory,'transport.jsonl'),JSON.stringify(value)+'\n',{mode:0o600});}}):new SourceControlClient({endpoint:config.endpoint,scope:config.scope,timeout_ms:300000,token:async()=>{const token=await credential(config);rememberCredential(hash(token));return token;},fetch:transport});
const mutate=(action,input,operation_id=randomUUID())=>client.call(action,input,{operation_id,idempotency_key:operation_id});
const custody=new WorkspaceCustody(async(workspace,operation)=>{operation=state.closing(workspace.workspace_id);const result=await client.call('source.workspaces.close',{workspace_id:workspace.workspace_id,expected_workspace_generation:workspace.workspace_generation},{operation_id:operation,idempotency_key:operation,signal:AbortSignal.timeout(30000)});state.closed(workspace.workspace_id);return result;},async workspace=>(await client.call('source.workspaces.detail',{workspace_id:workspace.workspace_id},{signal:AbortSignal.timeout(30000)})).workspace);
const openIntents=new Map();
for(const row of state.owned()){if(row.descriptor){custody.track(row.descriptor);if(row.close_operation)custody.operations.set(row.id,row.close_operation);}else openIntents.set(row.id,{input:row.input,operation_id:row.operation});}
async function openWorkspace(input,operation=stableOperation(contentRun,'open',input.workspace_id),transient=false){
 const prior=state.workspace(input.workspace_id);if(prior?.descriptor){if(!prior.closed)custody.track(prior.descriptor);return {workspace:prior.descriptor};}
 state.opening(currentCorpus??0,input,operation,transient);
 openIntents.set(input.workspace_id,{input,operation_id:operation});
 const result=await mutate('source.workspaces.open',input,operation);custody.track(result.workspace);state.opened(result.workspace);openIntents.delete(input.workspace_id);return result;
}
async function closeOwned(){
 cleanupPhase=true;const errors=[];
 try{for(const [id,intent]of openIntents){try{const result=await client.call('source.workspaces.open',intent.input,{operation_id:intent.operation_id,idempotency_key:intent.operation_id,signal:AbortSignal.timeout(30000)});custody.track(result.workspace);openIntents.delete(id);}catch(error){errors.push(error);}}return [...errors,...await custody.closeAll()];}finally{cleanupPhase=false;}
}
const context={scope:config.scope,outputDirectory:directory};
const observe=async phase=>{
 const witnessPath=config.client_metrics_file??path.join(directory,'client-metrics.json');assert(path.isAbsolute(witnessPath));
 const witness={schema_version:1,scope:config.scope,sampled_at:new Date().toISOString(),phase,measurement:'This API_ONLY driver does not instantiate a filesystem materializer or object cache; API response bytes are recorded separately.',hydrated_bytes:0,cache_hits:0,cache_misses:0,application_request_bytes:requestBytes,application_response_bytes:responseBytes};
 const temporary=witnessPath+'.tmp-'+process.pid;await fs.writeFile(temporary,JSON.stringify(witness)+'\n',{mode:0o600});await fs.rename(temporary,witnessPath);
 const record=await runCampaignHook(config.observer,{...context,ordinal:'observer-'+phase});const value=JSON.parse(await fs.readFile(record.receipt_file,'utf8')).observations;observerCounters(value,plan.backend_identity,config.deployment_identity);return {record,value};};
const before=state.get('observer_before')??state.set('observer_before',await observe('before'));
await client.capabilities();
const verified=new Map();
async function countTree(id,ancestors=new Set()){
 if(verified.has(id))return verified.get(id);assert(!ancestors.has(id),'Tree cycle');const next=new Set(ancestors).add(id);let cursor,total=0;
 do{const page=await client.tree(id,{limit:256,...(cursor?{cursor}:{})});for(const entry of page.entries)total+=entry.kind==='directory'?await countTree(entry.object_id,next):1;cursor=page.next_cursor;}while(cursor);
 verified.set(id,total);return total;
}
let hooks,results=state.get('results')??[],workspaces=[],passed=false,finalReceipt;
assert(!['PASS','FAILED'].includes(state.get('status')),'Campaign is terminal; verify completed evidence or use a new campaign directory');state.set('status','RUNNING');
try{
 // Verify immutable corpus snapshots before starting the timed fault schedule.
 for(const count of plan.file_counts){const corpus=config.corpora.find(c=>c.logical_files===count);assert(corpus,'Missing prepared corpus');const revision=await client.revision(corpus.revision_id);assert.equal(await countTree(revision.root_tree_id),count);assert(Array.isArray(corpus.edit_paths)&&corpus.edit_paths.length===plan.modified_files);for(const p of corpus.edit_paths)assert.equal((await client.lookup(revision.root_tree_id,p)).entry.kind,'file');}

 for(const count of plan.file_counts){
  if(results.some(row=>row.logical_files===count))continue;currentCorpus=count;
  const corpus=config.corpora.find(c=>c.logical_files===count),serverBefore=state.get('observer_before:'+count)??state.set('observer_before:'+count,await observe('before-corpus-'+count));workspaces=[];
  for(let n=0;n<plan.clients;n++)workspaces.push((await openWorkspace({workspace_id:stableOperation(contentRun,count,'initial',n),base_revision_id:corpus.revision_id,mode:'API_ONLY',read_paths:[''],write_paths:['']})).workspace);
  if(!hooks){const start=state.get('campaign_start')??state.set('campaign_start',Date.now());if(!state.get('start:'+count))state.set('start:'+count,start);hooks=scheduleCampaignHooks(plan,context,cancellation.signal,state);hooks.catch(error=>cancellation.abort(error));}
  if(!state.get('start:'+count))state.set('start:'+count,Date.now());
  const ledger=new OperationLedger(path.join(directory,'operations-'+count+'.jsonl'),{started_at_ms:state.get('start:'+count)});
  const queryLedger=['mixed','endurance'].includes(plan.kind)?new OperationLedger(path.join(directory,'queries-'+count+'.jsonl'),{started_at_ms:state.get('start:'+count)}):null;
  const current=new Map(workspaces.map(w=>[w.workspace_id,w]));let first;
  try{
   const result=await executePersistentWorkload({manifest:plan,client,workspaces,ledger,state,corpus:count,onError:error=>cancellation.abort(error),signal:cancellation.signal,openOnly:plan.kind==='admission',edit:async({workspace,ordinal,operation_id,openOnly,saved})=>{
    if(openOnly){const opened=await openWorkspace({workspace_id:stableOperation(contentRun,count,ordinal,'admission'),base_revision_id:corpus.revision_id,mode:'API_ONLY',read_paths:[''],write_paths:[]},operation_id,true);custody.track(opened.workspace);await custody.close(opened.workspace.workspace_id);return opened;}
    const previous=current.get(workspace.workspace_id),changes=saved.request?.changes??[];let remaining=plan.modified_bytes;
    if(!saved.request){
    for(let n=0;n<plan.modified_files;n++){const size=n===plan.modified_files-1?remaining:Math.floor(plan.modified_bytes/plan.modified_files);remaining-=size;const bytes=coldEditBytes({run:contentRun,seed:plan.seed,corpus:count,ordinal,index:n,size});const blob=await client.call('source.objects.put',{kind:'blob',payload_base64:bytes.toString('base64')},{operation_id:stableOperation(contentRun,count,ordinal,n,'blob')});const descriptor=Buffer.from(JSON.stringify([1,String(size),hash(bytes),['blob',blob.object_id]]));const file=await client.call('source.objects.put',{kind:'file',payload_base64:descriptor.toString('base64')},{operation_id:stableOperation(contentRun,count,ordinal,n,'file')});changes.push({path:corpus.edit_paths[n],operation:'put',kind:'file',mode:'100644',object_id:file.object_id});}
    }
    const input=saved.request??{operation_id,workspace_id:previous.workspace_id,expected_workspace_generation:previous.workspace_generation,expected_scope_generation:previous.scope_generation,base_revision_id:previous.base_revision_id,overlay_generation:String(ordinal+1),changes};state.request(count,ordinal,input);const started=performance.now();if(saved.result)assert(saved.result.receipt&&Number.isFinite(saved.result.checkpoint_rpc_ms),'Persisted checkpoint requires its original measured RPC duration');const receipt=saved.result?.receipt??await mutate('source.workspaces.checkpoint',input,operation_id);const checkpoint_rpc_ms=saved.result?.checkpoint_rpc_ms??performance.now()-started;state.result(count,ordinal,{receipt,checkpoint_rpc_ms});state.opened(receipt.workspace);current.set(workspace.workspace_id,receipt.workspace);custody.track(receipt.workspace);
    const revision=await client.revision(receipt.revision_id);for(const change of changes){assert.equal((await client.lookup(revision.root_tree_id,change.path)).entry.object_id,change.object_id);const file=await client.object(change.object_id);const tuple=JSON.parse(Buffer.from(file.payload_base64,'base64').toString());const blob=await client.object(tuple[3][1]);assert.equal(hash(Buffer.from(blob.payload_base64,'base64')),tuple[2]);}
    if(queryLedger){
     const queries=[['source.queries.history',{revision_id:receipt.revision_id,limit:10,budget:{max_nodes:64,max_bytes:1048576,max_ms:5000}}],['source.queries.diff',{before_revision_id:input.base_revision_id,after_revision_id:receipt.revision_id,limit:10,budget:{max_nodes:256,max_bytes:1048576,max_ms:5000}}]];
     for(const [action,payload] of queries){const queryId=stableOperation(contentRun,count,ordinal,action);if(queryLedger.hasOperation(queryId))continue;const before=performance.now();try{const value=await client.call(action,payload,{operation_id:queryId});await queryLedger.record({operation_id:queryId,status:'ACKNOWLEDGED',elapsed_ms:performance.now()-before,action,result_bytes:Buffer.byteLength(JSON.stringify(value))});}catch(error){await queryLedger.record({operation_id:queryId,status:isResumableInterruption(error,cancellation.signal)?(error?.code==='OUTCOME_UNKNOWN'?'OUTCOME_UNKNOWN':'INTERRUPTED'):'REFUSED',elapsed_ms:performance.now()-before,action,error_code:error.code??error.name??'ERROR'});throw error;}}
    }
    if(!first)first={input,operation_id,receipt};return {...receipt,checkpoint_rpc_ms};
   }});
   assert.equal(result.rejected,0);assert.equal(result.completed_operations,plan.operations);if(plan.kind!=='admission'){assert.equal(result.checkpoint_rpc_ms.count,result.completed_operations);assert(result.checkpoint_rpc_ms.p95<=config.budgets.max_checkpoint_p95_ms,'Declared checkpoint p95 budget exceeded');}if(plan.kind==='mixed')assert(result.observed_submission_rate>=plan.rate_per_second*.95,'Offered load fell below target');
   if(first)assert.equal((await mutate('source.workspaces.checkpoint',first.input,first.operation_id)).revision_id,first.receipt.revision_id);
   if(plan.kind==='endurance'){assert(result.elapsed_ms>=plan.duration_seconds*1000);assert(result.daily_new_revisions.slice(0,3).every(n=>n>=100000));}
   const serverAfter=await observe('after-corpus-'+count);results.push({content_condition:{profile:'cold-unique-edit-objects',run:contentRun,corpus:count},logical_files:count,measurements:result,ledger:ledger.path,server_before:serverBefore,server_after:serverAfter,...(queryLedger?{query_ledger:queryLedger.path,query_measurements:queryLedger.summary()}:{} )});state.set('results',results);saveTransport();
  }finally{ledger.close();queryLedger?.close();const failures=paused?[]:await closeOwned();if(failures.length)throw new AggregateError(failures,'Workspace cleanup failed');workspaces=[];}
 }
 if(plan.kind==='growth'){const latencies=results.map(r=>r.measurements.checkpoint_rpc_ms.p95);assert(Math.max(...latencies)/Math.min(...latencies)<=config.budgets.max_growth_ratio,'Declared growth ratio exceeded');}if(!hooks)hooks=scheduleCampaignHooks(plan,context,cancellation.signal,state);const hookReceipts=await hooks,after=await observe('after');
 const workerRevisions=new Set();
 for(const hook of hookReceipts.filter(h=>h.kind==='worker-canary')){const receipt=JSON.parse(await fs.readFile(hook.receipt_file,'utf8'));assert(Array.isArray(receipt.worker_revision_ids)&&receipt.worker_revision_ids.length,'Real worker canary must identify its independently authored revisions');for(const id of receipt.worker_revision_ids){assert(/^sha256:[0-9a-f]{64}$/.test(id));await client.revision(id);workerRevisions.add(id);}}
 for(const row of results){const db=new DatabaseSync(row.ledger+'.sqlite',{readOnly:true});try{for(const id of workerRevisions)assert.equal(db.prepare('SELECT count(*) AS n FROM revisions WHERE id=?').get(id).n,0,'Worker revision was also counted as client revision');}finally{db.close();}}
 const revisions=results.reduce((sum,r)=>sum+r.measurements.new_revisions,0);assert.equal(after.value.persisted_revisions-before.value.persisted_revisions,revisions+workerRevisions.size,'Independent scope revision count differs');assert(after.value.storage_requests>before.value.storage_requests,'No observed storage traffic');
 if(plan.kind==='admission'){assert.equal(after.value.persisted_workspaces-before.value.persisted_workspaces,plan.operations+plan.clients);assert(results.every(result=>result.measurements.elapsed_ms<=86400000),'Admission did not complete twenty million opens within one day');}
 if(plan.kind==='endurance')assert(credentialHashes.size>=2,'Credential rotation was not observed by the real client');
 const receipt={schema_version:1,status:'PASS',scope:'explicit deployed-service campaign',manifest:plan,machine,endpoint:config.endpoint,source_scope:config.scope,results,worker_new_revisions:workerRevisions.size,hook_receipts:hookReceipts,observer_before:before,observer_after:after,application_request_bytes:requestBytes,application_response_bytes:responseBytes,response_attempts_with_unknown_bytes:unknownResponseBytes,byte_measurement:config.signed_config_file?'recorded canonical verified SDK envelopes; failed response bytes explicitly unknown; attempts interrupted before durable observation are excluded':'recorded actual fetch response bodies; attempts interrupted before durable observation are excluded',credential_versions_observed:credentialHashes.size};
 finalReceipt=receipt;state.set('status','FINALIZING');
}catch(error){paused=paused||isResumableInterruption(error);state.set('status',paused?'PAUSED':'FAILED');await fs.writeFile(path.join(directory,'receipt.json'),JSON.stringify({schema_version:1,status:paused?'PAUSED':'FAIL',kind:plan.kind,diagnostic:error.message,results})+'\n',{mode:0o600});throw error;}finally{cancellation.abort(new Error('Campaign finished'));await hooks?.catch(()=>{});const failures=paused?[]:await closeOwned();saveTransport();const complete=!paused&&!failures.length&&!custody.pending().length&&!openIntents.size;await fs.writeFile(path.join(directory,'cleanup.json'),JSON.stringify({schema_version:1,status:complete?'PASS':paused?'RETAINED_FOR_RESUME':'FAILED',open_intents:[...openIntents.values()],open_workspaces:custody.pending(),cleanup_outcomes:custody.outcomes,persistent_evidence_retained:true})+'\n',{mode:0o600});if(finalReceipt&&!complete){state.set('status','FAILED');throw new Error('Campaign cleanup incomplete');}if(finalReceipt){finalReceipt.artifacts=await captureArtifacts(directory);const temporary=path.join(directory,'receipt.json.tmp');const receiptFile=await fs.open(temporary,'w',0o600);try{await receiptFile.writeFile(JSON.stringify(finalReceipt,null,2)+'\n');await receiptFile.sync();}finally{await receiptFile.close();}await fs.rename(temporary,path.join(directory,'receipt.json'));const folder=await fs.open(directory,'r');try{await folder.sync();}finally{await folder.close();}state.set('final_receipt',finalReceipt);state.set('status','PASS');passed=true;}state.close();}
if(passed){console.log(JSON.stringify({type:'assertion',id:'source-workload.full.'+plan.kind,expected:true,actual:true}));console.log(JSON.stringify({type:'cleanup',complete:true,resources:[]}));console.log(JSON.stringify({status:'PASS',kind:plan.kind,corpora:results.length}));}
