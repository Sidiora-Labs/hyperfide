import {randomUUID} from 'node:crypto';
import type {InvocationContext} from '../transport/protocol.js';
import {SourceControlError, SOURCE_ACTIONS, parseSourceScope, parseRepositoryPath, parseObjectId, type SourceScope} from './contracts.js';

export interface SourceSQL {query<R extends Record<string,any>=Record<string,any>>(sql:string,values?:unknown[]):Promise<{rows:R[];rowCount:number|null}>}
export type SourcePrincipalKind='human'|'automation'|'import'|'worker'|'service';
export interface SourcePrincipal {id:string;credential_id:string;organisation_id:string;kind:SourcePrincipalKind;expires_at:string;capability_id?:string;assertCurrent(tx:SourceSQL):Promise<void>}
export interface ManagedSourceBinding {workspace_id:string;generation:string;task_id?:string;attempt_id?:string;attempt_generation?:string}
export interface SourceAuthorizationRequest {principal:SourcePrincipal;scope:SourceScope;action:string;paths?:readonly string[];revision_id?:string;object_id?:string;mutation:boolean;authority?:unknown;capability_id?:string}
export interface SourceAuthorization {
 scope:SourceScope;principal_id:string;capability_id:string;authority_epoch:string;policy_version:string;path_prefixes:readonly string[];expires_at:string;workspace?:{workspace_id:string;generation:string};
 assertCurrent(tx:SourceSQL,action?:string,paths?:readonly string[]):Promise<void>;
 assertObjectAccess(tx:SourceSQL,input:{object_id:string;revision_id?:string;paths?:readonly string[]},action?:string):Promise<void>;
}
export interface SourceAuthorizationOptions {assertManagedAuthority?:(tx:SourceSQL,principal:SourcePrincipal,binding:ManagedSourceBinding)=>Promise<void>;assertObjectAccess?:(tx:SourceSQL,input:{scope:SourceScope;action:string;object_id:string;revision_id?:string;paths?:readonly string[];path_prefixes:readonly string[]})=>Promise<void>}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DECIMAL=/^(0|[1-9][0-9]{0,18})$/;
export const SOURCE_AUTHORIZATION_ACTIONS=new Set<string>(SOURCE_ACTIONS);
const MUTATIONS=new Set(['source.capabilities.manage','source.objects.put','source.uploads.prepare','source.uploads.complete','source.trees.patch','source.revisions.create','source.operations.cancel','source.workspaces.open','source.workspaces.create','source.workspaces.checkpoint','source.workspaces.widen','source.workspaces.close','source.subscriptions.create','source.subscriptions.ack','source.transfers.create']);
const METADATA_ONLY=new Set(['source.capabilities','source.operations.read','source.operations.cancel','source.workspaces.open','source.workspaces.create','source.workspaces.detail','source.workspaces.read','source.workspaces.checkpoint','source.workspaces.widen','source.workspaces.close']);
function denied():never {throw new SourceControlError('SCOPE_DENIED','Source action is not authorized');}
function invalid(message:string):never {throw new SourceControlError('INVALID_REQUEST',message);}
function id(value:unknown):value is string {return typeof value==='string'&&UUID.test(value);}
function generation(value:unknown):value is string {return typeof value==='string'&&DECIMAL.test(value)&&BigInt(value)<=9223372036854775807n;}
function timestamp(value:unknown):number {if(typeof value!=='string'||!Number.isFinite(Date.parse(value)))invalid('A source authority expiry is required');return Date.parse(value);}
function prefix(value:unknown):string {if(value==='')return '';return parseRepositoryPath(value);}
export function sourcePathWithin(path:string,prefixes:readonly string[]):boolean {const valid=prefix(path);return prefixes.some(p=>p===''||valid===p||valid.startsWith(p+'/'));}
function managed(value:unknown):ManagedSourceBinding|null {
 if(value===null||value===undefined)return null;
 if(typeof value!=='object'||Array.isArray(value))invalid('Managed source binding is malformed');
 const v=value as Record<string,unknown>;
 if(Object.keys(v).some(k=>!['workspace_id','generation','task_id','attempt_id','attempt_generation'].includes(k))||!id(v.workspace_id)||!generation(v.generation))invalid('Managed source binding is malformed');
 if(v.task_id!==undefined&&!id(v.task_id)||v.attempt_id!==undefined&&!id(v.attempt_id)||v.attempt_generation!==undefined&&!generation(v.attempt_generation))invalid('Managed source binding is malformed');
 if((v.attempt_id===undefined)!==(v.attempt_generation===undefined))invalid('Attempt identity and generation must be supplied together');
 return v as unknown as ManagedSourceBinding;
}
function matchingAuthority(binding:ManagedSourceBinding,value:unknown):boolean {
 if(!value||typeof value!=='object'||Array.isArray(value))return false;const authority=value as Record<string,unknown>;
 const workspace=(authority.workspace??authority) as Record<string,unknown>,attempt=(authority.managed??authority) as Record<string,unknown>;
 return workspace.workspace_id===binding.workspace_id&&(workspace.workspace_generation??workspace.generation)===binding.generation&&
  (binding.task_id===undefined||attempt.task_id===binding.task_id)&&(binding.attempt_id===undefined||attempt.attempt_id===binding.attempt_id)&&
  (binding.attempt_generation===undefined||attempt.attempt_generation===binding.attempt_generation);
}
export async function authorizeSource(tx:SourceSQL,request:SourceAuthorizationRequest,options:SourceAuthorizationOptions={}):Promise<SourceAuthorization> {
 const scope=parseSourceScope(request.scope),p=request.principal;
 if(!id(p.id)||!id(p.credential_id)||p.organisation_id!==scope.organisation_id||!['human','automation','import','worker','service'].includes(p.kind)||!SOURCE_AUTHORIZATION_ACTIONS.has(request.action))denied();
 if(request.capability_id!==undefined&&!id(request.capability_id))denied();
 if(p.capability_id!==undefined&&request.capability_id!==undefined&&p.capability_id!==request.capability_id)denied();
 if(request.object_id!==undefined)parseObjectId(request.object_id);
 if(request.revision_id!==undefined)parseObjectId(request.revision_id);
 const paths=request.paths?.map(prefix);
 if(paths&&paths.length>256)invalid('Source authorization path batch exceeds its limit');
 await p.assertCurrent(tx);
 const nowResult=await tx.query('SELECT clock_timestamp() AS now');const now=new Date(nowResult.rows[0]!.now).getTime();
 if(timestamp(p.expires_at)<=now)denied();
 const result=await tx.query(`SELECT c.*,d.authority_epoch::text AS current_epoch,d.policy_version AS current_policy
 FROM hyperfide.source_capabilities c JOIN hyperfide.source_authority_domains d USING(organisation_id,repository_id,security_domain_id)
 WHERE c.organisation_id=$1 AND c.repository_id=$2 AND c.security_domain_id=$3 AND c.principal_id=$4 AND c.credential_id=$5
 AND c.principal_kind=$6 AND c.revoked_at IS NULL AND c.expires_at>clock_timestamp() AND d.enabled
 AND c.authority_epoch=d.authority_epoch AND c.policy_version=d.policy_version AND $7=ANY(c.actions)
 AND ($8::uuid IS NULL OR c.id=$8) ORDER BY c.id LIMIT 65 FOR SHARE OF c,d`,[scope.organisation_id,scope.repository_id,scope.security_domain_id,p.id,p.credential_id,p.kind,request.action,request.capability_id??p.capability_id??null]);
 if(result.rows.length>64)denied();
 for(const row of result.rows){
  if(request.authority){const a=request.authority as Record<string,unknown>;if(a.authority_epoch!==String(row.current_epoch)||a.policy_version!==row.current_policy)continue;}
  const prefixes=(row.path_prefixes as unknown[]).map(prefix);
  if(paths?.length?paths.some(path=>!sourcePathWithin(path,prefixes)):!prefixes.includes('')&&!METADATA_ONLY.has(request.action))continue;
  if(row.revision_ids!==null&&(!request.revision_id||!row.revision_ids.includes(request.revision_id)))continue;
  if(request.object_id&&request.action!=='source.objects.put'&&(!prefixes.includes('')||row.revision_ids!==null)){
   if(!options.assertObjectAccess)continue;
   await options.assertObjectAccess(tx,{scope,action:request.action,object_id:request.object_id,...(request.revision_id?{revision_id:request.revision_id}:{}),...(paths?{paths}:{}),path_prefixes:prefixes});
  }
  const binding=managed(row.managed_binding);
  const mutation=request.mutation||MUTATIONS.has(request.action);
  if(mutation&&p.kind==='worker'&&!binding)continue;
  if(mutation&&binding){
   if(!matchingAuthority(binding,request.authority)||!options.assertManagedAuthority)continue;
   await options.assertManagedAuthority(tx,p,binding);
  }
  const expires_at=new Date(Math.min(new Date(row.expires_at).getTime(),timestamp(p.expires_at))).toISOString();
  const pinned={...request,scope,capability_id:row.id};
  return {scope,principal_id:p.id,capability_id:row.id,authority_epoch:String(row.current_epoch),policy_version:row.current_policy,path_prefixes:prefixes,expires_at,
   ...(binding?{workspace:{workspace_id:binding.workspace_id,generation:binding.generation}}:{}),
   async assertCurrent(next,action=request.action,nextPaths=paths){await authorizeSource(next,{...pinned,action,...(nextPaths?{paths:nextPaths}:{})},options);},
   async assertObjectAccess(next,input,action='source.objects.read'){await authorizeSource(next,{...pinned,action,object_id:input.object_id,...(input.revision_id?{revision_id:input.revision_id}:{}),...(input.paths?{paths:input.paths}:{})},options);}};
 }
 return denied();
}
export function sourcePrincipalFromInvocation(invocation:InvocationContext,kind:SourcePrincipalKind=invocation.principal.attempt_id?'worker':'automation'):SourcePrincipal {
 const p=invocation.principal;
 return {id:p.actor_id,credential_id:p.credential_id,organisation_id:p.organisation_id,kind,expires_at:p.expires_at,async assertCurrent(tx){await invocation.guard(tx);}};
}
export async function authorizeInvocationSource(tx:SourceSQL,request:Omit<SourceAuthorizationRequest,'principal'>&{invocation:InvocationContext},options:SourceAuthorizationOptions={}):Promise<SourceAuthorization> {
 return authorizeSource(tx,{...request,principal:sourcePrincipalFromInvocation(request.invocation)},options);
}
export interface SourceCapabilityInput {scope:SourceScope;principal_id:string;credential_id:string;principal_kind:SourcePrincipalKind;authority_epoch:string;policy_version:string;actions:readonly string[];path_prefixes:readonly string[];revision_ids?:readonly string[];managed_binding?:ManagedSourceBinding;expires_at:string;id?:string}
export async function grantSourceCapability(tx:SourceSQL,administrator:SourceAuthorization,input:SourceCapabilityInput):Promise<string> {
 await administrator.assertCurrent(tx,'source.capabilities.manage');
 const scope=parseSourceScope(input.scope);
 if(JSON.stringify(scope)!==JSON.stringify(administrator.scope)||!id(input.principal_id)||!id(input.credential_id)||!generation(input.authority_epoch)||input.authority_epoch!==administrator.authority_epoch||input.policy_version!==administrator.policy_version)denied();
 if(!input.actions.length||input.actions.length>64||new Set(input.actions).size!==input.actions.length||input.actions.some(a=>!SOURCE_AUTHORIZATION_ACTIONS.has(a)))invalid('Explicit supported capability actions are required');
 const prefixes=input.path_prefixes.map(prefix);if(!prefixes.length||prefixes.length>256||prefixes.some(p=>!sourcePathWithin(p,administrator.path_prefixes)))denied();
 const binding=managed(input.managed_binding);if(input.principal_kind==='worker'&&!binding)invalid('A worker mutation capability requires its managed binding');
 const expires=timestamp(input.expires_at);if(expires>timestamp(administrator.expires_at))denied();
 const revisions=input.revision_ids?.map(parseObjectId)??null,capabilityId=input.id??randomUUID();if(!id(capabilityId))invalid('Invalid source capability identity');
 const inserted=await tx.query(`INSERT INTO hyperfide.source_capabilities(organisation_id,repository_id,security_domain_id,id,principal_id,credential_id,principal_kind,authority_epoch,policy_version,actions,path_prefixes,revision_ids,managed_binding,expires_at)
 SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14 WHERE $14::timestamptz>clock_timestamp() RETURNING id`,[scope.organisation_id,scope.repository_id,scope.security_domain_id,capabilityId,input.principal_id,input.credential_id,input.principal_kind,input.authority_epoch,input.policy_version,[...input.actions],prefixes,revisions,binding,input.expires_at]);
 if(inserted.rowCount!==1)denied();return capabilityId;
}
export async function revokeSourceCapability(tx:SourceSQL,administrator:SourceAuthorization,capabilityId:string):Promise<boolean> {
 await administrator.assertCurrent(tx,'source.capabilities.manage');if(!id(capabilityId))invalid('Invalid source capability identity');const s=administrator.scope;
 const result=await tx.query('UPDATE hyperfide.source_capabilities SET revoked_at=clock_timestamp() WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND id=$4 AND revoked_at IS NULL',[s.organisation_id,s.repository_id,s.security_domain_id,capabilityId]);return result.rowCount===1;
}
