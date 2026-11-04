import type {Pool} from 'pg';
import type {Component,ComponentContext} from '../components/registry.js';
import {getPool} from '../storage/schema.js';
import {isIdentityAuthority} from '../identity/enrollment.js';
import {FoundationError} from '../policy/programme.js';
import {createSourceApi, type SourceApiAuthorizationRequest} from './api.js';
import {authorizeInvocationSource,authorizeSource,type SourceAuthorizationOptions,type SourceAuthorization} from './capabilities.js';
import {SourceMetadata,type SourceMetadataOptions} from './metadata.js';
import {SourceObjectService} from './objects.js';
import {PersistentTree} from './trees.js';
import {S3SourceObjectBackend,sourceS3Configuration} from './s3.js';
import type {SourceObjectBackend,SourceDeletionBackend} from './storage_contract.js';
import {SourceWorkspaceService,type WorkspaceBudgets} from './workspaces.js';
import {SourceControlError,SOURCE_ACTIONS} from './contracts.js';
import {SourceMergeEngine} from './merge.js';
import {SourceTransformationService,type MergeInput,type RebaseInput,type RevertInput,type ResumeInput} from './transformations.js';
import {SourceCandidateService} from './candidates.js';
import {SourceAcceptanceService} from './acceptance.js';
import {SourceCandidateQueue} from './candidate_queue.js';
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
import {SourceRetentionService} from './retention.js';
import {SourceTransferService,sourceTransferOptions,SOURCE_TRANSFER_PATH,type SourceTransferOptions} from './transfers.js';
import {SourceMigrationService,sourceMigrationControls,type SourceMigrationControls} from './migration/cutover.js';
import {SourceBackupService} from './backup.js';
import {SourceRecoveryService,type SourceRecoveryAuthority} from './recovery.js';
import {SourceRoutingService,SourceRoutedObjectCatalog} from './routing.js';
import {SourceMetricsService} from './metrics.js';
import {lookupAuthorityActivation} from '../storage/durability.js';
import {NativeSourceGraph,sourceGraphConfiguration,type NativeGraphOptions} from './graph-adapter.js';
import {SourceGitImporter} from './git/import.js';
import {sourceImportSources,type GitImportSource} from './git/import_transport.js';

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
 invokeBatchMember?:(request:SourceRequest,parent:InvocationContext,signal:AbortSignal)=>Promise<unknown>;
 authorization?:SourceAuthorizationOptions;
 transaction?:SourceMetadataOptions['transaction'];
 publication?:{destinations:readonly SourceGitDestination[]};
 imports?:{sources:readonly GitImportSource[]};
 graph?:NativeGraphOptions;
 migration?:SourceMigrationControls;
 recoveryAuthority?:SourceRecoveryAuthority;
 routing_owner_id?:string;
 transfers?:SourceTransferOptions;
}
export function createSourceService(options:SourceServiceOptions) {
 const metadata=new SourceMetadata(options.pool,options.transaction?{transaction:options.transaction}:{});
 const database={transaction:<T>(body:(tx:import('./storage_contract.js').SourceTransaction)=>Promise<T>)=>metadata.transaction(tx=>body(tx))};
 const catalog=new SourceRoutedObjectCatalog(database,options.routing_owner_id??null);
 const objects=new SourceObjectService(catalog,options.backend),trees=new PersistentTree(objects);
 const workspaces=new SourceWorkspaceService(metadata,trees,options.workspaceBudgets);
 const retention='delete' in options.backend&&typeof options.backend.delete==='function'?new SourceRetentionService(metadata,options.backend as SourceDeletionBackend):undefined;
 const requireRetention=()=>{if(!retention)throw new SourceControlError('CAPABILITY_UNAVAILABLE','Object storage does not support conditional collection');return retention;};
 const graph=new NativeSourceGraph(metadata,trees,objects,options.graph,options.cursorKey);
 const imports=new SourceGitImporter(metadata,objects,trees,options.imports?.sources??[]);
 const migration=new SourceMigrationService(metadata,objects,trees,options.imports?.sources??[],options.migration,async(tx,context,id)=>{const accepted=await acceptance.authorizeAcceptance(tx,context,id);return {revision_id:accepted.revision_id,root_tree_id:accepted.root_tree_id};});
 const backups=new SourceBackupService(metadata,options.backend);
 const recovery=new SourceRecoveryService(metadata,backups,options.recoveryAuthority,(context,input,signal)=>publications.reconcileRecovery(context,input,signal));
 const routing=new SourceRoutingService(metadata);
 const metrics=new SourceMetricsService(metadata);
 const transformations=new SourceTransformationService(metadata,new SourceMergeEngine(objects,trees));
 const assurance=new NativeSourceAssurance(metadata,objects);
 const candidates=new SourceCandidateService(metadata,assurance.verifyEvidence.bind(assurance));
 const acceptance=new SourceAcceptanceService(candidates);
 const candidateQueue=new SourceCandidateQueue(candidates,assurance.verifyFailedEvidence.bind(assurance));
 const fleet=new SourceFleetService(metadata,options.workspaceBudgets);
 const fleetSelection=new SourceFleetSelectionService(metadata,acceptance);
 const fleetQualification=new NativeFleetQualification(candidates,assurance);
 const authorization={assertManagedAuthority:assertFleetManagedAuthority,...options.authorization};
 const transfers=new SourceTransferService(metadata,objects,options.transfers?{...options.transfers,authorization:{...authorization,...options.transfers.authorization}}:undefined);
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
  authorizePath:async(tx,context,path)=>{if(!('assertCurrent' in context)||typeof context.assertCurrent!=='function')throw new SourceControlError('SCOPE_DENIED','Publication requires current path authority');await (context as SourceAuthorization).assertCurrent(tx,'source.publications.resume',[path]);},
 });
 const authorize=(request:SourceApiAuthorizationRequest)=>metadata.transaction(async tx=>{
  const common={scope:request.scope,action:request.action,mutation:request.mutation,...(request.paths?{paths:request.paths}:{}),
   ...(request.revision_id?{revision_id:request.revision_id}:{}),...(request.object_id?{object_id:request.object_id}:{}),...(request.authority?{authority:{...request.authority}}:{})};
  if(request.invocation)return authorizeInvocationSource(tx,{...common,invocation:request.invocation},authorization);
  if(request.principal)return authorizeSource(tx,{...common,principal:request.principal},authorization);
  throw new SourceControlError('UNAUTHENTICATED','Source request has no authenticated principal');
 });
 const api=createSourceApi({objects,trees,metadata,authorize,cursorKey:options.cursorKey,...(options.invokeBatchMember?{invokeBatchMember:options.invokeBatchMember}:{}),
  workspaceOperation:(context,operation)=>workspaces.operation(context,operation),
  extensions:{
   'source.workspaces.widen':(request,context)=>workspaces.widen(context,mutationInput(request,['workspace_id','expected_workspace_generation','expected_scope_generation','read_paths','write_paths'])),
   'source.queue.enqueue':(request,context)=>candidateQueue.enqueue(context,mutationInput(request,["candidate_ids", "expires_at", "max_attempts"]) as unknown as Parameters<SourceCandidateQueue['enqueue']>[1]),
   'source.queue.claim':(request,context)=>candidateQueue.claim(context,mutationInput(request,["lease_ms"]) as unknown as Parameters<SourceCandidateQueue['claim']>[1]),
   'source.queue.bind':(request,context)=>candidateQueue.bind(context,mutationInput(request,["batch_id", "lease_id", "candidate_id"]) as unknown as Parameters<SourceCandidateQueue['bind']>[1]),
   'source.queue.complete':(request,context)=>candidateQueue.complete(context,mutationInput(request,["batch_id", "lease_id", "qualification_id"]) as unknown as Parameters<SourceCandidateQueue['complete']>[1]),
   'source.queue.fail':(request,context)=>candidateQueue.fail(context,mutationInput(request,["batch_id", "lease_id", "evidence_ids"]) as unknown as Parameters<SourceCandidateQueue['fail']>[1]),
   'source.queue.isolate':(request,context)=>candidateQueue.isolate(context,mutationInput(request,["batch_id", "lease_id", "partitions"]) as unknown as Parameters<SourceCandidateQueue['isolate']>[1]),
   'source.queue.read':(request,context)=>candidateQueue.read(context,actionInput(request.input,['batch_id']).batch_id as string),
   'source.transfers.create':(request,context)=>transfers.create(context,actionInput(request.input,['transfer_id','direction','object_id','kind','size_bytes','expires_at','paths','revision_id']) as unknown as Parameters<SourceTransferService['create']>[1]),
   'source.metrics.read':(request,context)=>metrics.read(context,actionInput(request.input,['max_rows']) as {max_rows?:number}),
   'source.transfers.read':(request,context)=>transfers.read(context,actionInput(request.input,['transfer_id']).transfer_id as string),
   'source.transfers.complete':(request,context)=>transfers.complete(context,actionInput(request.input,['transfer_id','object_id']) as unknown as Parameters<SourceTransferService['complete']>[1]),
   'source.transfers.cancel':(request,context)=>transfers.cancel(context,actionInput(request.input,['transfer_id']).transfer_id as string),
   'source.migration.prepare':(request,context)=>migration.prepare(context,request.input),
   'source.migration.refresh':(request,context)=>migration.refresh(context,mutationInput(request,['migration_id','expected_generation','manifest']) as unknown as Parameters<SourceMigrationService['refresh']>[1]),
   'source.migration.stage':(request,context)=>migration.stage(context,request.input,request.operation_id),
   'source.migration.read':(request,context)=>migration.read(context,actionInput(request.input,['migration_id']).migration_id as string),
   'source.migration.consolidate':(request,context)=>migration.consolidate(context,mutationInput(request,['migration_id','expected_generation']) as unknown as Parameters<SourceMigrationService['consolidate']>[1]),
   'source.migration.parity':(request,context)=>migration.parity(context,mutationInput(request,['migration_id','expected_generation']) as unknown as Parameters<SourceMigrationService['parity']>[1]),
   'source.migration.quiesce':(request,context)=>migration.quiesce(context,mutationInput(request,['migration_id','expected_generation']) as unknown as Parameters<SourceMigrationService['quiesce']>[1]),
   'source.migration.activate':(request,context)=>migration.activate(context,mutationInput(request,['migration_id','expected_generation','acceptance_id']) as unknown as Parameters<SourceMigrationService['activate']>[1]),
   'source.migration.abort':(request,context)=>migration.abort(context,mutationInput(request,['migration_id','expected_generation']) as unknown as Parameters<SourceMigrationService['abort']>[1]),
   'source.migration.recover':(request,context)=>migration.recover(context,mutationInput(request,['migration_id','expected_generation']) as unknown as Parameters<SourceMigrationService['recover']>[1]),
   'source.backups.create':(request,context)=>backups.create(context,actionInput(request.input,['backup_id','profile','expires_at','max_revisions','max_objects','max_bytes']) as unknown as Parameters<SourceBackupService['create']>[1]),
   'source.backups.read':(request,context)=>backups.read(context,actionInput(request.input,['backup_id']).backup_id as string),
   'source.backups.verify':(request,context)=>backups.verify(context,actionInput(request.input,['backup_id','limit']) as unknown as Parameters<SourceBackupService['verify']>[1]),
   'source.recovery.profile':async request=>recovery.profile(request.input),
   'source.recovery.readiness':(request,context)=>recovery.readiness(context,actionInput(request.input,['backup_id']) as unknown as Parameters<SourceRecoveryService['readiness']>[1]),
   'source.recovery.reconcile':(request,context,principal)=>recovery.reconcile(context,actionInput(request.input,['backup_id','operation_id','limit']) as unknown as Parameters<SourceRecoveryService['reconcile']>[1],'signal' in principal?principal.signal:undefined),
   'source.recovery.prepare':(request,context)=>recovery.prepare(context,mutationInput(request,['backup_id','expected_external_epoch','expected_database_epoch','activated_epoch']) as unknown as Parameters<SourceRecoveryService['prepare']>[1]),
   'source.recovery.activate':(request,context)=>recovery.activate(context,mutationInput(request,['backup_id','expected_external_epoch','expected_database_epoch','activated_epoch']) as unknown as Parameters<SourceRecoveryService['activate']>[1]),
   'source.routing.read':(request,context)=>routing.read(context,actionInput(request.input,['partition']) as unknown as Parameters<SourceRoutingService['read']>[1]),
   'source.routing.move':(request,context)=>routing.move(context,mutationInput(request,['partition','expected_generation','owner_id']) as unknown as Parameters<SourceRoutingService['move']>[1]),

   'source.retention.configure':(request,context)=>requireRetention().configure(context,actionInput(request.input,['expected_generation','minimum_age_seconds','quarantine_seconds','backup_until','backend_identity','independent_expiration']) as unknown as Parameters<SourceRetentionService['configure']>[1]),
   'source.retention.acquire':(request,context)=>requireRetention().acquire(context,actionInput(request.input,['root_id','owner_kind','owner_id','object_id','expires_at']) as unknown as Parameters<SourceRetentionService['acquire']>[1]),
   'source.retention.release':(request,context)=>requireRetention().release(context,actionInput(request.input,['root_id','owner_kind','owner_id']) as unknown as Parameters<SourceRetentionService['release']>[1]),
   'source.retention.reserve':(request,context)=>requireRetention().reserve(context,actionInput(request.input,['reservation_id','parent_object_id','parent_incarnation_id','child_object_id','child_incarnation_id','position']) as unknown as Parameters<SourceRetentionService['reserve']>[1]),
   'source.retention.reconcile':(request,context)=>requireRetention().reconcile(context,actionInput(request.input,['reservation_id']) as unknown as Parameters<SourceRetentionService['reconcile']>[1]),
   'source.collection.discover':(request,context)=>requireRetention().discover(context,actionInput(request.input,['partition','limit']) as unknown as Parameters<SourceRetentionService['discover']>[1]),
   'source.collection.collect':(request,context,principal)=>requireRetention().collect(context,actionInput(request.input,['partition','limit']) as unknown as Parameters<SourceRetentionService['collect']>[1],'signal' in principal?principal.signal:undefined),
   'source.collection.inspect':(request,context)=>requireRetention().inspect(context,actionInput(request.input,['partition','limit','after']) as unknown as Parameters<SourceRetentionService['inspect']>[1]),
   'source.graph.build':(request,context,principal)=>graph.build(context,actionInput(request.input,['build_id','revision_id','root_tree_id','paths','configuration','previous_build_id','overlay','budgets']) as unknown as Parameters<NativeSourceGraph['build']>[1],'signal' in principal?principal.signal:undefined),
   'source.graph.publish':(request,context)=>graph.publish(context,mutationInput(request,['build_id','channel','expected_generation']) as unknown as Parameters<NativeSourceGraph['publish']>[1]),
   'source.graph.query':(request,context)=>graph.query(context,actionInput(request.input,['build_id','revision_id','root_tree_id','mode','path','q','limit','cursor']) as unknown as Parameters<NativeSourceGraph['query']>[1]),
   'source.imports.create':(request,context)=>imports.create(context,actionInput(request.input,['import_id','source_id','tip_oid','base_revision_id','policy_id','policy_version','budget']) as unknown as Parameters<SourceGitImporter['create']>[1]),
   'source.imports.read':(request,context)=>imports.read(context,actionInput(request.input,['import_id']).import_id as string),
   'source.imports.resume':(request,context,principal)=>imports.resume(context,actionInput(request.input,['import_id']).import_id as string,'signal' in principal?principal.signal:undefined),
   'source.imports.mappings':(request,context)=>{const input=actionInput(request.input,['import_id','after','limit']);return imports.mappings(context,input.import_id as string,input as Parameters<SourceGitImporter['mappings']>[2]);},
   'source.projections.create':(request,context)=>imports.provenance.createPolicy(context,request.input),
   'source.projections.read':(request,context)=>{const input=actionInput(request.input,['policy_id','version']);return imports.provenance.readPolicy(context,input.policy_id as string,input.version as number);},
   'source.contributions.create':(request,context)=>imports.createContribution(context,actionInput(request.input,['import_id','source_id','tip_oid','base_revision_id','policy_id','policy_version','budget','contribution_id','provider','provider_identity']) as unknown as Parameters<SourceGitImporter['createContribution']>[1]),
   'source.contributions.read':(request,context)=>imports.readContribution(context,actionInput(request.input,['contribution_id']).contribution_id as string),

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
   'source.workspaces.close':(request,context)=>workspaces.close(context,mutationInput(request,['workspace_id','expected_workspace_generation'])),
   'source.workspaces.detail':(request,context)=>workspaces.detail(context,request.input),
   'source.workspaces.checkpoint':(request,context)=>{
    const input=request.input as Record<string,unknown>;
    if(input.operation_id!==request.operation_id||request.idempotency_key!==undefined&&request.idempotency_key!==request.operation_id)
     throw new SourceControlError('IDEMPOTENCY_CONFLICT','Checkpoint envelope and overlay must name the same operation');
    return workspaces.checkpoint(context,input);
   },
  }});
 return {api,metadata,catalog,objects,trees,workspaces,retention,graph,imports,migration,backups,recovery,routing,metrics,transfers,transformations,assurance,candidates,candidateQueue,acceptance,publications,fleet,fleetSelection,fleetQualification,verifyFleetManifest};
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
 const restoreAuthority=context.dependencies.require('4.4','storage.authority.v1',(value:unknown):value is {assertExternalCurrent:(options:{signal:AbortSignal})=>Promise<unknown>}=>Boolean(value&&typeof (value as any).assertExternalCurrent==='function'));
 const recoveryAuthority:SourceRecoveryAuthority={verify:async input=>{if(!context.env.HYPERFIDE_DEPLOYMENT_ID)throw new SourceControlError('CONFIGURATION_INVALID','Recovery requires the current deployment identity');const receipt=await lookupAuthorityActivation(context.resources,{deployment_id:context.env.HYPERFIDE_DEPLOYMENT_ID,operation_id:input.operation_id,expected_previous_epoch:input.expected_external_epoch,database_predecessor_epoch:input.expected_database_epoch,epoch:input.activated_epoch,signal:context.signal});await restoreAuthority.assertExternalCurrent({signal:context.signal});return {epoch:receipt.epoch,proof_digest:receipt.evidence_digest,deployment_id:receipt.deployment_id};}};
 let service:ReturnType<typeof createSourceService>|undefined;
 const current=()=>service??=createSourceService({invokeBatchMember:async(request,parent,signal)=>{
  if(!identity.deriveSourceRead||!context.dispatchInvocation)throw new SourceControlError('AUTH_SCOPE_DENIED','Authenticated child dispatch is unavailable');
  return context.dispatchInvocation(await identity.deriveSourceRead(parent,request,signal));
 },pool:getPool(context.env),backend:new S3SourceObjectBackend(sourceS3Configuration(context.env)),cursorKey:sourceCursorKey(context.env),workspaceBudgets:sourceWorkspaceBudgets(context.env),
  publication:{destinations:sourcePublicationDestinations(context.env)},transfers:{...sourceTransferOptions(identity.origin+SOURCE_TRANSFER_PATH,sourceCursorKey(context.env)),guardNativePrincipal:(tx,principal)=>identity.guard(tx as Parameters<typeof identity.guard>[0],principal)},recoveryAuthority,...(context.env.HF_SOURCE_ROUTING_OWNER_ID?{routing_owner_id:context.env.HF_SOURCE_ROUTING_OWNER_ID}:{}),...(sourceMigrationControls(context.env)?{migration:sourceMigrationControls(context.env)!}:{}),imports:{sources:sourceImportSources(context.env)},...(sourceGraphConfiguration(context.env)?{graph:sourceGraphConfiguration(context.env)!}:{}),
  transaction:body=>context.resources.gateway.withPrimaryTransaction({timeoutMs:10000,maxRetries:2,signal:context.signal},body)});
 const identity=context.dependencies.require('14.1','identity.authority',isIdentityAuthority);
 identity.installSourceWorkerEnroller(async(tx,invocation,credentialId)=>{try{return await current().fleet.enrollWorker(tx,invocation,credentialId);}catch(error){if(error instanceof SourceControlError)throw new FoundationError(error.code,error.message);throw error;}});
 const capability=new Proxy({} as ReturnType<typeof createSourceService>,{get:(_target,key)=>Reflect.get(current(),key)});
 return {apiVersion:1,actions:Object.fromEntries(SOURCE_ACTIONS.map(action=>[action,async(input:unknown,request:ComponentContext)=>{
  if(!request.invocation)throw new SourceControlError('UNAUTHENTICATED','Authenticated source invocation required');
  return current().api.invoke(action,input,request.invocation);
 }])),capabilities:{'source.service.v1':capability}};
}
