import test from 'node:test';
import assert from 'node:assert/strict';
import {getEventListeners} from 'node:events';
import {coldEditBytes,executeWorkload} from './campaign.mjs';
const manifest={schema_version:1,kind:'component',seed:42,file_counts:[10],modified_files:10,modified_bytes:1024,clients:1,operations:20,rate_per_second:1000,duration_seconds:1,hardware_digest:'sha256:'+'a'.repeat(64),backend_identity:'scheduler-test',real_backend:false};
function run(plan,signal,edit=async()=>({})){return executeWorkload({manifest:plan,signal,client:{},workspaces:[{workspace_id:'scheduler'}],edit,ledger:{record:async()=>{},summary:()=>({})}});}
test('completed scheduled arrivals release their cancellation listeners',async()=>{
 const controller=new AbortController();let observed=0;
 const result=await run(manifest,controller.signal,async()=>{observed++;return {};});
 assert.equal(result.completed_operations,20);assert.equal(observed,20);
 assert.equal(getEventListeners(controller.signal,'abort').length,0);
});
test('aborting a pending arrival releases its timer and cancellation listener',async()=>{
 const controller=new AbortController();let observed=0;
 const pending=run({...manifest,operations:2,rate_per_second:1},controller.signal,async()=>{observed++;return {};});
 const reason=new Error('campaign cancelled');setTimeout(()=>controller.abort(reason),10);
 await assert.rejects(pending,error=>error===reason);assert.equal(observed,1);
 assert.equal(getEventListeners(controller.signal,'abort').length,0);
});
test('cancellation settles in-flight workers before returning to the ledger owner',async()=>{
 const controller=new AbortController();const reason=new Error('cancel while worker active');let release,finished=false,settled=false;
 const pendingEdit=new Promise(resolve=>{release=resolve;});
 const runPromise=run({...manifest,clients:2,operations:3,rate_per_second:1000000},controller.signal,async({ordinal})=>{
  if(ordinal===0){await pendingEdit;finished=true;return {};}
  controller.abort(reason);return {};
 });
 const result=runPromise.then(()=>{settled=true;},error=>{settled=true;return error;});
 await new Promise(resolve=>setImmediate(resolve));
 try{assert.equal(settled,false);}finally{release();}
 assert.equal(await result,reason);assert.equal(finished,true);
});

test('growth edit objects are equally cold across corpora and campaign runs',()=>{
 const input={run:'first',seed:42,corpus:10000,ordinal:7,index:2,size:100001};
 const original=coldEditBytes(input);assert.equal(original.length,input.size);assert.deepEqual(original,coldEditBytes(input));
 for(const change of [{corpus:1000000},{corpus:10000000},{run:'second'},{ordinal:8},{index:3}])assert.notDeepEqual(original,coldEditBytes({...input,...change}));
});
