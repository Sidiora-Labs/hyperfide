import {createHash} from 'node:crypto';
import {parseGeneration, parseObjectId, parseRepositoryPath, parseSourceScope, parseUUID, SourceControlError, type SourceScope} from './contracts.js';
import {sourceDigest, sourceScopeValues, type SourceContext, SourceMetadata, type SourceSQL} from './metadata.js';
import {sourcePathWithin} from './capabilities.js';
import {PersistentTree, type TreePatch} from './trees.js';
import {decodeFileDescriptor} from './objects.js';
import {reserveSourceOperation} from './operations.js';
import {sourceScopeAllows} from '../preparation/fleet_source.js';
import {assertManagedObjectUploads} from './managed-objects.js';

export interface WorkspaceBudgets {
 cache_bytes:number; max_cache_entries:number; max_file_bytes:number; materialized_bytes:number; dirty_bytes:number;
}
export interface WorkspaceDescriptor {
 schema_version:1; scope:SourceScope; workspace_id:string; workspace_generation:string; scope_generation:string;
 authority_epoch:string; base_revision_id:string; root_tree_id:string; checkpoint_revision_id:string|null;
 mode:'API_ONLY'|'SPARSE'|'MATERIALIZED'; read_paths:string[]; write_paths:string[]; budgets:WorkspaceBudgets;
}
type Row=Record<string,any>;
function invalid(message:string):never {throw new SourceControlError('INVALID_REQUEST',message);}
function stale():never {throw new SourceControlError('WORKSPACE_CHANGED','Workspace generation or base changed','REFRESH_AUTHORITY');}
function boundWorkspace(context:SourceContext,id:string):void {
 if(context.workspace&&context.workspace.workspace_id!==id)throw new SourceControlError('SCOPE_DENIED','Source capability belongs to another workspace');
}
function record(value:unknown):Record<string,unknown> {
 if(!value||typeof value!=='object'||Array.isArray(value))invalid('Workspace input must be an object');
 return value as Record<string,unknown>;
}
function paths(value:unknown):string[] {
 if(!Array.isArray(value)||value.length>256)invalid('Explicit bounded source paths are required');
 const result=value.map(path=>path===''?'':parseRepositoryPath(path));
 if(new Set(result).size!==result.length)invalid('Duplicate source paths');
 return result;
}
function within(path:string,prefixes:readonly string[],managed=false):void {
 const allowed=managed?sourcePathWithin(path,prefixes.filter(prefix=>!prefix.includes('*')))||sourceScopeAllows(prefixes.filter(prefix=>prefix.includes('*')),path):sourcePathWithin(path,prefixes);
 if(!allowed)throw new SourceControlError('SCOPE_DENIED','Path is outside the installed workspace scope');
}
function descriptor(row:Row):WorkspaceDescriptor {
 return {schema_version:1,scope:{organisation_id:row.organisation_id,repository_id:row.repository_id,security_domain_id:row.security_domain_id},
  workspace_id:row.workspace_id,workspace_generation:String(row.workspace_generation),scope_generation:String(row.scope_generation),
  authority_epoch:String(row.authority_epoch),base_revision_id:row.base_revision_id,root_tree_id:row.root_tree_id,
  checkpoint_revision_id:row.checkpoint_revision_id,mode:row.mode,read_paths:row.read_paths,write_paths:row.write_paths,budgets:row.budgets};
}
function derivedOperation(scope:SourceScope,operation:string):string {
 const bytes=createHash('sha256').update(sourceDigest([scope,operation,'workspace-checkpoint-revision-v1'])).digest().subarray(0,16);
 bytes[6]=(bytes[6]!&15)|80;bytes[8]=(bytes[8]!&63)|128;
 const hex=bytes.toString('hex');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
export class SourceWorkspaceService {
 readonly budgets:WorkspaceBudgets;
 constructor(readonly metadata:SourceMetadata,readonly trees:PersistentTree,budgets:WorkspaceBudgets) {
  const required=['cache_bytes','max_cache_entries','max_file_bytes','materialized_bytes','dirty_bytes'] as const;
  if(Object.keys(budgets).length!==required.length||required.some(key=>!Number.isSafeInteger(budgets[key])||budgets[key]<1))invalid('Explicit positive workspace budgets are required');
  this.budgets=Object.freeze({...budgets});
 }
 private async row(tx:SourceSQL,context:SourceContext,id:string,lock=false):Promise<Row> {
  boundWorkspace(context,id);
  const row=(await tx.query(`SELECT * FROM hyperfide.source_workspaces WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND workspace_id=$4 AND principal_id=$5${lock?' FOR UPDATE':''}`,
   [...sourceScopeValues(context.scope),id,context.principal_id])).rows[0];
  if(!row||row.closed_at!==null)throw new SourceControlError('WORKSPACE_NOT_FOUND','Workspace is unavailable');
  if(String(row.authority_epoch)!==context.authority_epoch)stale();
  return row;
 }
 async open(context:SourceContext,input:unknown):Promise<{workspace:WorkspaceDescriptor;admission:{state:'OPEN'}}> {
  const value=record(input),id=parseUUID(value.workspace_id,'workspace_id'),base=parseObjectId(value.base_revision_id);
  boundWorkspace(context,id);
  const read=paths(value.read_paths),write=paths(value.write_paths);
  if(!['API_ONLY','SPARSE','MATERIALIZED'].includes(String(value.mode)))invalid('An explicit workspace materialization mode is required');
  for(const path of write)within(path,read);
  const budgets={...this.budgets};
  if(value.budgets!==undefined){
   const requested=record(value.budgets);
   for(const [name,limit]of Object.entries(requested)){
    if(!Object.hasOwn(budgets,name)||!Number.isSafeInteger(limit)||Number(limit)<1||Number(limit)>budgets[name as keyof WorkspaceBudgets])invalid('Requested workspace budgets may only lower protected limits');
    budgets[name as keyof WorkspaceBudgets]=Number(limit);
   }
  }
  const digest=sourceDigest({workspace_id:id,base_revision_id:base,mode:value.mode,read_paths:read,write_paths:write,budgets});
  return this.metadata.transaction(async tx=>{
   await this.metadata.guard(tx,context,'source.workspaces.open');
   const revision=await this.metadata.readRevisionInTransaction(tx,context,base);
   await tx.query(`INSERT INTO hyperfide.source_workspaces(organisation_id,repository_id,security_domain_id,workspace_id,principal_id,authority_epoch,base_revision_id,root_tree_id,mode,read_paths,write_paths,budgets,open_request_digest)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING`,
    [...sourceScopeValues(context.scope),id,context.principal_id,context.authority_epoch,base,revision.root_tree_id,value.mode,JSON.stringify(read),JSON.stringify(write),JSON.stringify(budgets),digest]);
   const current=await this.row(tx,context,id);
   if(current.open_request_digest!==digest)throw new SourceControlError('IDEMPOTENCY_CONFLICT','Workspace identity was opened with another request');
   return {workspace:descriptor(current),admission:{state:'OPEN'}};
  });
 }
 async detail(context:SourceContext,input:unknown):Promise<{workspace:WorkspaceDescriptor}> {
  const id=parseUUID(record(input).workspace_id,'workspace_id');
  return this.metadata.transaction(async tx=>{await this.metadata.guard(tx,context,'source.workspaces.detail');return {workspace:descriptor(await this.row(tx,context,id))};});
 }
 async operation(context:SourceContext,operationId:string):Promise<Row|null> {
  parseUUID(operationId,'operation_id');
  return this.metadata.transaction(async tx=>{
   await this.metadata.guard(tx,context,'source.operations.read');
   const row=(await tx.query('SELECT result FROM hyperfide.source_workspace_checkpoints WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND principal_id=$4 AND operation_id=$5',
    [...sourceScopeValues(context.scope),context.principal_id,operationId])).rows[0];
   return row?{state:'COMMITTED',operation_id:operationId,result:row.result}:null;
  });
 }
 async checkpoint(context:SourceContext,input:unknown):Promise<Row> {
  const value=record(input),id=parseUUID(value.workspace_id,'workspace_id'),operation=parseUUID(value.operation_id,'operation_id');
  boundWorkspace(context,id);
  const generation=parseGeneration(value.expected_workspace_generation),scopeGeneration=parseGeneration(value.expected_scope_generation);
  const base=parseObjectId(value.base_revision_id),overlay=parseGeneration(value.overlay_generation);
  if(value.scope!==undefined&&sourceDigest(parseSourceScope(value.scope))!==sourceDigest(context.scope))invalid('Checkpoint scope differs from its authenticated request');
  if(!Array.isArray(value.changes)||value.changes.length>256)invalid('Checkpoint changes must be an explicit bounded path list');
  const changes:TreePatch[]=value.changes.map(item=>{
   const change=record(item),path=parseRepositoryPath(change.path);
   if(change.operation==='remove')return {path,operation:'remove'};
   if(change.operation!=='put'||!['file','symlink'].includes(String(change.kind))||
     !(change.kind==='file'&&['100644','100755'].includes(String(change.mode))||change.kind==='symlink'&&change.mode==='120000'))invalid('Checkpoint entry type or mode is invalid');
   return {path,operation:'put',kind:change.kind as 'file'|'symlink',mode:change.mode as '100644'|'100755'|'120000',object_id:parseObjectId(change.object_id)};
  });
  const requestDigest=sourceDigest({workspace_id:id,operation_id:operation,expected_workspace_generation:generation,expected_scope_generation:scopeGeneration,base_revision_id:base,overlay_generation:overlay,changes});
  const replay=async(tx:SourceSQL):Promise<Row|null>=>{
   const old=(await tx.query('SELECT request_digest,result FROM hyperfide.source_workspace_checkpoints WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND principal_id=$4 AND operation_id=$5',
    [...sourceScopeValues(context.scope),context.principal_id,operation])).rows[0];
   if(old&&old.request_digest!==requestDigest)throw new SourceControlError('IDEMPOTENCY_CONFLICT','Checkpoint operation was used with another overlay');
   return old?.result??null;
  };
  const initial=await this.metadata.transaction(async tx=>{
   await this.metadata.guard(tx,context,'source.operations.read');const previous=await replay(tx);if(previous)return {previous,row:null};
   await this.metadata.guard(tx,context,'source.workspaces.checkpoint');const row=await this.row(tx,context,id);
   if(String(row.workspace_generation)!==generation||String(row.scope_generation)!==scopeGeneration||row.base_revision_id!==base)stale();
   for(const change of changes)within(change.path,row.write_paths,Boolean(context.workspace));
   await assertManagedObjectUploads(tx,context,changes.filter(change=>change.operation==='put').map(change=>change.object_id!));
   return {previous:null,row};
  });
  if(initial.previous)return initial.previous;
  let changedBytes=0n;
  for(const change of changes)if(change.operation==='put'){
   const object=await this.trees.store.read(context.scope,change.object_id);
   if(change.kind==='symlink'){
    if(object.kind!=='blob'||object.payload.byteLength>4096)invalid('Symlink entries require a bounded blob target');
    let target:string;try{target=new TextDecoder('utf-8',{fatal:true}).decode(object.payload);}catch{invalid('Symlink target must be UTF-8');}
    if(!target||target.includes('\0'))invalid('Symlink target must be nonempty and contain no NUL');
    changedBytes+=BigInt(object.payload.byteLength);continue;
   }
   if(object.kind!=='file')invalid('Workspace file entries must reference verified file descriptors');
   const bytes=BigInt(decodeFileDescriptor(object.payload).size_bytes);
   if(bytes>BigInt(initial.row!.budgets.max_file_bytes))throw new SourceControlError('LIMIT_EXCEEDED','Changed file exceeds the workspace file budget');
   changedBytes+=bytes;
  }
  if(changedBytes>BigInt(initial.row!.budgets.dirty_bytes))throw new SourceControlError('LIMIT_EXCEEDED','Checkpoint exceeds the workspace dirty-byte budget');
  const patched=await this.trees.patch(context.scope,initial.row!.root_tree_id,changes);
  return this.metadata.transaction(async tx=>{
   await this.metadata.guard(tx,context,'source.operations.read');const previous=await replay(tx);if(previous)return previous;
   await this.metadata.guard(tx,context,'source.workspaces.checkpoint');
   const operationRecord=await reserveSourceOperation(tx,context,{operation_id:operation,action:'source.workspaces.checkpoint',idempotency_key:operation,request_digest:requestDigest});
   if(operationRecord.state==='COMMITTED')return record(operationRecord.result);
   if(operationRecord.state!=='PENDING')throw new SourceControlError('OPERATION_CANCELLED','Checkpoint operation is already terminal');
   const row=await this.row(tx,context,id,true);
   const raced=await replay(tx);if(raced)return raced;
   if(String(row.workspace_generation)!==generation||String(row.scope_generation)!==scopeGeneration||row.base_revision_id!==base)stale();
   for(const change of changes)within(change.path,row.write_paths,Boolean(context.workspace));
   await assertManagedObjectUploads(tx,context,changes.filter(change=>change.operation==='put').map(change=>change.object_id!));
   const revisionContext:SourceContext=context.assertCurrent?{...context,assertCurrent:(sql,action)=>context.assertCurrent!(sql,action==='source.revisions.create'?'source.workspaces.checkpoint':action)}:context;
   const receipt=await this.metadata.createRevisionInTransaction(tx,revisionContext,{operation_id:derivedOperation(context.scope,operation),idempotency_key:operation,change_id:id,
    root_tree_id:patched.root_tree_id,parent_revision_ids:[base],predecessor_revision_ids:row.checkpoint_revision_id?[row.checkpoint_revision_id]:[],
    provenance:{author:{name:'Hyperfide',email:''},message:'Workspace checkpoint',timestamp:new Date().toISOString()}});
   const updated=(await tx.query(`UPDATE hyperfide.source_workspaces SET base_revision_id=$6,root_tree_id=$7,checkpoint_revision_id=$6,workspace_generation=workspace_generation+1,updated_at=clock_timestamp()
    WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND workspace_id=$4 AND workspace_generation=$5 RETURNING *`,
    [...sourceScopeValues(context.scope),id,generation,receipt.revision_id,patched.root_tree_id])).rows[0];
   if(!updated)stale();
   const checkpointReceipt={schema_version:1,scope:context.scope,operation_id:operation,overlay_generation:overlay,workspace_generation:String(updated.workspace_generation),revision_receipt:receipt};
   const result={workspace:descriptor(updated),revision_id:receipt.revision_id,receipt:{...checkpointReceipt,result_digest:sourceDigest(checkpointReceipt)}};
   await tx.query('INSERT INTO hyperfide.source_workspace_checkpoints(organisation_id,repository_id,security_domain_id,principal_id,operation_id,workspace_id,request_digest,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [...sourceScopeValues(context.scope),context.principal_id,operation,id,requestDigest,JSON.stringify(result)]);
   await tx.query("UPDATE hyperfide.source_metadata_operations SET state='COMMITTED',result=$6,result_digest=$7,updated_at=clock_timestamp() WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND principal_id=$4 AND operation_id=$5 AND state='PENDING'",
    [...sourceScopeValues(context.scope),context.principal_id,operation,JSON.stringify(result),sourceDigest(result)]);
   return result;
  });
 }
}
