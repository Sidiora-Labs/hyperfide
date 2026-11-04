import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import {chmodSync,openSync,fstatSync,ftruncateSync,writeSync,fsyncSync,closeSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {spawn} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {performance} from 'node:perf_hooks';
import {stableOperation} from './durable.mjs';
import {cgroupIdentity} from './hardware.mjs';

const fail=message=>{throw new Error(message);};

const pendingWaits=new WeakMap();
function waitForArrival(milliseconds,signal){
 if(!signal)return new Promise(resolve=>setTimeout(resolve,milliseconds));
 if(signal.aborted)return Promise.reject(signal.reason??new Error('Campaign interrupted'));
 let group=pendingWaits.get(signal);
 if(!group){
  group={items:new Set(),abort:null};
  group.abort=()=>{
   pendingWaits.delete(signal);
   for(const item of group.items){clearTimeout(item.timer);item.reject(signal.reason??new Error('Campaign interrupted'));}
   group.items.clear();
  };
  pendingWaits.set(signal,group);signal.addEventListener('abort',group.abort,{once:true});
 }
 return new Promise((resolve,reject)=>{
  const item={timer:null,reject};group.items.add(item);
  item.timer=setTimeout(()=>{
   group.items.delete(item);
   if(!group.items.size){signal.removeEventListener('abort',group.abort);pendingWaits.delete(signal);}
   resolve();
  },milliseconds);
 });
}

export function campaignManifest(value){
 if(!value||value.schema_version!==1||!['component','growth','mixed','admission','endurance'].includes(value.kind))fail('Explicit supported campaign kind required');
 const allowed=['schema_version','kind','seed','file_counts','modified_files','modified_bytes','clients','operations','rate_per_second','duration_seconds','hardware_digest','backend_identity','real_backend','canary','drills'];
 if(Object.keys(value).some(key=>!allowed.includes(key)))fail('Unknown campaign field');
 for(const key of ['seed','modified_files','modified_bytes','clients','operations','rate_per_second','duration_seconds'])if(!Number.isSafeInteger(value[key])||value[key]<1)fail('Positive campaign field required: '+key);
 if(!Array.isArray(value.file_counts)||!value.file_counts.length||value.file_counts.some(n=>!Number.isSafeInteger(n)||n<value.modified_files||n>10000000))fail('Bounded explicit corpus sizes required');
 if(typeof value.hardware_digest!=='string'||!/^sha256:[0-9a-f]{64}$/.test(value.hardware_digest)||typeof value.backend_identity!=='string'||!value.backend_identity)fail('Pinned hardware and storage identity required');
 if(value.kind==='growth'&&(JSON.stringify(value.file_counts)!=='[10000,1000000,10000000]'||value.modified_files!==10||value.modified_bytes!==1048576))fail('Full growth campaign requires all three corpus sizes and fixed ten-file one-MiB changes');
 if(value.kind==='mixed'&&(value.clients<5000||value.rate_per_second<100||value.duration_seconds<300||value.operations<30000))fail('Full mixed campaign requires 5000 clients and 100 submissions per second for five minutes');
 if(value.kind==='admission'&&value.operations<20000000)fail('Full admission campaign requires twenty million actual opens');
 if(value.kind==='endurance'&&(value.duration_seconds<259200||value.operations<300000||value.real_backend!==true||!value.canary||!Array.isArray(value.drills)||!['throttle','credential-rotation','collection','recovery'].every(x=>value.drills.some(d=>d.kind===x))))fail('Full endurance requires live storage, 72 elapsed hours, daily throughput, worker canary and all drills');
 if(value.kind==='endurance'){validateHook(value.canary);if(!Number.isSafeInteger(value.canary.interval_seconds)||value.canary.interval_seconds<1||value.canary.interval_seconds>3600)fail('Real worker canary interval must be at most one hour');for(const drill of value.drills){validateHook(drill);if(!Number.isSafeInteger(drill.at_seconds)||drill.at_seconds<0||drill.at_seconds>=value.duration_seconds)fail('Fault drill schedule is outside the campaign');}}
 return structuredClone(value);
}
export function machineIdentity(){
 const value={platform:os.platform(),release:os.release(),architecture:os.arch(),cpus:os.cpus().map(cpu=>cpu.model),memory_bytes:os.totalmem(),available_parallelism:typeof os.availableParallelism==='function'?os.availableParallelism():null,cgroups:cgroupIdentity(),node:process.version};
 return {value,digest:'sha256:'+createHash('sha256').update(JSON.stringify(value)).digest('hex')};
}
export class OperationLedger{
 constructor(path,{started_at_ms}={}){
  if(started_at_ms!==undefined&&(!Number.isSafeInteger(started_at_ms)||started_at_ms<=0))throw new Error('Positive persisted ledger start required');
  this.path=path;this.submitted=0;this.acknowledged=0;this.rejected=0;this.interrupted=0;this.replays=0;this.histogram=new Float64Array(4096);this.maximum=0;this.checkpointHistogram=new Float64Array(4096);this.checkpointCount=0;this.checkpointMaximum=0;this.queueMaximum=0;this.started=performance.now();this.daily=[0,0,0,0];this.newRevisions=0;
  this.database=new DatabaseSync(path+'.sqlite');chmodSync(path+'.sqlite',0o600);
  this.database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS revisions(id TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS ledger_meta(key TEXT PRIMARY KEY,value INTEGER NOT NULL)');
  const existing=this.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ledger_events'").get();
  if(!existing&&(this.database.prepare('SELECT count(*) AS n FROM operations').get().n||this.database.prepare('SELECT count(*) AS n FROM revisions').get().n)){this.database.close();throw new Error('Legacy ledger has no authoritative event history');}
  this.database.exec('CREATE TABLE IF NOT EXISTS ledger_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,body TEXT NOT NULL,acknowledged INTEGER NOT NULL,replayed INTEGER NOT NULL,new_revision INTEGER NOT NULL,day INTEGER NOT NULL,elapsed_ms REAL NOT NULL,checkpoint_ms REAL,queue_ms REAL NOT NULL)');
  if(!this.database.prepare('PRAGMA table_info(ledger_events)').all().some(column=>column.name==='interrupted'))this.database.exec('ALTER TABLE ledger_events ADD COLUMN interrupted INTEGER NOT NULL DEFAULT 0');
  if(!this.database.prepare('PRAGMA table_info(operations)').all().some(column=>column.name==='revision_id'))this.database.exec('ALTER TABLE operations ADD COLUMN revision_id TEXT');
  this.getMeta=this.database.prepare('SELECT value FROM ledger_meta WHERE key=?');this.setMeta=this.database.prepare('INSERT INTO ledger_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  if(!this.getMeta.get('started_at_ms'))this.setMeta.run('started_at_ms',started_at_ms??Date.now());this.startedAt=this.getMeta.get('started_at_ms').value;
  if(started_at_ms!==undefined&&this.startedAt!==started_at_ms){this.database.close();throw new Error('Ledger start differs from persisted campaign anchor');}
  this.addOperation=this.database.prepare('INSERT OR IGNORE INTO operations(id,revision_id) VALUES(?,?)');this.addRevision=this.database.prepare('INSERT OR IGNORE INTO revisions VALUES(?)');this.operationExists=this.database.prepare('SELECT revision_id FROM operations WHERE id=?');
  this.addEvent=this.database.prepare('INSERT INTO ledger_events(body,acknowledged,replayed,new_revision,day,elapsed_ms,checkpoint_ms,queue_ms,interrupted) VALUES(?,?,?,?,?,?,?,?,?)');
  for(const row of this.database.prepare('SELECT acknowledged,replayed,new_revision,day,elapsed_ms,checkpoint_ms,queue_ms,interrupted FROM ledger_events ORDER BY sequence').iterate())this.observe(row);
  this.journal=openSync(path,'a+',0o600);chmodSync(path,0o600);
  let offset=this.getMeta.get('journal_offset')?.value??0;
  if(fstatSync(this.journal).size<offset){offset=0;this.database.exec('BEGIN');try{this.setMeta.run('journal_sequence',0);this.setMeta.run('journal_offset',0);this.database.exec('COMMIT');}catch(error){this.database.exec('ROLLBACK');throw error;}}
  try{ftruncateSync(this.journal,offset);this.flushJournal();}catch(error){closeSync(this.journal);this.database.close();throw error;}
 }
 observe(row){
  this.submitted++;this.acknowledged+=row.acknowledged;this.rejected+=1-row.acknowledged-row.interrupted;this.interrupted+=row.interrupted;this.replays+=row.replayed;this.newRevisions+=row.new_revision;this.queueMaximum=Math.max(this.queueMaximum,row.queue_ms);this.maximum=Math.max(this.maximum,row.elapsed_ms);this.histogram[Math.min(4095,Math.floor(Math.log2(1+row.elapsed_ms)*128))]++;
  if(row.checkpoint_ms!==null){this.checkpointHistogram[Math.min(4095,Math.floor(Math.log2(1+row.checkpoint_ms)*128))]++;this.checkpointCount++;this.checkpointMaximum=Math.max(this.checkpointMaximum,row.checkpoint_ms);}
  if(row.new_revision&&row.day>=0&&row.day<this.daily.length)this.daily[row.day]++;
 }
 flushJournal(){
  let sequence=this.getMeta.get('journal_sequence')?.value??0,offset=this.getMeta.get('journal_offset')?.value??0,changed=false;
  ftruncateSync(this.journal,offset);
  for(const row of this.database.prepare('SELECT sequence,body FROM ledger_events WHERE sequence>? ORDER BY sequence').iterate(sequence)){
   const bytes=Buffer.from(row.body+'\n');let written=0;while(written<bytes.length){const count=writeSync(this.journal,bytes,written,bytes.length-written);if(!count)throw new Error('Ledger journal write made no progress');written+=count;}offset+=bytes.length;sequence=row.sequence;changed=true;
  }
  if(changed){fsyncSync(this.journal);this.database.exec('BEGIN');try{this.setMeta.run('journal_sequence',sequence);this.setMeta.run('journal_offset',offset);this.database.exec('COMMIT');}catch(error){this.database.exec('ROLLBACK');throw error;}}
 }
 hasOperation(id){return Boolean(this.operationExists.get(id));}
 async record(item){
  const checkpoint=item.checkpoint_rpc_ms??null,queue=item.queue_delay_ms??0;
  if(!['ACKNOWLEDGED','REFUSED','REJECTED','INTERRUPTED','OUTCOME_UNKNOWN'].includes(item.status))throw new Error('Explicit ledger outcome required');
  if(!item.operation_id||!Number.isFinite(item.elapsed_ms)||item.elapsed_ms<0||!Number.isFinite(queue)||queue<0||(checkpoint!==null&&(!Number.isFinite(checkpoint)||checkpoint<0)))fail('Measured operation identity and elapsed time required');
  const recorded=Date.now(),row={acknowledged:item.status==='ACKNOWLEDGED'?1:0,interrupted:['INTERRUPTED','OUTCOME_UNKNOWN'].includes(item.status)?1:0,replayed:0,new_revision:0,day:Math.floor((recorded-this.startedAt)/86400000),elapsed_ms:item.elapsed_ms,checkpoint_ms:checkpoint,queue_ms:queue};
  this.database.exec('BEGIN IMMEDIATE');
  try{
   if(row.acknowledged){row.replayed=this.addOperation.run(item.operation_id,item.revision_id??null).changes?0:1;if(row.replayed&&this.operationExists.get(item.operation_id).revision_id!==(item.revision_id??null))throw new Error('Acknowledged operation replay changed revision');if(!row.replayed&&item.revision_id)row.new_revision=Number(this.addRevision.run(item.revision_id).changes);}
   this.addEvent.run(JSON.stringify({...item,recorded_at_ms:recorded}),row.acknowledged,row.replayed,row.new_revision,row.day,row.elapsed_ms,row.checkpoint_ms,row.queue_ms,row.interrupted);this.database.exec('COMMIT');
  }catch(error){this.database.exec('ROLLBACK');throw error;}
  this.observe(row);this.flushJournal();
 }
 close(){try{this.flushJournal();}finally{closeSync(this.journal);this.database.close();}}
 summary(){const cp=q=>{let seen=0;for(let n=0;n<this.checkpointHistogram.length;n++){seen+=this.checkpointHistogram[n];if(seen>=Math.ceil(this.checkpointCount*q))return Math.min(this.checkpointMaximum,2**((n+1)/128)-1);}return null;};const checkpoint=this.checkpointCount?{count:this.checkpointCount,p50:cp(.5),p95:cp(.95),p99:cp(.99),max:this.checkpointMaximum}:null;const at=q=>{let seen=0;for(let n=0;n<this.histogram.length;n++){seen+=this.histogram[n];if(seen>=Math.ceil(this.submitted*q))return Math.min(this.maximum,2**((n+1)/128)-1);}return null;};return {submitted:this.submitted,acknowledged:this.acknowledged,rejected:this.rejected,replayed_acknowledgments:this.replays,interrupted_attempts:this.interrupted,new_revisions:this.newRevisions,daily_new_revisions:this.daily,checkpoint_rpc_ms:checkpoint,max_queue_delay_ms:this.queueMaximum,latency_ms:{kind:'bounded-logarithmic-histogram-upper-bounds',count:this.submitted,p50:at(.5),p95:at(.95),p99:at(.99),max:this.maximum}};}

}
export async function logicalCorpus(service,scope,count,seed){
 if(!Number.isSafeInteger(count)||count<1||count>10000000)fail('Invalid logical file count');
 const file=await service.objects.putFile(scope,Buffer.from('seed:'+seed+'\n'));
 const cache=new Map();
 const build=async(size)=>{
  if(cache.has(size))return cache.get(size);
  const entries=[];
  if(size<=1000)for(let n=0;n<size;n++)entries.push({name:'file-'+String(n).padStart(4,'0')+'.txt',kind:'file',mode:'100644',object_id:file.object_id});
  else for(let n=0,remaining=size;remaining>0;n++){
   const portion=Math.min(1000,remaining),child=await build(portion);
   entries.push({name:'dir-'+String(n).padStart(5,'0'),kind:'directory',mode:'040000',object_id:child});remaining-=portion;
  }
  const result=(await service.trees.fromEntries(scope,entries)).root_tree_id;cache.set(size,result);return result;
 };
 const root_tree_id=await build(count);
 const firstPaths=Array.from({length:Math.min(count,256)},(_,n)=>(count>1000?'dir-00000/':'')+'file-'+String(n).padStart(4,'0')+'.txt');
 return {root_tree_id,logical_files:count,unique_content_objects:1,first_paths:firstPaths};
}
export async function executeWorkload({manifest,client,workspaces,edit,ledger,signal,openOnly=false}){
 const plan=campaignManifest(manifest),start=performance.now();let next=0,complete=0;
 const worker=async(workerIndex)=>{
  for(;;){const ordinal=next++;if(ordinal>=plan.operations)break;if(signal?.aborted)throw signal.reason??new Error('Campaign interrupted');
   const due=start+ordinal*1000/plan.rate_per_second,delay=due-performance.now();if(delay>0)await waitForArrival(delay,signal);
   const operation_id=randomUUID(),before=performance.now();
   try{const result=await edit({client,workspace:workspaces[workerIndex%workspaces.length],ordinal,operation_id,openOnly});await ledger.record({operation_id,status:'ACKNOWLEDGED',elapsed_ms:performance.now()-before,scheduled_offset_ms:due-start,started_offset_ms:before-start,queue_delay_ms:Math.max(0,before-due),checkpoint_rpc_ms:result?.checkpoint_rpc_ms??null,revision_id:result?.revision_id??null});complete++;}
   catch(error){await ledger.record({operation_id,status:'REFUSED',elapsed_ms:performance.now()-before,error_code:error.code??error.message});}
  }
 };
 const outcomes=await Promise.allSettled(Array.from({length:Math.min(plan.clients,plan.operations)},(_,index)=>worker(index)));
 const failed=outcomes.find(outcome=>outcome.status==='rejected');if(failed)throw failed.reason;
 const elapsed_ms=performance.now()-start;
 return {...ledger.summary(),elapsed_ms,target_rate_per_second:plan.rate_per_second,observed_submission_rate:plan.operations/(elapsed_ms/1000),completed_operations:complete,logical_opens:openOnly?complete:0,materialized_files:0};
}

function validateHook(hook){
 if(!hook||!Array.isArray(hook.argv)||!hook.argv.length||hook.argv.some(x=>typeof x!=='string'||!x)||!path.isAbsolute(hook.argv[0])||!/^sha256:[0-9a-f]{64}$/.test(hook.executable_digest)||!Number.isSafeInteger(hook.timeout_seconds)||hook.timeout_seconds<1||hook.timeout_seconds>600||!Array.isArray(hook.env_keys)||hook.env_keys.some(x=>typeof x!=='string'||!/^[A-Z][A-Z0-9_]*$/.test(x)))fail('Faults and canaries require pinned executable commands and bounded explicit environments');
}
export async function runCampaignHook(hook,{scope,outputDirectory,ordinal,reuseExisting=false,operation_id}){
 validateHook(hook);const stat=await fs.lstat(hook.argv[0]);if(!stat.isFile()||stat.isSymbolicLink()||stat.mode&0o022)fail('Campaign hook executable must be an immutable regular file');
 if('sha256:'+createHash('sha256').update(await fs.readFile(hook.argv[0])).digest('hex')!==hook.executable_digest)fail('Campaign hook executable pin differs');
 const resultFile=path.join(outputDirectory,'hook-'+ordinal+'.json');const env={PATH:'/usr/bin:/bin',LANG:'C.UTF-8',HF_SOURCE_CAMPAIGN_SCOPE:JSON.stringify(scope),HF_SOURCE_CAMPAIGN_RESULT:resultFile,...(operation_id?{HF_SOURCE_CAMPAIGN_OPERATION_ID:operation_id}:{})};
 for(const key of hook.env_keys){if(!process.env[key])fail('Required campaign hook environment unavailable: '+key);env[key]=process.env[key];}
 let reused=false;if(reuseExisting){try{reused=(await fs.lstat(resultFile)).isFile();}catch(error){if(error.code!=='ENOENT')throw error;}}
 if(!reused)await fs.rm(resultFile,{force:true});const started=reused?null:new Date().toISOString();
 if(!reused)await new Promise((resolve,reject)=>{const child=spawn(hook.argv[0],hook.argv.slice(1),{env,stdio:['ignore','ignore','ignore']});const timeout=setTimeout(()=>child.kill('SIGKILL'),hook.timeout_seconds*1000);child.once('error',error=>{clearTimeout(timeout);reject(error);});child.once('close',(code,signal)=>{clearTimeout(timeout);code===0&&!signal?resolve():reject(new Error('Pinned campaign hook did not complete successfully'));});});
 const receiptStat=await fs.lstat(resultFile);if(!receiptStat.isFile()||receiptStat.isSymbolicLink())fail('Campaign receipt must be a regular file');const bytes=await fs.readFile(resultFile);if(bytes.length>1048576)fail('Campaign hook evidence exceeds bound');const result=JSON.parse(bytes);
 if(result?.schema_version!==1||result.status!=='PASS'||JSON.stringify(result.scope)!==JSON.stringify(scope)||!Array.isArray(result.evidence)||!result.evidence.length||result.evidence.some(e=>!/^sha256:[0-9a-f]{64}$/.test(e.sha256)||typeof e.path!=='string'))fail('Campaign hook requires scoped evidence references');
 for(const evidence of result.evidence){
  if(!Number.isSafeInteger(evidence.size)||evidence.size<1||evidence.size>16777216||path.isAbsolute(evidence.path))fail('Campaign evidence needs a bounded relative file');
  const file=path.resolve(outputDirectory,evidence.path);if(!file.startsWith(path.resolve(outputDirectory)+path.sep))fail('Campaign evidence escapes its owned directory');
  if(!(await fs.realpath(file)).startsWith((await fs.realpath(outputDirectory))+path.sep))fail('Campaign evidence follows an outside link');const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==evidence.size)fail('Campaign evidence file is missing or changed');
  if('sha256:'+createHash('sha256').update(await fs.readFile(file)).digest('hex')!==evidence.sha256)fail('Campaign evidence hash differs');
 }
 return {kind:hook.kind??'worker-canary',started_at:started,finished_at:new Date().toISOString(),executable_digest:hook.executable_digest,receipt_file:resultFile,receipt_sha256:'sha256:'+createHash('sha256').update(bytes).digest('hex')};
}
export async function scheduleCampaignHooks(manifest,context,signal,state){
 if(manifest.kind!=='endurance')return [];
 const events=manifest.drills.map(d=>({hook:d,second:d.at_seconds}));for(let second=0;second<manifest.duration_seconds;second+=manifest.canary.interval_seconds)events.push({hook:manifest.canary,second});events.sort((a,b)=>a.second-b.second);
 const start=state?.get('campaign_start')??Date.now(),results=[];for(let n=0;n<events.length;n++){const event=events[n],delay=start+event.second*1000-Date.now();if(signal?.aborted)throw signal.reason;if(delay>0)await waitForArrival(delay,signal);results.push(await runCampaignHook(event.hook,{...context,ordinal:n,reuseExisting:Boolean(state),operation_id:state?stableOperation(state.run,'hook',n):undefined}));}return results;
}

// Equal cold-content conditions: no uploaded edit object is reused across corpus sizes or runs.
export function coldEditBytes({run,seed,corpus,ordinal,index,size}){
 const block=createHash('sha256').update(JSON.stringify([run,seed,corpus,ordinal,index])).digest();
 const bytes=Buffer.alloc(size);for(let offset=0;offset<size;offset+=block.length)block.copy(bytes,offset,0,Math.min(block.length,size-offset));
 return bytes;
}
