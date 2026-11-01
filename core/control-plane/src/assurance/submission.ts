import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import type pg from 'pg';
import type {Component,ComponentContext} from '../components/registry.js';
import {FoundationError,object} from '../policy/programme.js';
import {assertInvocation} from '../transport/protocol.js';
import type {InvocationContext} from '../transport/protocol.js';
import type {PrimaryTransaction} from '../storage/transactions.js';
import {assertPrimaryTransaction} from '../storage/transactions.js';
import {createPublicKey,verify} from 'node:crypto';
import {lookupNativeLaunch,lockRun} from '../events/outbox.js';
import {deriveArchiveGitIdentity} from '../preparation/result_source_archive.js';

export type Data=Record<string,any>;
export const INPUT_KEYS=['source','dependency','toolchain','configuration','graph','contract'] as const;
export function fail(code:string,message:string):never{throw new FoundationError(code,message);}
export function canonical(value:unknown):string {
 if(value===null||typeof value!=='object'){const encoded=JSON.stringify(value);if(encoded===undefined)fail('QUALIFICATION_INPUT_INVALID','Undefined JSON value');return encoded;}
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 return '{'+Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
}
export function hash(value:unknown):string{return 'sha256:'+createHash('sha256').update(typeof value==='string'?value:canonical(value)).digest('hex');}
export function fields(input:unknown,required:string[],optional:string[]=[]):Data{
 if(!object(input)||required.some(k=>!Object.hasOwn(input,k))||Object.keys(input).some(k=>!required.includes(k)&&!optional.includes(k)))
 fail('QUALIFICATION_INPUT_INVALID','Operation fields do not match its contract');
 return input;
}
export function uuid(value:unknown):string{
 if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value))
 fail('QUALIFICATION_INPUT_INVALID','Canonical UUID required');return value;
}
export function decimal(value:unknown):string{
 if(typeof value!=='string'||!/^[1-9][0-9]{0,18}$/.test(value)||BigInt(value)>9223372036854775807n)
 fail('QUALIFICATION_INPUT_INVALID','Canonical positive generation required');return value;
}
export function digest(value:unknown):string{
 if(typeof value!=='string'||!/^sha256:[0-9a-f]{64}$/.test(value))fail('QUALIFICATION_INPUT_INVALID','SHA256 digest required');return value;
}
export function invocation(ctx:ComponentContext):Data{
 const value=(ctx as unknown as Data).invocation;
 assertInvocation(value);
 return value;
}
export function roles(ctx:ComponentContext,allowed:string[]):Data{
 const inv=invocation(ctx);
 if(!allowed.includes(inv.principal.role))fail('QUALIFICATION_ROLE_DENIED','Authenticated role is not permitted for this assurance action');
 return inv;
}
export function scope(ctx:ComponentContext,input:Data):[string,string]{
 const principal=invocation(ctx).principal;
 const org=uuid(principal.organisation_id),run=uuid(principal.run_id);
 if(uuid(input.organisation_id)!==org||uuid(input.run_id)!==run)
  fail('QUALIFICATION_SCOPE_DENIED','Request scope differs from its authenticated principal');
 return [org,run];
}
export interface PrimaryClient {query<R extends pg.QueryResultRow=any>(text:string,values?:readonly unknown[]):Promise<pg.QueryResult<R>>}
export async function assuranceBarrier(db:PrimaryClient,s:{organisation_id:string;run_id:string},mode:'SHARED'|'EXCLUSIVE'):Promise<void>{
 try{const name='../storage/transactions.js',module=await import(name) as Data;module.assertPrimaryTransaction(db);}
 catch{fail('QUALIFICATION_PRIMARY_REQUIRED','A live server-owned primary transaction is required');}
 let dispositions:Data;
 try{const source='../storage/dispositions.js';dispositions=await import(source) as Data;}
 catch{fail('QUALIFICATION_SEMANTIC_FENCE_REQUIRED','The actual shared semantic disposition fence is required');}
 const fence=mode==='EXCLUSIVE'?dispositions!.writeSemanticDisposition:dispositions!.readSemanticDisposition;
 if(typeof fence!=='function')fail('QUALIFICATION_SEMANTIC_FENCE_REQUIRED','The actual shared semantic disposition fence is required');
 await fence(db,s);
 await db.query(mode==='EXCLUSIVE'?'SELECT pg_advisory_xact_lock(hashtextextended($1,0))':'SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',[s.organisation_id+':'+s.run_id+':finding-disposition']);
}
export async function transaction<T>(ctx:ComponentContext,operation:(client:PrimaryClient)=>Promise<T>,identityOnly=false,mode:'READ'|'WRITE'='WRITE'):Promise<T>{
 const inv=invocation(ctx),gateway=(ctx as unknown as Data).resources?.gateway;
 if(!gateway||typeof gateway.withPrimaryTransaction!=='function')
  fail('QUALIFICATION_STORAGE_CAPABILITY_REQUIRED','Primary transaction gateway capability is required');
 try{
  return await gateway.withPrimaryTransaction({timeoutMs:30000,maxRetries:0,signal:inv.signal,guard:async(tx:PrimaryClient)=>{await assuranceBarrier(tx,{organisation_id:inv.principal.organisation_id,run_id:inv.principal.run_id},mode==='WRITE'?'EXCLUSIVE':'SHARED');return identityOnly?inv.identityGuard(tx):inv.guard(tx);}},operation) as T;
 }catch(error){
  if(error instanceof FoundationError)throw error;
  const code=object(error)?String(error.code):'';
  if(code==='COMMIT_AMBIGUOUS')fail('QUALIFICATION_OUTCOME_UNKNOWN','Commit outcome must be reconciled by immutable request identity');
  fail(['23505','40001','40P01','55P03','SERIALIZATION_FAILURE'].includes(code)?'QUALIFICATION_CONFLICT':'QUALIFICATION_DATABASE_UNAVAILABLE',
       'Assurance transaction was not accepted');
 }
}
export async function executionGate(ctx:ComponentContext,db:PrimaryClient,s:[string,string],operation:'ADMISSION'|'RENEWAL'|'ADVANCE'|'CLEANUP',options:Data={}):Promise<void>{
 let controls:Data;
 try{controls=(ctx as unknown as Data).dependencies.require('5.1','scheduler.controls.v1',(value:unknown)=>object(value)&&typeof value.assertNoExecutionHold==='function') as Data;}
 catch{fail('QUALIFICATION_EXECUTION_CONTROL_UNAVAILABLE','Actual execution-control authority is required');}
 await controls!.assertNoExecutionHold(db,{organisation_id:s[0],run_id:s[1]},{...options,operation});
}
export async function taskLock(client:PrimaryClient,s:[string,string],taskId:string):Promise<Data>{
 const run=await client.query('SELECT authority_epoch,state,spec_revision_id,spec_generation::text FROM hyperfide.runs WHERE organisation_id=$1 AND id=$2 FOR SHARE',s);
 if(!run.rows[0])fail('QUALIFICATION_NOT_FOUND','Run not found');
 const task=await client.query('SELECT * FROM hyperfide.tasks WHERE organisation_id=$1 AND run_id=$2 AND id=$3 FOR UPDATE',[...s,taskId]);
 if(!task.rows[0])fail('QUALIFICATION_NOT_FOUND','Task not found');
 return {...task.rows[0],run_epoch:run.rows[0].authority_epoch,run_state:run.rows[0].state};
}
export async function loadPolicy(ctx:ComponentContext,task:Data,client:PrimaryClient):Promise<Data>{
 return loadRegisteredPolicy(task,client);
}
async function loadRegisteredPolicy(task:Data,client:PrimaryClient):Promise<Data>{
 let policy:unknown;
 try{
  // Task2.4 owns persisted accepted proof obligations; import absence is an explicit unmet prerequisite.
  const registryPath='../spec/obligations.js';
  const registry=await import(registryPath) as Data;
  const registered=await registry.loadProofObligations(client,{
   organisation_id:task.organisation_id,run_id:task.run_id,task_id:task.id,
   spec_revision_id:task.spec_revision_id,spec_generation:String(task.spec_generation)});
  policy=registered.policy;
  if(registered.registry_digest!==hash(policy))fail('QUALIFICATION_POLICY_INVALID','Persisted proof policy digest differs');
 }catch(error){
  if(error instanceof FoundationError)throw error;
  fail('QUALIFICATION_POLICY_REQUIRED','Accepted persisted proof-obligation registry is unavailable');
 }
 if(!object(policy)||policy.criteria_digest!==task.criteria_digest||policy.spec_revision_id!==task.spec_revision_id||
 String(policy.spec_generation)!==String(task.spec_generation)||!Array.isArray(policy.checks)||!policy.checks.length||
 !Array.isArray(policy.clauses)||!policy.clauses.length||!object(policy.inputs))
 fail('QUALIFICATION_POLICY_INVALID','Qualification policy does not bind the accepted task revision and criteria');
 digest(policy.rubric_digest);
 const ids=new Set<string>(),clauses=new Set<string>();
 for(const rawCheck of policy.checks){
  if(!object(rawCheck))fail('QUALIFICATION_POLICY_INVALID','Registered check object required');
  const check=rawCheck as Data;
  if(typeof check.id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(check.id)||ids.has(check.id)||
    !Array.isArray(check.argv)||!check.argv.length||check.argv.some((v:unknown,index:number)=>typeof v!=='string'||index===0&&!v||typeof v==='string'&&v.includes('\0'))||
    !Number.isInteger(check.timeout_ms)||check.timeout_ms<100||check.timeout_ms>259200000||
    !Array.isArray(check.required_artifacts)||!check.required_artifacts.length||
    check.required_artifacts.some((v:unknown)=>typeof v!=='string'||v.startsWith('/')||v.split('/').some(p=>!p||p==='..'||p==='.')||v.includes('\\'))||
    !Array.isArray(check.input_keys)||!check.input_keys.length||check.input_keys.some((v:unknown)=>!INPUT_KEYS.includes(v as any)))
   fail('QUALIFICATION_POLICY_INVALID','Registered checks require bounded argv, complete artifacts and input dependencies');
  ids.add(check.id);digest(check.executable_digest);
 }
 for(const rawClause of policy.clauses){
  if(!object(rawClause))fail('QUALIFICATION_POLICY_INVALID','Acceptance clause object required');
  const clause=rawClause as Data;
  if(typeof clause.id!=='string'||!clause.id||clauses.has(clause.id)||!['EXECUTABLE','REVIEW'].includes(clause.mode))
   fail('QUALIFICATION_POLICY_INVALID','Acceptance clauses must have distinct explicit proof modes');
  clauses.add(clause.id);
  if(clause.mode==='EXECUTABLE'&&(!Array.isArray(clause.checks)||!clause.checks.length||clause.checks.some((v:unknown)=>!ids.has(String(v)))))
   fail('QUALIFICATION_POLICY_INVALID','Every executable clause needs registered required check coverage');
  if(clause.mode==='REVIEW'&&(!Array.isArray(clause.reviewers)||!clause.reviewers.length))
   fail('QUALIFICATION_POLICY_INVALID','Review judgement requires explicit allowed reviewer identities');
  if(clause.mode==='REVIEW'){digest(clause.rubric_digest);clause.reviewers.forEach(uuid);}
 }
 for(const key of INPUT_KEYS)digest(policy.inputs[key]);
 return JSON.parse(canonical(policy)) as Data;
}
export async function artifact(ctx:ComponentContext,action:string,input:Data):Promise<Data>{
 // The linked artifact capability owns principal, scope, object integrity and PostgreSQL receipts.
 const dependencies=(ctx as unknown as Data).dependencies;
 if(!dependencies||typeof dependencies.require!=='function')
  fail('QUALIFICATION_ARTIFACT_UNAVAILABLE','Linked artifact authority capability is required');
 const store=dependencies.require('15.2','artifact.store.v1',(value:unknown)=>object(value)&&typeof value.invoke==='function') as Data;
 const result=await store.invoke(action,input,ctx) as Data;
 if(result.outcome!=='SUCCEEDED'||result.availability!=='VERIFIED'||result.artifact?.status!=='COMPLETE'||!result.receipt)
  fail('QUALIFICATION_ARTIFACT_INCOMPLETE','Required immutable object is unavailable or incomplete');
 return result;
}
export async function completeArtifact(ctx:ComponentContext,s:[string,string],id:string):Promise<Data>{
 try{return await artifact(ctx,'artifact.object.read',{organisation_id:s[0],run_id:s[1],artifact_id:id});}
 catch(error){
  // A fabricated or foreign object identity is missing evidence, never a qualifying reference.
  if(error instanceof FoundationError&&error.code==='ARTIFACT_NOT_FOUND')fail('QUALIFICATION_ARTIFACT_INCOMPLETE','Required immutable object is unavailable or incomplete');
  throw error;
 }
}
export async function custodyLock(client:PrimaryClient,s:[string,string],id:string):Promise<Data>{
 const initial=await client.query('SELECT task_id FROM hyperfide.submission_custodies WHERE organisation_id=$1 AND run_id=$2 AND id=$3',[...s,id]);
 if(!initial.rows[0])fail('QUALIFICATION_NOT_FOUND','Submission custody not found');
 const task=await taskLock(client,s,initial.rows[0].task_id);
 const result=await client.query('SELECT * FROM hyperfide.submission_custodies WHERE organisation_id=$1 AND run_id=$2 AND id=$3 FOR UPDATE',[...s,id]);
 return {...result.rows[0],task};
}
export function currentCustody(c:Data,generation:string,version?:string):void{
 if(c.authority!=='ACTIVE'||String(c.custody_generation)!==generation||c.task.current_custody_id!==c.id||
 c.authority_epoch!==c.task.run_epoch||(version!==undefined&&String(c.state_version)!==version))
 fail('QUALIFICATION_STALE_CUSTODY','Current coordinator custody generation/version is required');
}
export async function loadPacketInputs(db:PrimaryClient,s:[string,string],packetDigest:string):Promise<Data>{
 digest(packetDigest);
 try{
  const packetModule='../hierarchy/packets.js',reader=await import(packetModule) as Data;
  const loaded=await reader.loadExecutionPacket(db,{organisation_id:s[0],run_id:s[1],digest:packetDigest}) as Data;
  if(loaded.digest!==packetDigest||!loaded.mandatory_digest||!loaded.packet?.mandatory)
   fail('QUALIFICATION_PACKET_INVALID','Actual execution packet identity is incomplete');
  const derived=await reader.deriveQualificationInputs(loaded.packet) as Data;
  for(const key of ['dependency_digest','toolchain_digest','configuration_digest','graph_digest','contract_digest'])digest(derived[key]);
  return {...loaded,derived};
 }catch(error){if(error instanceof FoundationError)throw error;fail('QUALIFICATION_PACKET_REQUIRED','Actual immutable execution packet reader is unavailable');}
}
export function resultInputs(facts:Data,sourceManifestDigest:string,derived:Data):Data{
 return {source:submittedResultSourceDigest({...facts,source_manifest_digest:sourceManifestDigest}),
  dependency:derived.dependency_digest,toolchain:derived.toolchain_digest,configuration:derived.configuration_digest,
  graph:derived.graph_digest,contract:derived.contract_digest};
}
export function submittedResultSourceDigest(result:Data):string{
 const git={repository_id:result.repository_id,source_object_id:result.source_object_id,source_tree_id:result.source_tree_id,
  baseline_source_object_id:result.baseline_source_object_id,source_parent_ids:result.source_parent_ids,source_manifest_digest:result.source_manifest_digest};
 return result.archive_source===undefined?hash(git):hash({schema_version:1,kind:'FLEET_SOURCE_ARCHIVE_RESULT_V1',...git,archive_source:result.archive_source});
}
function acceptedSourceScope(definition:unknown):string[]{
 if(!object(definition))fail('QUALIFICATION_SOURCE_SCOPE','Accepted task has no owned source scope');
 let value:unknown=definition.touches;
 if(value===undefined&&object(definition.section)&&object(definition.section.fields))value=definition.section.fields.touches;
 if(object(value)&&Object.hasOwn(value,'value'))value=value.value;
 if(typeof value==='string'){try{value=JSON.parse(value);}catch{fail('QUALIFICATION_SOURCE_SCOPE','Accepted source scope is not an explicit path list');}}
 if(!Array.isArray(value)||!value.length||value.length>4096||value.some(v=>typeof v!=='string'||!v||v.length>4096||
  v.startsWith('/')||v.includes('\\')||/[\x00-\x1f\x7f]/.test(v)||v.split('/').includes('..')||v.replace(/\/+$/,'').split('/').includes('')||v!=='.'&&v.split('/').includes('.')))
  fail('QUALIFICATION_SOURCE_SCOPE','Accepted task requires safe explicit owned paths');
 return value;
}
function ownedSourcePath(file:string,scopes:string[]):boolean{
 if(!file||file.startsWith('/')||file.includes('\\')||/[\x00-\x1f\x7f]/.test(file)||file.split('/').some(p=>!p||p==='.'||p==='..'))return false;
 return scopes.some(raw=>{
  const pattern=raw.replace(/\/+$/,'');
  if(pattern==='.')return true;
  const wildcard=pattern.search(/[*?\[]/),prefix=(wildcard<0?pattern:pattern.slice(0,pattern.lastIndexOf('/',wildcard)+1)).replace(/\/+$/,'')||'.';
  if(prefix!=='.'&&file!==prefix&&!file.startsWith(prefix+'/'))return false;
  return wildcard<0?(file===pattern||file.startsWith(pattern+'/')):path.matchesGlob(file,pattern);
 });
}
/** Glob matching cannot grant paths beyond the scheduler's reserved ownership prefix. */
export async function submittedGitFacts(ctx:ComponentContext,v:Data,policy:Data,workspace:Data,ownedScope:string[]):Promise<Data>{
 let repositories:Data;
 try{repositories=JSON.parse(ctx.env.HF_QUALIFICATION_REPOSITORIES??'');}catch{fail('QUALIFICATION_SOURCE_UNAVAILABLE','Trusted repository mapping is required');}
 const repository=repositories![v.repository_id];
 if(typeof repository!=='string'||!path.isAbsolute(repository)||policy.repository_id!==v.repository_id)
  fail('QUALIFICATION_SOURCE_UNAVAILABLE','Submission repository is not the accepted trusted repository');
 const run=promisify(execFile),environment={PATH:'/usr/local/bin:/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',
  GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_ALLOW_PROTOCOL:'file',GIT_NO_REPLACE_OBJECTS:'1'};
 try{
  const git=async(args:string[]):Promise<string>=>(await run('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args],
   {cwd:repository,env:environment,timeout:10000,maxBuffer:1024*1024})).stdout.trim();
  if(await git(['cat-file','-t',v.source_object_id])!=='commit')fail('QUALIFICATION_SOURCE_MISMATCH','Submission must name an actual immutable Git commit');
  const tree=await git(['rev-parse',v.source_object_id+'^{tree}']);
  if(await git(['rev-parse','--verify','--end-of-options',workspace.branch_ref+'^{commit}'])!==v.source_object_id)
   fail('QUALIFICATION_SOURCE_MISMATCH','Submitted result is not the measured head of the current attempt workspace');
  await git(['merge-base','--is-ancestor',policy.source_object_id,v.source_object_id]);
  const changed=await run('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','diff','--no-ext-diff','--no-textconv','--no-renames','--name-only','-z','--ignore-submodules=none',policy.source_object_id,v.source_object_id,'--'],
   {cwd:repository,env:environment,timeout:10000,maxBuffer:16*1024*1024,encoding:'buffer'});
  const listing=new TextDecoder('utf-8',{fatal:true}).decode(changed.stdout);
  if(listing&&!listing.endsWith('\0'))fail('QUALIFICATION_SOURCE_SCOPE','Git path inventory is incomplete');
  const paths=listing?listing.slice(0,-1).split('\0'):[];
  if(paths.length>100000||paths.some(file=>!ownedSourcePath(file,ownedScope)))
   fail('QUALIFICATION_SOURCE_SCOPE','Result changes a path outside its accepted owned scope');
  const parents=await git(['show','-s','--format=%P',v.source_object_id]);
  return {repository_id:v.repository_id,source_object_id:v.source_object_id,source_tree_id:tree,baseline_source_object_id:policy.source_object_id,
   source_parent_ids:parents?parents.split(' '):[],owned_scope_digest:hash(ownedScope),changed_paths_digest:hash(paths),changed_path_count:paths.length};
 }catch(error){if(error instanceof FoundationError)throw error;fail('QUALIFICATION_SOURCE_MISMATCH','Result commit does not have the accepted Git baseline ancestry');}
}
/* Snapshots as the unit of record (hyperfide-v21 6.2). The worker never commits: native
 * checkpoint.snapshot writes the slice workspace as a tree object plus an HFSN0001 checkpoint,
 * and the row below is what a worker result names. The base is the slice manifest's commit,
 * never a caller claim. */
