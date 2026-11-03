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
import {SourceControlError,SOURCE_ACTIONS} from './contracts.js';
import {SourceMergeEngine} from './merge.js';
import {SourceTransformationService,type MergeInput,type RebaseInput,type RevertInput,type ResumeInput} from './transformations.js';
import {SourceCandidateService} from './candidates.js';
import {SourceAcceptanceService} from './acceptance.js';
import {NativeSourceAssurance} from '../assurance/native_source.js';
import {SourceGitPublicationService} from './git/export.js';
import type {SourceGitDestination} from './git/types.js';
import {sourcePublicationDestinations} from './publication_config.js';
import type {SourceRequest} from './contracts.js';
import {SourceFleetSelectionService} from './fleet-source-selection.js';
import {SourceFleetService,assertFleetManagedAuthority} from './fleet-adapter.js';
import {NativeFleetQualification} from '../assurance/fleet_native.js';
import {createNativeSourceManifest,verifyFleetSourceManifest,type NativeSourceManifest} from '../preparation/fleet_source.js';
import type {InvocationContext} from '../transport/protocol.js';

function actionInput(input:unknown,allowed:readonly string[]):Record<string,unknown> {
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!allowed.includes(key)))
  throw new SourceControlError('INVALID_REQUEST','Source action fields differ from the versioned schema');
 return input as Record<string,unknown>;
}
function mutationInput(request:SourceRequest,allowed:readonly string[]):Record<string,unknown> {
 return {...actionInput(request.input,allowed),operation_id:request.operation_id,idempotency_key:request.idempotency_key??request.operation_id};
}

