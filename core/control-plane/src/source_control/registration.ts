import type {Pool} from 'pg';
import type {Component,ComponentContext} from '../components/registry.js';
import {getPool} from '../storage/schema.js';
import {createSourceApi, type SourceApiAuthorizationRequest} from './api.js';
import {authorizeInvocationSource,authorizeSource,type SourceAuthorizationOptions} from './capabilities.js';
import {SourceMetadata,type SourceMetadataOptions} from './metadata.js';
import {PostgresSourceObjectCatalog} from './object_catalog.js';
import {SourceObjectService} from './objects.js';
import {PersistentTree} from './trees.js';
import {S3SourceObjectBackend,sourceS3Configuration} from './s3.js';
import type {SourceObjectBackend} from './storage_contract.js';
import {SourceWorkspaceService,type WorkspaceBudgets} from './workspaces.js';
import {SourceControlError} from './contracts.js';
import {SourceMergeEngine} from './merge.js';
import {SourceTransformationService,type MergeInput,type RebaseInput,type RevertInput,type ResumeInput} from './transformations.js';

function transformInput(input:unknown,allowed:readonly string[]):Record<string,unknown> {
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!allowed.includes(key)))
  throw new SourceControlError('INVALID_REQUEST','Source transformation fields differ from the versioned schema');
 return input as Record<string,unknown>;
}

export interface SourceServiceOptions {
 pool:Pool; backend:SourceObjectBackend; cursorKey:Uint8Array; workspaceBudgets:WorkspaceBudgets;
 authorization?:SourceAuthorizationOptions;
 transaction?:SourceMetadataOptions['transaction'];
}
export function createSourceService(options:SourceServiceOptions) {
 const metadata=new SourceMetadata(options.pool,options.transaction?{transaction:options.transaction}:{});
 const catalog=new PostgresSourceObjectCatalog({transaction:body=>metadata.transaction(tx=>body(tx))});
 const objects=new SourceObjectService(catalog,options.backend),trees=new PersistentTree(objects);
 const workspaces=new SourceWorkspaceService(metadata,trees,options.workspaceBudgets);
 const transformations=new SourceTransformationService(metadata,new SourceMergeEngine(objects,trees));
 const authorize=(request:SourceApiAuthorizationRequest)=>metadata.transaction(async tx=>{
  const common={scope:request.scope,action:request.action,mutation:request.mutation,...(request.paths?{paths:request.paths}:{}),
   ...(request.revision_id?{revision_id:request.revision_id}:{}),...(request.object_id?{object_id:request.object_id}:{}),...(request.authority?{authority:{...request.authority}}:{})};
  if(request.invocation)return authorizeInvocationSource(tx,{...common,invocation:request.invocation},options.authorization);
  if(request.principal)return authorizeSource(tx,{...common,principal:request.principal},options.authorization);
  throw new SourceControlError('UNAUTHENTICATED','Source request has no authenticated principal');
 });
 const api=createSourceApi({objects,trees,metadata,authorize,cursorKey:options.cursorKey,
  workspaceOperation:(context,operation)=>workspaces.operation(context,operation),
  extensions:{
   'source.transforms.merge':(request,context,principal)=>transformations.merge(context,{
    ...transformInput(request.input,['ours_revision_id','theirs_revision_id','base_revision_id','change_id','provenance','budget']),
    operation_id:request.operation_id,idempotency_key:request.idempotency_key??request.operation_id,
   } as MergeInput,'signal' in principal?{signal:principal.signal}:{}),
   'source.transforms.rebase':(request,context,principal)=>transformations.rebase(context,{
    ...transformInput(request.input,['revision_ids','onto_revision_id','budget','max_steps']),
    operation_id:request.operation_id,idempotency_key:request.idempotency_key??request.operation_id,
   } as RebaseInput,'signal' in principal?{signal:principal.signal}:{}),
   'source.transforms.revert':(request,context,principal)=>transformations.revert(context,{
    ...transformInput(request.input,['revision_id','onto_revision_id','mainline_parent_revision_id','change_id','provenance','budget']),
    operation_id:request.operation_id,idempotency_key:request.idempotency_key??request.operation_id,
   } as RevertInput,'signal' in principal?{signal:principal.signal}:{}),
   'source.transforms.read':(request,context)=>{
    const input=transformInput(request.input,['operation_id']);
    return transformations.read(context,input.operation_id as string);
   },
   'source.transforms.resume':(request,context,principal)=>transformations.resume(context,
    transformInput(request.input,['operation_id','max_steps','expected_generation','resolution']) as unknown as ResumeInput,
    'signal' in principal?{signal:principal.signal}:{}),
   'source.workspaces.open':(request,context)=>workspaces.open(context,request.input),
   'source.workspaces.detail':(request,context)=>workspaces.detail(context,request.input),
   'source.workspaces.checkpoint':(request,context)=>{
    const input=request.input as Record<string,unknown>;
    if(input.operation_id!==request.operation_id||request.idempotency_key!==undefined&&request.idempotency_key!==request.operation_id)
     throw new SourceControlError('IDEMPOTENCY_CONFLICT','Checkpoint envelope and overlay must name the same operation');
    return workspaces.checkpoint(context,input);
   },
  }});
 return {api,metadata,catalog,objects,trees,workspaces,transformations};
}
export function sourceWorkspaceBudgets(env:Readonly<NodeJS.ProcessEnv>):WorkspaceBudgets {
 const positive=(key:string)=>{const text=env[key];if(!text||!/^\d+$/.test(text)||!Number.isSafeInteger(Number(text))||Number(text)<1)throw new SourceControlError('CONFIGURATION_INVALID','Explicit positive source budget required: '+key);return Number(text);};
 return {cache_bytes:positive('HF_SOURCE_CACHE_BYTES'),max_cache_entries:positive('HF_SOURCE_CACHE_ENTRIES'),max_file_bytes:positive('HF_SOURCE_MAX_FILE_BYTES'),materialized_bytes:positive('HF_SOURCE_MATERIALIZED_BYTES'),dirty_bytes:positive('HF_SOURCE_DIRTY_BYTES')};
}
export function sourceCursorKey(env:Readonly<NodeJS.ProcessEnv>):Uint8Array {
 const text=env.HF_SOURCE_CURSOR_KEY;if(!text||!/^[A-Za-z0-9_-]+$/.test(text))throw new SourceControlError('CONFIGURATION_INVALID','A protected source cursor signing key is required');
 const key=Buffer.from(text,'base64url');if(key.length<32||key.length>64||key.toString('base64url')!==text)throw new SourceControlError('CONFIGURATION_INVALID','Source cursor key must contain 32 to 64 bytes');return key;
}
export function createComponent(context:ComponentContext):Component {
 const service=createSourceService({pool:getPool(context.env),backend:new S3SourceObjectBackend(sourceS3Configuration(context.env)),cursorKey:sourceCursorKey(context.env),workspaceBudgets:sourceWorkspaceBudgets(context.env),
  transaction:body=>context.resources.gateway.withPrimaryTransaction({timeoutMs:10000,maxRetries:2,signal:context.signal},body)});
 return {apiVersion:1,actions:Object.fromEntries(service.api.actions.map(action=>[action,async(input:unknown,current:ComponentContext)=>{
  if(!current.invocation)throw new SourceControlError('UNAUTHENTICATED','Authenticated source invocation required');
  return service.api.invoke(action,input,current.invocation);
 }])),capabilities:{'source.service.v1':service}};
}
