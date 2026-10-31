import {readFileSync,lstatSync} from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {FoundationError,object} from '../policy/programme.js';

/**
 * Internal object store (hyperfide-v21 2.11, req 6 ac_1).
 * A bare Git repository on the operator's infrastructure is the store; each provider region has a bare mirror reachable over
 * that provider's private network. Materialisation resolves the mirror for the sandbox's provider and region and never uses
 * GitHub, which holds only the published projection. The configuration is the file named by HF_SLICE_SOURCE_CONFIG in the
 * provisioner environment file; schema 1 (one url per repository) is still read, as a store with no mirrors.
 */
export interface StoreSource {store:string;mirrors:Record<string,Record<string,string>>}
export interface ObjectStoreConfig {
 schema_version:1|2;
 /** What a region without its own mirror gets: the primary store, or a refusal. The operator decides; there is no default. */
 missing_region:'STORE'|'REFUSE';
 repositories:Record<string,StoreSource&{submodules:Record<string,StoreSource>}>;
}
export interface ResolvedSource {url:string;store:string;provider:string;region:string;resolution:'MIRROR'|'STORE'}

function fail(code:string,message:string):never{throw new FoundationError(code,message);}
function exact(value:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!object(value)||Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)))fail('SLICE_SOURCE_UNAVAILABLE','Fields differ from the object store contract');
 return value;
}
function name(value:unknown):string{
 if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value))fail('SLICE_SOURCE_UNAVAILABLE','Provider and region names must be plain identifiers');
 return value;
}
/**
 * An IP literal names no owner, so it cannot be shown not to be GitHub (hyperfide-v21 3.21). Covers bracketed IPv6 (mapped
 * IPv4 included) and every IPv4 spelling inet_aton accepts: ssh: is not a special scheme, so URL leaves 0x8c.0122.28707 or
 * 2358111235 as written where https: would have normalised it to dotted decimal.
 */
