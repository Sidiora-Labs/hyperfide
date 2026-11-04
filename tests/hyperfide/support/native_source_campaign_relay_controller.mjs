import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fork,spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {readPrivate} from '../source-control/workloads/deployment.mjs';
import {atomicJSON,boundedBody,canonical,digest,equalSecret,exactScope,mailboxStorage,packageEvidence,privateDirectory,s3Configuration} from '../source-control/workloads/mailbox.mjs';
const filename=fileURLToPath(import.meta.url);
async function guardedJob(configFile){
 const config=JSON.parse(await readPrivate(configFile));let child,finished=false,interrupted=false;
 const terminate=()=>{if(child&&!finished){try{process.kill(-child.pid,'SIGKILL');}catch{}}};
 const interrupt=()=>{interrupted=true;terminate();if(!child)process.exit(1);};process.once('disconnect',interrupt);process.once('SIGTERM',interrupt);
 const env={PATH:'/usr/bin:/bin',LANG:'C.UTF-8',...config.environment};
 child=spawn(config.argv[0],config.argv.slice(1),{env,detached:true,stdio:['ignore','pipe','pipe']});let size=0;const chunks=[];
 for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>{size+=bytes.length;if(size<=65536)chunks.push(bytes);if(size>1048576)terminate();});
 const timer=setTimeout(terminate,config.timeout_seconds*1000);
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve(signal?1:code));});finished=true;clearTimeout(timer);await fs.writeFile(config.log_file,Buffer.concat(chunks),{mode:0o600});if(process.connected)process.disconnect();process.exit(interrupted?1:code??1);
}
if(process.argv[2]==='--job'){await guardedJob(process.argv[3]);}
else{
 const config=JSON.parse(await readPrivate(process.argv[2]));assert.equal(config.schema_version,1);assert(config.prefix.startsWith('campaign-mailbox/v1/')&&!config.prefix.includes('..'));assert(path.isAbsolute(config.directory));assert(Number.isSafeInteger(config.max_parallel)&&config.max_parallel>=1&&config.max_parallel<=8);
 const jobs=new Map(config.jobs.map(job=>[job.id,job]));assert.equal(jobs.size,config.jobs.length);const storage=mailboxStorage(s3Configuration(process.env));await privateDirectory(config.directory);
 const lock=path.join(config.directory,'controller.lock');
 try{const old=JSON.parse(await fs.readFile(lock,'utf8'));try{process.kill(old.pid,0);throw Error('Mailbox controller is already running');}catch(error){if(error.code!=='ESRCH')throw error;}await fs.unlink(lock);}catch(error){if(error.code!=='ENOENT')throw error;}
 await fs.writeFile(lock,canonical({pid:process.pid}),{flag:'wx',mode:0o600});
 const db=new DatabaseSync(path.join(config.directory,'controller.sqlite'));await fs.chmod(path.join(config.directory,'controller.sqlite'),0o600);db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,request_sha TEXT NOT NULL,status TEXT NOT NULL,response TEXT,started_at TEXT NOT NULL,finished_at TEXT)");
 db.prepare("UPDATE jobs SET status='UNCERTAIN' WHERE status='DISPATCHED'").run();
 let running=true;for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{running=false;});const active=new Map();
 async function publish(id,response){const bytes=Buffer.from(canonical(response));assert(bytes.length<=25165824);const key=config.prefix+'/responses/'+id;const put=await storage.request('PUT',key,{body:bytes,conditional:true});if(![200,201,204,412].includes(put.status)){await put.body?.cancel();throw Error('Mailbox response publication failed');}await put.body?.cancel();const observed=await storage.request('GET',key);assert.equal(observed.status,200);assert.equal(digest(await boundedBody(observed,25165824)),digest(bytes),'Existing mailbox response differs');const removed=await storage.request('DELETE',config.prefix+'/requests/'+id);await removed.body?.cancel();}
 async function handle(id){
  const job=jobs.get(id);if(!job)return;const incoming=await storage.request('GET',config.prefix+'/requests/'+id);if(incoming.status===404){await incoming.body?.cancel();return;}assert.equal(incoming.status,200);const bytes=await boundedBody(incoming,65536),hash=digest(bytes),prior=db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
  if(prior){assert.equal(prior.request_sha,hash,'Mailbox operation replay changed request');if(prior.response){await publish(id,JSON.parse(prior.response));return;}const response={schema_version:1,job_id:id,request_sha256:hash,scope:config.scope,deployment_identity:config.deployment_identity,status:'UNCERTAIN',error:'Original job outcome requires reconciliation'};db.prepare("UPDATE jobs SET response=? WHERE id=?").run(canonical(response),id);await publish(id,response);return;}
  let request,invalid=false;
  try{request=JSON.parse(bytes);assert.deepEqual(Object.keys(request).sort(),['schema_version','job_id','nonce','scope','deployment_identity','operation_id','submitted_at','input'].sort());assert.equal(request.schema_version,1);assert.equal(request.job_id,id);assert(equalSecret(request.nonce,job.nonce));exactScope(request,config);assert(typeof request.operation_id==='string'&&request.operation_id.length<=64);assert(Date.parse(config.expires_at)>Date.now());assert(Math.abs(Date.now()-Date.parse(request.submitted_at))<=600000);if(job.kind==='observer'){assert.deepEqual(Object.keys(request.input).sort(),['schema_version','scope','sampled_at','phase','measurement','hydrated_bytes','cache_hits','cache_misses','application_request_bytes','application_response_bytes'].sort());assert(typeof request.input.phase==='string'&&request.input.phase.length<=256);assert(typeof request.input.measurement==='string'&&request.input.measurement.length<=1024);assert.equal(request.input.schema_version,1);assert.deepEqual(request.input.scope,config.scope);for(const key of ['hydrated_bytes','cache_hits','cache_misses','application_request_bytes','application_response_bytes'])assert(Number.isSafeInteger(request.input[key])&&request.input[key]>=0);assert(Math.abs(Date.now()-Date.parse(request.input.sampled_at))<=120000);assert(Buffer.byteLength(canonical(request.input))<=8192);}else assert.deepEqual(request.input,{});}catch{invalid=true;}
  db.prepare('INSERT INTO jobs(id,request_sha,status,started_at) VALUES(?,?,?,?)').run(id,hash,invalid?'REJECTED':'DISPATCHED',new Date().toISOString());
  const response={schema_version:1,job_id:id,request_sha256:hash,scope:config.scope,deployment_identity:config.deployment_identity,status:'REJECTED',error:'Mailbox request denied'};
  if(!invalid){
   let dispatched=false;try{
    const action=config.actions[job.kind];assert(action);assert(Array.isArray(action.argv)&&path.isAbsolute(action.argv[0]));assert(action.code_pins&&Object.hasOwn(action.code_pins,action.argv[0]));assert(Number.isSafeInteger(action.timeout_seconds)&&action.timeout_seconds>0&&action.timeout_seconds<=600);
    for(const [file,expected]of Object.entries(action.code_pins)){const stat=await fs.lstat(file);assert(stat.isFile()&&!stat.isSymbolicLink()&&!(stat.mode&0o022));assert.equal(digest(await fs.readFile(file)),expected);}
    const directory=path.join(config.directory,'jobs',id);await fs.mkdir(directory,{recursive:true,mode:0o700});const resultFile=path.join(directory,'result.json'),inputFile=path.join(directory,'input.json');await atomicJSON(inputFile,request.input);
    const environment={HF_SOURCE_CAMPAIGN_SCOPE:canonical(config.scope),HF_SOURCE_CAMPAIGN_RESULT:resultFile,HF_SOURCE_CAMPAIGN_OPERATION_ID:id,HF_SOURCE_RELAY_INPUT:inputFile};for(const key of action.env_keys??[]){assert(/^[A-Z][A-Z0-9_]*$/.test(key)&&process.env[key]);environment[key]=process.env[key];}
    const jobConfig=path.join(directory,'execution.json');await atomicJSON(jobConfig,{argv:action.argv,environment,timeout_seconds:action.timeout_seconds,log_file:path.join(directory,'process.log')});
    dispatched=true;const child=fork(filename,['--job',jobConfig],{env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},stdio:['ignore','ignore','ignore','ipc']});const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve(signal?1:code));});assert.equal(code,0,'Controller job failed');
    const result=JSON.parse(await readPrivate(resultFile));assert.equal(result.schema_version,1);assert.deepEqual(result.scope,config.scope);const files=await packageEvidence(directory,result);const prefix='relay-'+id+'/';response.status='COMPLETE';delete response.error;response.result={...result,evidence:result.evidence.map(file=>({...file,path:prefix+file.path}))};response.files=files.map(file=>({...file,path:prefix+file.path}));
   }catch{response.status=dispatched?'UNCERTAIN':'FAILED';response.error='Pinned controller job failed; private evidence retained';}
  }
  db.prepare('UPDATE jobs SET status=?,response=?,finished_at=? WHERE id=?').run(response.status,canonical(response),new Date().toISOString(),id);await publish(id,response);
 }
 const decode=value=>value.replaceAll('&amp;','&').replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&quot;','"').replaceAll('&apos;',"'");
 try{while(running){
  try{const response=await storage.request('GET',null,{query:[['list-type','2'],['prefix',config.prefix+'/requests/'],['max-keys','1000']]});assert.equal(response.status,200);const xml=(await boundedBody(response,1048576)).toString('utf8');
  for(const match of xml.matchAll(/<Key>([^<]+)<\/Key>/g)){const key=decode(match[1]);if(!key.startsWith(config.prefix+'/requests/'))continue;const id=key.slice((config.prefix+'/requests/').length);if(!jobs.has(id)||active.has(id)||active.size>=config.max_parallel)continue;const task=handle(id).catch(async error=>{await atomicJSON(path.join(config.directory,'last-error.json'),{at:new Date().toISOString(),job_id:id,name:error.name,message:error.message});}).finally(()=>active.delete(id));active.set(id,task);}
  await atomicJSON(path.join(config.directory,'heartbeat.json'),{at:new Date().toISOString(),pid:process.pid,active:active.size});}catch(error){await atomicJSON(path.join(config.directory,'poll-error.json'),{at:new Date().toISOString(),name:error.name,message:'Mailbox poll unavailable'});}await delay(config.poll_ms);
 }}finally{await Promise.allSettled(active.values());db.close();await fs.unlink(lock);}
}
