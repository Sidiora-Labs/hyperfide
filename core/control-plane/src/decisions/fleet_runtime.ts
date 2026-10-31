import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {hostname} from 'node:os';
import {readTrustedAgentFile} from '../agents/sessions.js';
import {fleetError,localProcessIdentity} from '../agents/fleet_authority.js';
import {strictJson} from './adapters.js';
import {object} from '../policy/programme.js';
export interface FleetRuntimeProfile {host_id:string;binary:string;binary_digest:string;binary_version:string;home:string;spool:string;model:string;timeout_seconds:number;max_output_bytes:number}
const digest=(b:Buffer)=>'sha256:'+createHash('sha256').update(b).digest('hex');
export async function fleetRuntimeProfile(env:Readonly<NodeJS.ProcessEnv>):Promise<FleetRuntimeProfile|null>{
 const raw=env.HYPERFIDE_FLEET_CODEX_CONFIG?strictJson((await readTrustedAgentFile(env.HYPERFIDE_FLEET_CODEX_CONFIG,65536)).toString('utf8')):{schema_version:1,host_id:env.HYPERFIDE_FLEET_HOST_ID??hostname(),binary:env.HYPERFIDE_FLEET_CODEX_BINARY,binary_digest:env.HYPERFIDE_FLEET_CODEX_BINARY_DIGEST,binary_version:env.HYPERFIDE_FLEET_CODEX_BINARY_VERSION,home:env.HYPERFIDE_FLEET_CODEX_HOME,spool:env.HYPERFIDE_FLEET_CODEX_SPOOL,model:env.HYPERFIDE_FLEET_CODEX_MODEL,timeout_seconds:90,max_output_bytes:1048576};
 if(!object(raw)||!raw.binary||!raw.home||!raw.spool||!raw.model||!raw.binary_digest||!raw.binary_version)return null;
 if(Object.keys(raw).sort().join(',')!==['schema_version','host_id','binary','binary_digest','binary_version','home','spool','model','timeout_seconds','max_output_bytes'].sort().join(',')||raw.schema_version!==1)fleetError('FLEET_MODEL_CONFIG_INVALID');
 for(const k of ['binary','home','spool'])if(typeof raw[k]!=='string'||!path.isAbsolute(String(raw[k])))fleetError('FLEET_MODEL_CONFIG_INVALID');
 for(const k of ['host_id','model','binary_version'])if(typeof raw[k]!=='string'||!raw[k]||String(raw[k]).length>256)fleetError('FLEET_MODEL_CONFIG_INVALID');
 if(!/^sha256:[a-f0-9]{64}$/.test(String(raw.binary_digest))||!Number.isSafeInteger(raw.timeout_seconds)||Number(raw.timeout_seconds)<1||Number(raw.timeout_seconds)>120||!Number.isSafeInteger(raw.max_output_bytes)||Number(raw.max_output_bytes)<1024||Number(raw.max_output_bytes)>1048576)fleetError('FLEET_MODEL_CONFIG_INVALID');
 const profile=raw as unknown as FleetRuntimeProfile;
 const actual=await fs.realpath(profile.binary),stat=await fs.stat(actual);
 if(!stat.isFile()||(stat.mode&0o022)!==0||digest(await fs.readFile(actual))!==profile.binary_digest)fleetError('FLEET_MODEL_BINARY_DRIFT');
 for(const directory of [profile.home,profile.spool]){const s=await fs.lstat(directory);if(!s.isDirectory()||s.isSymbolicLink()||(s.mode&0o077)!==0)fleetError('FLEET_MODEL_CONFIG_UNSAFE');}
 return profile;
}
export interface FleetModelResult {backend?:'gateway'|'codex';session_kind?:'LOGICAL_GATEWAY'|'NATIVE_CLI';profile_digest?:string;upstream_response_id?:string;profile_id?:string;endpoint?:string;key_env?:string;action:string;input:Record<string,unknown>;rationale_summary:string;native_session_id:string;process_identity:ReturnType<typeof localProcessIdentity>;model:string;binary_digest?:string}
export async function reasonWithCodex(profile:FleetRuntimeProfile,prompt:string,signal:AbortSignal,onStart:(identity:ReturnType<typeof localProcessIdentity>)=>Promise<void>):Promise<FleetModelResult>{
 const directory=await fs.mkdtemp(path.join(profile.spool,'reason-'));
 const output=path.join(directory,'decision.json');let nativeId:string|null=null,identity:ReturnType<typeof localProcessIdentity>|undefined;
 try{
  const version=await new Promise<string>((resolve,reject)=>{const child=spawn(profile.binary,['--version'],{env:{...process.env,CODEX_HOME:profile.home},stdio:['ignore','pipe','pipe']});let text='',failed=false;const timer=setTimeout(()=>{failed=true;child.kill('SIGKILL');},5000);const capture=(b:Buffer)=>{text+=String(b);if(Buffer.byteLength(text)>4096){failed=true;child.kill('SIGKILL');}};child.stdout.on('data',capture);child.stderr.on('data',capture);child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('exit',code=>{clearTimeout(timer);code===0&&!failed?resolve(text.trim()):reject(new Error('FLEET_MODEL_VERSION_UNAVAILABLE'));});});
  if(version!=='codex-cli '+profile.binary_version)fleetError('FLEET_MODEL_VERSION_DRIFT');
  await new Promise<void>((resolve,reject)=>{
   const child=spawn(profile.binary,['exec','--disable','shell_tool','--disable','unified_exec','--disable','sleep_tool','--disable','tool_suggest','--ignore-user-config','--json','--skip-git-repo-check','--sandbox','read-only','--model',profile.model,'--output-last-message',output,'-'],{cwd:directory,env:{PATH:process.env.PATH,HOME:process.env.HOME,CODEX_HOME:profile.home,LANG:'C.UTF-8'},stdio:['pipe','pipe','pipe'],detached:true});
   let bytes=0,pending='',ended=false,terminated=false;
   const stop=()=>{if(child.pid)try{process.kill(-child.pid,'SIGTERM');}catch{}};
   let killTimer:ReturnType<typeof setTimeout>|undefined;const terminate=()=>{if(terminated)return;terminated=true;stop();killTimer=setTimeout(()=>{if(child.pid)try{process.kill(-child.pid,'SIGKILL');}catch{}},1000);};const timer=setTimeout(terminate,profile.timeout_seconds*1000);signal.addEventListener('abort',terminate,{once:true});
   child.once('spawn',()=>{try{identity=localProcessIdentity(child.pid!);void onStart(identity).then(()=>child.stdin.end(prompt)).catch(error=>{terminate();reject(error);});}catch(error){terminate();reject(error);}});
   const observe=(data:Buffer,stdout:boolean)=>{bytes+=data.length;if(bytes>profile.max_output_bytes){terminate();return;}if(!stdout)return;pending+=data.toString('utf8');let split;while((split=pending.indexOf('\n'))>=0){const line=pending.slice(0,split);pending=pending.slice(split+1);try{const event=JSON.parse(line);if(event.type==='thread.started'&&typeof event.thread_id==='string')nativeId=event.thread_id;}catch{}}};
   child.stdout.on('data',b=>observe(b,true));child.stderr.on('data',b=>observe(b,false));
   const finish=(error?:Error)=>{if(ended)return;ended=true;clearTimeout(timer);if(killTimer)clearTimeout(killTimer);signal.removeEventListener('abort',terminate);if(error)reject(error);else resolve();};
   child.once('error',error=>finish(error));child.once('exit',code=>finish(code===0&&!terminated&&bytes<=profile.max_output_bytes&&!signal.aborted?undefined:new Error('FLEET_MODEL_UNAVAILABLE')));
  });
  const stat=await fs.stat(output);if(stat.size>131072||!identity||!nativeId)fleetError('FLEET_MODEL_OUTPUT_INVALID');
  const result=strictJson(await fs.readFile(output,'utf8'),131072);
  if(!object(result)||Object.keys(result).sort().join(',')!=='action,input,rationale_summary'||typeof result.action!=='string'||!object(result.input)||typeof result.rationale_summary!=='string'||!result.rationale_summary.trim()||Buffer.byteLength(result.rationale_summary)>4096)fleetError('FLEET_MODEL_OUTPUT_INVALID');
  return {action:result.action,input:result.input,rationale_summary:result.rationale_summary,native_session_id:nativeId,process_identity:identity,model:profile.model,binary_digest:profile.binary_digest};
 }finally{await fs.rm(directory,{recursive:true,force:true});}
}
