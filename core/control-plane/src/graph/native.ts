import type {SourceAuthorization,SourceSQL} from '../source_control/capabilities.js';
import {sourceScopeValues,type SourceMetadata} from '../source_control/metadata.js';
import {SourceControlError} from '../source_control/contracts.js';
import {canonical,digest} from './extraction.js';
import {retainSourceObject} from '../source_control/pins.js';
import {SourceCursorCodec} from '../source_control/cursors.js';
export interface NativeGraphRow extends Record<string,any>{build_id:string;identity:Record<string,any>;paths:string[];state:string;coverage:Record<string,any>}
export const graphScope=(context:SourceAuthorization)=>sourceScopeValues(context.scope);
export async function loadNativeGraph(metadata:SourceMetadata,context:SourceAuthorization,id:string,action:string):Promise<NativeGraphRow>{
 return metadata.transaction(async tx=>{await context.assertCurrent(tx,action);const row=(await tx.query<NativeGraphRow>('SELECT * FROM hyperfide.source_graph_builds WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND build_id=$4',[...graphScope(context),id])).rows[0];if(!row)throw new SourceControlError('GRAPH_UNAVAILABLE','Native graph build is unavailable');return row;});
}
export async function ingestNativeGraph(metadata:SourceMetadata,context:SourceAuthorization,input:{build_id:string;request_digest:string;revision_id:string;root_tree_id:string;identity:Record<string,any>;paths:string[]}):Promise<NativeGraphRow>{
 return metadata.transaction(async tx=>{
  await context.assertCurrent(tx,'source.graph.build',input.paths);
  await retainSourceObject(tx,context.scope,{object_id:input.root_tree_id,owner_id:'graph:'+input.build_id});
  await tx.query('INSERT INTO hyperfide.source_graph_builds(organisation_id,repository_id,security_domain_id,build_id,request_digest,revision_id,root_tree_id,identity,paths,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,\'BUILDING\') ON CONFLICT DO NOTHING',[...graphScope(context),input.build_id,input.request_digest,input.revision_id,input.root_tree_id,JSON.stringify(input.identity),JSON.stringify(input.paths)]);
  const row=(await tx.query<NativeGraphRow>('SELECT * FROM hyperfide.source_graph_builds WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND build_id=$4 FOR UPDATE',[...graphScope(context),input.build_id])).rows[0]!;
  if(row.request_digest!==input.request_digest)throw new SourceControlError('IDEMPOTENCY_CONFLICT','Graph build identity was reused with different source or configuration');return row;
 });
}
async function guardOverlay(tx:SourceSQL,context:SourceAuthorization,build:NativeGraphRow):Promise<void>{
 const overlay=build.identity.overlay;if(!overlay)return;
 const row=(await tx.query('SELECT workspace_generation::text,base_revision_id,checkpoint_revision_id,closed_at FROM hyperfide.source_workspaces WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND workspace_id=$4 FOR SHARE',[...graphScope(context),overlay.workspace_id])).rows[0];if(!row||row.closed_at||row.workspace_generation!==overlay.workspace_generation||(row.checkpoint_revision_id??row.base_revision_id)!==build.revision_id)throw new SourceControlError('GRAPH_OVERLAY_STALE','Native graph overlay is no longer the named workspace state');
}
export async function publishNativeGraph(metadata:SourceMetadata,context:SourceAuthorization,input:{operation_id:string;build_id:string;channel:string;expected_generation:string}):Promise<Record<string,any>>{
 const requestDigest=digest(canonical(input));
 return metadata.transaction(async tx=>{
  await context.assertCurrent(tx,'source.graph.publish');
  const prior=(await tx.query('SELECT request_digest,result FROM hyperfide.source_graph_publications WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND operation_id=$4',[...graphScope(context),input.operation_id])).rows[0];
  if(prior){if(prior.request_digest!==requestDigest)throw new SourceControlError('IDEMPOTENCY_CONFLICT','Graph publication operation differs');return prior.result;}
  const build=(await tx.query<NativeGraphRow>('SELECT * FROM hyperfide.source_graph_builds WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND build_id=$4 FOR UPDATE',[...graphScope(context),input.build_id])).rows[0];
  if(!build||!['READY','PUBLISHED'].includes(build.state)||build.coverage?.complete!==true)throw new SourceControlError('GRAPH_INCOMPLETE','Only a complete native graph can be published');
  await context.assertCurrent(tx,'source.graph.publish',build.paths);
  await guardOverlay(tx,context,build);
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[canonical([...graphScope(context),input.channel])]);
  const channel=(await tx.query('SELECT generation::text,build_id FROM hyperfide.source_graph_channels WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND channel=$4 FOR UPDATE',[...graphScope(context),input.channel])).rows[0];
  if(String(channel?.generation??'0')!==input.expected_generation)throw new SourceControlError('GRAPH_GENERATION_CONFLICT','Published graph generation changed');
  const generation=(BigInt(input.expected_generation)+1n).toString();
  await tx.query('INSERT INTO hyperfide.source_graph_channels(organisation_id,repository_id,security_domain_id,channel,generation,build_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(organisation_id,repository_id,security_domain_id,channel) DO UPDATE SET generation=EXCLUDED.generation,build_id=EXCLUDED.build_id',[...graphScope(context),input.channel,generation,input.build_id]);
  await tx.query("UPDATE hyperfide.source_graph_builds SET state='PUBLISHED' WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND build_id=$4",[...graphScope(context),input.build_id]);
  const result={schema_version:1,build_id:input.build_id,identity:build.identity,channel:input.channel,generation,coverage:build.coverage};
  await tx.query('INSERT INTO hyperfide.source_graph_publications(organisation_id,repository_id,security_domain_id,operation_id,request_digest,result) VALUES($1,$2,$3,$4,$5,$6)',[...graphScope(context),input.operation_id,requestDigest,JSON.stringify(result)]);return result;
 });
}
export async function queryNativeGraph(metadata:SourceMetadata,context:SourceAuthorization,input:{build_id:string;revision_id:string;root_tree_id:string;mode:string;path?:string;q?:string;limit:number;cursor?:string},cursors:SourceCursorCodec):Promise<Record<string,any>>{
 const build=await loadNativeGraph(metadata,context,input.build_id,'source.graph.query');
 if(build.revision_id!==input.revision_id||build.root_tree_id!==input.root_tree_id)throw new SourceControlError('GRAPH_SOURCE_MISMATCH','Query must name the exact native source revision and tree');
 if(build.state!=='PUBLISHED')throw new SourceControlError('GRAPH_UNPUBLISHED','Only a published immutable graph can serve context');
 const binding={scope:context.scope,principal_id:context.principal_id,capability_id:context.capability_id,authority_epoch:context.authority_epoch,policy_version:context.policy_version,query:{...input,cursor:null,authorized_paths:[...context.path_prefixes].sort()},snapshot:input.build_id};
 const offset=input.cursor===undefined?0:cursors.decode(binding,input.cursor);
 if(!Number.isSafeInteger(offset)||Number(offset)<0)throw new SourceControlError('INVALID_CURSOR','Invalid graph continuation');
 const page=await metadata.transaction(async tx=>{
  await context.assertCurrent(tx,'source.graph.query');
  await guardOverlay(tx,context,build);
  return (await tx.query(`SELECT f.path,f.body,f.dependencies,f.content_digest,e.facts,e.complete FROM hyperfide.source_graph_files f JOIN hyperfide.source_graph_extractions e USING(organisation_id,repository_id,security_domain_id,cache_key) WHERE f.organisation_id=$1 AND f.repository_id=$2 AND f.security_domain_id=$3 AND f.build_id=$4 AND ($6::text IS NULL OR f.path=$6) AND EXISTS(SELECT 1 FROM unnest($8::text[]) AS allowed(prefix) WHERE allowed.prefix='' OR f.path=allowed.prefix OR left(f.path,length(allowed.prefix)+1)=allowed.prefix||'/') ORDER BY f.path LIMIT $7 OFFSET $5`,[...graphScope(context),input.build_id,offset,input.path??null,input.limit+1,[...context.path_prefixes]])).rows;
 });
 const rows:Record<string,any>[]=[];let scanned=0;
 for(const file of page.slice(0,input.limit)){
  scanned++;
  try{await metadata.transaction(tx=>context.assertCurrent(tx,'source.graph.query',[file.path]));}catch(error){if(error instanceof SourceControlError&&error.code==='SCOPE_DENIED')continue;throw error;}
  const facts=file.facts as {table:string;row:Record<string,any>}[];
  if(input.mode==='status')rows.push({path:file.path,content_digest:file.content_digest,complete:file.complete});
  else if(input.mode==='symbols'){
   const symbols=facts.filter(f=>f.table==='symbols'&&(!input.q||String(f.row.name).includes(input.q))).map(f=>({...f.row,path:file.path}));
   rows.push({path:file.path,symbols});
  }else if(input.mode==='context')rows.push({path:file.path,content_digest:file.content_digest,body:file.body,facts});
  else{
   const dependencies:string[]=[];
   for(const dependency of file.dependencies as string[]){try{await metadata.transaction(tx=>context.assertCurrent(tx,'source.graph.query',[dependency]));dependencies.push(dependency);}catch(error){if(!(error instanceof SourceControlError&&error.code==='SCOPE_DENIED'))throw error;}}
   rows.push({path:file.path,dependencies});
  }
 }
 const next=page.length>input.limit?cursors.encode(binding,Number(offset)+input.limit):null;
 const coverage=context.path_prefixes.includes('')?build.coverage:{complete:build.coverage.complete,scope:'AUTHORIZED_FILES_ONLY'};
 const result={schema_version:1,identity:build.identity,coverage,rows,scanned,next_cursor:next,complete:next===null&&build.coverage.complete===true&&build.coverage.resolution_complete===true};
 if(Buffer.byteLength(JSON.stringify(result))>1048576)throw new SourceControlError('LIMIT_EXCEEDED','Graph response exceeds one MiB; narrow the file page');return result;
}
