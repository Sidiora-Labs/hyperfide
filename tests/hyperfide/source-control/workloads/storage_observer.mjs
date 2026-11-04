import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
export async function storageObservations(config,scope){
 const filename=config.storage_index_file;let lock;
 if(filename){
  assert(path.isAbsolute(filename));lock=filename+'.lock';
  for(let attempt=0;;attempt++){
   try{const fd=fs.openSync(lock,'wx',0o600);fs.writeSync(fd,String(process.pid));fs.closeSync(fd);break;}catch(error){if(error.code!=='EEXIST')throw error;const pid=Number(fs.readFileSync(lock,'utf8'));try{process.kill(pid,0);}catch(dead){if(dead.code==='ESRCH'){fs.unlinkSync(lock);continue;}throw dead;}if(attempt>=100)throw Error('Storage observer lock is busy');await new Promise(resolve=>setTimeout(resolve,100));}
  }
 }
 try{
  let index={schema_version:1,scope,backend_identity:config.backend_identity,logs:{}};
  if(filename){try{index=JSON.parse(await fsp.readFile(filename,'utf8'));assert.deepEqual(index.scope,scope);assert.equal(index.backend_identity,config.backend_identity);}catch(error){if(error.code!=='ENOENT')throw error;}}
  const logs=config.storage_logs??(await fsp.readdir(config.storage_log_directory)).filter(name=>name.startsWith('source-observer.')&&name.endsWith('.jsonl')).map(name=>path.join(config.storage_log_directory,name));assert(logs.length>0);
  for(const name of Object.keys(index.logs))assert(logs.includes(name),'Previously observed storage log disappeared');
  for(const name of logs){
   const stat=await fsp.lstat(name);assert(stat.isFile()&&!stat.isSymbolicLink());const old=index.logs[name]??{offset:0,requests:0,bytes:0,offered_write_bytes:0,acknowledged_write_bytes:0,unknown_write_lengths:0,failed_write_requests:0,unknown_write_outcomes:0,events:0,segments:[],started:false,dev:stat.dev,ino:stat.ino};assert.equal(old.dev,stat.dev);assert.equal(old.ino,stat.ino);assert(stat.size>=old.offset,'Storage log was truncated');
   if(stat.size===old.offset)continue;
   const next={...old,segments:[...old.segments]},hash=createHash('sha256');let pending=Buffer.alloc(0),read=0;
   for await(const bytes of fs.createReadStream(name,{start:old.offset,end:stat.size-1})){pending=Buffer.concat([pending,bytes]);let end;while((end=pending.indexOf(10))>=0){const line=pending.subarray(0,end+1);pending=pending.subarray(end+1);hash.update(line);read+=line.length;const event=JSON.parse(line.toString('utf8'));assert.deepEqual(event.scope,scope);next.events++;if(event.event==='start')next.started=true;if(event.event==='request'){next.requests++;if(event.method==='PUT'){if(Number.isSafeInteger(event.request_body_bytes)&&event.request_body_bytes>=0)next.offered_write_bytes=(next.offered_write_bytes??0)+event.request_body_bytes;else next.unknown_write_lengths=(next.unknown_write_lengths??0)+1;}}if(event.method==='PUT'&&event.event==='response'){if(event.status>=200&&event.status<300&&Number.isSafeInteger(event.request_body_bytes)&&event.request_body_bytes>=0)next.acknowledged_write_bytes=(next.acknowledged_write_bytes??0)+event.request_body_bytes;if(event.status<200||event.status>=300)next.failed_write_requests=(next.failed_write_requests??0)+1;}if(event.method==='PUT'&&event.event==='error')next.unknown_write_outcomes=(next.unknown_write_outcomes??0)+1;if(event.event==='bytes'){assert(Number.isSafeInteger(event.bytes)&&event.bytes>=0);next.bytes+=event.bytes;}}assert(pending.length<=1048576,'Storage event exceeds its bound');}
   assert.equal(pending.length,0,'Storage event is incomplete; retry this observation');assert(next.started,'Missing storage instrumentation start');next.offset+=read;next.segments.push({offset:old.offset,size:read,sha256:'sha256:'+hash.digest('hex')});index.logs[name]=next;
  }
  if(filename){const temporary=filename+'.tmp';const fd=fs.openSync(temporary,'w',0o600);try{fs.writeFileSync(fd,JSON.stringify(index));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temporary,filename);}
  const values=Object.entries(index.logs);return{storage_requests:values.reduce((n,[,v])=>n+v.requests,0),storage_bytes:values.reduce((n,[,v])=>n+v.bytes,0),storage_read_bytes:values.reduce((n,[,v])=>n+v.bytes,0),...Object.fromEntries(['offered_write_bytes','acknowledged_write_bytes','unknown_write_lengths','failed_write_requests','unknown_write_outcomes'].map(key=>['storage_'+key,values.reduce((n,[,v])=>n+(v[key]??0),0)])),evidence:values.map(([name,v])=>({kind:'actual-s3-fetch-stream-segments',identity:name,prefix_bytes:v.offset,events:v.events,segments:v.segments}))};
 }finally{if(lock)fs.unlinkSync(lock);}
}
