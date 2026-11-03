import {constants,closeSync,fstatSync,openSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {parseSourceScope,parseStrictJSON,SourceControlError} from './contracts.js';
import {createLocalGitDestination} from './git/transport.js';
import {createGitHubDestination} from './git/github.js';
import {createGitLabDestination} from './git/gitlab.js';
import type {SourceGitCredential,SourceGitDestination} from './git/types.js';
import {parseProjectionPolicy} from './git/provenance.js';

function invalid():never {throw new SourceControlError('CONFIGURATION_INVALID','Publication configuration requires explicit scoped destinations and private credential files');}
function record(value:unknown,required:readonly string[],optional:readonly string[]=[]):Record<string,unknown> {
 if(!value||typeof value!=='object'||Array.isArray(value)||required.some(key=>!Object.hasOwn(value,key))||Object.keys(value).some(key=>!required.includes(key)&&!optional.includes(key)))invalid();
 return value as Record<string,unknown>;
}
function text(value:unknown,maximum=4096):string {
 if(typeof value!=='string'||!value||Buffer.byteLength(value)>maximum||/[\x00-\x1f\x7f]/.test(value))invalid();return value;
}
function privateJSON(filename:string,maximum:number):unknown {
 let descriptor:number;
 try{descriptor=openSync(filename,constants.O_RDONLY|constants.O_NOFOLLOW);}catch{invalid();}
 try{
  const stat=fstatSync(descriptor);
  if(!stat.isFile()||stat.size<1||stat.size>maximum||(stat.mode&0o077)!==0||typeof process.getuid==='function'&&stat.uid!==process.getuid())invalid();
  const bytes=readFileSync(descriptor);if(bytes.length!==stat.size)invalid();return parseStrictJSON(bytes,maximum);
 }finally{closeSync(descriptor);}
}
export function sourcePublicationDestinations(env:Readonly<NodeJS.ProcessEnv>):SourceGitDestination[] {
 if(!env.HF_SOURCE_PUBLICATION_CONFIG)return [];
 const filename=path.resolve(text(env.HF_SOURCE_PUBLICATION_CONFIG)),config=record(privateJSON(filename,262144),['destinations']);
 if(!Array.isArray(config.destinations)||config.destinations.length>64)invalid();
 const seen=new Set<string>();
 return config.destinations.map(raw=>{
  const value=record(raw,['scope','id','provider','repository_identity','allowed_refs'],['path','remote_url','credential_file','projection_policy']);
  const scope=parseSourceScope(value.scope),id=text(value.id,128),repository_identity=text(value.repository_identity,512);
  if(seen.has(id)||!Array.isArray(value.allowed_refs)||!value.allowed_refs.length||value.allowed_refs.length>64)invalid();seen.add(id);
  const allowed_refs=value.allowed_refs.map(ref=>text(ref,1024));
  const policy=value.projection_policy===undefined?undefined:parseProjectionPolicy(value.projection_policy);
  const configured=(destination:SourceGitDestination):SourceGitDestination=>policy?{...destination,projection_policy:policy}:destination;
  if(value.provider==='local'){
   if(value.remote_url!==undefined||value.credential_file!==undefined)invalid();
   return configured(createLocalGitDestination({scope,id,repository_identity,path:path.resolve(path.dirname(filename),text(value.path)),allowed_refs}));
  }
  if(value.provider!=='github'&&value.provider!=='gitlab'||value.path!==undefined)invalid();
  const remote_url=text(value.remote_url),credentialFile=path.resolve(path.dirname(filename),text(value.credential_file));
  const credentials=async():Promise<SourceGitCredential>=>{
   const secret=record(privateJSON(credentialFile,16384),['authorization_header','expires_at']);
   const authorization_header=text(secret.authorization_header,8192),expires_at=text(secret.expires_at,64);
   if(!Number.isFinite(Date.parse(expires_at))||Date.parse(expires_at)<=Date.now())throw new SourceControlError('EXPIRED_CREDENTIAL','Publication credential is unavailable or expired');
   return {authorization_header,expires_at};
  };
  const input={scope,id,repository_identity,remote_url,allowed_refs,credentials};
  return configured(value.provider==='github'?createGitHubDestination(input):createGitLabDestination(input));
 });
}