export function isIPLiteral(hostname:string):boolean{
 const h=hostname.toLowerCase().replace(/\.$/,'');
 if(h.startsWith('[')||h.includes(':'))return true;
 const part=/^(0x[0-9a-f]*|0[0-7]*|[1-9][0-9]*)$/;
 const parts=h.split('.');
 return parts.length>=1&&parts.length<=4&&parts.every(p=>part.test(p));
}
/** GitHub receives publications only; a github.com host, or an IP literal that could be one, is never a materialisation source, mirror or store. */
export function isGitHubHost(hostname:string):boolean{
 const h=hostname.toLowerCase().replace(/\.$/,'');
 if(isIPLiteral(h))return true;
 return h==='github.com'||h.endsWith('.github.com')||h==='githubusercontent.com'||h.endsWith('.githubusercontent.com');
}
// A plain local path silently ignores --filter, so only URL transports are accepted.
export function sourceURL(value:unknown):string{
 if(typeof value!=='string'||value.length>2048||/[\x00-\x1f\s]/.test(value))return fail('SLICE_SOURCE_UNAVAILABLE','Invalid source URL');
 let url:URL;try{url=new URL(value);}catch{return fail('SLICE_SOURCE_UNAVAILABLE','Source must be a URL, not a local path');}
 if(!['https:','ssh:','file:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||(url.protocol==='file:'&&(url.hostname||!url.pathname.startsWith('/'))))
  fail('SLICE_SOURCE_UNAVAILABLE','Credential-free https, ssh or absolute file URL required');
 if(isGitHubHost(url.hostname))fail('SLICE_SOURCE_GITHUB_REFUSED',isIPLiteral(url.hostname)?'An IP-literal host cannot be shown not to be GitHub; name the store by host':'GitHub is the publication projection, never a materialisation source');
 return value;
}
function storeSource(value:unknown):StoreSource{
 const v=exact(value,['store','mirrors']);
 if(!object(v.mirrors))fail('SLICE_SOURCE_UNAVAILABLE','Mirrors are keyed by provider, then region');
 const mirrors:Record<string,Record<string,string>>={};
 for(const [provider,regions] of Object.entries(v.mirrors)){
  if(!object(regions))fail('SLICE_SOURCE_UNAVAILABLE','Mirrors are keyed by provider, then region');
  mirrors[name(provider)]=Object.fromEntries(Object.entries(regions).map(([region,url])=>[name(region),sourceURL(url)]));
 }
 return {store:sourceURL(v.store),mirrors};
}
export function parseObjectStore(raw:unknown):ObjectStoreConfig{
 if(!object(raw))return fail('SLICE_SOURCE_UNAVAILABLE','Unsupported source configuration');
 const repositories:ObjectStoreConfig['repositories']={};
 if(raw.schema_version===1){
  const v=exact(raw,['schema_version','repositories']);if(!object(v.repositories))fail('SLICE_SOURCE_UNAVAILABLE','Unsupported source configuration');
  for(const [id,entry] of Object.entries(v.repositories)){
   const e=exact(entry,['url','submodules']);if(!object(e.submodules))fail('SLICE_SOURCE_UNAVAILABLE','Submodule source map required');
   repositories[id]={store:sourceURL(e.url),mirrors:{},submodules:Object.fromEntries(Object.entries(e.submodules).map(([p,u])=>[p,{store:sourceURL(u),mirrors:{}}]))};
  }
  return {schema_version:1,missing_region:'STORE',repositories};
 }
 const v=exact(raw,['schema_version','missing_region','repositories']);
 if(v.schema_version!==2||!object(v.repositories))fail('SLICE_SOURCE_UNAVAILABLE','Unsupported source configuration');
 if(v.missing_region!=='STORE'&&v.missing_region!=='REFUSE')fail('SLICE_SOURCE_UNAVAILABLE','missing_region must be STORE or REFUSE');
 for(const [id,entry] of Object.entries(v.repositories)){
  const e=exact(entry,['store','mirrors','submodules']);if(!object(e.submodules))fail('SLICE_SOURCE_UNAVAILABLE','Submodule source map required');
  repositories[id]={...storeSource({store:e.store,mirrors:e.mirrors}),submodules:Object.fromEntries(Object.entries(e.submodules).map(([p,s])=>[p,storeSource(s)]))};
 }
 return {schema_version:2,missing_region:v.missing_region,repositories};
}
export function readObjectStore(env:Readonly<Record<string,string|undefined>>):ObjectStoreConfig{
 const filename=env.HF_SLICE_SOURCE_CONFIG;
 if(!filename||!path.isAbsolute(filename))return fail('SLICE_SOURCE_UNAVAILABLE','Trusted remote source configuration is required');
 let raw:unknown;
 try{const st=lstatSync(filename);if(!st.isFile()||st.size>262144)throw new Error();raw=JSON.parse(readFileSync(filename,'utf8'));}
 catch{return fail('SLICE_SOURCE_UNAVAILABLE','Trusted remote source configuration is unreadable');}
 return parseObjectStore(raw);
}
function pick(source:StoreSource,missing:ObjectStoreConfig['missing_region'],provider:string,region:string):ResolvedSource{
 const mirror=source.mirrors[name(provider)]?.[name(region)];
 if(mirror)return {url:mirror,store:source.store,provider,region,resolution:'MIRROR'};
 if(missing==='REFUSE')fail('SLICE_SOURCE_NO_REGIONAL_MIRROR','No object store mirror is configured for this provider region');
 return {url:source.store,store:source.store,provider,region,resolution:'STORE'};
}
/** The nearest source for one sandbox placement: its own provider-region mirror, else the store or a refusal as configured. */
export function resolveSource(config:ObjectStoreConfig,repository:string,provider:string,region:string):ResolvedSource&{submodules:Record<string,ResolvedSource>}{
 const entry=config.repositories[repository];
 if(!entry||!Object.hasOwn(config.repositories,repository))return fail('SLICE_SOURCE_UNAVAILABLE','Repository has no trusted remote source');
 const submodules:Record<string,ResolvedSource>={};
 for(const [p,s] of Object.entries(entry.submodules))submodules[p]=pick(s,config.missing_region,provider,region);
 return {...pick(entry,config.missing_region,provider,region),submodules};
}

export interface MirrorFreshness {
 provider:string;region:string;url:string;state:'FRESH'|'STALE'|'UNREACHABLE';
 /** Store refs the mirror lacks or holds at another object. */ behind:string[];
 /** Refs the mirror still holds that the store has deleted. */ extra:string[];
}
function lsRemote(url:string,timeoutMs:number):Promise<Map<string,string>|null>{
 return new Promise(resolve=>{
  execFile('git',['ls-remote','--',url],{timeout:timeoutMs,maxBuffer:64*1024*1024,env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:'/nonexistent',LC_ALL:'C.UTF-8',
   GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'}},(error,stdout)=>{
   if(error)return resolve(null);
   const refs=new Map<string,string>();
   for(const line of stdout.split('\n')){const [oid,ref]=line.split('\t');if(oid&&ref&&ref!=='HEAD')refs.set(ref,oid);}
   resolve(refs);
  });
 });
}
/** Compares every mirror's advertised refs with the store's; an unreachable store is a refusal, not a fresh report. */
export async function mirrorFreshness(config:ObjectStoreConfig,repository:string,timeoutMs=60000):Promise<{repository:string;store:string;mirrors:MirrorFreshness[]}>{
 const entry=config.repositories[repository];
 if(!entry||!Object.hasOwn(config.repositories,repository))return fail('SLICE_SOURCE_UNAVAILABLE','Repository has no trusted remote source');
 const store=await lsRemote(entry.store,timeoutMs);
 if(!store)return fail('SLICE_SOURCE_STORE_UNREACHABLE','The object store did not answer');
 const mirrors:MirrorFreshness[]=[];
 for(const [provider,regions] of Object.entries(entry.mirrors).sort(([a],[b])=>a<b?-1:a>b?1:0))
  for(const [region,url] of Object.entries(regions).sort(([a],[b])=>a<b?-1:a>b?1:0)){
   const refs=await lsRemote(url,timeoutMs);
   if(!refs){mirrors.push({provider,region,url,state:'UNREACHABLE',behind:[],extra:[]});continue;}
   const behind=[...store].filter(([ref,oid])=>refs.get(ref)!==oid).map(([ref])=>ref).sort();
   const extra=[...refs.keys()].filter(ref=>!store.has(ref)).sort();
   mirrors.push({provider,region,url,state:behind.length||extra.length?'STALE':'FRESH',behind,extra});
  }
 return {repository,store:entry.store,mirrors};
}
