import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import type {SourceMetadata} from './metadata.js';
import type {SourceAuthorization} from './capabilities.js';
import type {SourceObjectService} from './objects.js';
import type {PersistentTree} from './trees.js';
import {parseObjectId,parseRepositoryPath,parseUUID,SourceControlError} from './contracts.js';
import {createNativeSourceManifest} from '../preparation/fleet_source.js';
import {canonical,digest,extractNativeFile,type Fact} from '../graph/extraction.js';
import {ingestNativeGraph} from '../graph/ingestion.js';
import {publishNativeGraph} from '../graph/publication.js';
import {queryNativeGraph} from '../graph/query.js';
import {graphScope} from '../graph/native.js';
import {SourceCursorCodec} from './cursors.js';
export interface NativeGraphOptions {binary:string;binary_digest:string;scratch:string;max_active?:number}
export interface NativeGraphBuildInput {build_id:string;revision_id:string;root_tree_id:string;paths:string[];configuration:{resolver_digest:string;generated_digest:string;build_flags:string[]};previous_build_id?:string;overlay?:{workspace_id:string;workspace_generation:string;revision_id:string};budgets?:{max_files?:number;max_bytes?:number;max_rows?:number}}
const failure=(code:string,message:string):never=>{throw new SourceControlError(code,message);};
const hash=(value:unknown)=>digest(canonical(value));
function positive(value:number|undefined,fallback:number,max:number):number{const result=value??fallback;if(!Number.isSafeInteger(result)||result<1||result>max)failure('LIMIT_EXCEEDED','Invalid native graph budget');return result;}
export function sourceGraphConfiguration(env:Readonly<NodeJS.ProcessEnv>):NativeGraphOptions|undefined{
 if(!env.HF_SOURCE_GRAPH_BINARY&&!env.HF_SOURCE_GRAPH_SCRATCH&&!env.HF_SOURCE_GRAPH_BINARY_DIGEST)return undefined;
 if(!env.HF_SOURCE_GRAPH_BINARY||!env.HF_SOURCE_GRAPH_SCRATCH||!env.HF_SOURCE_GRAPH_BINARY_DIGEST)failure('CONFIGURATION_INVALID','Native graph scanner, digest and scratch directory must be configured together');
 return {binary:env.HF_SOURCE_GRAPH_BINARY!,binary_digest:env.HF_SOURCE_GRAPH_BINARY_DIGEST!,scratch:env.HF_SOURCE_GRAPH_SCRATCH!};
}
export class NativeSourceGraph {
 private active=0;
 private readonly cursors:SourceCursorCodec;
 constructor(readonly metadata:SourceMetadata,readonly trees:PersistentTree,readonly objects:SourceObjectService,readonly options:NativeGraphOptions|undefined,cursorKey:Uint8Array){this.cursors=new SourceCursorCodec(cursorKey);}
 private async overlay(context:SourceAuthorization,input:NativeGraphBuildInput):Promise<void>{
  if(!input.overlay)return;const overlay=input.overlay;parseUUID(overlay.workspace_id,'workspace_id');
  if(overlay.revision_id!==input.revision_id||typeof overlay.workspace_generation!=='string'||!/^[1-9][0-9]{0,18}$/.test(overlay.workspace_generation)||BigInt(overlay.workspace_generation)>9223372036854775807n)failure('GRAPH_OVERLAY_STALE','Native overlay identity differs from its revision');
  await this.metadata.transaction(async tx=>{await context.assertCurrent(tx,'source.graph.build',input.paths);const row=(await tx.query('SELECT workspace_generation::text,checkpoint_revision_id,base_revision_id,closed_at FROM hyperfide.source_workspaces WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND workspace_id=$4',[...graphScope(context),overlay.workspace_id])).rows[0];if(!row||row.closed_at||row.workspace_generation!==overlay.workspace_generation||(row.checkpoint_revision_id??row.base_revision_id)!==input.revision_id)failure('GRAPH_OVERLAY_STALE','Overlay workspace has changed or closed');});
 }
 async build(context:SourceAuthorization,input:NativeGraphBuildInput,signal:AbortSignal=new AbortController().signal):Promise<Record<string,any>>{
  if(!this.options)failure('GRAPH_UNAVAILABLE','Native graph scanner is not configured');
  if(this.active>=(this.options!.max_active??1))throw new SourceControlError('GRAPH_OVERLOADED','Native graph extraction admission is full','RETRY_SAME_OPERATION');
  this.active++;
  try{return await this.buildAdmitted(context,input,signal);}finally{this.active--;}
 }
 private async buildAdmitted(context:SourceAuthorization,input:NativeGraphBuildInput,signal:AbortSignal):Promise<Record<string,any>>{
  const config=this.options!;parseUUID(input.build_id,'build_id');parseObjectId(input.revision_id);parseObjectId(input.root_tree_id);
  if(!Array.isArray(input.paths)||!input.paths.length||input.paths.length>256)failure('LIMIT_EXCEEDED','Native graph requires one to 256 explicit paths');
  const paths=[...new Set(input.paths.map(parseRepositoryPath))].sort();
  if(!input.configuration||Object.keys(input.configuration).some(key=>!['resolver_digest','generated_digest','build_flags'].includes(key))||!Array.isArray(input.configuration.build_flags)||input.configuration.build_flags.length>64||input.configuration.build_flags.some(x=>typeof x!=='string'||x.length>1024))failure('INVALID_REQUEST','Bounded graph build configuration required');
  parseObjectId(input.configuration.resolver_digest);parseObjectId(input.configuration.generated_digest);parseObjectId(config.binary_digest);
  const maxFiles=positive(input.budgets?.max_files,128,256),maxBytes=positive(input.budgets?.max_bytes,8388608,33554432),maxRows=positive(input.budgets?.max_rows,100000,250000);
  if(!path.isAbsolute(config.binary)||!path.isAbsolute(config.scratch))failure('CONFIGURATION_INVALID','Native graph paths must be absolute');await fs.mkdir(config.scratch,{recursive:true,mode:0o700});
  const scanner=await fs.stat(config.binary);if(!scanner.isFile()||scanner.size>268435456||!(scanner.mode&0o111)||digest(await fs.readFile(config.binary))!==config.binary_digest)failure('GRAPH_SCANNER_CHANGED','Native graph scanner differs from the pinned executable');
  const revision=await this.metadata.readRevision(context,input.revision_id);if(revision.root_tree_id!==input.root_tree_id)failure('GRAPH_SOURCE_MISMATCH','Graph source revision and tree do not match');
  await this.overlay(context,input);
  const imported=await this.metadata.transaction(async tx=>{await context.assertCurrent(tx,'source.graph.build',paths);if(!(await tx.query("SELECT to_regclass('hyperfide.source_git_import_commits') IS NOT NULL AS present")).rows[0]?.present)return [];return (await tx.query("SELECT c.import_id,c.git_oid,c.disposition,i.repository_identity FROM hyperfide.source_git_import_commits c JOIN hyperfide.source_git_imports i USING(organisation_id,repository_id,security_domain_id,import_id) WHERE c.organisation_id=$1 AND c.repository_id=$2 AND c.security_domain_id=$3 AND c.revision_id=$4 AND i.state='COMPLETE' ORDER BY c.import_id,c.git_oid LIMIT 64",[...graphScope(context),input.revision_id])).rows;});
  const identity={schema_version:1,source_kind:'NATIVE',scope:context.scope,revision_id:input.revision_id,root_tree_id:input.root_tree_id,overlay:input.overlay??null,parser_digest:config.binary_digest,resolver_digest:input.configuration.resolver_digest,configuration_digest:hash(input.configuration),graph_schema:'native-graph-v1',imported_git_provenance:imported};
  const requestDigest=hash({...input,paths,identity});const build=await ingestNativeGraph(this.metadata,context,{build_id:input.build_id,request_digest:requestDigest,revision_id:input.revision_id,root_tree_id:input.root_tree_id,identity,paths});
  if(build.state!=='BUILDING')return {build_id:build.build_id,identity:build.identity,coverage:build.coverage,state:build.state,replayed:true};
  const manifest=await createNativeSourceManifest({metadata:this.metadata,trees:this.trees,objects:this.objects,authorization:context,repository:context.scope.repository_id,revision:input.revision_id,paths,maxFiles,maxBytes,maxNodes:4096});
  let extracted=0,reused=0,totalRows=0,unresolvedImports=0;const sourcePaths=new Set(manifest.entries.map(e=>e.path));const dependencies=new Map<string,string[]>();
  for(const entry of manifest.entries){
   signal.throwIfAborted();await this.overlay(context,input);await this.metadata.transaction(tx=>context.assertCurrent(tx,'source.graph.build',[entry.path]));
   const cacheKey=hash({path:entry.path,content_digest:entry.digest,parser_digest:config.binary_digest,configuration:input.configuration,graph_schema:'native-graph-v1'});
   let cached=(await this.metadata.transaction(tx=>tx.query('SELECT facts,complete FROM hyperfide.source_graph_extractions WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND cache_key=$4',[...graphScope(context),cacheKey]))).rows[0];
   if(!cached){const parsed=await extractNativeFile({path:entry.path,bytes:Buffer.from(entry.content_base64,'base64'),binary:config.binary,binary_digest:config.binary_digest,scratch:config.scratch,signal,max_rows:maxRows,max_bytes:maxBytes});
    await this.metadata.transaction(async tx=>{await context.assertCurrent(tx,'source.graph.build',[entry.path]);await tx.query('INSERT INTO hyperfide.source_graph_extractions(organisation_id,repository_id,security_domain_id,cache_key,path,content_digest,facts,complete) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING',[...graphScope(context),cacheKey,entry.path,entry.digest,JSON.stringify(parsed.facts),parsed.complete]);});cached=parsed;extracted++;
   }else reused++;
   const facts=cached.facts as Fact[];totalRows+=facts.length;if(totalRows>maxRows)failure('LIMIT_EXCEEDED','Native graph fact budget exhausted');
   const imports=facts.filter(f=>f.table==='imports').map(f=>String(f.row.module));const targets:string[]=[];
   for(const module of imports){const base=module.startsWith('.')?path.posix.normalize(path.posix.join(path.posix.dirname(entry.path),module)):module;const resolved=[base,base+'.ts',base+'.tsx',base+'.js',base+'/index.ts'].find(candidate=>sourcePaths.has(candidate));if(resolved)targets.push(resolved);}
   unresolvedImports+=imports.length-targets.length;dependencies.set(entry.path,[...new Set(targets)].sort());
   await this.metadata.transaction(async tx=>{await context.assertCurrent(tx,'source.graph.build',[entry.path]);await tx.query('INSERT INTO hyperfide.source_graph_files(organisation_id,repository_id,security_domain_id,build_id,path,cache_key,content_digest,body,dependencies) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING',[...graphScope(context),input.build_id,entry.path,cacheKey,entry.digest,Buffer.from(entry.content_base64,'base64').toString('utf8'),JSON.stringify(targets)]);});
  }
  let configurationChanged=false;
  const previous=input.previous_build_id?await this.metadata.transaction(async tx=>{await context.assertCurrent(tx,'source.graph.build',paths);const prior=(await tx.query('SELECT paths,identity FROM hyperfide.source_graph_builds WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND build_id=$4',[...graphScope(context),parseUUID(input.previous_build_id!,'previous_build_id')])).rows[0];if(!prior)failure('GRAPH_UNAVAILABLE','Previous graph build is unavailable');await context.assertCurrent(tx,'source.graph.build',prior!.paths);configurationChanged=prior!.identity.parser_digest!==identity.parser_digest||prior!.identity.resolver_digest!==identity.resolver_digest||prior!.identity.configuration_digest!==identity.configuration_digest;return (await tx.query('SELECT path,content_digest FROM hyperfide.source_graph_files WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND build_id=$4',[...graphScope(context),parseUUID(input.previous_build_id!,'previous_build_id')])).rows;}):[];
  const changed=new Set(manifest.entries.filter(e=>configurationChanged||!previous.some(p=>p.path===e.path&&p.content_digest===e.digest)).map(e=>e.path));for(const p of previous)if(!sourcePaths.has(p.path))changed.add(p.path);
  const invalidated=new Set(changed);let progress=true;while(progress){progress=false;for(const [file,targets]of dependencies)if(!invalidated.has(file)&&targets.some(t=>invalidated.has(t))){invalidated.add(file);progress=true;}}
  const coverage=await this.metadata.transaction(async tx=>{await context.assertCurrent(tx,'source.graph.build',paths);const rows=(await tx.query('SELECT e.complete FROM hyperfide.source_graph_files f JOIN hyperfide.source_graph_extractions e USING(organisation_id,repository_id,security_domain_id,cache_key) WHERE f.organisation_id=$1 AND f.repository_id=$2 AND f.security_domain_id=$3 AND f.build_id=$4',[...graphScope(context),input.build_id])).rows;return {complete:rows.length===manifest.entries.length&&rows.every(r=>r.complete),files:rows.length,fact_rows:totalRows,resolution_complete:unresolvedImports===0,unresolved_imports:unresolvedImports,extracted_files:extracted,reused_files:reused,changed_paths:[...changed].sort(),invalidated_paths:[...invalidated].sort(),limitations:['Unresolved imports remain explicit in parser facts; graph coverage does not qualify source changes']};});
  await this.overlay(context,input);signal.throwIfAborted();const stored=await this.metadata.transaction(async tx=>{await context.assertCurrent(tx,'source.graph.build',paths);await tx.query("UPDATE hyperfide.source_graph_builds SET state='READY',coverage=$5 WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND build_id=$4 AND state='BUILDING'",[...graphScope(context),input.build_id,JSON.stringify(coverage)]);return (await tx.query('SELECT state,coverage FROM hyperfide.source_graph_builds WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND build_id=$4',[...graphScope(context),input.build_id])).rows[0]!;});
  return {build_id:input.build_id,identity,coverage:stored.coverage,state:stored.state,replayed:false};
 }
 async publish(context:SourceAuthorization,input:{operation_id:string;build_id:string;channel:string;expected_generation:string}){parseUUID(input.operation_id,'operation_id');parseUUID(input.build_id,'build_id');if(!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(input.channel)||typeof input.expected_generation!=='string'||!/^(0|[1-9][0-9]{0,18})$/.test(input.expected_generation)||BigInt(input.expected_generation)>=9223372036854775807n)failure('INVALID_REQUEST','Explicit graph channel and generation required');return publishNativeGraph(this.metadata,context,input);}
 async query(context:SourceAuthorization,input:{build_id:string;revision_id:string;root_tree_id:string;mode:string;path?:string;q?:string;limit?:number;cursor?:string}){parseUUID(input.build_id,'build_id');parseObjectId(input.revision_id);parseObjectId(input.root_tree_id);if(!['status','symbols','context','dependencies'].includes(input.mode))failure('INVALID_REQUEST','Unknown native graph query mode');if(input.path)parseRepositoryPath(input.path);if(input.q!==undefined&&(typeof input.q!=='string'||input.q.length>256))failure('INVALID_REQUEST','Bounded graph search text required');return queryNativeGraph(this.metadata,context,{...input,limit:positive(input.limit,32,128)},this.cursors);}
}
