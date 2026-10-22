// The integrator merge queue (hyperfide-v21 4.8, req 6.3). Qualified worker results are snapshots
// (3.8): a result tree over a base commit. The queue folds them onto the run's internal trunk
// (refs/hyperfide/trunk/<run>) in queue order, grouped into touch-disjoint batches, with a
// tree-level three-way merge per snapshot. A batch is requalified once on its folded head; a
// failing batch is bisected until the snapshot that breaks it is isolated and rejected. A merge
// conflict never picks a side: it becomes one decision Ask (human.ask.raise) carrying both sides.
//
// The internal trunk is never pushed from here. GitHub receives per-wave publications through the
// separate human publication step (spec/workflow.kvx [publication]); fold commits carry
// Hyperfide-Snapshot trailers so a replayed queue skips what the trunk already holds.
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import type {Component,ComponentContext} from '../components/registry.js';
import {FoundationError} from '../policy/programme.js';
import {createAskComponent} from '../policy/human_interface.js';
import {bindScope,tx,obj,keys,scope,uuid,oid,digest,canonical,hash,fail,config,repository,currentRun,values,type Scope,type DB} from './candidates.js';

export const TRUNK_PREFIX='refs/hyperfide/trunk/';
const MAX_OUTPUT=16*1024*1024;
const SIDE_LIMIT=2048;

export interface QueueEntry {
 custody_id:string;task_id:string;task_key:string;snapshot_id:string;
 base_commit:string;base_tree:string;result_tree:string;checkpoint_digest:string;touches:string[];
}
export interface Requalification {outcome:'PASS'|'FAIL';receipt_digest:string}
export interface RequalifyInput {repository_path:string;commit:string;tree:string;snapshot_ids:string[]}
export interface QueuePorts {
 requalify(input:RequalifyInput):Promise<Requalification>;
 raiseAsk(input:Record<string,unknown>):Promise<unknown>;
}
interface ConflictSide {blob:string|null;content:string|null}
export interface Conflict {snapshot_id:string;custody_id:string;task_id:string;task_key:string;trunk_commit:string;paths:{path:string;base:ConflictSide;trunk:ConflictSide;snapshot:ConflictSide}[]}

function gitEnv():NodeJS.ProcessEnv{
 return {PATH:process.env.PATH,HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',
  GIT_AUTHOR_NAME:'Hyperfide Integrator',GIT_AUTHOR_EMAIL:'integrator@hyperfide.invalid',GIT_COMMITTER_NAME:'Hyperfide Integrator',GIT_COMMITTER_EMAIL:'integrator@hyperfide.invalid'};
}
/** Git in the integrator repository with stdin and an explicit set of accepted exit codes. */
export function git(directory:string,args:string[],options:{input?:Buffer|string;accept?:number[]}={}):Promise<{code:number;stdout:string}>{
 return new Promise((resolve,reject)=>{
  const child=spawn('git',['--no-replace-objects','-c','core.hooksPath=/dev/null','-c','gc.auto=0','-c','maintenance.auto=false',...args],{cwd:directory,env:gitEnv(),stdio:['pipe','pipe','pipe']});
  const out:Buffer[]=[],err:Buffer[]=[];let size=0;
  child.stdout.on('data',(b:Buffer)=>{size+=b.length;if(size>MAX_OUTPUT)child.kill('SIGKILL');else out.push(b);});
  child.stderr.on('data',(b:Buffer)=>{if(err.reduce((n,x)=>n+x.length,0)<65536)err.push(b);});
  child.on('error',reject);
  child.on('close',code=>{
   const stdout=Buffer.concat(out).toString('utf8'),accept=options.accept??[0];
   if(size>MAX_OUTPUT)return reject(new FoundationError('INTEGRATION_QUEUE_GIT_FAILED','git output exceeded its bound'));
   if(code===null||!accept.includes(code))return reject(new FoundationError('INTEGRATION_QUEUE_GIT_FAILED','git '+args[0]+' failed: '+Buffer.concat(err).toString('utf8').slice(0,400)));
   resolve({code,stdout});
  });
  child.stdin.on('error',()=>{});
  child.stdin.end(options.input??'');
 });
}
const line=async(directory:string,args:string[]):Promise<string>=>(await git(directory,args)).stdout.trim();
async function exists(directory:string,object:string):Promise<boolean>{return (await git(directory,['cat-file','-e',object],{accept:[0,1,128]})).code===0;}

