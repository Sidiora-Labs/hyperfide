import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {chmodSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
export const stableOperation=(...parts)=>{const h=createHash('sha256').update(JSON.stringify(parts)).digest('hex');return h.slice(0,8)+'-'+h.slice(8,12)+'-4'+h.slice(13,16)+'-a'+h.slice(17,20)+'-'+h.slice(20,32);};
export const isResumableInterruption=(error,signal)=>error?.code==='OUTCOME_UNKNOWN'||error?.retry==='RETRY_SAME_OPERATION'||error?.name==='AbortError'||error?.code==='ABORT_ERR'||Boolean(signal?.aborted&&error===signal.reason);
export class CampaignState {
 constructor(filename,binding){
  this.database=new DatabaseSync(filename);chmodSync(filename,0o600);this.database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,corpus INTEGER NOT NULL,transient INTEGER NOT NULL,input TEXT NOT NULL,operation TEXT NOT NULL,descriptor TEXT,close_operation TEXT,closed INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS progress(corpus INTEGER NOT NULL,ordinal INTEGER NOT NULL,worker INTEGER NOT NULL,operation TEXT NOT NULL,request TEXT,result TEXT,complete INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(corpus,ordinal)); CREATE INDEX IF NOT EXISTS progress_worker ON progress(corpus,worker,complete,ordinal);");
  const before=this.get('binding');if(before)assert.deepEqual(before,binding,'Campaign resume changed pinned inputs');else this.set('binding',binding);
  this.workers=binding.plan.clients;this.run=this.get('content_run')??randomUUID();this.set('content_run',this.run);
 }
 get(key){const row=this.database.prepare('SELECT value FROM meta WHERE key=?').get(key);return row?JSON.parse(row.value):undefined;}
 set(key,value){this.database.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));return value;}
 workspace(id){const row=this.database.prepare('SELECT * FROM workspaces WHERE id=?').get(id);return row?{...row,input:JSON.parse(row.input),descriptor:row.descriptor?JSON.parse(row.descriptor):null}:null;}
 opening(corpus,input,operation,transient){this.database.prepare('INSERT OR IGNORE INTO workspaces(id,corpus,transient,input,operation) VALUES(?,?,?,?,?)').run(input.workspace_id,corpus,transient?1:0,JSON.stringify(input),operation);return this.workspace(input.workspace_id);}
 opened(workspace){this.database.prepare('UPDATE workspaces SET descriptor=? WHERE id=?').run(JSON.stringify(workspace),workspace.workspace_id);}
 closing(id){const row=this.workspace(id);assert(row);const operation=row.close_operation??stableOperation(this.run,'close',id);this.database.prepare('UPDATE workspaces SET close_operation=? WHERE id=?').run(operation,id);return operation;}
 closed(id){this.database.prepare('UPDATE workspaces SET closed=1 WHERE id=?').run(id);}
 owned(){return this.database.prepare('SELECT * FROM workspaces WHERE closed=0').all().map(row=>({...row,input:JSON.parse(row.input),descriptor:row.descriptor?JSON.parse(row.descriptor):null}));}
 operation(corpus,ordinal){const operation=stableOperation(this.run,corpus,ordinal);let row=this.database.prepare('SELECT * FROM progress WHERE corpus=? AND ordinal=?').get(corpus,ordinal);if(!row){this.database.prepare('INSERT INTO progress(corpus,ordinal,worker,operation) VALUES(?,?,?,?)').run(corpus,ordinal,ordinal%this.workers,operation);row=this.database.prepare('SELECT * FROM progress WHERE corpus=? AND ordinal=?').get(corpus,ordinal);}return {...row,request:row.request?JSON.parse(row.request):null,result:row.result?JSON.parse(row.result):null};}
 next(corpus,worker){const pending=this.database.prepare('SELECT ordinal FROM progress WHERE corpus=? AND worker=? AND complete=0 ORDER BY ordinal LIMIT 1').get(corpus,worker);if(pending)return pending.ordinal;const prior=this.database.prepare('SELECT max(ordinal) AS n FROM progress WHERE corpus=? AND worker=?').get(corpus,worker);return prior.n===null?worker:prior.n+this.workers;}
 completed(corpus){return this.database.prepare('SELECT count(*) AS n FROM progress WHERE corpus=? AND complete=1').get(corpus).n;}
 request(corpus,ordinal,value){this.database.prepare('UPDATE progress SET request=? WHERE corpus=? AND ordinal=?').run(JSON.stringify(value),corpus,ordinal);}
 result(corpus,ordinal,value){this.database.prepare('UPDATE progress SET result=? WHERE corpus=? AND ordinal=?').run(JSON.stringify(value),corpus,ordinal);}
 complete(corpus,ordinal){this.database.prepare('UPDATE progress SET complete=1,request=NULL,result=NULL WHERE corpus=? AND ordinal=?').run(corpus,ordinal);}
 cleanTransient(id){this.database.prepare('DELETE FROM workspaces WHERE id=? AND transient=1 AND closed=1').run(id);}
 close(){this.database.close();}
}
export async function executePersistentWorkload({manifest,client,workspaces,edit,ledger,signal,openOnly=false,state,corpus,onError}){
 const start=state.get('start:'+corpus)??state.set('start:'+corpus,Date.now());
 const workers=Math.min(manifest.clients,manifest.operations);let complete=state.completed(corpus);
 const worker=async index=>{
  for(let ordinal=state.next(corpus,index);ordinal<manifest.operations;ordinal+=workers){
   signal?.throwIfAborted();const operation=state.operation(corpus,ordinal);if(operation.complete){complete++;continue;}
   const due=start+ordinal*1000/manifest.rate_per_second;if(due>Date.now())await delay(due-Date.now(),undefined,{signal});
   const before=performance.now(),started=Date.now();
   try{
    const result=await edit({client,workspace:workspaces[index%workspaces.length],ordinal,operation_id:operation.operation,openOnly,saved:operation});
    if(!ledger.hasOperation(operation.operation))await ledger.record({operation_id:operation.operation,status:'ACKNOWLEDGED',elapsed_ms:performance.now()-before,scheduled_offset_ms:due-start,started_offset_ms:started-start,queue_delay_ms:Math.max(0,started-due),checkpoint_rpc_ms:result?.checkpoint_rpc_ms??null,revision_id:result?.revision_id??null,observed_at:Date.now()});
    state.complete(corpus,ordinal);if(openOnly)state.cleanTransient(result.workspace.workspace_id);complete++;
   }catch(error){const resumable=isResumableInterruption(error,signal);await ledger.record({operation_id:operation.operation,status:resumable?(error?.code==='OUTCOME_UNKNOWN'?'OUTCOME_UNKNOWN':'INTERRUPTED'):'REFUSED',elapsed_ms:performance.now()-before,error_code:error.code??error.name??'ERROR',observed_at:Date.now()});onError?.(error);throw error;}
  }
 };
 const results=await Promise.allSettled(Array.from({length:workers},(_,index)=>worker(index)));const failure=results.find(row=>row.status==='rejected');if(failure)throw failure.reason;
 if(manifest.kind==='endurance'&&Date.now()<start+manifest.duration_seconds*1000)await delay(start+manifest.duration_seconds*1000-Date.now(),undefined,{signal});
 const elapsed_ms=Date.now()-start;return {...ledger.summary(),elapsed_ms,target_rate_per_second:manifest.rate_per_second,observed_submission_rate:manifest.operations/(elapsed_ms/1000),completed_operations:complete,logical_opens:openOnly?complete:0,materialized_files:0};
}
