import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('storage preload accounts acknowledged, failed and unknown-size write payloads while excluding other origins',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'source-instrument-'));
 const received=[];const server=http.createServer(async(req,res)=>{let size=0;for await(const chunk of req)size+=chunk.length;if(req.method==='PUT')received.push(size);if(req.url.includes('?abort=1')){req.socket.destroy();return;}res.statusCode=req.url.includes('?fail=1')?403:200;res.write('abc');res.end('defgh');});
 const other=http.createServer((req,res)=>res.end('unrelated'));
 await Promise.all([new Promise(r=>server.listen(0,'127.0.0.1',r)),new Promise(r=>other.listen(0,'127.0.0.1',r))]);
 const endpoint='http://127.0.0.1:'+server.address().port,unrelated='http://127.0.0.1:'+other.address().port;
 const filename=path.join(directory,'events.jsonl');
 try{
  const scope={organisation_id:'organization',repository_id:'repository',security_domain_id:'domain'};
  const storagePath='/fixture-bucket/source/v1/domain/blob/aa/'+('a'.repeat(64))+'/11111111-1111-4111-a111-111111111111';
  await new Promise((resolve,reject)=>{
   const child=spawn(process.execPath,['--import',fileURLToPath(new URL('./native_source_campaign_instrumentation.mjs',import.meta.url)),'--input-type=module','--eval',`const r=await fetch(${JSON.stringify(endpoint+storagePath)});if(await r.text()!=='abcdefgh')throw Error('changed body');await(await fetch(${JSON.stringify(endpoint+storagePath)},{method:'PUT',body:new Uint8Array([1,2,3])})).text();await(await fetch(${JSON.stringify(endpoint+storagePath+'?fail=1')},{method:'PUT',body:'π'})).text();await(await fetch(${JSON.stringify(endpoint+storagePath)},{method:'PUT',body:new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('four'));c.close();}}),duplex:'half'})).text();try{await fetch(${JSON.stringify(endpoint+storagePath+'?abort=1')},{method:'PUT',body:'gone'});throw Error('expected disconnected request');}catch(error){if(error.message==='expected disconnected request')throw error;}await(await fetch(${JSON.stringify(unrelated+storagePath)})).text();await(await fetch(${JSON.stringify(endpoint+'/artifacts/unrelated')})).text();await(await fetch(${JSON.stringify(endpoint+storagePath.replace('/domain/','/foreign-domain/'))})).text();await(await fetch(${JSON.stringify(endpoint+storagePath.replace('/fixture-bucket/','/another-bucket/'))})).text();`],{env:{...process.env,HF_SOURCE_INSTRUMENTATION_LOG:filename,HF_SOURCE_INSTRUMENTATION_S3_ENDPOINT:endpoint,HF_SOURCE_INSTRUMENTATION_S3_BUCKET:'fixture-bucket',HF_SOURCE_CAMPAIGN_SCOPE:JSON.stringify(scope)},stdio:'pipe'});
   let error='';child.stderr.on('data',b=>error+=b);child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error(error)));
  });
  const raw=await fs.readFile(filename,'utf8'),events=raw.trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(e=>e.event==='request').length,5);assert.deepEqual(received,[3,2,4,4]);
  assert.equal(events.filter(e=>e.event==='bytes').reduce((n,e)=>n+e.bytes,0),32);
  assert.equal(events.filter(e=>e.event==='body_end').length,4);
  const {storageObservations}=await import('../source-control/workloads/storage_observer.mjs');const measured=await storageObservations({storage_logs:[filename],backend_identity:'owned-http'},scope);assert.equal(measured.storage_read_bytes,32);assert.equal(measured.storage_offered_write_bytes,9);assert.equal(measured.storage_acknowledged_write_bytes,3);assert.equal(measured.storage_unknown_write_lengths,1);assert.equal(measured.storage_failed_write_requests,1);assert.equal(measured.storage_unknown_write_outcomes,1);
  assert(!raw.includes(storagePath));assert(events.every(e=>JSON.stringify(e.scope)===JSON.stringify(scope)));
 }finally{server.closeAllConnections();other.closeAllConnections();await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>other.close(r))]);await fs.rm(directory,{recursive:true,force:true});}
});
test('native listener counters distinguish source POST from unrelated traffic and preserve idle windows',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'source-http-counter-')),filename=path.join(directory,'events.jsonl'),snapshot=filename+'.requests.json';
 const preload=fileURLToPath(new URL('./native_source_campaign_instrumentation.mjs',import.meta.url));
 const code="import http from 'node:http';const s=http.createServer((q,r)=>r.end('ok'));s.listen(0,'127.0.0.1',()=>console.log(s.address().port));process.on('SIGTERM',()=>s.close(()=>process.exit(0)));";
 const child=spawn(process.execPath,['--import',preload,'--input-type=module','--eval',code],{env:{...process.env,HF_SOURCE_INSTRUMENTATION_LOG:filename,HF_SOURCE_INSTRUMENTATION_S3_ENDPOINT:'https://bucket.example.invalid',HF_SOURCE_INSTRUMENTATION_S3_BUCKET:'fixture-bucket',HF_SOURCE_CAMPAIGN_SCOPE:JSON.stringify({organisation_id:'org',repository_id:'repo',security_domain_id:'domain'}),RAILWAY_DEPLOYMENT_ID:'owned-deployment',RAILWAY_SERVICE_ID:'owned-service'},stdio:['ignore','pipe','pipe']});
 try{
  const port=await new Promise((resolve,reject)=>{child.once('error',reject);child.stdout.once('data',value=>resolve(Number(value.toString().trim())));});
  const initial=JSON.parse(await fs.readFile(snapshot,'utf8'));assert.equal(initial.requests,0);
  const url='http://127.0.0.1:'+port;await fetch(url+'/healthz');await fetch(url+'/other',{method:'POST'});await fetch(url+'/api/v1/source-control');await fetch(url+'/api/v1/source-control',{method:'POST',body:'not inspected'});
  let observed;for(let step=0;step<100;step++){observed=JSON.parse(await fs.readFile(snapshot,'utf8'));if(observed.requests===1)break;await new Promise(resolve=>setTimeout(resolve,25));}
  assert.equal(observed.requests,1);assert.equal(observed.completed,1);assert.equal(observed.inflight,0);assert.equal(observed.boot_id,initial.boot_id);assert.equal(observed.deployment_id,'owned-deployment');assert.equal(observed.service_id,'owned-service');assert.equal(observed.listeners.length,1);assert(Date.parse(observed.sampled_at)>Date.parse(initial.sampled_at));
  let idle;for(let step=0;step<200;step++){idle=JSON.parse(await fs.readFile(snapshot,'utf8'));if(Date.parse(idle.sampled_at)>Date.parse(observed.sampled_at))break;await new Promise(resolve=>setTimeout(resolve,25));}assert.equal(idle.requests,1);assert(Date.parse(idle.sampled_at)>Date.parse(observed.sampled_at));
 }finally{child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));const final=JSON.parse(await fs.readFile(snapshot,'utf8'));assert.equal(final.state,'STOPPED');await fs.rm(directory,{recursive:true,force:true});}
});
test('incremental storage observations count actual later requests once',async()=>{
 const {storageObservations}=await import('../source-control/workloads/storage_observer.mjs');
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'source-storage-index-')),filename=path.join(directory,'events.jsonl');
 const scope={organisation_id:'org',repository_id:'repo',security_domain_id:'domain'};
 const server=http.createServer((req,res)=>res.end('counted bytes'));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const endpoint='http://127.0.0.1:'+server.address().port,request=endpoint+'/bucket/source/v1/domain/blob/aa/'+('a'.repeat(64))+'/11111111-1111-4111-a111-111111111111';
 const preload=fileURLToPath(new URL('./native_source_campaign_instrumentation.mjs',import.meta.url));
 const code=`await(await fetch(${JSON.stringify(request)})).text();console.log('ready');process.stdin.once('data',async()=>{await(await fetch(${JSON.stringify(request)})).text();console.log('again');process.exit(0);});`;
 const child=spawn(process.execPath,['--import',preload,'--input-type=module','--eval',code],{env:{...process.env,HF_SOURCE_INSTRUMENTATION_LOG:filename,HF_SOURCE_INSTRUMENTATION_S3_ENDPOINT:endpoint,HF_SOURCE_INSTRUMENTATION_S3_BUCKET:'bucket',HF_SOURCE_CAMPAIGN_SCOPE:JSON.stringify(scope)},stdio:['pipe','pipe','pipe']});
 try{
  await new Promise(resolve=>child.stdout.once('data',resolve));
  const config={storage_logs:[filename],storage_index_file:path.join(directory,'index.json'),backend_identity:'owned-http'};
  const first=await storageObservations(config,scope);assert.equal(first.storage_requests,1);assert.equal(first.storage_bytes,13);
  const repeat=await storageObservations(config,scope);assert.equal(repeat.storage_requests,1);assert.equal(repeat.storage_bytes,13);
  child.stdin.write('again\n');await new Promise(resolve=>child.stdout.once('data',resolve));
  const second=await storageObservations(config,scope);assert.equal(second.storage_requests,2);assert.equal(second.storage_bytes,26);assert.equal(second.evidence[0].segments.length,2);
 }finally{if(child.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(directory,{recursive:true,force:true});}
});