/**
 * Touch-disjoint batches in queue order. An entry joins the current batch only when none of its
 * paths is touched by an entry already in the batch or by an earlier entry deferred from it, so two
 * overlapping snapshots always fold in the order they were queued.
 */
export function planBatches<T extends {touches:string[]}>(entries:readonly T[]):T[][]{
 const batches:T[][]=[];let pending=[...entries];
 while(pending.length){
  const batch:T[]=[],deferred:T[]=[],used=new Set<string>(),blocked=new Set<string>();
  for(const entry of pending){
   if(entry.touches.some(p=>used.has(p)||blocked.has(p))){deferred.push(entry);entry.touches.forEach(p=>blocked.add(p));}
   else{batch.push(entry);entry.touches.forEach(p=>used.add(p));}
  }
  batches.push(batch);pending=deferred;
 }
 return batches;
}

/** HFSN0001 checkpoint capsule (checkpoint.snapshot, 3.8): metadata plus a pack of the result's new objects. */
export async function importCheckpoint(repositoryPath:string,capsulePath:string,entry:Pick<QueueEntry,'checkpoint_digest'|'result_tree'|'snapshot_id'>):Promise<void>{
 let data:Buffer;
 try{data=await fs.readFile(capsulePath);}catch{return fail('INTEGRATION_QUEUE_SNAPSHOT_UNAVAILABLE','Snapshot '+entry.snapshot_id+' result tree is absent and its checkpoint capsule is not under the trusted root');}
 if(hash(data)!==entry.checkpoint_digest)fail('INTEGRATION_QUEUE_CHECKPOINT_MISMATCH','Checkpoint capsule bytes differ from the recorded digest');
 if(data.length<24||data.subarray(0,8).toString('latin1')!=='HFSN0001')fail('INTEGRATION_QUEUE_CHECKPOINT_MISMATCH','Not an HFSN0001 capsule');
 const metaLength=Number(data.readBigUInt64BE(8)),packLength=Number(data.readBigUInt64BE(16));
 if(24+metaLength+packLength!==data.length)fail('INTEGRATION_QUEUE_CHECKPOINT_MISMATCH','Capsule length mismatch');
 const meta=obj(JSON.parse(data.subarray(24,24+metaLength).toString('utf8')));
 if(meta.result_tree_id!==entry.result_tree)fail('INTEGRATION_QUEUE_CHECKPOINT_MISMATCH','Capsule names another result tree');
 if(packLength)await git(repositoryPath,['unpack-objects','-q'],{input:data.subarray(24+metaLength)});
 if(!await exists(repositoryPath,entry.result_tree+'^{tree}'))fail('INTEGRATION_QUEUE_CHECKPOINT_MISMATCH','Capsule pack does not hold the result tree');
}

