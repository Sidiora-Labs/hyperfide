import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import {documentDigest} from './seal.js';
import {fail,hash,DIGEST} from '../transport/protocol.js';
const execute=promisify(execFile);
export interface GitSourceEntry{path:string;mode:'100644'|'100755';git_oid:string;size:number;digest:string;content_base64:string}
export interface GitSourceManifest{schema_version:1;kind:'hyperfide.git-source-manifest';repository:string;revision:string;tree_oid:string;paths:string[];entries:GitSourceEntry[];bytes:number;digest:string;transfer_mode?:'metadata-only'}
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
export async function materializeGitSource(manifest:GitSourceManifest,root:string,scopes:readonly string[],readBytes:(entry:GitSourceEntry)=>Promise<Buffer>=async entry=>Buffer.from(entry.content_base64,'base64')):Promise<GitSourceEntry[]>{
 const realRoot=await fs.realpath(root);if(realRoot!==path.resolve(root)||(await fs.lstat(root)).isSymbolicLink())fail('FLEET_SOURCE_PATH','Materialization root must be an ordinary canonical directory');
 const selected=manifest.entries.filter(entry=>sourceScopeAllows(scopes,entry.path));if(!selected.length)fail('FLEET_SOURCE_EMPTY','Mount scope contains no admitted files');
 for(const entry of selected){const destination=path.join(root,safeSourcePath(entry.path));let directory=root;for(const component of entry.path.split('/').slice(0,-1)){directory=path.join(directory,component);try{await fs.mkdir(directory,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}const info=await fs.lstat(directory);if(!info.isDirectory()||info.isSymbolicLink())fail('FLEET_SOURCE_PATH','Source parent cannot be a symlink');}let old:Buffer|null=null;try{const info=await fs.lstat(destination);if(!info.isFile()||info.isSymbolicLink())fail('FLEET_SOURCE_DIRTY','Existing source is not a regular file');old=await fs.readFile(destination);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 if(old!==null&&hash(old)!==entry.digest)fail('FLEET_SOURCE_DIRTY','Existing source differs; refusing to overwrite dirty content');
 if(old===null){const bytes=await readBytes(entry);if(bytes.length!==entry.size||hash(bytes)!==entry.digest)fail('FLEET_SOURCE_INTEGRITY','Materialized cache bytes differ from admitted object');await fs.writeFile(destination,bytes,{flag:'wx',mode:entry.mode==='100755'?0o755:0o644});}}
 return selected;
}
