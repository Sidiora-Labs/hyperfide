import type {InvocationContext} from '../transport/protocol.js';
import {
  parseObjectId,parseRepositoryPath,parseSourceRequest,parseUUID,SourceControlError,
  SOURCE_CAPABILITIES,SOURCE_FORMAT,type SourceAuthority,type SourceRequest,type SourceScope,
} from './contracts.js';
import type {SourceAuthorization,SourcePrincipal} from './capabilities.js';
import type {SourceContext,SourceMetadata,RevisionInput} from './metadata.js';
import {decodeFileDescriptor,type SourceObjectService} from './objects.js';
import type {PersistentTree} from './trees.js';
import {SourceCursorCodec,type SourceCursorBinding} from './cursors.js';
import {SourceQueries,type QueryBudget} from './queries.js';

export const SOURCE_API_ACTIONS=[
  'source.capabilities','source.objects.put','source.objects.read','source.objects.inspect',
  'source.uploads.prepare','source.uploads.complete','source.trees.entries','source.trees.lookup','source.trees.patch',
  'source.revisions.create','source.revisions.read','source.changes.revisions','source.operations.read','source.operations.cancel',
  'source.queries.ancestry','source.queries.merge-bases','source.queries.history','source.queries.diff','source.queries.blame','source.queries.line-map',
  'source.subscriptions.create','source.subscriptions.poll','source.subscriptions.ack',
] as const;
export type SourceApiPrincipal=InvocationContext|SourcePrincipal;
export interface SourceApiAuthorizationRequest {
  invocation?:InvocationContext;principal?:SourcePrincipal;scope:SourceScope;action:string;
  paths?:readonly string[];revision_id?:string;object_id?:string;mutation:boolean;authority?:SourceAuthority;
}
export interface SourceApiDependencies {
  objects:SourceObjectService;trees:PersistentTree;metadata:SourceMetadata;cursorKey:Uint8Array;
  authorize(request:SourceApiAuthorizationRequest):Promise<SourceAuthorization>;
  workspaceOperation?:(context:SourceContext,operationId:string)=>Promise<unknown|null>;
  extensions?:Readonly<Record<string,(request:SourceRequest,context:SourceContext,principal:SourceApiPrincipal)=>Promise<unknown>>>;
}
function value(input:unknown):Record<string,unknown> {
  if(input===null||typeof input!=='object'||Array.isArray(input))throw new SourceControlError('INVALID_REQUEST','Source operation input must be an object');
  return input as Record<string,unknown>;
}
function objectView(input:unknown):unknown {
  if(input===null)return null;
  const row=value(input),result:Record<string,unknown>={};
  for(const field of ['organisation_id','repository_id','security_domain_id','object_id','kind','size_bytes','incarnation_id','generation','state','upload_id','operation_id','status','expires_at'])
    if(row[field]!==undefined)result[field]=row[field];
  return result;
}
function fields(input:Record<string,unknown>,allowed:readonly string[],required:readonly string[]):void {
  if(Object.keys(input).some(key=>!allowed.includes(key))||required.some(key=>!Object.hasOwn(input,key)))throw new SourceControlError('INVALID_REQUEST','Source action fields differ from its versioned schema');
}
function limit(input:unknown,fallback=128):number {
  if(input===undefined)return fallback;
  if(!Number.isSafeInteger(input)||Number(input)<1||Number(input)>256)throw new SourceControlError('LIMIT_EXCEEDED','Page size must be an integer between one and 256');
  return Number(input);
}
function base64(input:unknown):Buffer {
  if(typeof input!=='string'||input.length>12*1024*1024)throw new SourceControlError('INVALID_ENCODING','Canonical bounded base64 content required');
  const bytes=Buffer.from(input,'base64');if(bytes.length>SOURCE_FORMAT.max_object_bytes||bytes.toString('base64')!==input)throw new SourceControlError('INVALID_ENCODING','Noncanonical or excessive base64 content');return bytes;
}
function queryBudget(input:unknown,principal:SourceApiPrincipal):QueryBudget {
  const b=input===undefined?{}:value(input);fields(b,['max_nodes','max_bytes','max_ms'],[]);
  return {max_nodes:b.max_nodes===undefined?1024:b.max_nodes as number,max_bytes:b.max_bytes===undefined?4194304:b.max_bytes as number,max_ms:b.max_ms===undefined?5000:b.max_ms as number,...('signal' in principal?{signal:principal.signal}:{})};
}
function requestPaths(action:string,input:Record<string,unknown>):string[]|undefined {
  if(action==='source.workspaces.detail'&&input.path!==undefined)return [parseRepositoryPath(input.path)];
  if(['source.workspaces.open','source.workspaces.create','source.workspaces.widen'].includes(action)) {
    if(!Array.isArray(input.read_paths)||!input.read_paths.length||input.read_paths.length>256)throw new SourceControlError('INVALID_REQUEST','Workspace requires explicit bounded source paths');
    return input.read_paths.map(path=>path===''?'':parseRepositoryPath(path));
  }
  if(action==='source.workspaces.checkpoint') {
    if(!Array.isArray(input.changes)||input.changes.length>256)throw new SourceControlError('LIMIT_EXCEEDED','Workspace checkpoint requires a bounded explicit patch');
    return input.changes.map(change=>parseRepositoryPath(value(change).path));
  }
  if(['source.trees.lookup','source.queries.blame','source.queries.line-map'].includes(action))return [parseRepositoryPath(input.path)];
  if(action==='source.trees.patch') {
    if(!Array.isArray(input.patches)||input.patches.length>256)throw new SourceControlError('LIMIT_EXCEEDED','Tree patch must be a bounded explicit change set');
    return input.patches.map(patch=>parseRepositoryPath(value(patch).path));
  }
  return undefined;
}
export function createSourceApi(dependencies:SourceApiDependencies) {
  const cursors=new SourceCursorCodec(dependencies.cursorKey),extensions=dependencies.extensions??{};
  const supported=[...SOURCE_API_ACTIONS,...Object.keys(extensions)];
  return {
    actions:supported,
    async invoke(action:string,raw:unknown,principal:SourceApiPrincipal):Promise<unknown> {
      const request=parseSourceRequest(raw);
      if(request.action!==action||!supported.includes(action))throw new SourceControlError('UNSUPPORTED_ACTION','Source action is unavailable');
      const input=value(request.input),mutation=/\.(put|patch|create|open|prepare|complete|cancel|checkpoint|widen|close|ack|manage)$/.test(action);
      const paths=requestPaths(action,input),authorization=await dependencies.authorize({scope:request.scope,action,mutation,
        ...('operation' in principal?{invocation:principal}:{principal}),...(paths?{paths}:{}),
        ...(typeof input.revision_id==='string'?{revision_id:input.revision_id}:{}),
        ...(typeof input.object_id==='string'?{object_id:input.object_id}:{}),...(request.authority?{authority:request.authority}:{})});
      const context:SourceContext=authorization;
      const query=value({...input});delete query.cursor;
      const binding=(snapshot:string):SourceCursorBinding=>({scope:request.scope,principal_id:authorization.principal_id,authority_epoch:authorization.authority_epoch,policy_version:authorization.policy_version,capability_id:authorization.capability_id,query:{action,input:query},snapshot});
      const page=(snapshot:string):unknown=>input.cursor===undefined?undefined:cursors.decode(binding(snapshot),String(input.cursor));
      const continuation=(snapshot:string,position:unknown):string|null=>position===null?null:cursors.encode(binding(snapshot),position);
      const reader={
        revision:(id:string)=>dependencies.metadata.readRevision(context,parseObjectId(id)),
        tree:(id:string,after:string|undefined,size:number)=>dependencies.trees.list(request.scope,parseObjectId(id),{limit:size,...(after===undefined?{}:{cursor:after})}),
        async file(revision:string,path:string):Promise<Uint8Array|null> {
          const record=await dependencies.metadata.readRevision(context,parseObjectId(revision)),entry=await dependencies.trees.lookup(request.scope,parseObjectId(record.root_tree_id),path);
          if(!entry)return null;
          if(entry.kind!=='file')throw new SourceControlError('INVALID_REQUEST','Text queries require a regular file');
          const descriptor=await dependencies.objects.read(request.scope,entry.object_id);
          if(descriptor.kind!=='file'||BigInt(decodeFileDescriptor(descriptor.payload).size_bytes)>2097152n)throw new SourceControlError('LIMIT_EXCEEDED','Text query file exceeds its 2 MiB budget');
          return dependencies.objects.readFile(request.scope,entry.object_id);
        },
      };
      const queries=new SourceQueries(reader),scope=request.scope;
      if(action==='source.capabilities') {
        fields(input,[],[]);
        return {...SOURCE_CAPABILITIES,actions:supported,capabilities:['api-only','scoped-objects','durable-operations','bounded-history','bounded-diff']};
      }
      if(action==='source.objects.put') {
        fields(input,['kind','payload_base64'],['kind','payload_base64']);
        return objectView(await dependencies.objects.put(scope,input.kind as Parameters<SourceObjectService['put']>[1],base64(input.payload_base64),request.operation_id));
      }
      if(action==='source.objects.read') {
        fields(input,['object_id'],['object_id']);const result=await dependencies.objects.read(scope,parseObjectId(input.object_id));
        return {object_id:result.object_id,kind:result.kind,payload_base64:Buffer.from(result.payload).toString('base64'),byte_length:String(result.payload.byteLength)};
      }
      if(action==='source.objects.inspect') {fields(input,['object_id'],['object_id']);return objectView(await dependencies.objects.inspect(scope,parseObjectId(input.object_id)));}
      if(action==='source.uploads.prepare') {
        fields(input,['kind','object_id','size_bytes'],['kind','object_id','size_bytes']);
        if(typeof input.size_bytes!=='string')throw new SourceControlError('INVALID_REQUEST','Upload size must be a canonical decimal string');
        return objectView(await dependencies.objects.beginUpload(scope,{operation_id:request.operation_id,owner_principal_id:authorization.principal_id,kind:input.kind as Parameters<SourceObjectService['put']>[1],object_id:parseObjectId(input.object_id),size_bytes:input.size_bytes}));
      }
      if(action==='source.uploads.complete') {fields(input,['upload_id'],['upload_id']);return objectView(await dependencies.objects.completeUpload(scope,parseUUID(input.upload_id)));}
      if(action==='source.trees.entries') {
        fields(input,['tree_id','limit','cursor'],['tree_id']);const id=parseObjectId(input.tree_id),position=page(id);
        if(position!==undefined&&typeof position!=='string')throw new SourceControlError('INVALID_CURSOR','Directory cursor must address an exact name');
        const result=await dependencies.trees.list(scope,id,{limit:limit(input.limit),...(position===undefined?{}:{cursor:position as string})});
        return {...result,next_cursor:continuation(id,result.next_cursor),tree_id:id,coverage:{state:result.next_cursor===null?'COMPLETE':'PARTIAL'}};
      }
      if(action==='source.trees.lookup') {fields(input,['tree_id','path'],['tree_id','path']);return {entry:await dependencies.trees.lookup(scope,parseObjectId(input.tree_id),parseRepositoryPath(input.path))};}
      if(action==='source.trees.patch') {
        fields(input,['tree_id','patches'],['tree_id','patches']);
        return dependencies.trees.patch(scope,parseObjectId(input.tree_id),input.patches as Parameters<PersistentTree['patch']>[2]);
      }
      if(action==='source.revisions.create') {
        fields(input,['change_id','root_tree_id','parent_revision_ids','predecessor_revision_ids','provenance'],['change_id','root_tree_id','parent_revision_ids','predecessor_revision_ids','provenance']);
        if(!request.idempotency_key)throw new SourceControlError('INVALID_REQUEST','Revision mutation requires a stable idempotency key');
        return dependencies.metadata.createRevision(context,{...input,operation_id:request.operation_id,idempotency_key:request.idempotency_key} as RevisionInput);
      }
      if(action==='source.revisions.read') {fields(input,['revision_id'],['revision_id']);return dependencies.metadata.readRevision(context,parseObjectId(input.revision_id));}
      if(action==='source.changes.revisions') {
        fields(input,['change_id','limit','cursor'],['change_id']);const id=parseUUID(input.change_id),position=page(id);
        if(position!==undefined&&typeof position!=='string')throw new SourceControlError('INVALID_CURSOR','Change cursor is malformed');
        const result=await dependencies.metadata.changeRevisions(context,id,{limit:limit(input.limit),...(position===undefined?{}:{after:position as string})});
        return {...result,next_cursor:continuation(id,result.next_cursor)};
      }
      if(action==='source.operations.read') {
        fields(input,['operation_id'],['operation_id']);const id=parseUUID(input.operation_id),workspace=await dependencies.workspaceOperation?.(context,id);
        if(workspace!==null&&workspace!==undefined) {
          const result=value(workspace);return {...result,state:result.state==='COMMITTED'?'SUCCEEDED':result.state==='PENDING'?'ADMITTED':result.state};
        }
        const result=await dependencies.metadata.operation(context,id);
        return {...result,state:result.state==='COMMITTED'?'SUCCEEDED':result.state==='PENDING'?'ADMITTED':result.state};
      }
      if(action==='source.operations.cancel') {
        fields(input,['operation_id'],['operation_id']);const result=await dependencies.metadata.cancel(context,parseUUID(input.operation_id));
        return {...result,operation:{...result.operation,state:result.operation.state==='COMMITTED'?'SUCCEEDED':result.operation.state==='PENDING'?'ADMITTED':result.operation.state}};
      }
      if(action==='source.subscriptions.create') {
        fields(input,['consumer_id','bootstrap_revision_id'],['consumer_id','bootstrap_revision_id']);
        return dependencies.metadata.subscribe(context,{consumer_id:parseUUID(input.consumer_id),bootstrap_revision_id:parseObjectId(input.bootstrap_revision_id)});
      }
      if(action==='source.subscriptions.poll') {
        fields(input,['consumer_id','subscription_epoch','limit','lease_ms'],['consumer_id','subscription_epoch']);
        return dependencies.metadata.pollEvents(context,{consumer_id:parseUUID(input.consumer_id),subscription_epoch:parseUUID(input.subscription_epoch),limit:limit(input.limit),...(input.lease_ms===undefined?{}:{lease_ms:Number(input.lease_ms)})});
      }
      if(action==='source.subscriptions.ack') {
        fields(input,['consumer_id','subscription_epoch','event_id','lease_id'],['consumer_id','subscription_epoch','event_id','lease_id']);
        return dependencies.metadata.acknowledgeEvent(context,{consumer_id:parseUUID(input.consumer_id),subscription_epoch:parseUUID(input.subscription_epoch),event_id:parseUUID(input.event_id),lease_id:parseUUID(input.lease_id)});
      }
      if(action==='source.queries.history') {
        fields(input,['revision_id','limit','cursor','budget'],['revision_id']);const id=parseObjectId(input.revision_id),result=await queries.history(id,limit(input.limit),queryBudget(input.budget,principal),page(id));
        const {continuation:position,...response}=result;return {...response,next_cursor:continuation(id,position),revision_id:id};
      }
      if(action==='source.queries.ancestry') {
        fields(input,['ancestor_revision_id','descendant_revision_id','cursor','budget'],['ancestor_revision_id','descendant_revision_id']);
        const ancestor=parseObjectId(input.ancestor_revision_id),descendant=parseObjectId(input.descendant_revision_id),snapshot=ancestor+':'+descendant;
        const result=await queries.ancestry(ancestor,descendant,queryBudget(input.budget,principal),page(snapshot));
        const {continuation:position,...response}=result;return {...response,next_cursor:continuation(snapshot,position)};
      }
      if(action==='source.queries.merge-bases') {
        fields(input,['left_revision_id','right_revision_id','budget'],['left_revision_id','right_revision_id']);
        return queries.mergeBases(parseObjectId(input.left_revision_id),parseObjectId(input.right_revision_id),queryBudget(input.budget,principal));
      }
      if(action==='source.queries.diff') {
        fields(input,['before_revision_id','after_revision_id','limit','cursor','budget'],['before_revision_id','after_revision_id']);
        const before=parseObjectId(input.before_revision_id),after=parseObjectId(input.after_revision_id),snapshot=before+':'+after;
        const [a,b]=await Promise.all([reader.revision(before),reader.revision(after)]),result=await queries.diff(a.root_tree_id,b.root_tree_id,limit(input.limit),queryBudget(input.budget,principal),page(snapshot));
        const {continuation:position,...response}=result;return {...response,next_cursor:continuation(snapshot,position),before_revision_id:before,after_revision_id:after};
      }
      if(action==='source.queries.line-map') {
        fields(input,['before_revision_id','after_revision_id','path','budget'],['before_revision_id','after_revision_id','path']);
        return queries.lineMap(parseObjectId(input.before_revision_id),parseObjectId(input.after_revision_id),parseRepositoryPath(input.path),queryBudget(input.budget,principal));
      }
      if(action==='source.queries.blame') {
        fields(input,['revision_id','path','budget','start_line','limit','cursor'],['revision_id','path']);
        const id=parseObjectId(input.revision_id),position=page(id),start=position??input.start_line??1;
        if(typeof start!=='number')throw new SourceControlError('INVALID_CURSOR','Blame cursor must address a line');
        const result=await queries.blame(id,parseRepositoryPath(input.path),queryBudget(input.budget,principal),{start_line:start,limit:limit(input.limit)});
        const {next_line:next,...response}=result;return {...response,next_cursor:next===undefined?null:continuation(id,next)};
      }
      if(extensions[action])return extensions[action]!(request,context,principal);
      throw new SourceControlError('UNSUPPORTED_ACTION','Source operation is not implemented');
    },
  };
}
