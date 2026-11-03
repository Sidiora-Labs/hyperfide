import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import {documentDigest} from './seal.js';
import {fail,hash,DIGEST,uuid} from '../transport/protocol.js';
import {decodeFileDescriptor,sourceObjectId} from '../source_control/objects.js';
import type {SourceObjectService} from '../source_control/objects.js';
import type {SourceMetadata} from '../source_control/metadata.js';
import type {PersistentTree} from '../source_control/trees.js';
import type {SourceAuthorization} from '../source_control/capabilities.js';
import type {SourceScope,TreeEntry} from '../source_control/contracts.js';
const execute=promisify(execFile);
export interface GitSourceEntry{path:string;mode:'100644'|'100755';git_oid:string;size:number;digest:string;content_base64:string}
export interface GitSourceManifest{schema_version:1;kind:'hyperfide.git-source-manifest';repository:string;revision:string;tree_oid:string;paths:string[];entries:GitSourceEntry[];bytes:number;digest:string;transfer_mode?:'metadata-only'}
export interface NativeSourceEntry{path:string;mode:'100644'|'100755';file_object_id:string;file_descriptor_base64:string;size:number;digest:string;content_base64:string}
export interface NativeSourceManifest{schema_version:1;kind:'hyperfide.native-source-manifest';scope:SourceScope;repository:string;revision:string;root_tree_id:string;paths:string[];entries:NativeSourceEntry[];bytes:number;digest:string;transfer_mode?:'metadata-only'}
export type FleetSourceEntry=GitSourceEntry|NativeSourceEntry;
export type FleetSourceManifest=GitSourceManifest|NativeSourceManifest;
export interface FleetSourceExpectation{digest:string;revision:string;repository:string;readScope:readonly string[];metadataOnly?:boolean;backend:'git'|'native';scope?:SourceScope}
export function sourceManifestTreeId(value:FleetSourceManifest):string{return value.kind==='hyperfide.native-source-manifest'?value.root_tree_id:value.tree_oid;}
export function sourceRevisionObjectId(revision:string):string{
 if(typeof revision==='string'&&/^git:(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(revision))return revision.slice(4);
 if(typeof revision==='string'&&DIGEST.test(revision))return revision;
 return fail('FLEET_SOURCE_REVISION','Explicit immutable Git or native source revision required');
}
export function nativeFleetWorkspaceId(logicalOperationId:string,slot:number):string{
 if(!uuid(logicalOperationId)||!Number.isSafeInteger(slot)||slot<0||slot>1023)fail('FLEET_SOURCE_WORKSPACE','Exact install operation and bounded worker slot required');
 const bytes=Buffer.from(hash('hyperfide-native-fleet-workspace\0'+logicalOperationId+'\0'+slot).slice(7),'hex').subarray(0,16);
 bytes[6]=(bytes[6]!&0x0f)|0x80;bytes[8]=(bytes[8]!&0x3f)|0x80;
 const hex=bytes.toString('hex');return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
}
export function safeSourcePath(value:string):string{
 if(typeof value!=='string'||!value||value.startsWith('/')||value.includes('\\')||/[\x00-\x1f\x7f]/.test(value)||value.split('/').some(p=>!p||p==='.'||p==='..'||p==='.git'))fail('FLEET_SOURCE_PATH','Canonical repository-relative source path required');return value;
}
export function sourceScopeAllows(scopes:readonly string[],name:string):boolean{
 return scopes.some(scope=>{if(scope==='**')return true;const escaped=scope.split('/').map(part=>part==='**'?'.*':part.replace(/[.+?^${}()|[\]\\]/g,'\\$&').replace(/\*/g,'[^/]*')).join('/');return new RegExp('^'+escaped+'$').test(name);});
}
function sourceDigest(value:Omit<GitSourceManifest,'digest'>):string{return documentDigest(value);}
async function readGitObjects(repository:string,oids:string[],limit:number):Promise<Map<string,Buffer>>{
 const child=spawn('git',['-C',repository,'cat-file','--batch'],{stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH??'/usr/bin:/bin',GIT_OPTIONAL_LOCKS:'0',GIT_NO_LAZY_FETCH:'1'}});
 const input=oids.join('\n')+'\n',chunks:Buffer[]=[];let total=0;const errors:Buffer[]=[];
 child.stdout.on('data',(bytes:Buffer)=>{total+=bytes.length;if(total>limit+oids.length*256){child.kill('SIGKILL');return;}chunks.push(bytes);});
 child.stderr.on('data',(bytes:Buffer)=>{if(errors.reduce((n,x)=>n+x.length,0)<8192)errors.push(bytes);});child.stdin.end(input);
 const exit=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
 if(exit!==0||total>limit+oids.length*256)fail('FLEET_SOURCE_OBJECT','Pinned source objects are unavailable or exceed the transfer budget');
 const data=Buffer.concat(chunks),result=new Map<string,Buffer>();let offset=0;
 for(const oid of oids){const end=data.indexOf(10,offset);if(end<0)fail('FLEET_SOURCE_OBJECT','Truncated Git object framing');const header=data.subarray(offset,end).toString('ascii').split(' ');if(header.length!==3||header[0]!==oid||header[1]!=='blob'||!/^\d+$/.test(header[2]!))fail('FLEET_SOURCE_OBJECT','Pinned Git blob missing');const size=Number(header[2]);offset=end+1;if(!Number.isSafeInteger(size)||offset+size>=data.length||data[offset+size]!==10)fail('FLEET_SOURCE_OBJECT','Invalid Git blob length');result.set(oid,data.subarray(offset,offset+size));offset+=size+1;}
 return result;
}
export async function createGitSourceManifest(input:{repositoryPath:string;repository:string;revision:string;tree_oid:string;paths:string[];maxFiles?:number;maxBytes?:number;metadataOnly?:boolean}):Promise<GitSourceManifest>{
 if(!/^git:[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(input.revision))fail('FLEET_SOURCE_REVISION','Full immutable git: revision required');
 if(input.metadataOnly!==undefined&&typeof input.metadataOnly!=='boolean')fail('FLEET_SOURCE_SCOPE','Explicit metadata-only transfer flag must be boolean');
 if(input.metadataOnly?input.paths.length!==0:!input.paths.length||input.paths.length>1024||input.paths.some(p=>p!=='**'&&(!p||p.startsWith('/')||p.includes('..')||p.includes('\\'))))fail('FLEET_SOURCE_SCOPE','Explicit safe source scope or metadata-only transfer required');
 const maximumFiles=input.maxFiles??100000,maximumBytes=input.maxBytes??64*1024*1024;
 if(!Number.isSafeInteger(maximumFiles)||maximumFiles<1||!Number.isSafeInteger(maximumBytes)||maximumBytes<1)fail('FLEET_SOURCE_LIMIT','Positive source limits required');
 const revision=input.revision.slice(4),repository=await fs.realpath(input.repositoryPath);
 const pin=await execute('git',['-C',repository,'rev-parse','--verify',revision+'^{commit}'],{maxBuffer:4096});if(pin.stdout.trim()!==revision)fail('FLEET_SOURCE_REVISION','Pinned commit cannot be resolved');
 const tree=(await execute('git',['-C',repository,'rev-parse','--verify',revision+'^{tree}'],{maxBuffer:4096})).stdout.trim();
 if(input.metadataOnly){const manifest:Omit<GitSourceManifest,'digest'>={schema_version:1,kind:'hyperfide.git-source-manifest',repository:input.repository,revision:input.revision,tree_oid:tree,paths:[],entries:[],bytes:0,transfer_mode:'metadata-only'};return {...manifest,digest:sourceDigest(manifest)};}
 const prefixes=[...new Set(input.paths.map(pattern=>pattern==='**'?'.':pattern.split('/').slice(0,pattern.split('/').findIndex(part=>part.includes('*'))<0?undefined:pattern.split('/').findIndex(part=>part.includes('*'))).join('/')||'.').filter(Boolean))];
 const listing=await execute('git',['-C',repository,'ls-tree','-r','-z','-l',revision,'--',...prefixes],{encoding:'buffer',maxBuffer:32*1024*1024});
 const selected:Array<Omit<GitSourceEntry,'content_base64'|'digest'>>=[];let size=0;
 for(const raw of new TextDecoder('utf-8',{fatal:true}).decode(listing.stdout).split('\0')){if(!raw)continue;const tab=raw.indexOf('\t'),fields=raw.slice(0,tab).trim().split(/\s+/),name=safeSourcePath(raw.slice(tab+1));if(!sourceScopeAllows(input.paths,name))continue;if(fields[1]!=='blob'||!['100644','100755'].includes(fields[0]!))fail('FLEET_SOURCE_KIND','Git prerequisite currently supports regular source files only');const bytes=Number(fields[3]);size+=bytes;if(!Number.isSafeInteger(bytes)||bytes<0||size>maximumBytes||selected.length>=maximumFiles)fail('FLEET_SOURCE_LIMIT','Selected source exceeds explicit file or byte bound');selected.push({path:name,mode:fields[0] as GitSourceEntry['mode'],git_oid:fields[2]!,size:bytes});}
 if(!selected.length)fail('FLEET_SOURCE_EMPTY','Selected source scope contains no files');
 const objects=await readGitObjects(repository,[...new Set(selected.map(item=>item.git_oid))],maximumBytes);
 const entries=selected.sort((a,b)=>a.path.localeCompare(b.path)).map(item=>{const bytes=objects.get(item.git_oid)!;if(bytes.length!==item.size)fail('FLEET_SOURCE_OBJECT','Git object length changed');return {...item,digest:hash(bytes),content_base64:bytes.toString('base64')};});
 const manifest:Omit<GitSourceManifest,'digest'>={schema_version:1,kind:'hyperfide.git-source-manifest',repository:input.repository,revision:input.revision,tree_oid:tree,paths:[...input.paths],entries,bytes:size};return {...manifest,digest:sourceDigest(manifest)};
}
export function verifyGitSourceManifest(value:GitSourceManifest,expected:{digest:string;revision:string;repository:string;readScope:readonly string[];metadataOnly?:boolean}):GitSourceManifest{
 const {digest,...body}=value;
 if(value.schema_version!==1||value.kind!=='hyperfide.git-source-manifest'||digest!==expected.digest||sourceDigest(body)!==digest||value.revision!==expected.revision||value.repository!==expected.repository||!Array.isArray(value.entries)||value.entries.length>100000||!(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value.tree_oid)))fail('FLEET_SOURCE_MANIFEST','Source manifest does not match admitted source');
 if(expected.metadataOnly){if(value.transfer_mode!=='metadata-only'||value.entries.length||value.paths.length||value.bytes!==0)fail('FLEET_SOURCE_MANIFEST','Metadata-only source manifest cannot carry code objects');return value;}
 if(value.transfer_mode!==undefined||!value.entries.length)fail('FLEET_SOURCE_MANIFEST','File transfer requires nonempty admitted source objects');
 let total=0;const seen=new Set<string>();
 for(const entry of value.entries){safeSourcePath(entry.path);if(seen.has(entry.path)||!sourceScopeAllows(expected.readScope,entry.path)||!sourceScopeAllows(value.paths,entry.path)||!['100644','100755'].includes(entry.mode)||!DIGEST.test(entry.digest)||!Number.isSafeInteger(entry.size)||entry.size<0)fail('FLEET_SOURCE_SCOPE','Invalid, duplicate or unauthorized source entry');seen.add(entry.path);const bytes=Buffer.from(entry.content_base64,'base64');total+=bytes.length;if(total>64*1024*1024||bytes.toString('base64')!==entry.content_base64||bytes.length!==entry.size||hash(bytes)!==entry.digest)fail('FLEET_SOURCE_INTEGRITY','Source bytes differ from admitted object');}
 if(total!==value.bytes)fail('FLEET_SOURCE_INTEGRITY','Manifest byte inventory differs');return value;
}
export async function materializeFleetSource(manifest:FleetSourceManifest,root:string,scopes:readonly string[],readBytes:(entry:FleetSourceEntry)=>Promise<Buffer>=async entry=>Buffer.from(entry.content_base64,'base64')):Promise<FleetSourceEntry[]>{
 const realRoot=await fs.realpath(root);if(realRoot!==path.resolve(root)||(await fs.lstat(root)).isSymbolicLink())fail('FLEET_SOURCE_PATH','Materialization root must be an ordinary canonical directory');
 const selected=manifest.entries.filter(entry=>sourceScopeAllows(scopes,entry.path));if(!selected.length)fail('FLEET_SOURCE_EMPTY','Mount scope contains no admitted files');
 for(const entry of selected){const destination=path.join(root,safeSourcePath(entry.path));let directory=root;for(const component of entry.path.split('/').slice(0,-1)){directory=path.join(directory,component);try{await fs.mkdir(directory,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}const info=await fs.lstat(directory);if(!info.isDirectory()||info.isSymbolicLink())fail('FLEET_SOURCE_PATH','Source parent cannot be a symlink');}let old:Buffer|null=null;try{const info=await fs.lstat(destination);if(!info.isFile()||info.isSymbolicLink())fail('FLEET_SOURCE_DIRTY','Existing source is not a regular file');old=await fs.readFile(destination);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 if(old!==null&&hash(old)!==entry.digest)fail('FLEET_SOURCE_DIRTY','Existing source differs; refusing to overwrite dirty content');
 if(old===null){const bytes=await readBytes(entry);if(bytes.length!==entry.size||hash(bytes)!==entry.digest)fail('FLEET_SOURCE_INTEGRITY','Materialized cache bytes differ from admitted object');await fs.writeFile(destination,bytes,{flag:'wx',mode:entry.mode==='100755'?0o755:0o644});}}
 return selected;
}

export async function materializeGitSource(manifest:GitSourceManifest,root:string,scopes:readonly string[],readBytes?:(entry:GitSourceEntry)=>Promise<Buffer>):Promise<GitSourceEntry[]>{
 return await materializeFleetSource(manifest,root,scopes,readBytes?entry=>readBytes(entry as GitSourceEntry):undefined) as GitSourceEntry[];
}

function nativeScope(value:SourceScope):boolean{return !!value&&Object.keys(value).length===3&&[value.organisation_id,value.repository_id,value.security_domain_id].every(item=>typeof item==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(item));}
function nativeFileBytes(entry:NativeSourceEntry):Buffer{
 if(typeof entry.file_descriptor_base64!=='string'||entry.file_descriptor_base64.length>1024*1024||typeof entry.content_base64!=='string'||entry.content_base64.length>90*1024*1024)fail('FLEET_SOURCE_INTEGRITY','Bounded canonical native file payload required');
 const descriptorBytes=Buffer.from(entry.file_descriptor_base64,'base64'),bytes=Buffer.from(entry.content_base64,'base64');
 if(descriptorBytes.toString('base64')!==entry.file_descriptor_base64||bytes.toString('base64')!==entry.content_base64||sourceObjectId('file',descriptorBytes)!==entry.file_object_id)fail('FLEET_SOURCE_INTEGRITY','Native file identity differs from its descriptor');
 const descriptor=decodeFileDescriptor(descriptorBytes);
 if(descriptor.size_bytes!==String(entry.size)||descriptor.content_digest!==entry.digest||bytes.length!==entry.size||hash(bytes)!==entry.digest)fail('FLEET_SOURCE_INTEGRITY','Native source content differs from its descriptor');
 const chunks=descriptor.content.kind==='blob'?[{object_id:descriptor.content.object_id,size_bytes:descriptor.size_bytes}]:descriptor.content.chunks;
 let offset=0;
 for(const chunk of chunks){const end=offset+Number(chunk.size_bytes);if(sourceObjectId(descriptor.content.kind==='blob'?'blob':'chunk',bytes.subarray(offset,end))!==chunk.object_id)fail('FLEET_SOURCE_INTEGRITY','Native content chunk differs from its descriptor');offset=end;}
 return bytes;
}

export function verifyFleetSourceManifest(value:FleetSourceManifest,expected:FleetSourceExpectation):FleetSourceManifest{
 if(expected.backend==='git'){if(value?.kind!=='hyperfide.git-source-manifest')fail('FLEET_SOURCE_BACKEND','Git source requires its explicit manifest type');return verifyGitSourceManifest(value,expected);}
 if(expected.backend!=='native'||value?.kind!=='hyperfide.native-source-manifest')fail('FLEET_SOURCE_BACKEND','Native source requires its explicit manifest type');
 const {digest,...body}=value;
 if(value.schema_version!==1||digest!==expected.digest||documentDigest(body)!==digest||value.repository!==expected.repository||value.revision!==expected.revision||!DIGEST.test(value.revision)||!DIGEST.test(value.root_tree_id)||!nativeScope(value.scope)||value.scope.repository_id!==value.repository||expected.scope&&documentDigest(value.scope)!==documentDigest(expected.scope)||!Array.isArray(value.paths)||value.paths.length>1024||!Array.isArray(value.entries)||value.entries.length>100000)fail('FLEET_SOURCE_MANIFEST','Native manifest differs from admitted source');
 for(const name of value.paths)if(name!=='**')safeSourcePath(name);
 if(expected.metadataOnly){if(value.transfer_mode!=='metadata-only'||value.paths.length||value.entries.length||value.bytes!==0)fail('FLEET_SOURCE_MANIFEST','Metadata-only native manifests cannot contain code');return value;}
 if(value.transfer_mode!==undefined||!value.paths.length||!value.entries.length)fail('FLEET_SOURCE_MANIFEST','Native source transfer requires explicit selected files');
 let total=0;const seen=new Set<string>();
 for(const entry of value.entries){safeSourcePath(entry.path);if(seen.has(entry.path)||!sourceScopeAllows(expected.readScope,entry.path)||!sourceScopeAllows(value.paths,entry.path)||!['100644','100755'].includes(entry.mode)||!DIGEST.test(entry.digest)||!DIGEST.test(entry.file_object_id)||!Number.isSafeInteger(entry.size)||entry.size<0||total+entry.size>64*1024*1024)fail('FLEET_SOURCE_SCOPE','Invalid or unauthorized native source entry');seen.add(entry.path);total+=nativeFileBytes(entry).length;}
 if(total!==value.bytes)fail('FLEET_SOURCE_INTEGRITY','Native manifest byte inventory differs');
 return value;
}

function mayContainSource(pattern:string,directory:string):boolean{
 if(!directory)return true;
 const patternParts=pattern.split('/'),parts=directory.split('/');
 for(let index=0;index<parts.length;index++){const part=patternParts[index];if(part==='**')return true;if(part===undefined||!sourceScopeAllows([part],parts[index]!))return false;}
 return parts.length<patternParts.length;
}

export async function createNativeSourceManifest(input:{metadata:SourceMetadata;trees:PersistentTree;objects:SourceObjectService;authorization:SourceAuthorization;repository:string;revision:string;paths:string[];maxFiles?:number;maxBytes?:number;maxNodes?:number;metadataOnly?:boolean}):Promise<NativeSourceManifest>{
 const {metadata,trees,objects,authorization}=input;
 if(!nativeScope(authorization.scope)||authorization.scope.repository_id!==input.repository||!DIGEST.test(input.revision))fail('FLEET_SOURCE_REVISION','Scoped immutable native revision required');
 if((input.metadataOnly!==undefined&&typeof input.metadataOnly!=='boolean')||!Array.isArray(input.paths)||input.paths.length>1024||(input.metadataOnly?input.paths.length!==0:!input.paths.length))fail('FLEET_SOURCE_SCOPE','Explicit selected native paths or metadata-only transfer required');
 for(const selected of input.paths)if(selected!=='**')safeSourcePath(selected);
 const maximumFiles=input.maxFiles??100000,maximumBytes=input.maxBytes??64*1024*1024,maximumNodes=input.maxNodes??100000;
 if(!Number.isSafeInteger(maximumFiles)||maximumFiles<1||maximumFiles>100000||!Number.isSafeInteger(maximumBytes)||maximumBytes<1||maximumBytes>64*1024*1024||!Number.isSafeInteger(maximumNodes)||maximumNodes<1||maximumNodes>100000)fail('FLEET_SOURCE_LIMIT','Bounded positive native transfer limits required');
 const record=await metadata.readRevision(authorization,input.revision),entries:NativeSourceEntry[]=[];
 const base={schema_version:1 as const,kind:'hyperfide.native-source-manifest' as const,scope:{...authorization.scope},repository:input.repository,revision:input.revision,root_tree_id:record.root_tree_id,paths:[...input.paths]};
 if(input.metadataOnly){const body={...base,entries,bytes:0,transfer_mode:'metadata-only' as const};return {...body,digest:documentDigest(body)};}
 const seen=new Set<string>(),visited=new Set<string>();let bytes=0,nodes=0,encodedBytes=Buffer.byteLength(JSON.stringify(base))+1024;
 const current=async(action:string,pathname:string)=>metadata.transaction(tx=>authorization.assertCurrent(tx,action,[pathname]));
 const file=async(pathname:string,entry:TreeEntry):Promise<void>=>{
  if(seen.has(pathname)||!sourceScopeAllows(input.paths,pathname))return;
  if(entry.kind!=='file'||!['100644','100755'].includes(entry.mode))fail('FLEET_SOURCE_KIND','Fleet source installation currently supports regular native files only');
  if(entries.length>=maximumFiles)fail('FLEET_SOURCE_LIMIT','Selected native files exceed the transfer bound');
  await metadata.transaction(tx=>authorization.assertObjectAccess(tx,{object_id:entry.object_id,revision_id:input.revision,paths:[pathname]}));
  const object=await objects.read(authorization.scope,entry.object_id);if(object.kind!=='file')fail('FLEET_SOURCE_INTEGRITY','Native file entry does not name a file descriptor');
  const descriptor=decodeFileDescriptor(object.payload),size=Number(descriptor.size_bytes);if(!Number.isSafeInteger(size)||bytes+size>maximumBytes)fail('FLEET_SOURCE_LIMIT','Selected native bytes exceed the transfer bound');
  const chunks=descriptor.content.kind==='blob'?[{object_id:descriptor.content.object_id,size_bytes:descriptor.size_bytes}]:descriptor.content.chunks,parts:Buffer[]=[];
  for(const chunk of chunks){await current('source.objects.read',pathname);const value=await objects.read(authorization.scope,chunk.object_id);if(value.kind!==(descriptor.content.kind==='blob'?'blob':'chunk')||value.payload.length!==Number(chunk.size_bytes))fail('FLEET_SOURCE_INTEGRITY','Native content chunk differs from its descriptor');parts.push(value.payload);}
  const content=Buffer.concat(parts);if(content.length!==size||hash(content)!==descriptor.content_digest)fail('FLEET_SOURCE_INTEGRITY','Native file bytes differ from their content digest');
  const selected:NativeSourceEntry={path:pathname,mode:entry.mode as NativeSourceEntry['mode'],file_object_id:entry.object_id,file_descriptor_base64:object.payload.toString('base64'),size,digest:descriptor.content_digest,content_base64:content.toString('base64')};
  encodedBytes+=Buffer.byteLength(JSON.stringify(selected))+1;if(encodedBytes>96*1024*1024)fail('FLEET_SOURCE_LIMIT','Encoded native source exceeds the manifest transfer bound');
  seen.add(pathname);bytes+=size;entries.push(selected);
 };
 const visit=async(tree:string,directory:string,depth:number):Promise<void>=>{
  if(visited.has(directory)||!input.paths.some(pattern=>mayContainSource(pattern,directory)))return;
  if(depth>256)fail('FLEET_SOURCE_LIMIT','Native source depth exceeds its bound');visited.add(directory);
  let cursor:string|undefined;
  do{if(++nodes>maximumNodes)fail('FLEET_SOURCE_LIMIT','Native source pages exceed the traversal bound');await current('source.trees.entries',directory);const page=await trees.list(authorization.scope,tree,{limit:256,...(cursor?{cursor}:{})});for(const entry of page.entries){const name=directory?directory+'/'+entry.name:entry.name;safeSourcePath(name);if(entry.kind==='directory')await visit(entry.object_id,name,depth+1);else await file(name,entry);}cursor=page.next_cursor??undefined;}while(cursor);
 };
 for(const pattern of input.paths){const parts=pattern.split('/'),wildcard=parts.findIndex(part=>part.includes('*')),prefix=parts.slice(0,wildcard<0?parts.length:wildcard).join('/');if(!prefix){await visit(record.root_tree_id,'',0);continue;}nodes+=prefix.split('/').length;if(nodes>maximumNodes)fail('FLEET_SOURCE_LIMIT','Native source lookups exceed the traversal bound');await current('source.trees.lookup',prefix);const entry=await trees.lookup(authorization.scope,record.root_tree_id,prefix);if(!entry)continue;if(entry.kind==='directory')await visit(entry.object_id,prefix,0);else await file(prefix,entry);}
 if(!entries.length)fail('FLEET_SOURCE_EMPTY','Selected native source contains no files');
 await metadata.readRevision(authorization,input.revision);
 entries.sort((left,right)=>Buffer.compare(Buffer.from(left.path),Buffer.from(right.path)));
 const body={...base,entries,bytes};return {...body,digest:documentDigest(body)};
}