/** The queue's custody inputs: every one current, qualified PASS, and bound to its own snapshot. */
async function readQueue(db:DB,s:Scope,repositoryId:string,custodyIds:string[]):Promise<(Omit<QueueEntry,'touches'>)[]>{
 const rows=(await db.query(`SELECT c.id AS custody_id,c.task_id,c.repository_id,c.authority,c.qualification_outcome,c.source_attempt_id,
   t.current_custody_id,t.state AS task_state,t.task_key,a.manifest->>'snapshot_id' AS bound_snapshot,a.manifest->>'snapshot_tree_id' AS bound_tree,
   n.id AS snapshot_id,n.task_id AS snapshot_task,n.attempt_id AS snapshot_attempt,n.repository_id AS snapshot_repository,
   n.base_commit,n.base_tree,n.result_tree,n.checkpoint_digest
  FROM hyperfide.submission_custodies c
  JOIN hyperfide.tasks t ON t.organisation_id=c.organisation_id AND t.run_id=c.run_id AND t.id=c.task_id
  LEFT JOIN hyperfide.assurance_submissions a ON a.organisation_id=c.organisation_id AND a.run_id=c.run_id AND a.custody_id=c.id
  LEFT JOIN hyperfide.source_snapshots n ON n.organisation_id=c.organisation_id AND n.run_id=c.run_id AND n.id::text=a.manifest->>'snapshot_id'
  WHERE c.organisation_id=$1 AND c.run_id=$2 AND c.id=ANY($3::uuid[])`,[...values(s),custodyIds])).rows;
 return custodyIds.map(id=>{
  const r=rows.find(x=>x.custody_id===id);
  if(!r||r.authority!=='ACTIVE'||r.qualification_outcome!=='PASS'||r.current_custody_id!==id||!['QUALIFIED','INTEGRATING'].includes(r.task_state))
   fail('INTEGRATION_CUSTODY_STALE','Custody '+id+' is not the current qualified result of its task');
  if(r.repository_id!==repositoryId)fail('INTEGRATION_SCOPE_DENIED','Custody '+id+' belongs to another repository');
  if(!r.bound_snapshot||!r.snapshot_id)fail('INTEGRATION_QUEUE_SNAPSHOT_REQUIRED','Custody '+id+' carries no recorded source snapshot');
  if(r.snapshot_task!==r.task_id||r.snapshot_attempt!==r.source_attempt_id||r.snapshot_repository!==r.repository_id||r.bound_tree!==r.result_tree)
   fail('INTEGRATION_QUEUE_SNAPSHOT_MISMATCH','Custody '+id+' snapshot is not the result of its attempt');
  return {custody_id:id,task_id:r.task_id,task_key:String(r.task_key),snapshot_id:r.snapshot_id,base_commit:oid(r.base_commit),base_tree:oid(r.base_tree),result_tree:oid(r.result_tree),checkpoint_digest:digest(r.checkpoint_digest)};
 });
}

async function side(repo:string,object:string):Promise<ConflictSide>{
 const blob=(await git(repo,['rev-parse','--verify','--quiet',object],{accept:[0,1,128]})).stdout.trim();
 if(!blob)return {blob:null,content:null};
 const content=(await git(repo,['cat-file','-p',blob])).stdout;
 return {blob,content:content.length>SIDE_LIMIT?content.slice(0,SIDE_LIMIT)+'\n[truncated]':content};
}

type Fold={commit:string}|{conflict:Conflict};
/** Tree-level three-way merge of one snapshot (base -> result) onto head, written as one fold commit. */
async function fold(repo:string,head:string,entry:QueueEntry):Promise<Fold>{
 // merge-tree before 2.45 merges commits only; the snapshot is wrapped in an unreferenced commit over its base.
 const theirs=await line(repo,['commit-tree',entry.result_tree,'-p',entry.base_commit,'-m','hyperfide snapshot '+entry.snapshot_id]);
 const merged=await git(repo,['merge-tree','--write-tree','--name-only','--no-messages','--merge-base='+entry.base_commit,head,theirs],{accept:[0,1]});
 const lines=merged.stdout.split('\n');const tree=oid(lines[0]);
 if(merged.code===1){
  const names=[...new Set(lines.slice(1).filter(Boolean))],paths=[];
  for(const name of names)paths.push({path:name,base:await side(repo,entry.base_commit+':'+name),trunk:await side(repo,head+':'+name),snapshot:await side(repo,entry.result_tree+':'+name)});
  return {conflict:{snapshot_id:entry.snapshot_id,custody_id:entry.custody_id,task_id:entry.task_id,task_key:entry.task_key,trunk_commit:head,paths}};
 }
 const message='hyperfide: fold task '+entry.task_key+' snapshot '+entry.snapshot_id+'\n\nHyperfide-Snapshot: '+entry.snapshot_id+'\nHyperfide-Task: '+entry.task_id+'\nHyperfide-Custody: '+entry.custody_id+'\n';
 return {commit:await line(repo,['commit-tree',tree,'-p',head,'-m',message])};
}

