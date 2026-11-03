import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {parseSourceScope,SourceControlError,type SourceScope} from '../contracts.js';

export interface ImportedGitObject {oid:string;kind:'commit'|'tree'|'blob'|'tag';payload:Buffer}
export interface GitImportSource {
 id:string;scope:SourceScope;repository_identity:string;object_format:'sha1';readable_path?:string;
 read(oid:string,maximum:number,signal?:AbortSignal):Promise<ImportedGitObject>;
 resolve?(ref:string,signal?:AbortSignal):Promise<string>;
}
export function gitImportOID(value:unknown):string {
 if(typeof value!=='string'||!/^git:sha1:[0-9a-f]{40}$/.test(value))throw new SourceControlError('INVALID_GIT_OBJECT','Explicit namespaced SHA-1 identity required');return value;
}
export function createLocalGitImportSource(input:{id:string;scope:SourceScope;repository_identity:string;path:string}):GitImportSource {
 const scope=parseSourceScope(input.scope);
 if(!/^[a-zA-Z0-9_.-]{1,128}$/.test(input.id)||!input.repository_identity||input.repository_identity.length>256||!path.isAbsolute(input.path)||fs.realpathSync(input.path)!==input.path||!fs.statSync(input.path).isDirectory())throw new SourceControlError('CONFIGURATION_INVALID','Git import source requires an explicit canonical administrative repository');
 const repository=input.path;
 const localStorage=()=>{const alternates=path.join(repository,'objects/info/alternates');if(fs.existsSync(path.join(repository,'commondir'))||fs.existsSync(alternates)&&fs.readFileSync(alternates,'utf8').trim())throw new SourceControlError('CONFIGURATION_INVALID','Linked worktrees and alternate object databases require an explicitly isolated source profile');};localStorage();
 return {id:input.id,scope,repository_identity:input.repository_identity,object_format:'sha1',readable_path:repository,async resolve(ref,signal){
  localStorage();if(!/^refs\/(heads|tags)\/[A-Za-z0-9._/-]+$/.test(ref)||ref.includes('..')||ref.endsWith('/')||ref.includes('//'))throw new SourceControlError('INVALID_GIT_REF','Exact branch or tag ref required');
  return new Promise<string>((resolve,reject)=>{const child=spawn('git',['--no-replace-objects','-c','core.hooksPath=/dev/null','-c','protocol.allow=never','--git-dir='+repository,'show-ref','--verify','--hash',ref],{env:{PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',LANG:'C'},stdio:['ignore','pipe','ignore'],...(signal?{signal}:{})});let output='';const timer=setTimeout(()=>child.kill('SIGKILL'),15000);child.stdout.on('data',(part:Buffer)=>{output+=part.toString('ascii');if(output.length>128)child.kill('SIGKILL');});child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('close',code=>{clearTimeout(timer);if(code!==0||!/^([a-f0-9]{40})\n$/.test(output))reject(new SourceControlError('GIT_SOURCE_UNAVAILABLE','Configured ref is missing or unsupported'));else resolve('git:sha1:'+output.trim());});});
 },async read(oid,maximum,signal){
  localStorage();gitImportOID(oid);if(!Number.isSafeInteger(maximum)||maximum<1||maximum>536870912)throw new SourceControlError('INVALID_REQUEST','Bounded Git object read required');
  const raw=oid.slice(9);
  const bytes=await new Promise<Buffer>((resolve,reject)=>{
   const child=spawn('git',['--no-replace-objects','-c','core.hooksPath=/dev/null','-c','core.attributesFile=/dev/null','-c','protocol.allow=never','--git-dir='+repository,'cat-file','--batch'],{env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1',LANG:'C'},stdio:['pipe','pipe','pipe'],...(signal?{signal}:{})});
   const chunks:Buffer[]=[];let size=0,failed=false;const timer=setTimeout(()=>{failed=true;child.kill('SIGKILL');},30000);
   child.stdout.on('data',(part:Buffer)=>{size+=part.length;if(size>maximum+128){failed=true;child.kill('SIGKILL');}else chunks.push(part);});
   child.stderr.on('data',()=>{});child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('close',code=>{clearTimeout(timer);if(failed)reject(new SourceControlError('IMPORT_BUDGET_EXCEEDED','Git read exceeds its byte or time budget'));else if(code!==0)reject(new SourceControlError('GIT_SOURCE_UNAVAILABLE','Configured Git object cannot be read'));else resolve(Buffer.concat(chunks));});child.stdin.end(raw+'\n');
  });
  const end=bytes.indexOf(10),header=bytes.subarray(0,end).toString('ascii').split(' '),kind=header[1];
  if(end<0||header[0]!==raw||!['commit','tree','blob','tag'].includes(kind??'')||!/^\d+$/.test(header[2]??''))throw new SourceControlError('GIT_SOURCE_UNAVAILABLE','Pinned Git object is missing or unsupported');
  const length=Number(header[2]),payload=bytes.subarray(end+1,bytes.length-1);
  if(length>maximum||payload.length!==length||bytes.at(-1)!==10||'git:sha1:'+createHash('sha1').update(kind+' '+length+'\0').update(payload).digest('hex')!==oid)throw new SourceControlError('GIT_OBJECT_INTEGRITY','Git object length or digest differs from its pinned identity');
  return {oid,kind:kind as ImportedGitObject['kind'],payload};
 }};
}
export function sourceImportSources(env:Readonly<NodeJS.ProcessEnv>):GitImportSource[]{
 const file=env.HF_SOURCE_IMPORT_CONFIG;if(!file)return [];
 if(!path.isAbsolute(file))throw new SourceControlError('CONFIGURATION_INVALID','Absolute import configuration required');
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let decoded:any;
 try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>1048576||(stat.mode&0o077)!==0||stat.nlink!==1||stat.uid!==process.getuid?.())throw new SourceControlError('CONFIGURATION_INVALID','Private bounded import configuration required');decoded=JSON.parse(fs.readFileSync(fd,'utf8'));}finally{fs.closeSync(fd);}
 if(!decoded||Object.keys(decoded).join()!=='sources'||!Array.isArray(decoded.sources)||decoded.sources.length>64)throw new SourceControlError('CONFIGURATION_INVALID','Bounded administrative import sources required');
 const sources=decoded.sources.map((v:any)=>{if(!v||Object.keys(v).sort().join(',')!=='id,path,repository_identity,scope')throw new SourceControlError('CONFIGURATION_INVALID','Exact import source fields required');return createLocalGitImportSource(v);});
 if(new Set(sources.map((s:GitImportSource)=>JSON.stringify([s.scope,s.id]))).size!==sources.length)throw new SourceControlError('CONFIGURATION_INVALID','Duplicate source identity');return sources;
}