export interface SourceServiceOptions {
 pool:Pool; backend:SourceObjectBackend; cursorKey:Uint8Array; workspaceBudgets:WorkspaceBudgets;
 authorization?:SourceAuthorizationOptions;
 transaction?:SourceMetadataOptions['transaction'];
 publication?:{destinations:readonly SourceGitDestination[]};
}
export function createSourceService(options:SourceServiceOptions) {
 const metadata=new SourceMetadata(options.pool,options.transaction?{transaction:options.transaction}:{});
 const catalog=new PostgresSourceObjectCatalog({transaction:body=>metadata.transaction(tx=>body(tx))});
 const objects=new SourceObjectService(catalog,options.backend),trees=new PersistentTree(objects);
 const workspaces=new SourceWorkspaceService(metadata,trees,options.workspaceBudgets);
 const transformations=new SourceTransformationService(metadata,new SourceMergeEngine(objects,trees));
 const assurance=new NativeSourceAssurance(metadata,objects);
 const candidates=new SourceCandidateService(metadata,assurance.verifyEvidence.bind(assurance));
 const acceptance=new SourceAcceptanceService(candidates);
 const fleet=new SourceFleetService(metadata,options.workspaceBudgets);
 const fleetSelection=new SourceFleetSelectionService(metadata,acceptance);
 const fleetQualification=new NativeFleetQualification(candidates,assurance);
 const authorization={assertManagedAuthority:assertFleetManagedAuthority,...options.authorization};
 const verifyFleetManifest=async(invocation:InvocationContext,manifest:NativeSourceManifest):Promise<void>=>{
  const context=await metadata.transaction(tx=>authorizeInvocationSource(tx,{invocation,scope:manifest.scope,action:'source.fleet.manifest',mutation:false,revision_id:manifest.revision},authorization));
  verifyFleetSourceManifest(manifest,{digest:manifest.digest,revision:manifest.revision,repository:manifest.repository,readScope:manifest.paths,metadataOnly:manifest.transfer_mode==='metadata-only',backend:'native',scope:context.scope});
  const actual=await createNativeSourceManifest({metadata,trees,objects,authorization:context,repository:manifest.repository,revision:manifest.revision,paths:manifest.paths,maxFiles:100000,maxBytes:64*1024*1024,maxNodes:100000,metadataOnly:manifest.transfer_mode==='metadata-only'});
  if(actual.digest!==manifest.digest)throw new SourceControlError('FLEET_SOURCE_MANIFEST','Delivered source entries differ from their accepted native tree');
 };
 const publications=new SourceGitPublicationService(metadata,objects,trees,{
  destinations:options.publication?.destinations??[],
  acceptance:async(tx,context,id)=>{
   const receipt=await acceptance.authorizeAcceptance(tx,context,id);
   return {acceptance_id:receipt.acceptance_id,revision_id:receipt.revision_id,root_tree_id:receipt.root_tree_id,receipt_digest:receipt.result_digest};
  },
  authorizeRevision:async(tx,context,id)=>{await acceptance.authorizeAcceptedRevision(tx,context,id);},
 });
 const authorize=(request:SourceApiAuthorizationRequest)=>metadata.transaction(async tx=>{
  const common={scope:request.scope,action:request.action,mutation:request.mutation,...(request.paths?{paths:request.paths}:{}),
   ...(request.revision_id?{revision_id:request.revision_id}:{}),...(request.object_id?{object_id:request.object_id}:{}),...(request.authority?{authority:{...request.authority}}:{})};
  if(request.invocation)return authorizeInvocationSource(tx,{...common,invocation:request.invocation},authorization);
  if(request.principal)return authorizeSource(tx,{...common,principal:request.principal},authorization);
  throw new SourceControlError('UNAUTHENTICATED','Source request has no authenticated principal');
 });
 const api=createSourceApi({objects,trees,metadata,authorize,cursorKey:options.cursorKey,
  workspaceOperation:(context,operation)=>workspaces.operation(context,operation),
  extensions:{
   'source.fleet.select':(request,context,principal)=>fleetSelection.select(context,mutationInput(request,['selection_id','run_id','acceptance_id','expected_generation','leader_generation']) as unknown as Parameters<typeof fleetSelection.select>[1],'operation' in principal?principal:undefined),
   'source.fleet.selection':(request,context)=>fleetSelection.read(context,actionInput(request.input,['run_id','selection_id']) as unknown as Parameters<typeof fleetSelection.read>[1]),
   'source.fleet.manifest':(request,context)=>{
    const input=actionInput(request.input,['revision_id','paths','max_files','max_bytes','max_nodes','metadata_only']);
    for(const key of ['max_files','max_bytes','max_nodes'])if(!Number.isSafeInteger(input[key])||Number(input[key])<1)throw new SourceControlError('INVALID_REQUEST','Explicit positive source manifest budgets required');
    if(typeof input.metadata_only!=='boolean')throw new SourceControlError('INVALID_REQUEST','Explicit metadata-only selection required');
    return createNativeSourceManifest({metadata,trees,objects,authorization:context,repository:context.scope.repository_id,revision:input.revision_id as string,paths:input.paths as string[],maxFiles:input.max_files as number,maxBytes:input.max_bytes as number,maxNodes:input.max_nodes as number,metadataOnly:input.metadata_only});
   },
   'source.fleet.qualify':(request,context,principal)=>fleetQualification.qualify(context,mutationInput(request,['run_id','task_id','custody_id','custody_generation','candidate_id','qualification_id','expected_state_version']) as unknown as Parameters<typeof fleetQualification.qualify>[1],'operation' in principal?principal:undefined),
   'source.fleet.bind-run':(request,context,principal)=>fleet.bindRun(context,mutationInput(request,['run_id','revision_id','leader_generation']) as unknown as Parameters<typeof fleet.bindRun>[1],'operation' in principal?principal:undefined),
   'source.fleet.assign':(request,context,principal)=>fleet.assign(context,mutationInput(request,['assignment_id','run_id','task_id','attempt_id','attempt_generation','workspace_id','base_revision_id','closure_digest','environment_digest','read_paths','write_paths','mode','worker_principal_id','worker_credential_id','leader_generation','package_id','package_generation']) as unknown as Parameters<typeof fleet.assign>[1],'operation' in principal?principal:undefined),
   'source.fleet.read':(request,context)=>fleet.read(context,actionInput(request.input,['assignment_id']).assignment_id as string),
   'source.fleet.submit':(request,context,principal)=>fleet.submit(context,mutationInput(request,['assignment_id','expected_assignment_generation','expected_workspace_generation','revision_id']) as unknown as Parameters<typeof fleet.submit>[1],'operation' in principal?principal:undefined),
   'source.fleet.submission':(request,context)=>fleet.submission(context,actionInput(request.input,['submission_id']).submission_id as string),
   'source.domains.create':(request,context)=>candidates.createDomain(context,mutationInput(request,['domain_id','revision_id','policy_id','policy_digest']) as unknown as Parameters<typeof candidates.createDomain>[1]),
   'source.domains.read':(request,context)=>candidates.readDomain(context,actionInput(request.input,['domain_id']).domain_id as string),
   'source.domains.configure':(request,context)=>candidates.configureDomain(context,mutationInput(request,['domain_id','expected_generation','policy_id','policy_digest']) as unknown as Parameters<typeof candidates.configureDomain>[1]),
   'source.candidates.create':(request,context)=>candidates.create(context,mutationInput(request,['candidate_id','domain_id','expected_generation','expected_revision_id','revision_id','contributors','dependencies','inputs','transformation_version']) as unknown as Parameters<typeof candidates.create>[1]),
   'source.candidates.read':(request,context)=>candidates.read(context,actionInput(request.input,['candidate_id']).candidate_id as string),
   'source.candidates.qualify':(request,context)=>candidates.qualify(context,mutationInput(request,['candidate_id','evidence_ids']) as unknown as Parameters<typeof candidates.qualify>[1]),
   'source.acceptance.accept':(request,context)=>acceptance.accept(context,mutationInput(request,['candidate_id','qualification_id']) as unknown as Parameters<typeof acceptance.accept>[1]),
   'source.acceptance.read':(request,context)=>acceptance.read(context,actionInput(request.input,['acceptance_id']).acceptance_id as string),
   'source.assurance.custody.create':(request,context)=>assurance.registerCustody(context,mutationInput(request,['custody_id','custody_generation','revision_id','run_id','task_id']) as unknown as Parameters<typeof assurance.registerCustody>[1]),
   'source.assurance.publish':(request,context)=>assurance.publish(context,mutationInput(request,['candidate_id','check_id','receipt_object_id']) as unknown as Parameters<typeof assurance.publish>[1]),
   'source.assurance.revoke':(request,context)=>assurance.revoke(context,mutationInput(request,['evidence_id','custody_id']) as unknown as Parameters<typeof assurance.revoke>[1]),
   'source.publications.create':(request,context)=>publications.create(context,mutationInput(request,['acceptance_id','destination_id','target_ref','expected_old_oid']) as unknown as Parameters<typeof publications.create>[1]),
   'source.publications.read':(request,context)=>publications.read(context,actionInput(request.input,['operation_id']).operation_id as string),
   'source.publications.resume':(request,context,principal)=>publications.resume(context,actionInput(request.input,['operation_id']).operation_id as string,'signal' in principal?{signal:principal.signal}:{}),
   'source.publications.cancel':(request,context)=>publications.cancel(context,actionInput(request.input,['operation_id']).operation_id as string),
   'source.transforms.merge':(request,context,principal)=>transformations.merge(context,{
    ...actionInput(request.input,['ours_revision_id','theirs_revision_id','base_revision_id','change_id','provenance','budget']),
    operation_id:request.operation_id,idempotency_key:request.idempotency_key??request.operation_id,
   } as MergeInput,'signal' in principal?{signal:principal.signal}:{}),
   'source.transforms.rebase':(request,context,principal)=>transformations.rebase(context,{
    ...actionInput(request.input,['revision_ids','onto_revision_id','budget','max_steps']),
    operation_id:request.operation_id,idempotency_key:request.idempotency_key??request.operation_id,
   } as RebaseInput,'signal' in principal?{signal:principal.signal}:{}),
   'source.transforms.revert':(request,context,principal)=>transformations.revert(context,{
    ...actionInput(request.input,['revision_id','onto_revision_id','mainline_parent_revision_id','change_id','provenance','budget']),
    operation_id:request.operation_id,idempotency_key:request.idempotency_key??request.operation_id,
   } as RevertInput,'signal' in principal?{signal:principal.signal}:{}),
   'source.transforms.read':(request,context)=>{
    const input=actionInput(request.input,['operation_id']);
    return transformations.read(context,input.operation_id as string);
   },
   'source.transforms.resume':(request,context,principal)=>transformations.resume(context,
    actionInput(request.input,['operation_id','max_steps','expected_generation','resolution']) as unknown as ResumeInput,
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
 return {api,metadata,catalog,objects,trees,workspaces,transformations,assurance,candidates,acceptance,publications,fleet,fleetSelection,fleetQualification,verifyFleetManifest};
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
 let service:ReturnType<typeof createSourceService>|undefined;
 const current=()=>service??=createSourceService({pool:getPool(context.env),backend:new S3SourceObjectBackend(sourceS3Configuration(context.env)),cursorKey:sourceCursorKey(context.env),workspaceBudgets:sourceWorkspaceBudgets(context.env),
  publication:{destinations:sourcePublicationDestinations(context.env)},
  transaction:body=>context.resources.gateway.withPrimaryTransaction({timeoutMs:10000,maxRetries:2,signal:context.signal},body)});
 const reserved=new Set(['source.capabilities.manage','source.workspaces.widen','source.workspaces.close','source.transfers.create','source.audit.read']);
 const capability=new Proxy({} as ReturnType<typeof createSourceService>,{get:(_target,key)=>Reflect.get(current(),key)});
 return {apiVersion:1,actions:Object.fromEntries(SOURCE_ACTIONS.filter(action=>!reserved.has(action)).map(action=>[action,async(input:unknown,request:ComponentContext)=>{
  if(!request.invocation)throw new SourceControlError('UNAUTHENTICATED','Authenticated source invocation required');
  return current().api.invoke(action,input,request.invocation);
 }])),capabilities:{'source.service.v1':capability}};
}