export interface QueueRequest {repository_path:string;trunk_ref:string;run_base:string;entries:Omit<QueueEntry,'touches'>[];checkpoint_root:string}
export interface QueueReport {
 trunk_ref:string;trunk_before:string;trunk_after:string;skipped:string[];batches:{index:number;snapshot_ids:string[]}[];
 folded:{snapshot_id:string;custody_id:string;task_id:string;commit:string;batch:number}[];
 rejected:{snapshot_id:string;custody_id:string;task_id:string;reason:'REQUALIFICATION_FAILED';receipt_digest:string|null;batch:number}[];
 conflicts:Conflict[];requalifications:{batch:number;commit:string;tree:string;snapshot_ids:string[];outcome:'PASS'|'FAIL';receipt_digest:string}[];
}

/** Fold the queue onto the trunk; returns what folded, what was rejected and what conflicted. */
export async function runQueue(request:QueueRequest,ports:Pick<QueuePorts,'requalify'>):Promise<QueueReport>{
 const repo=request.repository_path,ref=request.trunk_ref;
 if(!await exists(repo,request.run_base+'^{commit}'))fail('INTEGRATION_QUEUE_BASE_UNKNOWN','Run base commit is not in the integrator repository');
 let head=(await git(repo,['rev-parse','--verify','--quiet',ref+'^{commit}'],{accept:[0,1,128]})).stdout.trim();
 if(!head){await git(repo,['update-ref','-m','hyperfide: internal trunk from run base',ref,request.run_base,'']);head=request.run_base;}
 const trunkBefore=head;
 const onTrunk=new Set((await line(repo,['log','--format=%(trailers:key=Hyperfide-Snapshot,valueonly)',request.run_base+'..'+head])).split('\n').map(x=>x.trim()).filter(Boolean));
 const report:QueueReport={trunk_ref:ref,trunk_before:trunkBefore,trunk_after:head,skipped:[],batches:[],folded:[],rejected:[],conflicts:[],requalifications:[]};
 const pending:QueueEntry[]=[];
 for(const raw of request.entries){
  if(onTrunk.has(raw.snapshot_id)){report.skipped.push(raw.snapshot_id);continue;}
  if(!await exists(repo,raw.base_commit+'^{commit}'))fail('INTEGRATION_QUEUE_BASE_UNKNOWN','Snapshot '+raw.snapshot_id+' base commit is not in the integrator repository');
  if(!await exists(repo,raw.result_tree+'^{tree}'))await importCheckpoint(repo,path.join(request.checkpoint_root,raw.checkpoint_digest.slice(7)+'.hfs'),raw);
  if(await line(repo,['rev-parse',raw.base_commit+'^{tree}'])!==raw.base_tree)fail('INTEGRATION_QUEUE_SNAPSHOT_MISMATCH','Snapshot '+raw.snapshot_id+' base tree differs from its base commit');
  const touches=(await git(repo,['diff-tree','-r','--no-renames','--name-only','-z',raw.base_tree,raw.result_tree])).stdout.split('\0').filter(Boolean);
  pending.push({...raw,touches});
 }
 const advance=async(next:string)=>{
  const moved=await git(repo,['update-ref','-m','hyperfide: fold queue batch',ref,next,head],{accept:[0,1,128]});
  if(moved.code!==0)fail('INTEGRATION_QUEUE_TRUNK_MOVED','The internal trunk moved during the fold; rerun the queue');
  head=next;
 };
 // Folds the group onto the current trunk and requalifies its head once. On failure the group is
 // halved; when the left half advances whole, the right half is known to fail on the new trunk and
 // is bisected without another run. Returns whether every entry of the group advanced the trunk.
 const integrate=async(batch:number,group:QueueEntry[],knownFailing:boolean):Promise<boolean>=>{
  if(!group.length)return true;
  let next=head;const folded:{entry:QueueEntry;commit:string}[]=[];
  for(const entry of group){
   const result=await fold(repo,next,entry);
   if('conflict' in result){report.conflicts.push(result.conflict);continue;}
   next=result.commit;folded.push({entry,commit:result.commit});
  }
  if(!folded.length)return false;
  let verdict:Requalification|null=null;
  if(!(knownFailing&&folded.length===group.length)){
   const ids=folded.map(f=>f.entry.snapshot_id),tree=await line(repo,['rev-parse',next+'^{tree}']);
   const raw=obj(await ports.requalify({repository_path:repo,commit:next,tree,snapshot_ids:ids}));
   if(raw.outcome!=='PASS'&&raw.outcome!=='FAIL')fail('INTEGRATION_QUEUE_REQUALIFIER_INVALID','Requalification outcome must be PASS or FAIL');
   verdict={outcome:raw.outcome,receipt_digest:digest(raw.receipt_digest)};
   report.requalifications.push({batch,commit:next,tree,snapshot_ids:ids,...verdict});
  }
  if(verdict?.outcome==='PASS'){
   await advance(next);
   for(const f of folded)report.folded.push({snapshot_id:f.entry.snapshot_id,custody_id:f.entry.custody_id,task_id:f.entry.task_id,commit:f.commit,batch});
   return folded.length===group.length;
  }
  if(folded.length===1){
   const e=folded[0]!.entry;report.rejected.push({snapshot_id:e.snapshot_id,custody_id:e.custody_id,task_id:e.task_id,reason:'REQUALIFICATION_FAILED',receipt_digest:verdict?.receipt_digest??null,batch});
   return false;
  }
  const entries=folded.map(f=>f.entry),middle=Math.ceil(entries.length/2);
  const leftWhole=await integrate(batch,entries.slice(0,middle),false);
  await integrate(batch,entries.slice(middle),leftWhole);
  return false;
 };
 const batches=planBatches(pending);
 for(const [index,batch] of batches.entries()){
  report.batches.push({index,snapshot_ids:batch.map(e=>e.snapshot_id)});
  await integrate(index,batch,false);
 }
 report.trunk_after=head;
 return report;
}

