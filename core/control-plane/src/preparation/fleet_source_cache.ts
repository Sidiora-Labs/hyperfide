import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fail,hash,DIGEST} from '../transport/protocol.js';
import type {FleetSourceEntry} from './fleet_source.js';
export interface FleetSourceCacheStats {hits:number;misses:number;read_bytes:number;source_bytes:number;evicted_entries:number;evicted_bytes:number}
export interface FleetSourceCache {read(entry:FleetSourceEntry):Promise<Buffer>;stats:FleetSourceCacheStats}
async function start(pid:number):Promise<string|null>{try{const raw=await fs.readFile('/proc/'+pid+'/stat','utf8');const fields=raw.slice(raw.lastIndexOf(')')+2).split(' ');return fields[0]==='Z'?null:fields[19]??null;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}}
async function directory(filename:string):Promise<void>{
 if(!path.isAbsolute(filename)||path.resolve(filename)!==filename)fail('FLEET_CACHE_PATH','Canonical absolute cache directory required');
 let current='/';for(const part of filename.split('/').filter(Boolean)){current=path.join(current,part);try{await fs.mkdir(current,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}const st=await fs.lstat(current);if(!st.isDirectory()||st.isSymbolicLink())fail('FLEET_CACHE_PATH','Cache ancestry cannot contain links');}
 const st=await fs.lstat(filename);if(st.uid!==process.getuid?.()||(st.mode&0o077))fail('FLEET_CACHE_PATH','Cache must be private to its installer account');
}
async function protectedBytes(filename:string,maximum:number,touch=false,ticket=false):Promise<Buffer>{
 const file=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);try{const st=await file.stat();if(!st.isFile()||(st.nlink!==1&&!(ticket&&st.nlink===0))||st.uid!==process.getuid?.()||(st.mode&0o077)||st.size>maximum)fail('FLEET_CACHE_PATH','Cache object must be a bounded private ordinary file');const buffer=Buffer.alloc(st.size+1);const count=await file.read(buffer,0,buffer.length,0);const bytes=buffer.subarray(0,count.bytesRead);if(bytes.length>maximum)fail('FLEET_CACHE_PATH','Cache file changed during read');if(bytes.length!==st.size){if(ticket)return Buffer.alloc(0);fail('FLEET_CACHE_PATH','Cache file changed during read');}if(touch)await file.utimes(new Date(),new Date());return bytes;}finally{await file.close();}
}
async function acquire(root:string):Promise<()=>Promise<void>>{
 const processStart=await start(process.pid);if(!processStart)fail('FLEET_CACHE_LOCK','Actual process identity required');
 const identity=process.pid+'-'+processStart+'-'+randomUUID(),name='.lock-'+identity,filename=path.join(root,name),publication=path.join(root,'.publish-'+identity);
 const pattern=/^\.lock-(\d+)-(\d+)-[0-9a-f-]{36}$/;
 const own={choosing:true,number:0};await fs.writeFile(filename,JSON.stringify(own),{flag:'wx',mode:0o600});
 const records=async()=>{const result:Array<{name:string;choosing:boolean;number:number}>=[];for(const other of await fs.readdir(root)){const match=pattern.exec(other);if(!match)continue;if(await start(Number(match[1]))!==match[2]){await fs.unlink(path.join(root,other)).catch((error:NodeJS.ErrnoException)=>{if(error.code!=='ENOENT')throw error;});continue;}let bytes;try{bytes=await protectedBytes(path.join(root,other),4096,false,true);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}let value;try{value=JSON.parse(bytes.toString('utf8'));}catch{result.push({name:other,choosing:true,number:0});continue;}if(typeof value.choosing!=='boolean'||!Number.isSafeInteger(value.number)||value.number<0)fail('FLEET_CACHE_LOCK','Unknown live cache lock is preserved');result.push({name:other,choosing:value.choosing,number:value.number});}return result;};
 try{
  const ticket=1+Math.max(0,...(await records()).map(record=>record.number));if(!Number.isSafeInteger(ticket))fail('FLEET_CACHE_LOCK','Cache ticket bound exhausted');
  await fs.writeFile(publication,JSON.stringify({choosing:false,number:ticket}),{flag:'wx',mode:0o600});await fs.rename(publication,filename);
  for(let attempt=0;attempt<100;attempt++){const blocked=(await records()).some(other=>other.name!==name&&(other.choosing||other.number<ticket||other.number===ticket&&other.name<name));if(!blocked)return async()=>{await fs.unlink(filename);};await new Promise(resolve=>setTimeout(resolve,10));}
  fail('FLEET_CACHE_BUSY','Another installer owns this cache');
 }catch(error){await fs.unlink(filename);await fs.unlink(publication).catch((e:NodeJS.ErrnoException)=>{if(e.code!=='ENOENT')throw e;});throw error;}
}
export async function withFleetSourceCache<T>(input:{directory:string;maxBytes:number;maxEntries:number;namespace:string},body:(cache:FleetSourceCache)=>Promise<T>):Promise<T>{
 if(!Number.isSafeInteger(input.maxBytes)||input.maxBytes<1||!Number.isSafeInteger(input.maxEntries)||input.maxEntries<1||!DIGEST.test(input.namespace))fail('FLEET_CACHE_LIMIT','Positive bounded cache policy required');
 await directory(input.directory);const handle=await fs.open(input.directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
 const anchored='/proc/self/fd/'+handle.fd;let release:(()=>Promise<void>)|undefined;
 const rootStat=await handle.stat();if(!rootStat.isDirectory()||rootStat.uid!==process.getuid?.()||(rootStat.mode&0o077)||await fs.realpath(anchored)!==input.directory){await handle.close();fail('FLEET_CACHE_PATH','Cache directory identity changed before anchoring');}
 input={...input,directory:anchored};
 const stats:FleetSourceCacheStats={hits:0,misses:0,read_bytes:0,source_bytes:0,evicted_entries:0,evicted_bytes:0};
 let queue=Promise.resolve();
 try{
  release=await acquire(anchored);
  const inventory: Array<{name:string;size:number;mtime:number}>=[];let total=0;
  for(const name of await fs.readdir(input.directory)){
   if(/^\.lock-\d+-\d+-[0-9a-f-]{36}$/.test(name))continue;if(/^\.publish-\d+-\d+-[0-9a-f-]{36}$/.test(name)){const parts=name.split('-');if(await start(Number(parts[1]))!==parts[2])await fs.unlink(path.join(input.directory,name));continue;}const filename=path.join(input.directory,name),st=await fs.lstat(filename);
   if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.uid!==process.getuid?.()||(st.mode&0o077))fail('FLEET_CACHE_PATH','Unknown cache content is preserved');
   if(/^\.partial-[0-9a-f-]{36}$/.test(name)){await fs.unlink(filename);continue;}
   if(!/^[0-9a-f]{64}-[0-9a-f]{64}$/.test(name))fail('FLEET_CACHE_PATH','Unrecognized cache content is preserved');
   inventory.push({name,size:st.size,mtime:st.mtimeMs});total+=st.size;
  }
  const prune=async(bytes:number,entries:number)=>{inventory.sort((a,b)=>a.mtime-b.mtime||a.name.localeCompare(b.name));while(inventory.length&&(total+bytes>input.maxBytes||inventory.length+entries>input.maxEntries)){const old=inventory.shift()!;await fs.unlink(path.join(input.directory,old.name));total-=old.size;stats.evicted_entries++;stats.evicted_bytes+=old.size;}};
  await prune(0,0);
  const readObject=async(entry:FleetSourceEntry):Promise<Buffer>=>{
   if(!DIGEST.test(entry.digest)||!Number.isSafeInteger(entry.size)||entry.size<0)fail('FLEET_SOURCE_INTEGRITY','Invalid admitted cache object');
   const name=input.namespace.slice(7)+'-'+entry.digest.slice(7),filename=path.join(input.directory,name),known=inventory.find(item=>item.name===name);
   if(known){const bytes=await protectedBytes(filename,input.maxBytes,true);if(bytes.length===entry.size&&hash(bytes)===entry.digest){stats.hits++;stats.read_bytes+=bytes.length;known.mtime=Date.now();return bytes;}await fs.unlink(filename);inventory.splice(inventory.indexOf(known),1);total-=known.size;stats.evicted_entries++;stats.evicted_bytes+=known.size;}
   const bytes=Buffer.from(entry.content_base64,'base64');if(bytes.toString('base64')!==entry.content_base64||bytes.length!==entry.size||hash(bytes)!==entry.digest)fail('FLEET_SOURCE_INTEGRITY','Inline source differs from admitted digest');stats.misses++;stats.source_bytes+=bytes.length;
   if(bytes.length<=input.maxBytes){await prune(bytes.length,1);const partial=path.join(input.directory,'.partial-'+randomUUID());const file=await fs.open(partial,'wx',0o600);try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}await fs.rename(partial,filename);inventory.push({name,size:bytes.length,mtime:Date.now()});total+=bytes.length;}
   return bytes;
  };
  const cache:FleetSourceCache={stats,read:entry=>{const pending=queue.then(()=>readObject(entry));queue=pending.then(()=>{},()=>{});return pending;}};
  return await body(cache);
 }finally{await queue;try{if(release)await release();}finally{await handle.close();}}
}
