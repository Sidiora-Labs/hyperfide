import fs from 'node:fs/promises';
import path from 'node:path';
import {fail,hash} from '../transport/protocol.js';
import {documentDigest} from './seal.js';
import {captureDependencyInventory} from './fleet_install_inventory.js';
import type {DependencyInventoryEntry} from './fleet_install_inventory.js';
import {materializeGitSource,safeSourcePath,sourceScopeAllows} from './fleet_source.js';
import type {GitSourceEntry,GitSourceManifest} from './fleet_source.js';

type Document=Record<string,any>;
export interface FleetSourceFile {mount:string;path:string;digest:string;mode:GitSourceEntry['mode'];size:number}
export interface FleetSourceMount {name:string;target:string;access:'read_only'|'private_overlay';mode:'sparse'|'materialized';paths:string[];entries:GitSourceEntry[]}
export interface FleetMountLayout {apiOnly:boolean;environmentRoot:string;mounts:FleetSourceMount[];sourceFiles:FleetSourceFile[];unionEntries:GitSourceEntry[]}

function relative(root:string,filename:string):string {
 if(!path.isAbsolute(root)||path.resolve(root)!==root||!path.isAbsolute(filename)||path.resolve(filename)!==filename||/[\x00-\x1f\x7f]/.test(filename))fail('FLEET_INSTALL_PATH','Canonical absolute environment paths required');
 const result=path.relative(root,filename);
 if(!result||result==='..'||result.startsWith('..'+path.sep)||path.isAbsolute(result))fail('FLEET_INSTALL_PATH','Mount and worker roots must be strictly below the admitted environment');
 return result;
}
function overlaps(a:string,b:string):boolean{return a===b||a.startsWith(b+path.sep)||b.startsWith(a+path.sep);}
async function directory(root:string,filename:string):Promise<void>{
 const components=relative(root,filename).split(path.sep);let current=root;
 const rootStat=await fs.lstat(root);if(!rootStat.isDirectory()||rootStat.isSymbolicLink()||await fs.realpath(root)!==root)fail('FLEET_INSTALL_PATH','Canonical ordinary environment directory required');
 for(const component of components){current=path.join(current,component);try{await fs.mkdir(current,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}const stat=await fs.lstat(current);if(!stat.isDirectory()||stat.isSymbolicLink())fail('FLEET_INSTALL_PATH','Mount or workspace parent cannot be a symlink');}
}
export function resolveFleetMounts(input:{manifest:Document;sourceConfig:Document;source:GitSourceManifest}):FleetMountLayout {
 const {manifest:p,sourceConfig:n,source}=input,environmentRoot=p.environment.root as string;
 if(n.source.source_backend!=='git'||!['sparse','materialized','api_only'].includes(n.client.mode))fail('FLEET_INSTALL_BACKEND_UNSUPPORTED','Explicit Git sparse, materialized or API-only source mode required');
 const sections=Object.entries(p).filter(([key])=>key.startsWith('mount.')).sort(([a],[b])=>a.localeCompare(b));
 const apiOnly=n.client.mode==='api_only';
 if(apiOnly){if(sections.length||Object.keys(p).some(key=>key.startsWith('dependency.')))fail('FLEET_INSTALL_API_ONLY','API-only environments cannot request source mounts or source dependency installation');if(source.entries.length||source.bytes!==0)fail('FLEET_INSTALL_API_ONLY','API-only source manifest must contain metadata without code objects');return {apiOnly:true,environmentRoot,mounts:[],sourceFiles:[],unionEntries:[]};}
 if(!sections.length)fail('FLEET_INSTALL_MOUNT_REQUIRED','A file-based environment requires explicit scoped source mounts');
 const mounts:FleetSourceMount[]=[],sourceFiles:FleetSourceFile[]=[],union=new Map<string,GitSourceEntry>();
 for(const [key,spec]of sections as Array<[string,Document]>){
  if(spec.kind!=='source'||spec.source!=='primary'||!['sparse','materialized'].includes(spec.mode)||!['read_only','private_overlay'].includes(spec.access)||!Array.isArray(spec.paths)||!spec.paths.length)fail('FLEET_INSTALL_MOUNTS_UNSUPPORTED','Named mounts must select the admitted source with a supported explicit mode');
  relative(environmentRoot,spec.target);if(mounts.some(mount=>overlaps(mount.target,spec.target)))fail('FLEET_INSTALL_MOUNT_OVERLAP','Mount targets overlap');
  const entries=source.entries.filter(entry=>sourceScopeAllows(spec.paths,entry.path));if(!entries.length)fail('FLEET_SOURCE_EMPTY','Named mount contains no admitted source files');
  for(const entry of entries){safeSourcePath(entry.path);if(entry.path==='.neron')fail('FLEET_INSTALL_RESERVED_PATH','Source cannot replace the protected workspace descriptor');if(!sourceScopeAllows(n.workspace.read_scope,entry.path))fail('FLEET_SOURCE_SCOPE','Mount exceeds the admitted source scope');const old=union.get(entry.path);if(old&&(old.digest!==entry.digest||old.mode!==entry.mode||old.size!==entry.size))fail('FLEET_INSTALL_MOUNT_CONFLICT','Overlapping source selections disagree');union.set(entry.path,entry);sourceFiles.push({mount:key.slice(6),path:entry.path,digest:entry.digest,mode:entry.mode,size:entry.size});}
  mounts.push({name:key.slice(6),target:spec.target,access:spec.access,mode:spec.mode,paths:[...spec.paths],entries});
 }
 for(const [key,spec]of Object.entries(p)as Array<[string,Document]>)if(key.startsWith('dependency.')&&!mounts.some(mount=>mount.name===spec.mount))fail('FLEET_INSTALL_DEPENDENCY_SCOPE','Dependency names an absent source mount');
 return {apiOnly:false,environmentRoot,mounts,sourceFiles,unionEntries:[...union.values()].sort((a,b)=>a.path.localeCompare(b.path))};
}
export function fleetMountPath(layout:FleetMountLayout,actualRoot:string,mount:FleetSourceMount):string{return path.join(actualRoot,relative(layout.environmentRoot,mount.target));}
export async function materializeFleetMounts(layout:FleetMountLayout,source:GitSourceManifest,actualRoot:string):Promise<void>{
 for(const mount of layout.mounts){const target=fleetMountPath(layout,actualRoot,mount);await directory(actualRoot,target);const selected=await materializeGitSource(source,target,mount.paths);if(selected.length!==mount.entries.length||selected.some((entry,index)=>entry.path!==mount.entries[index]?.path||entry.digest!==mount.entries[index]?.digest||entry.mode!==mount.entries[index]?.mode))fail('FLEET_INSTALL_SOURCE_PLAN','Materialized mount differs from the resolved source inventory');}
}
async function mergeTree(sourceRoot:string,source:string,destination:string):Promise<void>{
 for(const item of await fs.readdir(source,{withFileTypes:true})){
  const from=path.join(source,item.name),to=path.join(destination,item.name),stat=await fs.lstat(from),old=await fs.lstat(to).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return null;throw error;});
  if(stat.isDirectory()){if(old&&(!old.isDirectory()||old.isSymbolicLink()))fail('FLEET_INSTALL_MOUNT_CONFLICT','Private mount outputs have conflicting file types');if(!old)await fs.mkdir(to,{mode:0o700});await mergeTree(sourceRoot,from,to);continue;}
  if(stat.isSymbolicLink()){const link=await fs.readlink(from),resolved=path.resolve(path.dirname(from),link),actual=await fs.realpath(from);if(path.isAbsolute(link)||!resolved.startsWith(sourceRoot+path.sep)||!actual.startsWith(sourceRoot+path.sep))fail('FLEET_INSTALL_SYMLINK','Private mount dependency link escapes its prepared mount');if(old){if(!old.isSymbolicLink()||await fs.readlink(to)!==link)fail('FLEET_INSTALL_MOUNT_CONFLICT','Private mount outputs contain conflicting links');}else await fs.symlink(link,to);continue;}
  if(!stat.isFile())fail('FLEET_INSTALL_FILE','Private mount outputs require regular files and contained links');
  if(old){if(!old.isFile()||old.isSymbolicLink()||hash(await fs.readFile(from))!==hash(await fs.readFile(to))||Boolean(stat.mode&0o111)!==Boolean(old.mode&0o111))fail('FLEET_INSTALL_MOUNT_CONFLICT','Private mount outputs contain conflicting files');continue;}
  await fs.copyFile(from,to,fs.constants.COPYFILE_EXCL);await fs.chmod(to,stat.mode&0o777);
 }
}
export async function assembleFleetWorkerSource(layout:FleetMountLayout,input:{actualRoot:string;workerSource:string}):Promise<void>{
 const target=path.join(input.actualRoot,relative(layout.environmentRoot,input.workerSource));
 await directory(input.actualRoot,target);
 for(const mount of layout.mounts){const base=fleetMountPath(layout,input.actualRoot,mount);if(overlaps(base,target))fail('FLEET_INSTALL_MOUNT_OVERLAP','Worker writable view cannot overlap a prepared mount');await mergeTree(base,base,target);}
}
export async function verifyFleetWorkerDependencies(layout:FleetMountLayout,input:{actualRoot:string;workerSource:string}):Promise<void>{
 const expected=new Map<string,DependencyInventoryEntry>();
 for(const mount of layout.mounts){const inventory=await captureDependencyInventory(fleetMountPath(layout,input.actualRoot,mount));for(const entry of inventory.entries){const previous=expected.get(entry.path);if(previous&&documentDigest(previous)!==documentDigest(entry))fail('FLEET_INSTALL_MOUNT_CONFLICT','Prepared mount dependency closures conflict');expected.set(entry.path,entry);}}
 const actual=await captureDependencyInventory(path.join(input.actualRoot,relative(layout.environmentRoot,input.workerSource)));
 if(actual.entries.length!==expected.size||actual.entries.some(entry=>!expected.has(entry.path)||documentDigest(expected.get(entry.path))!==documentDigest(entry)))fail('FLEET_INSTALL_DEPENDENCY_INTEGRITY','Private worker dependency closure differs from its prepared mount union');
}