/** One decision Ask for the conflicts of a fold: both sides of every conflicted path, never a chosen side. */
export function conflictAsk(s:Scope,repositoryId:string,conflicts:Conflict[],deadlineSeconds:number):Record<string,unknown>{
 const key='queue-conflict-'+hash(canonical({scope:s,repository_id:repositoryId,conflicts:conflicts.map(c=>({snapshot_id:c.snapshot_id,paths:c.paths.map(p=>[p.path,p.trunk.blob,p.snapshot.blob])}))})).slice(7);
 let body='The integrator could not fold these snapshots onto the internal trunk: the same lines changed on both sides. '+
  'Nothing was taken from either side; the trunk keeps its side until this is decided.\n';
 for(const c of conflicts){
  // The body is a function of the conflict content only, so a rerun that meets the same conflict replays the same Ask.
  body+='\nSnapshot '+c.snapshot_id+' (task '+c.task_key+' '+c.task_id+', custody '+c.custody_id+')\n';
  for(const p of c.paths){
   body+='--- '+p.path+' base '+(p.base.blob??'absent')+'\n';
   body+='<<< trunk side '+(p.trunk.blob??'absent')+'\n'+(p.trunk.content??'')+'\n';
   body+='>>> snapshot side '+(p.snapshot.blob??'absent')+'\n'+(p.snapshot.content??'')+'\n';
  }
 }
 if(body.length>65536)body=body.slice(0,65500)+'\n[truncated]';
 return {idempotency_key:key,kind:'decision',title:'Merge conflict folding '+conflicts.length+' snapshot'+(conflicts.length===1?'':'s')+' onto the internal trunk',
  body,options:['rework-snapshot','keep-trunk-side','take-snapshot-side'],recommended:'rework-snapshot',deadline_seconds:deadlineSeconds,
  chain:['leader','operator'],task_id:conflicts.length===1?conflicts[0]!.task_id:null};
}

