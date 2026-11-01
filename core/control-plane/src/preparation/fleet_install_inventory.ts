import fs from 'node:fs/promises';
import path from 'node:path';
import {constants,createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {fleetReadinessDigest as documentDigest} from './fleet_readiness_contract.js';
import {fail,hash} from '../transport/protocol.js';
import {fleetConfigurationTargets} from './fleet_configurations.js';
import type {FleetConfiguration,FleetConfigurationSlot} from './fleet_configurations.js';
import {readProtectedFile,readVerifiedInstalledFile} from './fleet_client.js';
type Data=Record<string,any>;
export interface DependencyInventoryEntry{path:string;kind:'file'|'symlink'|'directory';digest:string;executable?:boolean;target?:string;size?:number}
export interface DependencyInventory{schema_version:1;kind:'hyperfide.installed-dependency-inventory';entries:DependencyInventoryEntry[];digest:string}
async function stableDigest(filename:string):Promise<{digest:string;size:number;executable:boolean}>{
 const handle=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const before=await handle.stat();if(!before.isFile())fail('FLEET_INSTALL_DEPENDENCY_INTEGRITY','Dependency output is not a regular file');const hasher=createHash('sha256');let received=0;for await(const chunk of createReadStream(filename,{fd:handle.fd,autoClose:false})){const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);received+=bytes.length;hasher.update(bytes);}const after=await handle.stat();if(received!==before.size||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)fail('FLEET_INSTALL_DEPENDENCY_INTEGRITY','Dependency output changed while inventoried');return {digest:'sha256:'+hasher.digest('hex'),size:received,executable:Boolean(before.mode&0o111)};}finally{await handle.close();}
}
export async function captureDependencyInventory(root:string,options:{normalizeLinks?:boolean;maxEntries?:number;maxBytes?:number}={}):Promise<DependencyInventory>{
 const normalized=path.resolve(root);if(await fs.realpath(normalized)!==normalized)fail('FLEET_INSTALL_DEPENDENCY_INTEGRITY','Dependency root may not traverse symlinks');
 const entries:DependencyInventoryEntry[]=[],maximum=options.maxEntries??1000000,byteLimit=options.maxBytes??16*1024*1024*1024;let bytes=0;
 const walk=async(directory:string,insideModules:boolean):Promise<void>=>{
  for(const entry of (await fs.readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
   const filename=path.join(directory,entry.name),relative=path.relative(normalized,filename).split(path.sep).join('/');
   const moduleOutput=insideModules||entry.name==='node_modules';
   if(entry.isSymbolicLink()){
    if(!moduleOutput)continue;
    let target=await fs.readlink(filename);const absolute=path.resolve(path.dirname(filename),target),within=path.relative(normalized,absolute);
    if(within==='..'||within.startsWith('..'+path.sep)||path.isAbsolute(within))fail('FLEET_INSTALL_DEPENDENCY_INTEGRITY','Dependency symlink escapes its private copied source');
    const actual=await fs.realpath(filename),actualWithin=path.relative(normalized,actual);
    if(actualWithin==='..'||actualWithin.startsWith('..'+path.sep)||path.isAbsolute(actualWithin))fail('FLEET_INSTALL_DEPENDENCY_INTEGRITY','Dependency symlink resolves outside its copied source');
    if(path.isAbsolute(target)){if(!options.normalizeLinks)fail('FLEET_INSTALL_DEPENDENCY_INTEGRITY','Absolute dependency link is not portable across generation publication');target=path.relative(path.dirname(filename),absolute);await fs.unlink(filename);await fs.symlink(target,filename);}
    entries.push({path:relative,kind:'symlink',target,digest:hash(target)});
   }else if(entry.isDirectory()){if(moduleOutput)entries.push({path:relative,kind:'directory',digest:hash('directory')});await walk(filename,moduleOutput);}
   else if(entry.isFile()&&moduleOutput){const record=await stableDigest(filename);bytes+=record.size;if(bytes>byteLimit)fail('FLEET_INSTALL_DEPENDENCY_LIMIT','Installed dependency bytes exceed verification budget');entries.push({path:relative,kind:'file',...record});}
   else if(moduleOutput)fail('FLEET_INSTALL_DEPENDENCY_INTEGRITY','Unsupported dependency output file type');
   if(entries.length>maximum)fail('FLEET_INSTALL_DEPENDENCY_LIMIT','Installed dependency entries exceed verification budget');
  }
 };
 await walk(normalized,false);const body={schema_version:1 as const,kind:'hyperfide.installed-dependency-inventory' as const,entries};return {...body,digest:documentDigest(body)};
}
export function dependencyClosureDigest(inventory:DependencyInventory,pins:{lockfile_digest:string;selection:unknown}):string{return documentDigest({inventory_digest:inventory.digest,lockfile_digest:pins.lockfile_digest,selection:pins.selection});}
export async function verifyConfigurationSnapshot(input:{manifest:Data;plan:Data;receiptConfigurations:Data[];sourcePaths:Record<string,string>;slots?:readonly FleetConfigurationSlot[];secretValues?:Map<string,Buffer>;skipPrivate?:boolean;verifiedReadyReplay?:boolean;deferSecrets?:boolean;rootOverride?:{expected:string;actual:string}}):Promise<void>{
 for(const [section,configuration]of Object.entries(input.manifest)as Array<[string,Data]>){
  if(!section.startsWith('configuration.'))continue;const name=section.slice(14),record=input.receiptConfigurations.find(row=>row.name===name),pin=(input.plan.configuration_versions as Data[]).find(row=>row.name===name);
  if(!record){if(configuration.required)fail('FLEET_INSTALL_CONFIGURATION_MISSING','Required installed configuration is absent');continue;}
  if(!pin||record.reference!==configuration.reference||record.version!==pin.version||record.target!==configuration.target||record.mode!==configuration.mode)fail('FLEET_INSTALL_CONFIGURATION_PIN','Installed configuration version differs from immutable plan');
  const targets=fleetConfigurationTargets(configuration as FleetConfiguration,input.slots??[]),privateConfig=configuration.kind==='secret-ref'||configuration.mode!=='0444';
  if(privateConfig&&documentDigest(record.slots)!==documentDigest(targets))fail('FLEET_INSTALL_CONFIGURATION_PIN','Private configuration targets differ from signed workers');
  if(privateConfig&&input.skipPrivate||configuration.kind==='secret-ref'&&input.deferSecrets)continue;
  for(const destination of privateConfig?targets.map(item=>item.target):[configuration.target]){
   const filename=input.rootOverride?path.join(input.rootOverride.actual,path.relative(input.rootOverride.expected,destination)):destination;const actual=input.verifiedReadyReplay&&!privateConfig?await readVerifiedInstalledFile(filename,1024*1024,pin.digest):await readProtectedFile(filename,1024*1024,configuration.kind==='secret-ref');
   if(configuration.kind==='secret-ref'){
    const original=input.sourcePaths[name],expected=input.secretValues?.get(name)??(original?await readProtectedFile(original,1024*1024,true):null);if(!expected)fail('FLEET_INSTALL_CONFIGURATION_MISSING','Secret reuse requires its protected reference channel');if(!actual.equals(expected))fail('FLEET_INSTALL_CONFIGURATION_PIN','Installed secret differs from protected resolved reference');
   }else if(hash(actual)!==pin.digest)fail('FLEET_INSTALL_CONFIGURATION_PIN','Installed configuration bytes differ from immutable reference');
   const mode=(await fs.lstat(filename)).mode&0o777;if(mode!==parseInt(configuration.mode,8))fail('FLEET_INSTALL_CONFIGURATION_PIN','Installed configuration permissions differ');
  }
 }
}
