import {createSignedSourceClient} from '@hyperfide/authority';
import {constants} from 'node:fs';
import {mkdir,mkdtemp,open,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {NativeWorkspaceClient,assertObjectId,repositoryPath,withinScope,type WorkspaceBudgets} from '../../core/host-daemon/src/source-control/client';
import {NativeObjectCache} from '../../core/host-daemon/src/source-control/cache';
import {SourceWorkspaceJournal} from '../../core/host-daemon/src/source-control/journal';
import {SparseSourceMaterializer} from '../../core/host-daemon/src/source-control/materializer';
import type {ManagedEnvironment} from './adapter';

export interface NativeQualificationConfiguration {
 schema_version:1;
 transport:Parameters<typeof createSignedSourceClient>[0];
 revision_id:string;
 read_paths:string[];
 budgets:WorkspaceBudgets;
}
export async function readNativeQualificationConfiguration(filename:string):Promise<NativeQualificationConfiguration>{
 if(!path.isAbsolute(filename)||path.resolve(filename)!==filename)throw new Error('Native qualification configuration must be an absolute protected file');
 const file=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const stat=await file.stat();if(!stat.isFile()||stat.size>65536||stat.mode&0o077||stat.nlink!==1||typeof process.getuid==='function'&&stat.uid!==process.getuid())throw new Error('Native qualification configuration must be a bounded private file');
  const value:unknown=JSON.parse(await file.readFile('utf8'));
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='budgets,read_paths,revision_id,schema_version,transport')throw new Error('Invalid native qualification configuration');
  const config=value as NativeQualificationConfiguration;
  if(config.schema_version!==1||!Array.isArray(config.read_paths)||!config.read_paths.length||config.read_paths.length>256||new Set(config.read_paths).size!==config.read_paths.length)throw new Error('Explicit native qualification source scope required');
  assertObjectId(config.revision_id);for(const entry of config.read_paths)if(entry!=='')repositoryPath(entry);
  const names=['cache_bytes','dirty_bytes','materialized_bytes','max_cache_entries','max_file_bytes'];
  if(!config.budgets||Object.keys(config.budgets).sort().join(',')!==names.sort().join(',')||Object.values(config.budgets).some(value=>!Number.isSafeInteger(value)||value<1))throw new Error('Explicit positive native qualification budgets required');
  return config;
 }finally{await file.close();}
}
export async function materializeQualification(config:NativeQualificationConfiguration,paths:string[],lane:string):Promise<ManagedEnvironment>{
 for(const entry of paths)if(entry!==''&&!withinScope(repositoryPath(entry),config.read_paths))throw new Error('Qualification input is outside the configured source scope');
 const sdk=await createSignedSourceClient(config.transport);
 const client=new NativeWorkspaceClient({call:(action,input,options)=>sdk.call(action as Parameters<typeof sdk.call>[0],input,options)},config.transport.scope);
 const root=await mkdtemp(path.join(tmpdir(),'hyperfide-native-qualify-'));
 let workspace:Awaited<ReturnType<typeof client.open>>|undefined;
 try{
  workspace=await client.open({base_revision_id:config.revision_id,mode:'SPARSE',read_paths:paths,write_paths:[],budgets:config.budgets});
  const journal=new SourceWorkspaceJournal(path.join(root,'journal'));
  const materializer=new SparseSourceMaterializer(client,new NativeObjectCache(path.join(root,'cache'),{max_bytes:config.budgets.cache_bytes,max_entries:config.budgets.max_cache_entries,max_object_bytes:8*1024*1024}),journal,path.join(root,'source'));
  await materializer.materialize(workspace,paths);
  const installed=(await journal.snapshot()).installed;
  const current=workspace,bin=path.join(root,'bin');
  await mkdir(bin);await symlink(process.execPath,path.join(bin,'node'));
  await writeFile(path.join(bin,'pnpm'),'#!/bin/sh\nexec corepack pnpm@9.15.0 "$@"\n',{mode:0o755});
  return {id:'native-'+lane,path:materializer.root,variables:{...process.env,PATH:bin+':'+path.dirname(process.execPath)+':'+(process.env.PATH??'')},source:{schema_version:1,scope:current.scope,revision_id:current.base_revision_id,root_tree_id:current.root_tree_id,workspace_id:current.workspace_id},sourceFiles:installed,
   async release(){
    try{await client.close(current);}
    finally{await rm(root,{recursive:true,force:true});}
   }};
 }catch(error){
  if(workspace)try{await client.close(workspace);}catch{}
  await rm(root,{recursive:true,force:true});throw error;
 }
}
export async function readNativeTask(config:NativeQualificationConfiguration,feature:string,task:string):Promise<string>{
 if(!/^[\w-]+$/.test(feature))throw new Error('Invalid feature');
 const environment=await materializeQualification(config,['spec/'+feature+'/spec.kvx'],'task-'+task);
 try{return await readFile(path.join(environment.path,'spec',feature,'spec.kvx'),'utf8');}
 finally{await environment.release();}
}