/**
 * The requalifier is the trusted module named by HYPERFIDE_QUEUE_REQUALIFIER_MODULE, pinned by
 * HYPERFIDE_QUEUE_REQUALIFIER_DIGEST and loaded from the verified bytes. It runs the batch's gates
 * on the folded head and returns {outcome, receipt_digest}; without it the queue refuses to fold.
 */
async function requalifier(env:Readonly<NodeJS.ProcessEnv>):Promise<QueuePorts['requalify']>{
 const file=env.HYPERFIDE_QUEUE_REQUALIFIER_MODULE,pinned=env.HYPERFIDE_QUEUE_REQUALIFIER_DIGEST;
 if(!file||!pinned||!path.isAbsolute(file))fail('INTEGRATION_QUEUE_REQUALIFIER_UNAVAILABLE','A pinned requalification module is required before the queue folds');
 const bytes=await fs.readFile(file);if(hash(bytes)!==digest(pinned))fail('INTEGRATION_QUEUE_REQUALIFIER_UNAVAILABLE','Requalification module bytes differ from the pinned digest');
 const loaded=await import('data:text/javascript;base64,'+bytes.toString('base64')) as {requalify?:unknown};
 if(typeof loaded.requalify!=='function')fail('INTEGRATION_QUEUE_REQUALIFIER_UNAVAILABLE','Requalification module exports no requalify function');
 return loaded.requalify as QueuePorts['requalify'];
}

async function foldAction(ctx:ComponentContext,asks:Component,input:unknown,context:ComponentContext):Promise<unknown>{
 const v=obj(input);keys(v,['organisation_id','run_id','repository_id','custody_ids','ask_deadline_seconds']);
 const s=scope(v),repositoryId=uuid(v.repository_id);
 if(!Array.isArray(v.custody_ids)||!v.custody_ids.length||v.custody_ids.length>1000)fail('INTEGRATION_INVALID','Bounded nonempty queue required');
 const custodyIds=v.custody_ids.map(uuid);if(new Set(custodyIds).size!==custodyIds.length)fail('INTEGRATION_INVALID','Duplicate custody in queue');
 const deadline=v.ask_deadline_seconds;
 if(typeof deadline!=='number'||!Number.isSafeInteger(deadline)||deadline<1||deadline>30*86400)fail('INTEGRATION_INVALID','Conflict Ask deadline must be 1 s to 30 days');
 const cfg=await config(ctx.env),r=repository(cfg,repositoryId),requalify=await requalifier(ctx.env);
 const {entries,base}=await tx(null,async db=>{
  await currentRun(db,s);
  const run=(await db.query('SELECT source_object_id FROM hyperfide.run_repositories WHERE organisation_id=$1 AND run_id=$2 AND repository_id=$3',[...values(s),repositoryId])).rows[0];
  if(!run)fail('INTEGRATION_REPOSITORY_UNKNOWN','Repository is not registered for this run');
  return {entries:await readQueue(db,s,repositoryId,custodyIds),base:oid(run.source_object_id)};
 },'READ');
 const report=await runQueue({repository_path:r.path,trunk_ref:TRUNK_PREFIX+s.run_id,run_base:base,entries,checkpoint_root:path.join(cfg.root,'checkpoints')},{requalify});
 let ask:unknown=null;
 if(report.conflicts.length){
  try{ask=await asks.actions['human.ask.raise']!(conflictAsk(s,repositoryId,report.conflicts,deadline),context);}
  catch(error){
   // The trunk has already advanced for the clean entries; report the unraised Ask instead of losing that work.
   if(!(error instanceof FoundationError))throw error;
   ask={status:'NOT_RAISED',code:error.code,message:error.message};
  }
 }
 return {...report,repository_id:repositoryId,ask,complete:!report.conflicts.length||(ask as {status?:string}).status==='RAISED',pushed:false};
}

export function createComponent(ctx:ComponentContext):Component{
 const asks=createAskComponent(ctx);
 return bindScope(ctx,{apiVersion:1,actions:{
  'integration.queue.fold':(input,context)=>foldAction(ctx,asks,input,context)
 }});
}