export interface SnapshotNative {binary:string;allowed_root:string;spool_root:string;timeout_ms?:number}
const OID=/^([0-9a-f]{40}|[0-9a-f]{64})$/;
function snapshotCount(value:unknown):number{
 if(!Number.isSafeInteger(value)||(value as number)<0)fail('SOURCE_SNAPSHOT_INVALID','Native snapshot statistics are malformed');
 return value as number;
}
export async function snapshotBinding(db:PrimaryClient,v:Data):Promise<Data>{
 const s=[v.organisation_id,v.run_id];
 const attempt=await db.query('SELECT a.id FROM hyperfide.attempts a WHERE a.organisation_id=$1 AND a.run_id=$2 AND a.task_id=$3 AND a.id=$4 AND a.generation=$5',[...s,v.task_id,v.attempt_id,v.attempt_generation]);
 if(!attempt.rows[0])fail('SOURCE_SNAPSHOT_ATTEMPT_UNKNOWN','Snapshot attempt is not the named task attempt generation');
 const slice=await db.query('SELECT repository_id,commit FROM hyperfide.workspace_slice_manifests WHERE organisation_id=$1 AND run_id=$2 AND digest=$3',[...s,v.slice_digest]);
 if(!slice.rows[0])fail('SOURCE_SNAPSHOT_SLICE_UNKNOWN','Snapshot slice manifest is not recorded for this run');
 if(slice.rows[0].repository_id!==v.repository_id)fail('SOURCE_SNAPSHOT_SLICE_MISMATCH','Snapshot slice belongs to another repository');
 return {base_commit:slice.rows[0].commit};
}
export async function nativeSnapshot(native:SnapshotNative,request:Data):Promise<Data>{
 const run=promisify(execFile),encoded=Buffer.from(JSON.stringify(request)).toString('base64url');
 let stdout:string;
 try{({stdout}=await run(native.binary,['--component','15.1','--action','checkpoint.snapshot','--request-base64',encoded],
  {env:{PATH:'/usr/bin:/bin',LANG:'C',HF_CHECKPOINT_ALLOWED_ROOT:native.allowed_root,HF_CHECKPOINT_SPOOL_ROOT:native.spool_root},
   timeout:native.timeout_ms??120000,maxBuffer:1024*1024}));}
 catch{fail('SOURCE_SNAPSHOT_UNAVAILABLE','Native snapshot capture did not complete');}
 let envelope:Data;
 try{envelope=JSON.parse(stdout!) as Data;}catch{fail('SOURCE_SNAPSHOT_INVALID','Native snapshot result is not JSON');}
 const r=envelope!.ok===true&&object(envelope!.result)?envelope!.result as Data:fail('SOURCE_SNAPSHOT_UNAVAILABLE','Native snapshot dispatch failed');
 if(r.capture_state==='REFUSED')fail('SOURCE_SNAPSHOT_REFUSED','Native snapshot refused: '+String(r.code));
 const c=r.checkpoint,d=r.diff;
 if(r.capture_state!=='SNAPSHOT_COMPLETE'||r.authority!=='NONE'||r.base_commit!==request.base_commit||r.slice_digest!==request.slice_digest||
  !OID.test(String(r.base_tree_id))||!OID.test(String(r.result_tree_id))||!object(c)||!object(d)||c.format!=='HFSN0001')
  fail('SOURCE_SNAPSHOT_INVALID','Native snapshot result does not bind the requested base and slice');
 digest(c.checkpoint_digest);digest(c.metadata_digest);
 if(typeof c.size_bytes!=='string'||!/^[1-9][0-9]{0,15}$/.test(c.size_bytes))fail('SOURCE_SNAPSHOT_INVALID','Checkpoint size is malformed');
 const diff={files_changed:snapshotCount(d.files_changed),insertions:snapshotCount(d.insertions),deletions:snapshotCount(d.deletions),binary_files:snapshotCount(d.binary_files)};
 if((r.base_tree_id===r.result_tree_id)!==(diff.files_changed===0)||diff.binary_files>diff.files_changed)fail('SOURCE_SNAPSHOT_INVALID','Snapshot statistics contradict its trees');
 return {base_tree_id:r.base_tree_id,result_tree_id:r.result_tree_id,diff,
  receipt:{format:'HFSN0001',checkpoint_digest:c.checkpoint_digest,metadata_digest:c.metadata_digest,size_bytes:c.size_bytes,object_count:snapshotCount(c.object_count),durability:r.durability,authority:'NONE'}};
}
export async function recordSourceSnapshot(db:PrimaryClient,v:Data,base:Data,captured:Data):Promise<Data>{
 const id=randomUUID(),d=captured.diff;
 await db.query('INSERT INTO hyperfide.source_snapshots(organisation_id,run_id,id,task_id,attempt_id,attempt_generation,repository_id,base_commit,base_tree,result_tree,slice_digest,checkpoint_digest,checkpoint_receipt,files_changed,insertions,deletions,binary_files,created_by_credential_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) ON CONFLICT(organisation_id,run_id,attempt_id,checkpoint_digest) DO NOTHING',
  [v.organisation_id,v.run_id,id,v.task_id,v.attempt_id,v.attempt_generation,v.repository_id,base.base_commit,captured.base_tree_id,captured.result_tree_id,v.slice_digest,captured.receipt.checkpoint_digest,captured.receipt,d.files_changed,d.insertions,d.deletions,d.binary_files,v.credential_id]);
 const row=await db.query('SELECT id,task_id,attempt_id,attempt_generation::text,repository_id,base_commit,base_tree,result_tree,slice_digest,checkpoint_digest,checkpoint_receipt,files_changed::int,insertions::int,deletions::int,binary_files::int FROM hyperfide.source_snapshots WHERE organisation_id=$1 AND run_id=$2 AND attempt_id=$3 AND checkpoint_digest=$4',
  [v.organisation_id,v.run_id,v.attempt_id,captured.receipt.checkpoint_digest]);
 const r=row.rows[0];
 if(!r||r.task_id!==v.task_id||r.result_tree!==captured.result_tree_id||r.slice_digest!==v.slice_digest)fail('SOURCE_SNAPSHOT_CONFLICT','Recorded snapshot identity differs from this capture');
 return {snapshot_id:r.id,replayed:r.id!==id,...r};
}
function snapshotRequest(raw:unknown):Data{
 const v=fields(raw,['organisation_id','run_id','task_id','attempt_id','attempt_generation','repository_id','slice_digest','candidate_path','credential_id']);
 ['organisation_id','run_id','task_id','attempt_id','repository_id','credential_id'].forEach(k=>uuid(v[k]));decimal(v.attempt_generation);digest(v.slice_digest);
 if(typeof v.candidate_path!=='string'||!v.candidate_path||v.candidate_path.startsWith('/')||v.candidate_path.split('/').some((p:string)=>!p||p==='.'||p==='..'))
  fail('QUALIFICATION_INPUT_INVALID','Candidate path must be relative to the trusted snapshot root');
 return v;
}
/** Capture outside any transaction: native work holds no database lock. */
export async function captureSourceSnapshot(db:PrimaryClient,native:SnapshotNative,raw:unknown):Promise<Data>{
 const v=snapshotRequest(raw),base=await snapshotBinding(db,v);
 const captured=await nativeSnapshot(native,{candidate_path:v.candidate_path,organisation_id:v.organisation_id,run_id:v.run_id,repository_id:v.repository_id,
  task_id:v.task_id,attempt_id:v.attempt_id,base_commit:base.base_commit,slice_digest:v.slice_digest});
 return recordSourceSnapshot(db,v,base,captured);
}
/** A worker result naming a snapshot must name one of its own attempt whose tree is the submitted tree. */
export async function bindSubmittedSnapshot(db:PrimaryClient,s:[string,string],v:Data,sourceTreeId:string):Promise<Data>{
 const row=await db.query('SELECT id,task_id,attempt_id,attempt_generation::text,repository_id,result_tree,slice_digest,checkpoint_digest FROM hyperfide.source_snapshots WHERE organisation_id=$1 AND run_id=$2 AND id=$3',[...s,uuid(v.snapshot_id)]);
 const r=row.rows[0];
 if(!r||r.task_id!==v.task_id||r.attempt_id!==v.attempt_id||r.attempt_generation!==String(v.attempt_generation)||r.repository_id!==v.repository_id)
  fail('QUALIFICATION_SNAPSHOT_MISMATCH','Result snapshot is not a capture of the submitting attempt');
 if(r.result_tree!==sourceTreeId)fail('QUALIFICATION_SNAPSHOT_MISMATCH','Result snapshot tree differs from the submitted source tree');
 return {snapshot_id:r.id,snapshot_tree_id:r.result_tree,snapshot_slice_digest:r.slice_digest,snapshot_checkpoint_digest:r.checkpoint_digest};
}
async function snapshotAction(ctx:ComponentContext,raw:unknown):Promise<Data>{
 const inv=roles(ctx,['WORKER']);
 const v=snapshotRequest({...fields(raw,['organisation_id','run_id','task_id','attempt_id','attempt_generation','repository_id','slice_digest','candidate_path']),credential_id:inv.principal.credential_id}),s=scope(ctx,v);
 if(inv.principal.attempt_id!==v.attempt_id||String(inv.principal.attempt_generation)!==String(v.attempt_generation))
  fail('QUALIFICATION_STALE_COMPUTE','Snapshot request differs from its authenticated worker identity');
 const env=ctx.env as Data,native={binary:env.HF_SNAPSHOT_NATIVE_BINARY,allowed_root:env.HF_CHECKPOINT_ALLOWED_ROOT,spool_root:env.HF_CHECKPOINT_SPOOL_ROOT};
 if(![native.binary,native.allowed_root,native.spool_root].every(p=>typeof p==='string'&&path.isAbsolute(p)))
  fail('SOURCE_SNAPSHOT_UNAVAILABLE','Trusted native snapshot binary and roots are required');
 const base=await transaction(ctx,db=>snapshotBinding(db,{...v,organisation_id:s[0],run_id:s[1]}),false,'READ');
 const captured=await nativeSnapshot(native,{candidate_path:v.candidate_path,organisation_id:s[0],run_id:s[1],repository_id:v.repository_id,
  task_id:v.task_id,attempt_id:v.attempt_id,base_commit:base.base_commit,slice_digest:v.slice_digest});
 return transaction(ctx,db=>recordSourceSnapshot(db,v,base,captured));
}
const STALE_COMPUTE_CODES=new Set(['STALE_COMPUTE','COMPUTE_LEASE_EXPIRED','STALE_SANDBOX_BOOT','STALE_AUTHORITY_EPOCH','COMPUTE_ALLOCATION_INVALID','ACTIVE_SUBMISSION_CUSTODY']);
async function submit(ctx:ComponentContext,raw:unknown):Promise<Data>{
 const v=fields(raw,['organisation_id','run_id','task_id','request_id','attempt_id','attempt_generation','authority_epoch',
 'sandbox_id','slot_id','sandbox_boot_generation','repository_id','source_object_id','source_manifest_artifact_id','evidence_manifest_artifact_id','criteria_digest','contract_digests'],['snapshot_id']);
 const inv=roles(ctx,['WORKER']),s=scope(ctx,v);
 if(v.request_id!==inv.operation.idempotency_key)fail('QUALIFICATION_IDEMPOTENCY_CONFLICT','Submission request must match authenticated idempotency identity');
 if(inv.principal.attempt_id!==v.attempt_id||inv.principal.attempt_generation!==v.attempt_generation||
 inv.principal.sandbox_id!==v.sandbox_id||inv.principal.boot_generation!==v.sandbox_boot_generation)
 fail('QUALIFICATION_STALE_COMPUTE','Submission token differs from its authenticated worker identity');
 ['task_id','request_id','attempt_id','authority_epoch','sandbox_id','slot_id','repository_id','source_manifest_artifact_id','evidence_manifest_artifact_id'].forEach(k=>uuid(v[k]));
 decimal(v.attempt_generation);decimal(v.sandbox_boot_generation);digest(v.criteria_digest);
 if(v.snapshot_id!==undefined)uuid(v.snapshot_id);
 if(typeof v.source_object_id!=='string'||!/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(v.source_object_id)||
 !Array.isArray(v.contract_digests)||v.contract_digests.some((d:unknown)=>typeof d!=='string'||!/^sha256:[0-9a-f]{64}$/.test(d))||
 new Set(v.contract_digests).size!==v.contract_digests.length)fail('QUALIFICATION_INPUT_INVALID','Immutable source and contract identities required');
 const requestDigest=hash(v);
 // Lost-response replay precedes compute and object checks: released compute never erases admitted custody.
 const prior=await transaction(ctx,db=>db.query('SELECT request_digest,custody_id FROM hyperfide.assurance_submissions WHERE organisation_id=$1 AND run_id=$2 AND request_id=$3',[...s,v.request_id]),true,'READ');
 if(prior.rows[0]){
  if(prior.rows[0].request_digest!==requestDigest)fail('QUALIFICATION_IDEMPOTENCY_CONFLICT','Request identity already binds different submission bytes');
  const c=await transaction(ctx,db=>db.query('SELECT id,custody_generation::text,authority,qualification_outcome FROM hyperfide.submission_custodies WHERE organisation_id=$1 AND run_id=$2 AND id=$3',[...s,prior.rows[0].custody_id]),true,'READ');
  return {submission:c.rows[0],replayed:true,qualification:'PENDING_OR_RECORDED'};
 }
 try{
 const source=await completeArtifact(ctx,s,v.source_manifest_artifact_id),evidence=await completeArtifact(ctx,s,v.evidence_manifest_artifact_id);
 let sourceManifest:Data,evidenceManifest:Data;
 try{sourceManifest=JSON.parse(Buffer.from(source.data_base64,'base64').toString('utf8')) as Data;
 evidenceManifest=JSON.parse(Buffer.from(evidence.data_base64,'base64').toString('utf8')) as Data;}
 catch{fail('QUALIFICATION_MANIFEST_INVALID','Submission artifacts must contain complete JSON manifests');}
 if(!object(sourceManifest)||sourceManifest.repository_id!==v.repository_id||sourceManifest.source_object_id!==v.source_object_id||
 !object(evidenceManifest)||evidenceManifest.source_object_id!==v.source_object_id||evidenceManifest.criteria_digest!==v.criteria_digest||
 !Array.isArray(evidenceManifest.artifact_ids)||!evidenceManifest.artifact_ids.length)
 fail('QUALIFICATION_MANIFEST_INVALID','Submission manifests do not bind source, criteria and evidence objects');
 for(const id of evidenceManifest.artifact_ids){uuid(id);await completeArtifact(ctx,s,id);}
 uuid(sourceManifest.workspace_id);
 const preflight=await transaction(ctx,async client=>{
  const task=await taskLock(client,s,v.task_id),policy=await loadPolicy(ctx,task,client);
  const workspace=await client.query('SELECT id,branch_ref,base_commit,state_version::text FROM hyperfide.workspaces WHERE organisation_id=$1 AND run_id=$2 AND id=$3 AND repository_id=$4 AND attempt_id=$5 AND attempt_generation=$6 AND sandbox_id=$7 AND slot_id=$8 AND sandbox_boot_generation=$9 AND writable=true FOR SHARE',
   [...s,sourceManifest.workspace_id,v.repository_id,v.attempt_id,v.attempt_generation,v.sandbox_id,v.slot_id,v.sandbox_boot_generation]);
  if(!workspace.rows[0]||workspace.rows[0].base_commit!==policy.source_object_id)
   fail('QUALIFICATION_SOURCE_MISMATCH','Result workspace is not owned by the current attempt and accepted baseline');
  return {policy,workspace:workspace.rows[0],owned_scope:acceptedSourceScope(task.definition)};
 });
 const acceptedPolicy=preflight.policy,gitFacts=await submittedGitFacts(ctx,v,acceptedPolicy,preflight.workspace,preflight.owned_scope);
 return await transaction(ctx,async client=>{
  const task=await taskLock(client,s,v.task_id);
  const old=await client.query('SELECT request_digest,custody_id FROM hyperfide.assurance_submissions WHERE organisation_id=$1 AND run_id=$2 AND request_id=$3',[...s,v.request_id]);
  if(old.rows[0]){
   if(old.rows[0].request_digest!==requestDigest)fail('QUALIFICATION_IDEMPOTENCY_CONFLICT','Request identity already binds different submission bytes');
   return {submission:{id:old.rows[0].custody_id},replayed:true,qualification:'PENDING_OR_RECORDED'};
  }
  await inv.guard(client);
  const policy=await loadPolicy(ctx,task,client);
  if(hash(policy)!==hash(acceptedPolicy))fail('QUALIFICATION_INPUT_STALE','Accepted proof policy changed during submission preflight');
  if(policy.repository_id!==v.repository_id||task.criteria_digest!==v.criteria_digest||canonical(policy.contract_digests??[])!==canonical(v.contract_digests)||
 task.current_attempt_id!==v.attempt_id||String(task.generation)!==v.attempt_generation||task.current_custody_id||
 task.run_epoch!==v.authority_epoch)
   fail('QUALIFICATION_STALE_COMPUTE','Submission is not from the current task compute generation');
  let compute:Data;
  try{const leaseModule='../scheduler/leases.js';compute=await import(leaseModule) as Data;}
  catch{fail('QUALIFICATION_COMPUTE_CAPABILITY_REQUIRED','Actual scheduler compute authority module required');}
  const token={organisation_id:s[0],run_id:s[1],task_id:v.task_id,attempt_id:v.attempt_id,attempt_generation:v.attempt_generation,
   authority_epoch:v.authority_epoch,sandbox_id:v.sandbox_id,slot_id:v.slot_id,sandbox_boot_generation:v.sandbox_boot_generation};
  let computeIdentity:Data;
  try{computeIdentity=await compute!.assertCurrentCompute(client,token);}
  catch(error){
   // Expired, superseded or reallocated compute is one stale-generation outcome for the submitting worker.
   if(error instanceof FoundationError&&STALE_COMPUTE_CODES.has(error.code))fail('QUALIFICATION_STALE_COMPUTE','Current primary-clock compute authority is required');
   throw error;
  }
  const packet=await loadPacketInputs(client,s,computeIdentity.input_packet_digest);
  const packetIdentity=packet.packet.mandatory.identity;
  if(packetIdentity.organisation_id!==s[0]||packetIdentity.run_id!==s[1]||packetIdentity.task_id!==v.task_id||packetIdentity.attempt_id!==v.attempt_id||String(packetIdentity.attempt_generation)!==v.attempt_generation||
   packetIdentity.spec_revision_id!==task.spec_revision_id||String(packetIdentity.spec_generation)!==String(task.spec_generation)||
   packetIdentity.criteria_digest!==task.criteria_digest||packetIdentity.authority_epoch!==task.run_epoch||packet.packet.mandatory.intent.registry_digest!==hash(policy))
   fail('QUALIFICATION_PACKET_INVALID','Execution packet does not bind the submitting attempt');
  if(hash(packet.packet.mandatory.intent.owned_scope)!==gitFacts.owned_scope_digest||hash(acceptedSourceScope(task.definition))!==gitFacts.owned_scope_digest)
   fail('QUALIFICATION_SOURCE_SCOPE','Accepted source ownership changed before custody admission');
  const runtimeInputs=resultInputs(gitFacts,source.artifact.digest,packet.derived);
  const current=await client.query("SELECT a.*,a.lease_expires_at>clock_timestamp() AS alive FROM hyperfide.attempts a WHERE organisation_id=$1 AND run_id=$2 AND id=$3 FOR UPDATE",[...s,v.attempt_id]);
  const attempt=current.rows[0];
  if(!attempt||attempt.compute_authority!=='CURRENT'||!attempt.alive||attempt.authority_epoch!==v.authority_epoch||
   String(attempt.generation)!==v.attempt_generation||attempt.sandbox_id!==v.sandbox_id||
   String(attempt.sandbox_boot_generation)!==v.sandbox_boot_generation)
   fail('QUALIFICATION_STALE_COMPUTE','Current primary-clock compute authority is required');
  const leases=await client.query("SELECT id FROM hyperfide.compute_leases WHERE organisation_id=$1 AND run_id=$2 AND attempt_id=$3 AND attempt_generation=$4 AND authority_epoch=$5 AND sandbox_boot_generation=$6 AND state='ACTIVE' AND expires_at>clock_timestamp() FOR UPDATE",
   [...s,v.attempt_id,v.attempt_generation,v.authority_epoch,v.sandbox_boot_generation]);
  if(leases.rowCount!==1)fail('QUALIFICATION_STALE_COMPUTE','Active primary-clock worker lease is required');
  for(const id of [v.source_manifest_artifact_id,v.evidence_manifest_artifact_id,...(evidenceManifest.artifact_ids as string[])])
   await client.query('SELECT hyperfide.require_complete_artifact($1,$2,$3)',[...s,id]);
  const workspace=await client.query('SELECT id,branch_ref,base_commit,state_version::text FROM hyperfide.workspaces WHERE organisation_id=$1 AND run_id=$2 AND id=$3 AND repository_id=$4 AND attempt_id=$5 AND attempt_generation=$6 AND sandbox_id=$7 AND slot_id=$8 AND sandbox_boot_generation=$9 AND writable=true FOR SHARE',
   [...s,sourceManifest.workspace_id,v.repository_id,v.attempt_id,v.attempt_generation,v.sandbox_id,v.slot_id,v.sandbox_boot_generation]);
  if(!workspace.rows[0]||workspace.rows[0].branch_ref!==preflight.workspace.branch_ref||
   workspace.rows[0].base_commit!==preflight.workspace.base_commit||workspace.rows[0].state_version!==preflight.workspace.state_version)
   fail('QUALIFICATION_SOURCE_MISMATCH','Attributable workspace changed before admission');
  const snapshot=v.snapshot_id===undefined?{}:await bindSubmittedSnapshot(client,s,v,gitFacts.source_tree_id);
  // Register only the actual independently read Git result; the accepted repository baseline remains unchanged.
  for(const [objectId,objectType] of [[v.source_object_id,'commit'],[gitFacts.source_tree_id,'tree']]){
   await client.query('INSERT INTO hyperfide.source_objects(organisation_id,repository_id,object_id,object_type) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[s[0],v.repository_id,objectId,objectType]);
   const registered=await client.query('SELECT object_type FROM hyperfide.source_objects WHERE organisation_id=$1 AND repository_id=$2 AND object_id=$3',[s[0],v.repository_id,objectId]);
   if(registered.rows[0]?.object_type!==objectType)fail('QUALIFICATION_SOURCE_MISMATCH','Actual result Git object metadata conflicts');
  }
  await compute!.releaseCompute(client,token,{execution_state:'SUBMITTED'});
  const gen=await client.query('SELECT (coalesce(max(custody_generation),0)+1)::text AS generation FROM hyperfide.submission_custodies WHERE organisation_id=$1 AND run_id=$2 AND task_id=$3',[...s,v.task_id]);
  const custody=randomUUID(),job=randomUUID();
  await client.query("INSERT INTO hyperfide.submission_custodies(organisation_id,run_id,id,task_id,source_attempt_id,source_generation,custody_generation,authority_epoch,repository_id,source_object_id,source_manifest_digest,evidence_manifest_digest,criteria_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
   [...s,custody,v.task_id,v.attempt_id,v.attempt_generation,gen.rows[0].generation,v.authority_epoch,v.repository_id,v.source_object_id,source.artifact.digest,evidence.artifact.digest,v.criteria_digest]);
  await client.query("INSERT INTO hyperfide.assurance_submissions(organisation_id,run_id,custody_id,request_id,request_digest,manifest,policy,source_artifact_id,evidence_artifact_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
   [...s,custody,v.request_id,requestDigest,{...v,...gitFacts,...snapshot,evidence_artifact_ids:[...new Set(evidenceManifest.artifact_ids as string[])].sort(),workspace_id:sourceManifest.workspace_id,source_manifest_digest:source.artifact.digest,registry_digest:hash(policy),input_packet_digest:computeIdentity.input_packet_digest,mandatory_digest:packet.mandatory_digest,input_manifest:runtimeInputs,graph_manifest_digest:packet.derived.graph_manifest_digest,graph_status:packet.derived.graph_status},policy,v.source_manifest_artifact_id,v.evidence_manifest_artifact_id]);
  await client.query("INSERT INTO hyperfide.qualification_jobs(organisation_id,run_id,id,custody_id,custody_generation,rubric_digest) VALUES($1,$2,$3,$4,$5,$6)",[...s,job,custody,gen.rows[0].generation,policy.rubric_digest]);
  await client.query("INSERT INTO hyperfide.assurance_applicability(organisation_id,run_id,custody_id,input_manifest) VALUES($1,$2,$3,$4)",[...s,custody,runtimeInputs]);
  await client.query("UPDATE hyperfide.tasks SET current_custody_id=$4,state='SUBMITTED',state_version=state_version+1 WHERE organisation_id=$1 AND run_id=$2 AND id=$3",[...s,v.task_id,custody]);
  return {submission:{id:custody,custody_generation:gen.rows[0].generation,authority:'ACTIVE',qualification_outcome:'PENDING'},job_id:job,replayed:false,qualification:'PENDING'};
 },true);
 }catch(error){
  // A concurrent identical submit may release compute while this request is reading its artifacts.
  // Reconcile the committed immutable identity before reporting a preflight/lease failure.
  const replay=await transaction(ctx,db=>db.query(
   'SELECT s.request_digest,c.id,c.custody_generation::text,c.authority,c.qualification_outcome,j.id AS job_id FROM hyperfide.assurance_submissions s JOIN hyperfide.submission_custodies c ON c.organisation_id=s.organisation_id AND c.run_id=s.run_id AND c.id=s.custody_id LEFT JOIN hyperfide.qualification_jobs j ON j.organisation_id=c.organisation_id AND j.run_id=c.run_id AND j.custody_id=c.id WHERE s.organisation_id=$1 AND s.run_id=$2 AND s.request_id=$3 ORDER BY j.created_at LIMIT 1',[...s,v.request_id]),true,'READ');
  if(!replay.rows[0])throw error;
  const row=replay.rows[0];
  if(row.request_digest!==requestDigest)fail('QUALIFICATION_IDEMPOTENCY_CONFLICT','Request identity already binds different submission bytes');
  return {submission:{id:row.id,custody_generation:row.custody_generation,authority:row.authority,qualification_outcome:row.qualification_outcome},job_id:row.job_id,replayed:true,qualification:'PENDING_OR_RECORDED'};
 }
}
async function revoke(ctx:ComponentContext,raw:unknown):Promise<Data>{
 const v=fields(raw,['organisation_id','run_id','submission_id','custody_generation','expected_state_version','reason']);
 roles(ctx,['COORDINATOR','OPERATOR']);
 const s=scope(ctx,v),id=uuid(v.submission_id),generation=decimal(v.custody_generation),version=decimal(v.expected_state_version);
 if(typeof v.reason!=='string'||!v.reason.trim()||v.reason.length>2048)fail('QUALIFICATION_INPUT_INVALID','Explicit custody disposition reason required');
 return transaction(ctx,async client=>{
  const c=await custodyLock(client,s,id);currentCustody(c,generation,version);
  await executionGate(ctx,client,s,'CLEANUP');
  await revokeCustodies(client,{organisation_id:s[0],run_id:s[1]},[id],{actor_id:invocation(ctx).principal.actor_id,reason:v.reason});
  return {submission_id:id,authority:'REVOKED',state_version:(BigInt(version)+1n).toString()};
 });
}
/** STOP/CANCEL callers retain their guarded transaction and reconcile publication effects separately. */
export async function revokeCustodies(db:PrimaryClient,s:{organisation_id:string;run_id:string},submissionIds:string[],
 disposition:{actor_id:string;reason:string}):Promise<Data>{
 uuid(disposition.actor_id);
 if(!disposition.reason.trim()||disposition.reason.length>2048)fail('QUALIFICATION_INPUT_INVALID','Explicit custody disposition reason required');
 await assuranceBarrier(db,s,'EXCLUSIVE');
 const revoked:string[]=[];
 for(const id of [...new Set(submissionIds)].sort()){
  const c=await custodyLock(db,[s.organisation_id,s.run_id],uuid(id));
  if(c.authority!=='ACTIVE')continue;
  await db.query("INSERT INTO hyperfide.assurance_dispositions(organisation_id,run_id,custody_id,custody_generation,actor_id,reason,disposition) VALUES($1,$2,$3,$4,$5,$6,'REVOKED')",
   [s.organisation_id,s.run_id,id,String(c.custody_generation),disposition.actor_id,disposition.reason]);
  await db.query("UPDATE hyperfide.submission_custodies SET authority='REVOKED',state_version=state_version+1 WHERE organisation_id=$1 AND run_id=$2 AND id=$3",[s.organisation_id,s.run_id,id]);
  await db.query("UPDATE hyperfide.assurance_applicability SET applicability='STALE',reasons=$4::jsonb,state_version=state_version+1 WHERE organisation_id=$1 AND run_id=$2 AND custody_id=$3",
   [s.organisation_id,s.run_id,id,JSON.stringify([{kind:'CUSTODY_REVOKED',reason:disposition.reason}])]);
  await db.query("UPDATE hyperfide.tasks SET current_custody_id=NULL,state='STALE',state_version=state_version+1 WHERE organisation_id=$1 AND run_id=$2 AND id=$3 AND current_custody_id=$4",
   [s.organisation_id,s.run_id,c.task_id,id]);
  await fenceQualificationJobs(db,s,[id],disposition.reason);revoked.push(id);
 }
 return {revoked_custody_ids:revoked,released_publication_custody_changed:false,history_preserved:true};
}
export async function fenceQualificationJobs(db:PrimaryClient,s:{organisation_id:string;run_id:string},
 submissionIds:string[],reason:string):Promise<Data>{
 if(!reason.trim()||reason.length>2048)fail('QUALIFICATION_INPUT_INVALID','Explicit qualification-fence reason required');
 await assuranceBarrier(db,s,'EXCLUSIVE');
 const fenced:string[]=[];
 for(const id of [...new Set(submissionIds)].sort()){
  uuid(id);
  const custody=await custodyLock(db,[s.organisation_id,s.run_id],id);
  const jobs=await db.query("UPDATE hyperfide.qualification_jobs SET state='CANCELLED',lease_generation=lease_generation+1,"
   +"lease_owner=NULL,lease_expires_at=NULL,state_version=state_version+1 WHERE organisation_id=$1 AND run_id=$2 AND custody_id=$3 "
   +"AND state IN ('PENDING','RUNNING') RETURNING id",[s.organisation_id,s.run_id,custody.id]);
  fenced.push(...jobs.rows.map(row=>row.id));
 }
 return {fenced_job_ids:fenced,custody_changed:false,history_preserved:true};
}
export interface ClosedArchiveSelection{task_id:string;attempt_id:string;attempt_generation:string;session_id:string;launch_id:string;command_id:string;quiescence_operation_id:string;custody_id:string}
/** Closure authorizes preservation and qualification only; it grants no execution lease. */
export async function prepareClosedArchiveCustody(tx:PrimaryTransaction,i:InvocationContext,selection:ClosedArchiveSelection):Promise<Data>{
 assertPrimaryTransaction(tx);assertInvocation(i);await i.guard(tx);
 if(!['OPERATOR','COORDINATOR'].includes(i.principal.role))fail('QUALIFICATION_ROLE_DENIED','Mechanical archive admission authority required');
 const v=fields(selection,['task_id','attempt_id','attempt_generation','session_id','launch_id','command_id','quiescence_operation_id','custody_id']);
 for(const key of ['task_id','attempt_id','session_id','launch_id','command_id','quiescence_operation_id','custody_id'])uuid(v[key]);decimal(v.attempt_generation);
 const s:[string,string]=[i.principal.organisation_id,i.principal.run_id];await assuranceBarrier(tx,{organisation_id:s[0],run_id:s[1]},'EXCLUSIVE');
 await lockRun(tx,{organisation_id:s[0],run_id:s[1]});const task=await taskLock(tx,s,v.task_id),policy=await loadRegisteredPolicy(task,tx);
 const attempt=(await tx.query('SELECT *,generation::text,sandbox_boot_generation::text FROM hyperfide.attempts WHERE organisation_id=$1 AND run_id=$2 AND id=$3 FOR UPDATE',[...s,v.attempt_id])).rows[0];
 if(!attempt||attempt.task_id!==task.id||attempt.generation!==v.attempt_generation||task.current_attempt_id!==attempt.id||String(task.generation)!==attempt.generation||task.run_epoch!==i.principal.deployment_epoch||attempt.authority_epoch!==task.run_epoch||!['CURRENT','RELEASED','REVOKED'].includes(attempt.compute_authority)||task.current_custody_id&&task.current_custody_id!==v.custody_id||['CANCELLED','SUPERSEDED'].includes(task.state))fail('QUALIFICATION_ARCHIVE_STALE','Closed result must retain the accepted current task, attempt, generation and authority');
 const launch=(await tx.query('SELECT * FROM hyperfide.native_launch_plans WHERE organisation_id=$1 AND run_id=$2 AND launch_id=$3 FOR SHARE',[...s,v.launch_id])).rows[0];
 if(!launch||launch.agent_session_id!==v.session_id||launch.attempt_id!==attempt.id||String(launch.attempt_generation)!==attempt.generation||launch.slot_id!==attempt.slot_id)fail('QUALIFICATION_ARCHIVE_CLOSURE','Original committed coding launch required');
 const observed=await lookupNativeLaunch(tx,{organisation_id:s[0],run_id:s[1],launch_id:v.launch_id},i) as Data|null;
 const process=observed?.runner_ack?.pinned_process??observed?.runner_ack?.observed_process;
 if(!observed||observed.command_id!==launch.command_id||observed.agent_session_id!==v.session_id||observed.attempt_id!==attempt.id||!object(process))fail('QUALIFICATION_ARCHIVE_CLOSURE','Actual retained native process and kernel boot identity required');uuid(process.os_boot_id);
 const fleet=(await tx.query(`SELECT f.*,p.role AS executor_role,p.public_key_b64 FROM hyperfide.fleet_worker_launches f JOIN hyperfide.identity_principals p ON p.credential_id=f.executor_credential_id WHERE f.organisation_id=$1 AND f.run_id=$2 AND f.launch_id=$3 FOR SHARE OF f,p`,[...s,v.launch_id])).rows[0];
 if(!fleet||fleet.state!=='COMPLETED'||fleet.executor_role!=='PROVISIONER'||!object(fleet.result)||hash(fleet.result)!==fleet.result_digest||fleet.result.launch_id!==v.launch_id||fleet.result.command_id!==launch.command_id||!object(fleet.result.native)||fleet.result.native.terminal_observed!==true||fleet.result.native.foreground_owner!==true||typeof fleet.result_signature!=='string'||typeof fleet.public_key_b64!=='string')fail('QUALIFICATION_ARCHIVE_CLOSURE','Signed completed physical coding execution required');
 const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(fleet.public_key_b64,'base64url')]),format:'der',type:'spki'});
 if(!verify(null,Buffer.from(canonical(fleet.result)),key,Buffer.from(fleet.result_signature,'base64url')))fail('QUALIFICATION_ARCHIVE_CLOSURE','Coding execution signature differs');
 const command=(await tx.query('SELECT * FROM hyperfide.runner_control_commands WHERE organisation_id=$1 AND run_id=$2 AND command_id=$3 FOR SHARE',[...s,v.command_id])).rows[0];
 const latest=(await tx.query('SELECT max(fence_sequence)::text AS fence FROM hyperfide.runner_control_commands WHERE organisation_id=$1 AND run_id=$2 AND launch_id=$3',[...s,v.launch_id])).rows[0];
 if(!command||command.launch_id!==v.launch_id||command.attempt_id!==attempt.id||String(command.attempt_generation)!==attempt.generation||String(command.fence_sequence)!==latest?.fence||command.action!=='runner.stop'||command.state!=='REPORTED'||command.outcome!=='STOPPED'||command.termination!=='CONFIRMED'||command.cleanup_complete!==true||!object(command.report)||hash(command.report)!==command.report_digest||command.report.remaining_descendants!==0||command.report.cleanup_complete!==true||!Array.isArray(command.report.cleanup_debt)||command.report.cleanup_debt.length||!Array.isArray(command.report.credential_revocation)||command.report.credential_revocation.some((r:Data)=>r.state==='UNRESOLVED'))fail('QUALIFICATION_ARCHIVE_CLOSURE','Exact latest confirmed signed STOP and zero residue required');
 const live=(await tx.query(`SELECT EXISTS(SELECT 1 FROM hyperfide.compute_leases WHERE organisation_id=$1 AND run_id=$2 AND attempt_id=$3 AND state='ACTIVE') OR EXISTS(SELECT 1 FROM hyperfide.identity_principals WHERE organisation_id=$1 AND run_id=$2 AND attempt_id=$3 AND state='ACTIVE') AS live`,[...s,attempt.id])).rows[0];
 if(live?.live!==false)fail('QUALIFICATION_ARCHIVE_CLOSURE','Active compute leases or child credentials prevent archive transfer');
 const rows=(await tx.query(`SELECT r.*,r.boot_generation::text,r.slot_generation::text,q.publication,q.publication->'readiness_input' AS readiness_input,s.boot_generation::text AS current_generation,b.boot_id AS current_boot FROM hyperfide.runner_registry r JOIN hyperfide.fleet_runtime_readiness q ON q.organisation_id=r.organisation_id AND q.run_id=r.run_id AND q.runner_session_id=r.session_id AND q.readiness_digest=r.readiness_digest JOIN hyperfide.sandboxes s ON s.organisation_id=r.organisation_id AND s.id=r.sandbox_id JOIN hyperfide.sandbox_boots b ON b.organisation_id=s.organisation_id AND b.sandbox_id=s.id AND b.boot_generation=s.boot_generation WHERE r.organisation_id=$1 AND r.run_id=$2 AND r.session_id=$3 FOR SHARE OF r,q,s,b`,[...s,fleet.runner_session_id])).rows;
 if(rows.length!==1)fail('QUALIFICATION_ARCHIVE_CLOSURE','One retained manifest runner required');const runner=rows[0]!,publication=runner.publication,readiness=runner.readiness_input;
 if(runner.sandbox_id!==attempt.sandbox_id||runner.slot_id!==attempt.slot_id||runner.boot_generation!==attempt.sandbox_boot_generation||runner.current_generation!==runner.boot_generation||runner.current_boot!==runner.boot_id||runner.repository_id!==policy.repository_id||runner.source_object_id!==policy.source_object_id||command.boot_id!==runner.boot_id||command.sandbox_id!==runner.sandbox_id||String(command.boot_generation)!==runner.boot_generation||!object(publication)||!object(readiness)||publication.kind!=='FLEET_MANIFEST_V1'||publication.readiness_digest!==runner.readiness_digest||!object(readiness.slot)||readiness.slot.source!==runner.workspace_path)fail('QUALIFICATION_ARCHIVE_CLOSURE','Closed launch and actual measured workspace identity differ');
 const {readiness_digest:_digest,...body}=publication;if(hash(body)!==runner.readiness_digest)fail('QUALIFICATION_ARCHIVE_CLOSURE','Retained readiness publication changed');uuid(publication.id);
 const remote=(await tx.query('SELECT * FROM hyperfide.provider_remote_operations WHERE organisation_id=$1 AND run_id=$2 AND id=$3 FOR SHARE',[...s,v.quiescence_operation_id])).rows[0];
 if(!remote||remote.session_id!==runner.session_id||remote.sandbox_id!==runner.sandbox_id||String(remote.boot_generation)!==runner.boot_generation||remote.state!=='OBSERVED'||remote.outcome?.status!=='SUCCEEDED'||remote.outcome?.result?.phase!=='EXITED'||remote.outcome.result.exit_code!==0||remote.outcome.result.termination_confirmed!==true||remote.outcome.result.output?.complete!==true||remote.outcome.result.output?.truncated!==false)fail('QUALIFICATION_ARCHIVE_CLOSURE','Actual terminal native STOP provider observation required');
 const target={state_dir:runner.state_dir,launch_id:v.launch_id,attempt_id:attempt.id,attempt_generation:attempt.generation,sandbox_id:runner.sandbox_id,boot_id:runner.boot_id,boot_generation:runner.boot_generation,command_id:v.command_id};
 const expectedArgv=[runner.runner_binary,'--component','12.4','--action','runner.stop','--request-base64',Buffer.from(JSON.stringify(target)).toString('base64url')];
 if(remote.operation?.kind!=='execute'||canonical(remote.operation?.parameters?.argv)!==canonical(expectedArgv))fail('QUALIFICATION_ARCHIVE_CLOSURE','Quiescence operation is not the exact retained native STOP command');
 const bootstrap=(await tx.query("SELECT manifest,manifest_digest,receipt FROM hyperfide.provider_native_bootstraps WHERE organisation_id=$1 AND run_id=$2 AND sandbox_id=$3 AND boot_id=$4 AND boot_generation=$5 AND state='READY' FOR SHARE",[...s,runner.sandbox_id,runner.boot_id,runner.boot_generation])).rows;
 const bootstrapRow=bootstrap[0];if(!bootstrapRow||bootstrap.length!==1||bootstrapRow.receipt?.credential_id!==runner.credential_id||!object(bootstrapRow.manifest)||hash(bootstrapRow.manifest)!==bootstrapRow.manifest_digest||!object(bootstrapRow.manifest.template)||typeof bootstrapRow.manifest.template.state_root!=='string'||!path.isAbsolute(bootstrapRow.manifest.template.state_root)||path.resolve(bootstrapRow.manifest.template.state_root)!==bootstrapRow.manifest.template.state_root)fail('QUALIFICATION_ARCHIVE_CLOSURE','Exact protected original bootstrap state root required');
 const state_dir=path.join(bootstrapRow.manifest.template.state_root,runner.sandbox_id,runner.boot_id);
 const packet=await loadPacketInputs(tx,s,attempt.input_packet_digest),identity=packet.packet.mandatory.identity;
 if(identity.task_id!==task.id||identity.attempt_id!==attempt.id||String(identity.attempt_generation)!==attempt.generation||identity.authority_epoch!==task.run_epoch||identity.criteria_digest!==task.criteria_digest||identity.spec_revision_id!==task.spec_revision_id||String(identity.spec_generation)!==String(task.spec_generation)||packet.packet.mandatory.intent.registry_digest!==hash(policy)||hash(packet.packet.mandatory.intent.owned_scope)!==hash(acceptedSourceScope(task.definition)))fail('QUALIFICATION_PACKET_INVALID','Closed attempt packet or accepted proof policy changed');
 const prior=(await tx.query('SELECT custody_generation::text FROM hyperfide.submission_custodies WHERE organisation_id=$1 AND run_id=$2 AND id=$3',[...s,v.custody_id])).rows[0];
 const next=prior?.custody_generation??(await tx.query('SELECT (coalesce(max(custody_generation),0)+1)::text AS generation FROM hyperfide.submission_custodies WHERE organisation_id=$1 AND run_id=$2 AND task_id=$3',[...s,task.id])).rows[0]!.generation;
 const binding={organisation_id:s[0],run_id:s[1],custody_id:v.custody_id,custody_generation:next,task_id:task.id,attempt_id:attempt.id,attempt_generation:attempt.generation,sandbox_id:runner.sandbox_id,boot_id:runner.boot_id,boot_generation:runner.boot_generation,os_boot_id:process.os_boot_id,slot_id:runner.slot_id,slot_generation:runner.slot_generation,session_id:v.session_id,workspace_id:publication.id,launch_id:v.launch_id,command_id:v.command_id,quiescence_operation_id:v.quiescence_operation_id,quiescence_receipt_digest:command.report.receipt_digest,native_launch_plan_digest:hash(launch.plan),captured_result_digest:fleet.result_digest,report_digest:command.report_digest,uid:runner.uid,gid:runner.gid};
 return {binding,baseline:{source_revision:readiness.source_revision,source_manifest_digest:readiness.source_manifest_digest},source_root:runner.workspace_path,seal_root:path.dirname(runner.workspace_path),state_dir,runner_state_dir:runner.state_dir,runner_session_id:runner.session_id,task,attempt,packet,proof_policy:policy,owned_scope:acceptedSourceScope(task.definition),source_files:readiness.source_files};
}

