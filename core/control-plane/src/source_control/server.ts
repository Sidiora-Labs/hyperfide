import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createPublicKey} from 'node:crypto';
import {getPool} from '../storage/schema.js';
import {createResourceContainer} from '../storage/runtime.js';
import {standaloneSourceAuthority} from './standalone-authority.js';
import {createSourceService,sourceCursorKey,sourceWorkspaceBudgets} from './registration.js';
import {sourceTransferOptions,SOURCE_TRANSFER_PATH} from './transfers.js';
import {sourceGraphConfiguration} from './graph-adapter.js';
import {sourceImportSources} from './git/import_transport.js';
import {sourceMigrationControls} from './migration/cutover.js';
import {S3SourceObjectBackend,sourceS3Configuration} from './s3.js';
import {startSourceHttp} from './http.js';
import {parseStrictJSON,SourceControlError} from './contracts.js';
import type {SourceTokenTrust} from './authentication.js';
import {sourcePublicationDestinations} from './publication_config.js';

interface ListenerConfiguration {
 host:string;port:number;trust:SourceTokenTrust;allowLoopbackHTTP:boolean;
 tls?:{cert:Buffer;key:Buffer};
}
function invalid(message:string):never {throw new SourceControlError('CONFIGURATION_INVALID',message);}
function record(value:unknown,label:string):Record<string,unknown> {
 if(!value||typeof value!=='object'||Array.isArray(value))invalid(label+' must be an object');return value as Record<string,unknown>;
}
function fields(value:Record<string,unknown>,allowed:readonly string[],required:readonly string[],label:string):void {
 if(Object.keys(value).some(key=>!allowed.includes(key))||required.some(key=>!Object.hasOwn(value,key)))invalid(label+' contains unknown or missing fields');
}
function text(value:unknown,label:string,maximum=4096):string {
 if(typeof value!=='string'||!value||Buffer.byteLength(value)>maximum||/[\x00-\x1f\x7f]/.test(value))invalid(label+' must be bounded text');return value;
}
async function file(filename:string,privateFile:boolean,maxBytes:number):Promise<Buffer> {
 const handle=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
 try {
  const stat=await handle.stat();
  if(!stat.isFile()||stat.size<1||stat.size>maxBytes||privateFile&&(typeof process.getuid==='function'&&stat.uid!==process.getuid()||process.platform!=='win32'&&(stat.mode&0o077)!==0))invalid('Configuration and private keys require bounded owner-only regular files');
  const bytes=await handle.readFile();if(bytes.length!==stat.size||bytes.length>maxBytes)invalid('Configuration file changed while reading');return bytes;
 } finally {await handle.close();}
}
async function listenerConfiguration(env:Readonly<NodeJS.ProcessEnv>):Promise<ListenerConfiguration> {
 const filename=path.resolve(text(env.HF_SOURCE_CONTROL_CONFIG,'HF_SOURCE_CONTROL_CONFIG'));
 const value=record(parseStrictJSON(await file(filename,true,1048576)),'source listener configuration');
 fields(value,['host','port','trust','tls','allowLoopbackHTTP'],['host','port','trust'],'source listener configuration');
 const host=text(value.host,'host',253),port=value.port;
 if(!Number.isInteger(port)||Number(port)<0||Number(port)>65535)invalid('Listener port must be an integer from 0 through 65535');
 if(value.allowLoopbackHTTP!==undefined&&typeof value.allowLoopbackHTTP!=='boolean')invalid('allowLoopbackHTTP must be explicit boolean');
 const trust=record(value.trust,'token trust');
 fields(trust,['issuer','audience','keys','max_ttl_seconds','clock_skew_seconds'],['issuer','audience','keys'],'token trust');
 const keys=record(trust.keys,'token public keys'),entries=Object.entries(keys);
 if(entries.length<1||entries.length>64)invalid('One through 64 token verification keys are required');
 const publicKeys:Record<string,string>=Object.create(null);
 for(const [id,value]of entries){
  if(!/^[A-Za-z0-9._-]{1,128}$/.test(id)||typeof value!=='string'||Buffer.byteLength(value)>16384||!value.startsWith('-----BEGIN PUBLIC KEY-----')||value.includes('PRIVATE KEY'))invalid('Token trust requires named Ed25519 public verification keys');
  let key;try{key=createPublicKey(value);}catch{invalid('Invalid token public verification key');}
  if(key.asymmetricKeyType!=='ed25519')invalid('Source principal tokens require Ed25519 verification keys');publicKeys[id]=key.export({type:'spki',format:'pem'}).toString();
 }
 const maximum=trust.max_ttl_seconds,skew=trust.clock_skew_seconds;
 if(maximum!==undefined&&(!Number.isInteger(maximum)||Number(maximum)<1||Number(maximum)>900)||skew!==undefined&&(!Number.isInteger(skew)||Number(skew)<0||Number(skew)>30))invalid('Token lifetime or clock-skew policy is invalid');
 const result:ListenerConfiguration={host,port:Number(port),allowLoopbackHTTP:value.allowLoopbackHTTP===true,
  trust:{issuer:text(trust.issuer,'token issuer',2048),audience:text(trust.audience,'token audience',2048),keys:publicKeys,
   ...(maximum!==undefined?{max_ttl_seconds:Number(maximum)}:{}),...(skew!==undefined?{clock_skew_seconds:Number(skew)}:{})}};
 if(value.tls!==undefined){
  const tls=record(value.tls,'TLS');fields(tls,['certificate','private_key'],['certificate','private_key'],'TLS');
  const certificate=path.resolve(path.dirname(filename),text(tls.certificate,'TLS certificate file'));
  const key=path.resolve(path.dirname(filename),text(tls.private_key,'TLS private-key file'));
  result.tls={cert:await file(certificate,false,1048576),key:await file(key,true,65536)};
 }
 if(!result.tls&&!(result.allowLoopbackHTTP&&['127.0.0.1','::1'].includes(host)))invalid('TLS is required outside explicitly enabled loopback HTTP');
 return result;
}
export async function startSourceControl(env:Readonly<NodeJS.ProcessEnv>=process.env,signal:AbortSignal=new AbortController().signal):Promise<{address:string;close():Promise<void>}> {
 const configuration=await listenerConfiguration(env),cursorKey=sourceCursorKey(env),workspaceBudgets=sourceWorkspaceBudgets(env);
 const backend=new S3SourceObjectBackend(sourceS3Configuration(env));
 const resources=createResourceContainer({role:'control',env,signal});let listener:Awaited<ReturnType<typeof startSourceHttp>>|undefined;
 let closing:Promise<void>|undefined;
 const close=():Promise<void>=>closing??=(async()=>{signal.removeEventListener('abort',abort);try{await listener?.close();}finally{await resources.close();}})();
 const abort=()=>{void close().catch(()=>{});};
 try {
  const pool=getPool(env);
  const authority=standaloneSourceAuthority(resources,env,signal);
  await authority.current();
  const tables=['source_native_objects','source_repositories','source_principal_credentials','source_capabilities','source_workspaces','source_transformations','source_native_candidates','source_native_acceptances','source_native_assurance_evidence','source_git_publications','source_fleet_runs','source_fleet_assignments','source_fleet_submissions','source_fleet_qualifications','source_fleet_selections','source_fleet_selection_heads'];
  const readiness=await pool.query<{name:string;present:boolean}>('SELECT name,to_regclass(name) IS NOT NULL AS present FROM unnest($1::text[]) AS name',[tables.map(name=>'hyperfide.'+name)]);
  if(readiness.rows.length!==tables.length||readiness.rows.some(row=>!row.present))throw new SourceControlError('SCHEMA_NOT_READY','Apply the source-control migrations before starting the service');
  if(signal.aborted)throw new SourceControlError('SERVICE_UNAVAILABLE','Source startup was cancelled');
  const transferOrigin=env.HF_SOURCE_TRANSFER_ORIGIN;
  if(transferOrigin!==undefined&&(!/^https:\/\//.test(transferOrigin)||new URL(transferOrigin).origin!==transferOrigin))invalid('HF_SOURCE_TRANSFER_ORIGIN must be a canonical HTTPS origin');
  const service=createSourceService({pool,backend,cursorKey,workspaceBudgets,transaction:authority.transaction,...(transferOrigin?{transfers:sourceTransferOptions(transferOrigin+SOURCE_TRANSFER_PATH,cursorKey)}:{}),publication:{destinations:sourcePublicationDestinations(env)},imports:{sources:sourceImportSources(env)},...(sourceGraphConfiguration(env)?{graph:sourceGraphConfiguration(env)!}:{}),...(sourceMigrationControls(env)?{migration:sourceMigrationControls(env)!}:{}),...(env.HF_SOURCE_ROUTING_OWNER_ID?{routing_owner_id:env.HF_SOURCE_ROUTING_OWNER_ID}:{})});
  listener=await startSourceHttp({api:service.api,transfers:service.transfers,trust:configuration.trust,host:configuration.host,port:configuration.port,signal,...(configuration.tls?{tls:configuration.tls}:{}),allowLoopbackHTTP:configuration.allowLoopbackHTTP});
  signal.addEventListener('abort',abort,{once:true});if(signal.aborted)await close();
  return {address:listener.address,close};
 } catch(error) {await close();throw error;}
}
async function main():Promise<void> {
 const controller=new AbortController(),stop=()=>controller.abort();process.once('SIGTERM',stop);process.once('SIGINT',stop);
 let server:Awaited<ReturnType<typeof startSourceControl>>|undefined;
 try {
  server=await startSourceControl(process.env,controller.signal);
  if(!controller.signal.aborted)process.stdout.write(JSON.stringify({event:'source-control.ready',protocol_version:1,address:server.address})+'\n');
  if(!controller.signal.aborted)await new Promise<void>(resolve=>controller.signal.addEventListener('abort',()=>resolve(),{once:true}));
  await server.close();
 } catch(error) {if(!controller.signal.aborted){process.stderr.write(JSON.stringify({event:'source-control.failed',code:error instanceof SourceControlError?error.code:'SERVICE_START_FAILED'})+'\n');process.exitCode=1;}}
 finally {process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);}
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)await main();
