import type {ComponentContext} from '../components/registry.js';
import type {InvocationContext} from '../transport/protocol.js';
import type {PrimaryTransaction} from '../storage/transactions.js';
import {object,FoundationError} from '../policy/programme.js';
import {parseObjectId,parseSourceScope,parseSourceRequest,SourceControlError,type SourceRequest} from '../source_control/contracts.js';
import {assertFleetActor,fleetError,withAdmittedDecision,type FleetDecision} from './fleet_authority.js';
import {canonical,hash} from '../hierarchy/packages.js';

export const PRIMARY_SOURCE_ACTIONS=Object.freeze([
 'source.capabilities','source.revisions.read','source.operations.read','source.candidates.read','source.acceptance.read','source.graph.query',
 'source.fleet.selection','source.fleet.submission','source.fleet.bind-run','source.candidates.create','source.candidates.qualify',
 'source.acceptance.accept','source.fleet.qualify','source.fleet.select',
 'source.objects.read','source.objects.inspect','source.trees.entries','source.trees.lookup','source.changes.revisions',
 'source.queries.batch','source.queries.ancestry','source.queries.merge-bases','source.queries.history','source.queries.diff','source.queries.blame','source.queries.line-map',
 'source.domains.read','source.metrics.read','source.fleet.read','source.fleet.manifest',
 'source.transforms.merge','source.transforms.rebase','source.transforms.revert','source.transforms.read','source.transforms.resume',
 'source.queue.enqueue','source.queue.claim','source.queue.bind','source.queue.complete','source.queue.fail','source.queue.isolate','source.queue.read',
 'source.publications.create','source.publications.read','source.publications.resume','source.publications.cancel',
]);
interface NativeSourceService {api:{invoke(action:string,request:SourceRequest,invocation:InvocationContext):Promise<unknown>}}
const sourceService=(value:unknown):value is NativeSourceService=>object(value)&&object(value.api)&&typeof value.api.invoke==='function';
export interface PrimarySourceCapability {scope:ReturnType<typeof parseSourceScope>;actions:string[];initial_revision_ids?:string[]}
export function parsePrimarySourceCapabilities(value:unknown):PrimarySourceCapability[]{
 if(!Array.isArray(value)||value.length<1||value.length>8)fleetError('FLEET_SOURCE_CAPABILITIES_INVALID');
 const seen=new Set<string>();return value.map(item=>{
  if(!object(item)||Object.keys(item).some(key=>!['actions','scope','initial_revision_ids'].includes(key))||!Object.hasOwn(item,'scope')||!Array.isArray(item.actions)||!item.actions.length||item.actions.length>PRIMARY_SOURCE_ACTIONS.length||item.actions.some(action=>typeof action!=='string'||!PRIMARY_SOURCE_ACTIONS.includes(action))||new Set(item.actions).size!==item.actions.length)fleetError('FLEET_SOURCE_CAPABILITIES_INVALID');
  const scope=parseSourceScope(item.scope),key=canonical(scope);if(seen.has(key))fleetError('FLEET_SOURCE_CAPABILITIES_INVALID');seen.add(key);
  if(item.initial_revision_ids!==undefined&&(!Array.isArray(item.initial_revision_ids)||!item.initial_revision_ids.length||item.initial_revision_ids.length>8||new Set(item.initial_revision_ids).size!==item.initial_revision_ids.length||!item.actions.includes('source.revisions.read')))fleetError('FLEET_SOURCE_CAPABILITIES_INVALID');
  const initial=item.initial_revision_ids===undefined?undefined:(item.initial_revision_ids as unknown[]).map(parseObjectId);
  return {scope,actions:[...item.actions] as string[],...(initial?{initial_revision_ids:initial}:{})};
 });
}
export function primarySourceRequest(decision:FleetDecision):SourceRequest {
 if(decision.actor_role!=='PRIMARY'||decision.action!=='SOURCE_OPERATION')fleetError('FLEET_PRIMARY_REQUIRED');
 const input=decision.input;
 if(Object.keys(input).some(key=>!['scope','action','input'].includes(key))||!Object.hasOwn(input,'scope')||!Object.hasOwn(input,'action')||!object(input.input)||!PRIMARY_SOURCE_ACTIONS.includes(input.action as string))fleetError('FLEET_SOURCE_ACTION_INVALID');
 const scope=parseSourceScope(input.scope);
 if(['source.fleet.bind-run','source.fleet.qualify','source.fleet.select'].includes(String(input.action))&&input.input.run_id!==decision.run_id)fleetError('FLEET_SOURCE_ACTION_SCOPE');
 if(['source.fleet.bind-run','source.fleet.select'].includes(String(input.action))&&input.input.leader_generation!==decision.leader_generation)fleetError('FLEET_SOURCE_ACTION_SCOPE');
 return parseSourceRequest({protocol_version:1,scope,action:input.action,input:input.input,operation_id:decision.operation_id,idempotency_key:decision.operation_id});
}
export async function executePrimarySource(ctx:ComponentContext,invocation:InvocationContext,decision:FleetDecision):Promise<Record<string,unknown>> {
 const request=primarySourceRequest(decision);
 if(request.scope.organisation_id!==invocation.principal.organisation_id)fleetError('FLEET_SOURCE_ACTION_SCOPE');
 const transact=<T>(body:(tx:PrimaryTransaction)=>Promise<T>)=>ctx.resources.gateway.withPrimaryTransaction({signal:invocation.signal,timeoutMs:15000,maxRetries:2},body);
 const admitted=await transact(tx=>withAdmittedDecision(tx,invocation,decision,'SOURCE_OPERATION',async()=>({kind:'SOURCE_OPERATION',source_action:request.action,source_operation_id:request.operation_id,scope:request.scope,state:'ADMITTED'})));
 const read=()=>transact(async tx=>{
  await assertFleetActor(tx,invocation,decision);
  return (await tx.query('SELECT result FROM hyperfide.fleet_native_source_results WHERE organisation_id=$1 AND run_id=$2 AND operation_id=$3',[invocation.principal.organisation_id,decision.run_id,decision.operation_id])).rows[0]?.result as Record<string,unknown>|undefined;
 });
 const previous=await read();if(previous)return {...previous,replayed:true};
 let result:Record<string,unknown>;
 try {
  const response=await ctx.dependencies.require('source-control','source.service.v1',sourceService).api.invoke(request.action,request,invocation);
  result={...admitted,state:'COMMITTED',response};delete result.replayed;
 }catch(error){
  if(!(error instanceof SourceControlError)||error.outcome==='UNKNOWN'||error.retry==='RETRY_SAME_OPERATION'||error.retry==='RESUME')throw new FoundationError('OUTCOME_UNKNOWN','Native source outcome is unknown; replay the original decision and operation');
  result={...admitted,state:'REFUSED',error:{code:error.code,message:error.message,retry:error.retry,outcome:error.outcome}};delete result.replayed;
 }
 if(Buffer.byteLength(canonical(result))>1048576)throw new FoundationError('OUTCOME_UNKNOWN','Native source response exceeds the retained outcome budget; reconcile its original operation');
 return transact(async tx=>{
  await assertFleetActor(tx,invocation,decision);
  await tx.query('INSERT INTO hyperfide.fleet_native_source_results(organisation_id,run_id,operation_id,decision_id,actor_id,source_scope,source_action,result,result_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING',[invocation.principal.organisation_id,decision.run_id,decision.operation_id,decision.decision_id,decision.actor_id,request.scope,request.action,result,hash(result)]);
  const retained=(await tx.query('SELECT result,result_digest FROM hyperfide.fleet_native_source_results WHERE organisation_id=$1 AND run_id=$2 AND operation_id=$3',[invocation.principal.organisation_id,decision.run_id,decision.operation_id])).rows[0];
  if(!retained||retained.result_digest!==hash(retained.result)||retained.result.source_operation_id!==request.operation_id||retained.result.source_action!==request.action)fleetError('FLEET_SOURCE_RESULT_CONFLICT');
  return retained.result;
 });
}
export async function observePrimarySources(tx:PrimaryTransaction,invocation:InvocationContext):Promise<Record<string,unknown>> {
 const p=invocation.principal;
 if(p.role!=='LEADER')return {available:false};
 const scopes=(await tx.query(`SELECT c.organisation_id,c.repository_id,c.security_domain_id,array_agg(DISTINCT permitted.action ORDER BY permitted.action) AS actions,min(c.expires_at) AS expires_at
 FROM hyperfide.source_capabilities c JOIN hyperfide.source_authority_domains d USING(organisation_id,repository_id,security_domain_id) CROSS JOIN LATERAL unnest(c.actions) AS permitted(action)
 WHERE c.organisation_id=$1 AND c.principal_id=$2 AND c.credential_id=$3 AND c.revoked_at IS NULL AND c.expires_at>clock_timestamp()
 AND c.authority_epoch=d.authority_epoch AND c.policy_version=d.policy_version AND d.enabled AND c.path_prefixes @> ARRAY['']::text[]
 GROUP BY c.organisation_id,c.repository_id,c.security_domain_id ORDER BY c.repository_id,c.security_domain_id LIMIT 9`,[p.organisation_id,p.actor_id,p.credential_id])).rows;
 const selected=scopes.slice(0,8),scopePairs=selected.map(row=>row.repository_id+':'+row.security_domain_id);
 const initial=scopePairs.length?(await tx.query(`SELECT DISTINCT c.organisation_id,c.repository_id,c.security_domain_id,pinned.revision_id,r.root_tree_id
 FROM hyperfide.source_capabilities c JOIN hyperfide.source_authority_domains d USING(organisation_id,repository_id,security_domain_id)
 CROSS JOIN LATERAL unnest(c.revision_ids) AS pinned(revision_id)
 JOIN hyperfide.source_revisions r ON r.organisation_id=c.organisation_id AND r.repository_id=c.repository_id AND r.security_domain_id=c.security_domain_id AND r.revision_id=pinned.revision_id
 WHERE c.organisation_id=$1 AND c.principal_id=$2 AND c.credential_id=$3 AND c.principal_kind='automation'
 AND c.actions=ARRAY['source.revisions.read']::text[] AND c.revoked_at IS NULL AND c.expires_at>clock_timestamp()
 AND c.authority_epoch=d.authority_epoch AND c.policy_version=d.policy_version AND d.enabled AND c.path_prefixes @> ARRAY['']::text[]
 AND c.repository_id::text||':'||c.security_domain_id::text=ANY($4::text[])
 ORDER BY c.repository_id,c.security_domain_id,pinned.revision_id LIMIT 65`,[p.organisation_id,p.actor_id,p.credential_id,scopePairs])).rows:[];
 const leader=(await tx.query('SELECT generation::text AS generation FROM hyperfide.hierarchy_leaders WHERE organisation_id=$1 AND run_id=$2 AND leader_session_id=$3 AND authority_epoch=$4',[p.organisation_id,p.run_id,p.actor_id,p.deployment_epoch])).rows[0];
 const initialRevisions:Record<string,unknown>[]=[];
 for(const row of initial.slice(0,64)){
  const scope={organisation_id:row.organisation_id,repository_id:row.repository_id,security_domain_id:row.security_domain_id};
  const canBind=leader&&selected.some(cap=>cap.repository_id===row.repository_id&&cap.security_domain_id===row.security_domain_id&&cap.actions.includes('source.fleet.bind-run'));
  const descriptor={scope,revision_id:row.revision_id,root_tree_id:row.root_tree_id,...(canBind?{bind_request:{action:'SOURCE_OPERATION',input:{scope,action:'source.fleet.bind-run',input:{run_id:p.run_id,revision_id:row.revision_id,leader_generation:leader.generation}}}}:{})};
  if(Buffer.byteLength(canonical([...initialRevisions,descriptor]))>16384)break;
  initialRevisions.push(descriptor);
 }
 const operations=scopePairs.length?(await tx.query(`SELECT r.operation_id,r.source_scope,r.source_action,r.result,r.created_at FROM hyperfide.fleet_native_source_results r
 WHERE r.organisation_id=$1 AND r.run_id=$2 AND r.actor_id=$3 AND (r.source_scope->>'repository_id')||':'||(r.source_scope->>'security_domain_id')=ANY($4::text[]) ORDER BY r.created_at DESC,r.operation_id DESC LIMIT 4`,[p.organisation_id,p.run_id,p.actor_id,scopePairs])).rows:[];
 const readablePairs=(action:string)=>selected.filter(row=>row.actions.includes(action)).map(row=>row.repository_id+':'+row.security_domain_id);
 const bindingScopes=readablePairs('source.fleet.selection'),submissionScopes=readablePairs('source.fleet.submission'),candidateScopes=readablePairs('source.candidates.read');
 const bindings=bindingScopes.length?(await tx.query(`SELECT f.repository_id,f.security_domain_id,COALESCE(s.revision_id,f.revision_id) AS revision_id,COALESCE(s.root_tree_id,f.root_tree_id) AS root_tree_id,COALESCE(h.generation,0)::text AS selection_generation
 FROM hyperfide.source_fleet_runs f LEFT JOIN hyperfide.source_fleet_selection_heads h USING(organisation_id,repository_id,security_domain_id,run_id) LEFT JOIN hyperfide.source_fleet_selections s USING(organisation_id,repository_id,security_domain_id,run_id,selection_id)
 WHERE f.organisation_id=$1 AND f.run_id=$2 AND f.repository_id::text||':'||f.security_domain_id::text=ANY($3::text[]) ORDER BY f.repository_id,f.security_domain_id LIMIT 8`,[p.organisation_id,p.run_id,bindingScopes])).rows:[];
 const submissions=submissionScopes.length?(await tx.query(`SELECT c.repository_id,c.security_domain_id,c.custody_id,c.custody_generation::text,c.task_id,c.revision_id,c.root_tree_id,c.qualification_outcome,t.state_version::text AS task_state_version
 FROM hyperfide.source_fleet_submissions c JOIN hyperfide.tasks t ON t.organisation_id=c.organisation_id AND t.run_id=c.run_id AND t.id=c.task_id AND t.current_native_custody_id=c.custody_id
 WHERE c.organisation_id=$1 AND c.run_id=$2 AND c.repository_id::text||':'||c.security_domain_id::text=ANY($3::text[]) AND c.authority='ACTIVE' ORDER BY c.created_at DESC,c.custody_id DESC LIMIT 8`,[p.organisation_id,p.run_id,submissionScopes])).rows:[];
 const candidates=candidateScopes.length?(await tx.query(`SELECT c.repository_id,c.security_domain_id,c.candidate_id,c.domain_id,c.revision_id,c.root_tree_id,q.qualification_id,a.acceptance_id
 FROM hyperfide.source_native_candidates c LEFT JOIN LATERAL(SELECT qualification_id FROM hyperfide.source_candidate_qualifications q WHERE q.organisation_id=c.organisation_id AND q.repository_id=c.repository_id AND q.security_domain_id=c.security_domain_id AND q.candidate_id=c.candidate_id ORDER BY q.created_at DESC LIMIT 1) q ON true LEFT JOIN hyperfide.source_native_acceptances a USING(organisation_id,repository_id,security_domain_id,candidate_id)
 WHERE c.organisation_id=$1 AND c.repository_id::text||':'||c.security_domain_id::text=ANY($2::text[]) ORDER BY c.created_at DESC,c.candidate_id DESC LIMIT 8`,[p.organisation_id,candidateScopes])).rows:[];
 const summary=(value:unknown):unknown=>{
  if(Buffer.byteLength(canonical(value))<=8192)return value;
  if(!object(value))return {details_omitted:true};
  const response=object(value.response)?value.response:{};
  return {kind:value.kind,state:value.state,source_action:value.source_action,source_operation_id:value.source_operation_id,details_omitted:true,response:Object.fromEntries(Object.entries(response).filter(([key,val])=>/(?:^id$|_id$|^state$|^generation$|^result_digest$)/.test(key)&&['string','number','boolean'].includes(typeof val)))};
 };
 return {available:selected.length>0,scopes:selected.map(row=>({scope:{organisation_id:row.organisation_id,repository_id:row.repository_id,security_domain_id:row.security_domain_id},actions:row.actions.filter((action:string)=>PRIMARY_SOURCE_ACTIONS.includes(action)),expires_at:new Date(row.expires_at).toISOString()})),scopes_omitted:scopes.length>8,
  initial_revisions:initialRevisions,initial_revisions_omitted:initial.length>initialRevisions.length,initial_revisions_budget_bytes:16384,
  bindings,submissions,candidates,results:operations.filter(row=>selected.some(cap=>cap.repository_id===row.source_scope.repository_id&&cap.security_domain_id===row.source_scope.security_domain_id&&cap.actions.includes(row.source_action))).map(row=>({operation_id:row.operation_id,action:row.source_action,result:summary(row.result),created_at:new Date(row.created_at).toISOString()}))};
}