export interface ClosedArchiveAdmission{custody_id:string;archive_id:string;archive:Data;archive_reference:Data;capture_receipt:Data;derived_git:Data;evidence_artifact_ids:string[];source_manifest_reference:Data;evidence_manifest_reference:Data}
export async function admitClosedArchiveCustody(tx:PrimaryTransaction,i:InvocationContext,input:ClosedArchiveAdmission):Promise<Data>{
 assertPrimaryTransaction(tx);assertInvocation(i);await i.guard(tx);uuid(input.custody_id);uuid(input.archive_id);
 const archive=input.archive,receipt=input.capture_receipt,b=archive?.binding;if(!object(b))fail('QUALIFICATION_ARCHIVE_INVALID','Typed source archive binding required');
 const prepared=await prepareClosedArchiveCustody(tx,i,{task_id:uuid(b.task_id),attempt_id:uuid(b.attempt_id),attempt_generation:decimal(b.attempt_generation),session_id:uuid(b.session_id),launch_id:uuid(b.launch_id),command_id:uuid(b.command_id),quiescence_operation_id:uuid(b.quiescence_operation_id),custody_id:input.custody_id});
 if(canonical(b)!==canonical(prepared.binding)||canonical(archive.baseline)!==canonical(prepared.baseline)||receipt.kind!=='FLEET_SOURCE_ARCHIVE_CAPTURE_RECEIPT_V1'||canonical(receipt.binding)!==canonical(b)||receipt.source_sealed!==true||receipt.observed_process_absent!==true)fail('QUALIFICATION_ARCHIVE_INVALID','Actual archive differs from its accepted closed attempt');
 const derived=deriveArchiveGitIdentity(archive);
 if(derived.source_object_id!==input.derived_git.source_object_id||derived.source_tree_id!==input.derived_git.source_tree_id||derived.archive_digest!==receipt.archive_digest||derived.inventory_digest!==receipt.inventory_digest)fail('QUALIFICATION_ARCHIVE_INVALID','Archive-derived representation or actual byte digests differ');
 const s:[string,string]=[i.principal.organisation_id,i.principal.run_id],source=input.source_manifest_reference,evidence=input.evidence_manifest_reference;
 const physical=(ref:Data):string=>digest(ref.manifest_digest??ref.digest),sourceDigest=physical(source),evidenceDigest=physical(evidence);const references=[input.archive_reference,source,evidence];for(const ref of references){uuid(ref.artifact_id);digest(ref.digest);physical(ref);}
 if(source.artifact_id!==input.archive_reference.artifact_id||sourceDigest!==physical(input.archive_reference)||input.archive_reference.digest!==derived.archive_digest)fail('QUALIFICATION_ARCHIVE_INVALID','Source authority must reference the actual stored archive');
 const retained=[...new Set([input.archive_reference.artifact_id,evidence.artifact_id,...input.evidence_artifact_ids])];
 if(retained.length>4096)fail('QUALIFICATION_ARCHIVE_INVALID','Bounded semantic evidence inventory required');for(const id of retained){uuid(id);await tx.query('SELECT hyperfide.require_complete_artifact($1,$2,$3)',[...s,id]);}
 for(const ref of references){const row=(await tx.query('SELECT digest,status FROM hyperfide.artifacts WHERE organisation_id=$1 AND run_id=$2 AND id=$3 FOR SHARE',[...s,ref.artifact_id])).rows[0];if(row?.status!=='COMPLETE'||row.digest!==physical(ref))fail('QUALIFICATION_ARCHIVE_INVALID','Archive publication changed before custody transfer');}
 if(!Array.isArray(prepared.source_files))fail('QUALIFICATION_ARCHIVE_INVALID','Actual baseline source inventory required');
 const baseline=new Map<string,Data>(prepared.source_files.filter((f:Data)=>!archive.policy.excluded_paths.some((p:string)=>f.path===p||f.path.startsWith(p+'/'))).map((f:Data)=>[f.path,f])),actual=new Map<string,Data>(archive.files.map((f:Data)=>[f.path,f]));
 for(const name of new Set([...baseline.keys(),...actual.keys()])){const before=baseline.get(name),after=actual.get(name);if(before?.digest===after?.digest&&before?.mode===after?.mode)continue;if(!ownedSourcePath(name,prepared.owned_scope))fail('QUALIFICATION_SOURCE_SCOPE','Archived changes exceed accepted task ownership');}
 const artifact={artifact_id:source.artifact_id,storage_kind:source.storage_kind==='manifest'||source.storage_kind==='CHUNK_MANIFEST'?'manifest':'object',digest:derived.archive_digest,size_bytes:String(receipt.size_bytes),...(sourceDigest===derived.archive_digest?{}:{manifest_digest:sourceDigest})};
 const archive_source={schema_version:1,kind:'FLEET_SOURCE_ARCHIVE_V1',archive_id:input.archive_id,artifact,archive_digest:derived.archive_digest,inventory_digest:derived.inventory_digest,binding:b,baseline:archive.baseline,derived_git:{source_object_id:derived.source_object_id,source_tree_id:derived.source_tree_id}};
 const facts={repository_id:prepared.proof_policy.repository_id,source_object_id:derived.source_object_id,source_tree_id:derived.source_tree_id,baseline_source_object_id:prepared.proof_policy.source_object_id,source_parent_ids:[],owned_scope_digest:hash(prepared.owned_scope),source_origin:'FLEET_SOURCE_ARCHIVE_V1',archive_source};
 const manifest={organisation_id:s[0],run_id:s[1],task_id:b.task_id,request_id:i.operation.idempotency_key,attempt_id:b.attempt_id,attempt_generation:b.attempt_generation,authority_epoch:prepared.task.run_epoch,sandbox_id:b.sandbox_id,slot_id:b.slot_id,sandbox_boot_generation:b.boot_generation,...facts,workspace_id:b.workspace_id,source_manifest_artifact_id:source.artifact_id,evidence_manifest_artifact_id:evidence.artifact_id,source_manifest_digest:sourceDigest,criteria_digest:prepared.task.criteria_digest,contract_digests:prepared.proof_policy.contract_digests??[],evidence_artifact_ids:retained.sort(),registry_digest:hash(prepared.proof_policy),input_packet_digest:prepared.attempt.input_packet_digest,mandatory_digest:prepared.packet.mandatory_digest,input_manifest:resultInputs(facts,sourceDigest,prepared.packet.derived),graph_manifest_digest:prepared.packet.derived.graph_manifest_digest,graph_status:prepared.packet.derived.graph_status};
 const prior=(await tx.query('SELECT c.id,c.custody_generation::text,c.authority,c.qualification_outcome,s.manifest,j.id AS job_id FROM hyperfide.submission_custodies c JOIN hyperfide.assurance_submissions s ON s.organisation_id=c.organisation_id AND s.run_id=c.run_id AND s.custody_id=c.id LEFT JOIN hyperfide.qualification_jobs j ON j.organisation_id=c.organisation_id AND j.run_id=c.run_id AND j.custody_id=c.id WHERE c.organisation_id=$1 AND c.run_id=$2 AND c.id=$3 ORDER BY j.created_at LIMIT 1',[...s,input.custody_id])).rows[0];
 if(prior){if(canonical(prior.manifest)!==canonical(manifest))fail('QUALIFICATION_IDEMPOTENCY_CONFLICT','Planned archive custody already holds different admitted bytes');return {submission:{id:prior.id,custody_generation:prior.custody_generation,authority:prior.authority,qualification_outcome:prior.qualification_outcome},job_id:prior.job_id,evidence_artifact_ids:retained,replayed:true};}
 for(const [id,kind]of [[derived.source_object_id,'commit'],[derived.source_tree_id,'tree']]){await tx.query('INSERT INTO hyperfide.source_objects(organisation_id,repository_id,object_id,object_type) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[s[0],facts.repository_id,id,kind]);const old=(await tx.query('SELECT object_type FROM hyperfide.source_objects WHERE organisation_id=$1 AND repository_id=$2 AND object_id=$3',[s[0],facts.repository_id,id])).rows[0];if(old?.object_type!==kind)fail('QUALIFICATION_SOURCE_MISMATCH','Derived archive representation conflicts with registered object type');}
 const scheduler=await import('../scheduler/leases.js');
 await scheduler.finalizeClosedArchiveCompute(tx,{organisation_id:s[0],run_id:s[1],task_id:uuid(b.task_id),attempt_id:uuid(b.attempt_id),attempt_generation:decimal(b.attempt_generation),authority_epoch:prepared.task.run_epoch,sandbox_id:uuid(b.sandbox_id),slot_id:uuid(b.slot_id),sandbox_boot_generation:decimal(b.boot_generation)},{launch_id:uuid(b.launch_id),command_id:uuid(b.command_id),result_digest:digest(b.captured_result_digest),report_digest:digest(b.report_digest),archive_artifact_id:source.artifact_id,archive_artifact_digest:sourceDigest});
 const job=randomUUID();await tx.query("INSERT INTO hyperfide.submission_custodies(organisation_id,run_id,id,task_id,source_attempt_id,source_generation,custody_generation,authority_epoch,repository_id,source_object_id,source_manifest_digest,evidence_manifest_digest,criteria_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",[...s,input.custody_id,b.task_id,b.attempt_id,b.attempt_generation,b.custody_generation,prepared.task.run_epoch,facts.repository_id,derived.source_object_id,sourceDigest,evidenceDigest,prepared.task.criteria_digest]);
 await tx.query('INSERT INTO hyperfide.assurance_submissions(organisation_id,run_id,custody_id,request_id,request_digest,manifest,policy,source_artifact_id,evidence_artifact_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[...s,input.custody_id,i.operation.idempotency_key,hash(manifest),manifest,prepared.proof_policy,source.artifact_id,evidence.artifact_id]);
 await tx.query('INSERT INTO hyperfide.qualification_jobs(organisation_id,run_id,id,custody_id,custody_generation,rubric_digest) VALUES($1,$2,$3,$4,$5,$6)',[...s,job,input.custody_id,b.custody_generation,prepared.proof_policy.rubric_digest]);
 await tx.query('INSERT INTO hyperfide.assurance_applicability(organisation_id,run_id,custody_id,input_manifest) VALUES($1,$2,$3,$4)',[...s,input.custody_id,manifest.input_manifest]);
 await tx.query("UPDATE hyperfide.tasks SET current_custody_id=$4,state='SUBMITTED',state_version=state_version+1 WHERE organisation_id=$1 AND run_id=$2 AND id=$3",[...s,b.task_id,input.custody_id]);
 return {submission:{id:input.custody_id,custody_generation:b.custody_generation,authority:'ACTIVE',qualification_outcome:'PENDING'},job_id:job,evidence_artifact_ids:retained,replayed:false,qualification:'PENDING'};
}
/** Immutable admission provenance; consumers must independently re-read the COMPLETE object through15.2. */
export async function inspectSubmittedResult(db:PrimaryClient,scopeValue:{organisation_id:string;run_id:string},
 query:{custody_id:string}):Promise<Data>{
 const s:[string,string]=[uuid(scopeValue.organisation_id),uuid(scopeValue.run_id)],id=uuid(query.custody_id);
 await assuranceBarrier(db,{organisation_id:s[0],run_id:s[1]},'SHARED');
 const result=await db.query("SELECT c.id,c.task_id,c.source_attempt_id,c.source_generation::text,c.custody_generation::text,c.authority,c.repository_id,"
  +"c.source_object_id,c.source_manifest_digest,c.authority_epoch,s.manifest,s.source_artifact_id,a.digest,a.size_bytes::text,a.status "
  +"FROM hyperfide.submission_custodies c JOIN hyperfide.assurance_submissions s ON s.organisation_id=c.organisation_id AND s.run_id=c.run_id AND s.custody_id=c.id "
  +"JOIN hyperfide.artifacts a ON a.organisation_id=s.organisation_id AND a.run_id=s.run_id AND a.id=s.source_artifact_id "
  +"WHERE c.organisation_id=$1 AND c.run_id=$2 AND c.id=$3",[...s,id]);
 const row=result.rows[0],m=row?.manifest;
 if(!row||!object(m)||row.authority==='REVOKED'||row.status!=='COMPLETE'||row.digest!==row.source_manifest_digest||
  m.repository_id!==row.repository_id||m.source_object_id!==row.source_object_id||m.source_manifest_digest!==row.source_manifest_digest||
  m.task_id!==row.task_id||m.attempt_id!==row.source_attempt_id||String(m.attempt_generation)!==String(row.source_generation)||
  m.authority_epoch!==row.authority_epoch||m.source_manifest_artifact_id!==row.source_artifact_id||
  !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(String(m.source_tree_id??''))||!Array.isArray(m.source_parent_ids))
  fail('QUALIFICATION_RESULT_UNAVAILABLE','Immutable admitted result provenance is unavailable or inconsistent');
 let archiveOrigin:Data={};
 if(m.archive_source!==undefined){
  const a=m.archive_source;
  if(m.source_origin!=='FLEET_SOURCE_ARCHIVE_V1'||!object(a)||a.schema_version!==1||a.kind!=='FLEET_SOURCE_ARCHIVE_V1'||!object(a.artifact)||!object(a.binding)||!object(a.baseline)||!object(a.derived_git)||a.derived_git.source_object_id!==m.source_object_id||a.derived_git.source_tree_id!==m.source_tree_id||a.artifact.artifact_id!==row.source_artifact_id||(a.artifact.manifest_digest??a.artifact.digest)!==row.digest||a.artifact.digest!==a.archive_digest)fail('QUALIFICATION_RESULT_UNAVAILABLE','Archive origin differs from its derived adapter and physical source root');
  const x=(await db.query(`SELECT x.*,ar.status AS archive_status,cr.status AS receipt_status FROM hyperfide.fleet_source_archive_custodies x JOIN hyperfide.artifacts ar ON ar.organisation_id=x.organisation_id AND ar.run_id=x.run_id AND ar.id=x.archive_artifact_id JOIN hyperfide.artifacts cr ON cr.organisation_id=x.organisation_id AND cr.run_id=x.run_id AND cr.id=x.capture_receipt_artifact_id WHERE x.organisation_id=$1 AND x.run_id=$2 AND x.id=$3 AND x.custody_id=$4 FOR SHARE OF x,ar,cr`,[...s,uuid(a.archive_id),id])).rows[0];
  if(!x||x.archive_status!=='COMPLETE'||x.receipt_status!=='COMPLETE'||String(x.custody_generation)!==String(row.custody_generation)||x.archive_artifact_id!==row.source_artifact_id||x.archive_artifact_digest!==row.digest||x.archive_digest!==a.archive_digest||x.inventory_digest!==a.inventory_digest||canonical(x.binding)!==canonical(a.binding)||x.baseline_source_revision!==a.baseline?.source_revision||x.source_manifest_digest!==a.baseline?.source_manifest_digest)fail('QUALIFICATION_RESULT_UNAVAILABLE','Durable typed archive custody is missing or inconsistent');
  archiveOrigin={source_origin:'FLEET_SOURCE_ARCHIVE_V1',archive_source:a};
 }
 const binding={organisation_id:s[0],run_id:s[1],custody_id:id,custody_generation:String(row.custody_generation),
  task_id:row.task_id,source_attempt_id:row.source_attempt_id,source_attempt_generation:String(row.source_generation),
  authority_epoch:row.authority_epoch,repository_id:row.repository_id,source_object_id:row.source_object_id,source_tree_id:m.source_tree_id,
  baseline_source_object_id:m.baseline_source_object_id,source_parent_ids:m.source_parent_ids,workspace_id:m.workspace_id,
  source_manifest_digest:row.source_manifest_digest,source_manifest_artifact_id:row.source_artifact_id,source_manifest_size_bytes:String(row.size_bytes),
  input_packet_digest:m.input_packet_digest,input_manifest:m.input_manifest,registry_digest:m.registry_digest,
  ...archiveOrigin,...(m.snapshot_id===undefined?{}:{snapshot_id:m.snapshot_id,snapshot_tree_id:m.snapshot_tree_id})};
 return {...binding,binding_digest:hash(binding),authority:row.authority,object_bytes_reverified:false};
}
export function rawDigest(bytes:Uint8Array):string{return 'sha256:'+createHash('sha256').update(bytes).digest('hex');}
export async function retainArtifactBytes(ctx:ComponentContext,s:[string,string],bytes:Buffer):Promise<Data>{
 if(bytes.length>32*1024*1024)fail('QUALIFICATION_ARTIFACT_BUDGET','Bounded artifact publication limit exceeded');
 const common={organisation_id:s[0],run_id:s[1],retention_class:'RUN',retention_until:null,retention_hold:false};
 const chunks:Data[]=[];
 for(let offset=0;offset<bytes.length||offset===0;offset+=256*1024){
  const part=bytes.subarray(offset,Math.min(offset+256*1024,bytes.length));
  const result=await artifact(ctx,'artifact.object.put',{...common,digest:rawDigest(part),size_bytes:String(part.length),data_base64:part.toString('base64')});
  chunks.push({sequence:chunks.length,artifact_id:result.artifact.artifact_id,digest:result.artifact.digest,
   size_bytes:String(part.length),offset_bytes:String(offset)});
  if(bytes.length===0)break;
 }
 if(chunks.length===1)return {artifact_id:chunks[0]!.artifact_id,digest:chunks[0]!.digest,size_bytes:String(bytes.length),storage_kind:'OBJECT'};
 const result=await artifact(ctx,'artifact.manifest.commit',{...common,expected_chunks:chunks.length,total_size_bytes:String(bytes.length),
 content_digest:rawDigest(bytes),complete:true,truncated:false,missing_ranges:[],chunks});
 return {artifact_id:result.artifact.artifact_id,digest:result.artifact.digest,content_digest:rawDigest(bytes),size_bytes:String(bytes.length),manifest_size_bytes:result.artifact.size_bytes,storage_kind:'CHUNK_MANIFEST'};
}
export function createComponent(ctx:ComponentContext):Component & {capabilities:Record<string,unknown>}{
 return {apiVersion:1,capabilities:{'assurance.custody.v1':Object.freeze({fenceQualificationJobs,revokeCustodies,inspectSubmittedResult})},actions:{
  'submission.submit':(input,requestContext)=>submit(requestContext,input),
  'submission.archive.register':async(input,requestContext)=>(await import('./source_archive.js')).registerSourceArchive(requestContext,input),
  'submission.revoke':(input,requestContext)=>revoke(requestContext,input),
  'submission.snapshot':(input,requestContext)=>snapshotAction(requestContext,input),
  'submission.inspect':async(raw,requestContext)=>{
   const ctx=requestContext;
   const v=fields(raw,['organisation_id','run_id','submission_id']),s=scope(ctx,v),id=uuid(v.submission_id);
   const c=await transaction(ctx,db=>db.query('SELECT c.*,a.applicability,a.current_receipt_digest FROM hyperfide.submission_custodies c LEFT JOIN hyperfide.assurance_applicability a ON a.organisation_id=c.organisation_id AND a.run_id=c.run_id AND a.custody_id=c.id WHERE c.organisation_id=$1 AND c.run_id=$2 AND c.id=$3',[...s,id]),false,'READ');
   if(!c.rows[0])fail('QUALIFICATION_NOT_FOUND','Submission not found');return c.rows[0];
  }
 }};
}
