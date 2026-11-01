import fs from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import net from 'node:net';
import {createPrivateKey,createPublicKey,generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import type {KeyObject} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {canonicalOrigin,decimal,exact,fail,hash,signingBytes,strictJSON,uuid} from './transport/protocol.js';
import {object} from './policy/programme.js';
import {readProtectedFile} from './preparation/fleet_client.js';
import {localProcessIdentity} from './agents/fleet_authority.js';
import {canonical} from './hierarchy/packages.js';
import {readTrustedAgentFile} from './agents/sessions.js';

type RecordValue=Record<string,any>;
type ActorReference={session_id:string;credential_file:string;key_file?:string};
interface Configuration {bootstrap?:{operator_credential_file:string;ttl_seconds:number};schema_version:1;origin:string;ca_file:string;organisation_id:string;run_id:string;cohort_id:string;host_id:string;leader_generation:string;expected_cohort_generation:string;primary:ActorReference;managers:ActorReference[];state_directory:string;poll_interval_ms:number;request_timeout_ms:number}
interface Actor {session_id:string;role:'PRIMARY'|'WAVE_MANAGER'|'OPERATOR';credential_id:string;authority_epoch:string;key:KeyObject;key_file:string;cohort_generation?:string;expires_at?:string;enrollment_scope?:RecordValue}
interface Command {actor_id:string;operation_id:string;component?:string;action:string;input:RecordValue}
interface ActorState {binding:RecordValue;reasoning:RecordValue|null;observed_state:string|null}
interface SupervisorState {schema_version:1;config_digest:string;cohort_generation:string;leader_generation:string;pending:Command|null;grants:Record<string,{input:RecordValue;grant:RecordValue}>;actors:Record<string,ActorState>}
const CONFIG_KEYS=['schema_version','origin','ca_file','organisation_id','run_id','cohort_id','host_id','leader_generation','expected_cohort_generation','primary','managers','state_directory','poll_interval_ms','request_timeout_ms'];
function absolute(value:unknown):value is string{return typeof value==='string'&&path.isAbsolute(value)&&value!=='/'&&path.resolve(value)===value&&!value.includes('\0');}
function actorReference(value:unknown):ActorReference{if(!object(value))fail('FLEET_SUPERVISOR_CONFIG','Actor reference required');exact(value,value.key_file===undefined?['session_id','credential_file']:['session_id','credential_file','key_file']);if(!uuid(value.session_id)||!absolute(value.credential_file)||value.key_file!==undefined&&!absolute(value.key_file))fail('FLEET_SUPERVISOR_CONFIG','Current actor identity and private credential reference required');return value as unknown as ActorReference;}
export async function readFleetSupervisorConfig(filename:string):Promise<Configuration>{
 const value=strictJSON(await readProtectedFile(filename,65536,true));if(!object(value))fail('FLEET_SUPERVISOR_CONFIG','Versioned supervisor configuration required');exact(value,value.bootstrap===undefined?CONFIG_KEYS:[...CONFIG_KEYS,'bootstrap']);
 if(value.schema_version!==1||!uuid(value.organisation_id)||!uuid(value.run_id)||!uuid(value.cohort_id)||!decimal(value.leader_generation)||!decimal(value.expected_cohort_generation)||typeof value.host_id!=='string'||!value.host_id||value.host_id.length>256||!absolute(value.ca_file)||!absolute(value.state_directory))fail('FLEET_SUPERVISOR_CONFIG','Versioned run/cohort identity and absolute private paths required');
 if(typeof value.origin!=='string')fail('FLEET_SUPERVISOR_CONFIG','Fixed HTTPS coordinator origin required');canonicalOrigin(value.origin);
 if(!Number.isSafeInteger(value.poll_interval_ms)||Number(value.poll_interval_ms)<1000||Number(value.poll_interval_ms)>60000||!Number.isSafeInteger(value.request_timeout_ms)||Number(value.request_timeout_ms)<1000||Number(value.request_timeout_ms)>120000)fail('FLEET_SUPERVISOR_CONFIG','Bounded observation and request deadlines required');
 if(value.bootstrap!==undefined){exact(value.bootstrap,['operator_credential_file','ttl_seconds']);if(!absolute(value.bootstrap.operator_credential_file)||!Number.isSafeInteger(value.bootstrap.ttl_seconds)||Number(value.bootstrap.ttl_seconds)<60||Number(value.bootstrap.ttl_seconds)>900)fail('FLEET_SUPERVISOR_CONFIG','Explicit operator credential reference and bounded bootstrap lifetime required');}
 if(object(value.bootstrap)&&Number(value.bootstrap.ttl_seconds)*1000<=Number(value.request_timeout_ms)+30000)fail('FLEET_SUPERVISOR_CONFIG','Bootstrap credential lifetime must cover a full request and renewal margin');
 const primary=actorReference(value.primary);
 if(!Array.isArray(value.managers)||value.managers.length<1||value.managers.length>128)fail('FLEET_SUPERVISOR_CONFIG','Bounded manager credential references required');
 const managers=value.managers.map(actorReference),ids=[primary,...managers].map(a=>a.session_id);
 if(new Set(ids).size!==ids.length)fail('FLEET_SUPERVISOR_CONFIG','Each supervisory actor requires a distinct identity');
 return {...value,primary,managers} as unknown as Configuration;
}
async function loadActor(reference:ActorReference,role:Actor['role'],config:Configuration):Promise<Actor>{
 const value=strictJSON(await readProtectedFile(reference.credential_file,65536,true));if(!object(value))fail('FLEET_SUPERVISOR_IDENTITY','Versioned actor credential reference required');
 const fields=['schema_version','credential_id','actor_id','organisation_id','run_id','role','authority_epoch','key_file'];exact(value,[...fields,...['cohort_generation','expires_at','enrollment_scope'].filter(field=>value[field]!==undefined)]);if(value.expires_at!==undefined&&(typeof value.expires_at!=='string'||!Number.isFinite(Date.parse(value.expires_at))))fail('FLEET_SUPERVISOR_IDENTITY','Credential expiry metadata must be an exact timestamp');if(value.cohort_generation!==undefined&&!decimal(value.cohort_generation))fail('FLEET_SUPERVISOR_IDENTITY','Versioned credential cohort metadata required');
 if(value.enrollment_scope!==undefined){if(!object(value.enrollment_scope))fail('FLEET_SUPERVISOR_IDENTITY','Exact enrollment scope required');exact(value.enrollment_scope,['delegation_id','manager_generation','handoff_id']);if(value.enrollment_scope.delegation_id!==null&&!uuid(value.enrollment_scope.delegation_id)||value.enrollment_scope.manager_generation!==null&&!decimal(value.enrollment_scope.manager_generation)||value.enrollment_scope.handoff_id!==null&&!uuid(value.enrollment_scope.handoff_id))fail('FLEET_SUPERVISOR_IDENTITY','Invalid enrollment scope');}
 if(value.schema_version!==1||!uuid(value.credential_id)||value.actor_id!==reference.session_id||value.organisation_id!==config.organisation_id||value.run_id!==config.run_id||value.role!==(role==='PRIMARY'?'LEADER':role==='OPERATOR'?'OPERATOR':'FEATURE_MANAGER')||!uuid(value.authority_epoch)||!absolute(value.key_file))fail('FLEET_SUPERVISOR_IDENTITY','Pre-enrolled actor credential must match the configured role and run');
 const bytes=await readProtectedFile(value.key_file,16384,true);let key:KeyObject;try{key=createPrivateKey(bytes);}finally{bytes.fill(0);}
 if(key.asymmetricKeyType!=='ed25519')fail('FLEET_SUPERVISOR_IDENTITY','Actor signing key must be Ed25519');
 return {session_id:reference.session_id,role,credential_id:value.credential_id,authority_epoch:value.authority_epoch,key,key_file:value.key_file,...(typeof value.cohort_generation==='string'?{cohort_generation:value.cohort_generation}:{}),...(typeof value.expires_at==='string'?{expires_at:value.expires_at}:{}),...(object(value.enrollment_scope)?{enrollment_scope:value.enrollment_scope}:{})};
}
function assertActorKeys(actors:Iterable<Actor>):void{
 const credentials=new Set<string>(),keys=new Set<string>(),epochs=new Set<string>();
 for(const actor of actors){const fingerprint=hash(createPublicKey(actor.key).export({format:'der',type:'spki'}));if(credentials.has(actor.credential_id)||keys.has(fingerprint))fail('FLEET_SUPERVISOR_IDENTITY','Each actor requires a distinct enrolled credential and signing key');credentials.add(actor.credential_id);keys.add(fingerprint);epochs.add(actor.authority_epoch);}
 if(epochs.size>1)fail('FLEET_SUPERVISOR_IDENTITY','Supervisory actors must share the current authority epoch');
}
async function loadActors(config:Configuration):Promise<Map<string,Actor>>{
 const actors=new Map<string,Actor>(),fingerprints:string[]=[];
 if(config.bootstrap){const input=strictJSON(await readProtectedFile(config.bootstrap.operator_credential_file,65536,true));if(!object(input)||!uuid(input.actor_id))fail('FLEET_SUPERVISOR_IDENTITY','Explicit enrolled operator identity required');const operator=await loadActor({session_id:input.actor_id,credential_file:config.bootstrap.operator_credential_file},'OPERATOR',config);actors.set(operator.session_id,operator);}
 for(const reference of [config.primary,...config.managers]){
  if(actors.has(reference.session_id))fail('FLEET_SUPERVISOR_IDENTITY','Supervisory actor cannot reuse the operator identity');
  try{const actor=await loadActor(reference,reference===config.primary?'PRIMARY':'WAVE_MANAGER',config);actors.set(actor.session_id,actor);}
  catch(error){if(!config.bootstrap||!reference.key_file||(error as NodeJS.ErrnoException).code!=='ENOENT')throw error;let targetMissing=false;try{await fs.lstat(reference.credential_file);}catch(missing){if((missing as NodeJS.ErrnoException).code!=='ENOENT')throw missing;targetMissing=true;}if(!targetMissing)throw error;const bytes=await readProtectedFile(reference.key_file,16384,true);try{const key=createPrivateKey(bytes);if(key.asymmetricKeyType!=='ed25519')fail('FLEET_SUPERVISOR_IDENTITY','Bootstrap signing key must be Ed25519');fingerprints.push(hash(createPublicKey(key).export({format:'der',type:'spki'})));}finally{bytes.fill(0);}}
 }
 assertActorKeys(actors.values());for(const actor of actors.values())fingerprints.push(hash(createPublicKey(actor.key).export({format:'der',type:'spki'})));
 if(new Set(fingerprints).size!==fingerprints.length)fail('FLEET_SUPERVISOR_IDENTITY','Each configured actor requires a distinct signing key');
 return actors;
}
async function writeState(filename:string,value:unknown):Promise<void>{
 const parent=path.dirname(filename),stat=await fs.lstat(parent);if(!absolute(filename)||await fs.realpath(parent)!==parent||!stat.isDirectory()||(stat.mode&0o022)!==0)fail('FLEET_SUPERVISOR_STATE','Persistent state and credential destinations require protected canonical parent directories');
 const temporary=filename+'.'+randomUUID(),fd=await fs.open(temporary,'wx',0o600);
 try{await fd.writeFile(JSON.stringify(value));await fd.sync();}finally{await fd.close();}
 await fs.rename(temporary,filename);const directory=await fs.open(path.dirname(filename),'r');try{await directory.sync();}finally{await directory.close();}
}
async function prepareActorKey(filename:string):Promise<void>{
 const temporary=filename+'.'+randomUUID(),file=await fs.open(temporary,'wx',0o600);
 try{const pair=generateKeyPairSync('ed25519');await file.writeFile(pair.privateKey.export({type:'pkcs8',format:'pem'}));await file.sync();}finally{await file.close();}
 try{await fs.link(temporary,filename);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}finally{await fs.unlink(temporary);}
 const directory=await fs.open(path.dirname(filename),'r');try{await directory.sync();}finally{await directory.close();}
}
class SupervisorRpcError extends Error {constructor(readonly code:string,readonly uncertain:boolean){super(code);}}
async function invoke(config:Configuration,ca:Buffer,actor:Actor,command:Command,signal:AbortSignal):Promise<RecordValue>{
 const payload=Buffer.from(JSON.stringify({run_id:config.run_id,component:command.component??'fleet-orchestration',action:command.action,input:command.input,expected_version:null,authority:null}));
 const body=Buffer.from(JSON.stringify({protocol_version:1,operation_id:command.operation_id,idempotency_key:command.operation_id,payload_digest:hash(payload),correlation_id:command.operation_id,causation_id:null,payload_b64:payload.toString('base64url')}));
 const proof={id:actor.credential_id,time:String(Math.floor(Date.now()/1000)),nonce:randomUUID()},signature=sign(null,signingBytes(config.origin,'/v1/invoke',proof,body),actor.key).toString('base64url');
 return await new Promise<RecordValue>((resolve,reject)=>{
  const request=https.request(new URL('/v1/invoke',config.origin),{method:'POST',ca,rejectUnauthorized:true,minVersion:'TLSv1.3',agent:false,signal:AbortSignal.any([signal,AbortSignal.timeout(config.request_timeout_ms)]),headers:{'Content-Type':'application/json','Content-Length':body.length,'HF-Credential-Id':proof.id,'HF-Request-Time':proof.time,'HF-Request-Nonce':proof.nonce,'HF-Request-Signature':signature}},response=>{
   const parts:Buffer[]=[];let length=0;
   response.on('data',(part:Buffer)=>{length+=part.length;if(length>1048576)response.destroy();else parts.push(part);});
   response.once('aborted',()=>reject(new SupervisorRpcError('FLEET_RPC_UNKNOWN',true)));
   response.once('error',()=>reject(new SupervisorRpcError('FLEET_RPC_UNKNOWN',true)));
   response.once('end',()=>{try{
    const result=strictJSON(Buffer.concat(parts));
    if(!object(result)||result.protocol_version!==1||result.operation_id!==undefined&&result.operation_id!==command.operation_id)throw new SupervisorRpcError('FLEET_RPC_UNKNOWN',true);
    if(result.ok===false&&object(result.error)&&typeof result.error.code==='string')throw new SupervisorRpcError(result.error.code,['OUTCOME_UNKNOWN','RESPONSE_TOO_LARGE','HANDLER_FAILED'].includes(result.error.code));
    if(result.ok!==true||result.operation_id!==command.operation_id||!object(result.result))throw new SupervisorRpcError('FLEET_RPC_UNKNOWN',true);
    resolve(result.result);
   }catch(error){reject(error instanceof SupervisorRpcError?error:new SupervisorRpcError('FLEET_RPC_UNKNOWN',true));}});
  });
  request.once('error',()=>reject(new SupervisorRpcError('FLEET_RPC_UNKNOWN',true)));request.end(body);
 });
}
function binding(actor:Actor,config:Configuration,delegation:RecordValue|null):RecordValue{return {actor_id:actor.session_id,actor_role:actor.role,authority_epoch:actor.authority_epoch,leader_generation:config.leader_generation,delegation_id:delegation?.package_id??null,manager_generation:delegation?.manager_generation??null};}
function event(event:string,actor_id:string|null,details:RecordValue={}):void{process.stdout.write(JSON.stringify({event,actor_id,...details})+'\n');}
function observationState(value:RecordValue):string{
 const content={...value};for(const key of ['observation_id','context_digest','observed_at'])delete content[key];
 return hash(canonical(content));
}
async function acquireLock(directory:string):Promise<()=>Promise<void>>{
 await fs.mkdir(directory,{mode:0o700,recursive:true});const stat=await fs.lstat(directory);
 if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0||await fs.realpath(directory)!==directory)fail('FLEET_SUPERVISOR_STATE','Private owned state directory required');
 const lock=net.createServer(socket=>socket.destroy()),address='\0hf-fleet:'+process.getuid?.()+':'+hash(directory).slice(7);
 await new Promise<void>((resolve,reject)=>{lock.once('error',error=>reject(Object.assign(new Error('Current supervisor lock is unavailable'),{code:(error as NodeJS.ErrnoException).code==='EADDRINUSE'?'FLEET_SUPERVISOR_RUNNING':'FLEET_SUPERVISOR_LOCK'})));lock.listen(address,resolve);});
 const filename=path.join(directory,'supervisor.lock');
 try{await writeState(filename,localProcessIdentity());}catch(error){lock.close();throw error;}
 return async()=>{try{await fs.unlink(filename);}finally{await new Promise<void>(resolve=>lock.close(()=>resolve()));}};
}

export async function runFleetSupervisor(filename:string,signal:AbortSignal,once=false):Promise<void>{
 const config=await readFleetSupervisorConfig(filename),actors=await loadActors(config),operator=[...actors.values()].find(a=>a.role==='OPERATOR');
 const ca=await readTrustedAgentFile(config.ca_file,65536),release=await acquireLock(config.state_directory),stateFile=path.join(config.state_directory,'state.json'),configDigest=hash(canonical(config));
 try{
  let state:SupervisorState;
  try{state=strictJSON(await readProtectedFile(stateFile,1048576,true)) as SupervisorState;if(!object(state)||state.schema_version!==1||state.config_digest!==configDigest||!decimal(state.cohort_generation)||!object(state.actors))fail('FLEET_SUPERVISOR_STATE','Retained state belongs to a different configured cohort');}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;state={schema_version:1,config_digest:configDigest,cohort_generation:config.expected_cohort_generation,leader_generation:config.leader_generation,pending:null,grants:{},actors:{}};}
  state.grants??={};state.leader_generation??=config.leader_generation;config.leader_generation=state.leader_generation;
  const persist=()=>writeState(stateFile,state);
  const call=async(actor:Actor,action:string,input:RecordValue,component='fleet-orchestration',operation_id?:string):Promise<RecordValue>=>{
   if(state.pending&&(state.pending.actor_id!==actor.session_id||state.pending.action!==action||(state.pending.component??'fleet-orchestration')!==component||JSON.stringify(state.pending.input)!==JSON.stringify(input)))throw new SupervisorRpcError('FLEET_RECONCILIATION_REQUIRED',true);
   if(operation_id!==undefined&&!uuid(operation_id))fail('FLEET_DELIVERY_RESPONSE','Stable bootstrap command identity required');if(operation_id&&state.pending&&state.pending.operation_id!==operation_id)throw new SupervisorRpcError('FLEET_RECONCILIATION_REQUIRED',true);state.pending??={actor_id:actor.session_id,operation_id:operation_id??randomUUID(),component,action,input};await persist();
   try{const result=await invoke(config,ca,actor,state.pending,signal);if(action==='fleet.cohort.bind'){if(!decimal(result.cohort_generation,true))fail('FLEET_SUPERVISOR_IDENTITY','Cohort binding did not return current authority');state.cohort_generation=result.cohort_generation;}if(action==='hierarchy.leader.acquire'){if(!decimal(result.leader_generation,true))fail('FLEET_SUPERVISOR_IDENTITY','Leader acquisition did not return current authority');state.leader_generation=result.leader_generation;config.leader_generation=result.leader_generation;}if(action==='fleet.identity.bootstrap')state.grants[String(input.session_id)]={input,grant:result};state.pending=null;await persist();return result;}
   catch(error){if(error instanceof SupervisorRpcError&&!error.uncertain){state.pending=null;await persist();}throw error;}
  };
  const enrolled=async(reference:ActorReference,role:'PRIMARY'|'WAVE_MANAGER',delegation:RecordValue|null,replaceCohort=false):Promise<Actor>=>{
   const scope={delegation_id:delegation?.package_id??null,manager_generation:delegation?.manager_generation??null,handoff_id:delegation?.handoff_id??null};
   const old=actors.get(reference.session_id),scopeChanged=role==='WAVE_MANAGER'&&Boolean(operator)&&canonical(old?.enrollment_scope??null)!==canonical(scope),renew=Boolean(old?.expires_at&&operator&&Date.parse(old.expires_at)-Date.now()<=config.request_timeout_ms+30000);
   if(old&&!replaceCohort&&!renew&&!scopeChanged&&!(role==='WAVE_MANAGER'&&operator&&old.cohort_generation!==undefined&&old.cohort_generation!==state.cohort_generation))return old;
   const baseKey=old?.key_file??reference.key_file;if(!operator||!config.bootstrap||!baseKey)fail('FLEET_SUPERVISOR_IDENTITY','Missing actor credential requires explicit operator and actor signing-key references');
   const rotate=role==='WAVE_MANAGER'&&(scopeChanged||old?.cohort_generation!==undefined&&old.cohort_generation!==state.cohort_generation);
   const keyFile=rotate?path.join(config.state_directory,'actor-'+reference.session_id+'.scope-'+hash(canonical({cohort_generation:state.cohort_generation,scope})).slice(7)+'.key.pem'):baseKey;
   if(rotate)await prepareActorKey(keyFile);
   const bytes=await readProtectedFile(keyFile,16384,true);let key:KeyObject;try{key=createPrivateKey(bytes);}finally{bytes.fill(0);}
   if(key.asymmetricKeyType!=='ed25519')fail('FLEET_SUPERVISOR_IDENTITY','Actor signing key must be Ed25519');
   const fingerprint=hash(createPublicKey(key).export({format:'der',type:'spki'}));if([...actors.values()].some(a=>a.session_id!==reference.session_id&&hash(createPublicKey(a.key).export({format:'der',type:'spki'}))===fingerprint))fail('FLEET_SUPERVISOR_IDENTITY','Bootstrap actor key must be distinct from existing actors');
   const publicKey=createPublicKey(key).export({format:'jwk'}).x;if(typeof publicKey!=='string')fail('FLEET_SUPERVISOR_IDENTITY','Raw Ed25519 public key required');
   const allowed=scope.handoff_id?['hierarchy.package.handoff.acknowledge']:role==='PRIMARY'?['hierarchy.leader.acquire','fleet.cohort.bind','fleet.session.bind','fleet.observe','fleet.session.reason','fleet.decision.inspect','fleet.decision.apply','spec.amendment.admit','hierarchy.package.configure']:['fleet.session.bind','fleet.observe','fleet.session.reason','fleet.decision.inspect','fleet.decision.apply'];
   const input={session_id:reference.session_id,public_key_b64:publicKey,allowed_actions:allowed,ttl_seconds:config.bootstrap.ttl_seconds,authority_epoch:operator.authority_epoch,leader_generation:config.leader_generation,delegation_id:delegation?.package_id??null,manager_generation:delegation?.manager_generation??null,host_id:config.host_id,cohort_id:config.cohort_id,cohort_generation:state.cohort_generation,...(replaceCohort?{replace_cohort:true}:{}),...(scope.handoff_id?{handoff_id:scope.handoff_id}:{})};
   const retained=state.grants[reference.session_id];if(retained&&canonical(retained.input)!==canonical(input))fail('FLEET_SUPERVISOR_IDENTITY','Retained enrollment belongs to different authority or key inputs');
   const grant=retained?.grant??await call(operator,'fleet.identity.bootstrap',input);
   if(!uuid(grant.credential_id)||typeof grant.expires_at!=='string'||!Number.isFinite(Date.parse(grant.expires_at))||grant.actor_id!==reference.session_id||grant.run_id!==config.run_id||grant.role!==(role==='PRIMARY'?'LEADER':'FEATURE_MANAGER')||grant.deployment_epoch!==operator.authority_epoch)fail('FLEET_SUPERVISOR_IDENTITY','Authenticated bootstrap returned a mismatched identity');
   await writeState(reference.credential_file,{schema_version:1,credential_id:grant.credential_id,actor_id:grant.actor_id,organisation_id:config.organisation_id,run_id:config.run_id,role:grant.role,authority_epoch:grant.deployment_epoch,key_file:keyFile,cohort_generation:grant.cohort_generation,expires_at:grant.expires_at,enrollment_scope:scope});
   const actor=await loadActor(reference,role,config);actors.set(actor.session_id,actor);delete state.grants[reference.session_id];await persist();return actor;
  };
  if(state.pending){const pending=state.pending,owner=actors.get(pending.actor_id);if(!owner)fail('FLEET_SUPERVISOR_IDENTITY','Pending actor credentials are unavailable');const recovered=await call(owner,pending.action,pending.input,pending.component??'fleet-orchestration');if(pending.action==='fleet.cohort.bind')state.cohort_generation=String(recovered.cohort_generation);await persist();event('reconciled',owner.session_id,{operation_id:pending.operation_id});}
  const staleSupervisor=(error:unknown):error is SupervisorRpcError=>error instanceof SupervisorRpcError&&!error.uncertain&&['FLEET_COHORT_STALE','FLEET_SUPERVISOR_STALE','FLEET_SUPERVISOR_UNAVAILABLE','FLEET_BOOTSTRAP_CONTROLLER_STALE','FLEET_BOOTSTRAP_HOST_STALE','FLEET_BOOTSTRAP_COHORT_STALE'].includes(error.code);
  let primary=actors.get(config.primary.session_id),restore=Boolean(primary&&state.actors[config.primary.session_id]);
  // Retained authority is observed before renewal: a new control host requires
  // the operator's explicit replacement phase before ordinary cohort issuance.
  if(primary&&restore)try{await call(primary,'fleet.observe',{binding:state.actors[primary.session_id]!.binding,after:null,limit:100});}
  catch(error){if(staleSupervisor(error)){primary=await enrolled(config.primary,'PRIMARY',null,true);restore=false;}else if(!(error instanceof SupervisorRpcError&&!error.uncertain&&error.code==='AUTH_EXPIRED'))throw error;}
  try{primary=await enrolled(config.primary,'PRIMARY',null);}
  catch(error){if(staleSupervisor(error)&&operator){primary=await enrolled(config.primary,'PRIMARY',null,true);restore=false;}else throw error;}
  if(!primary)fail('FLEET_SUPERVISOR_IDENTITY','Current Primary credential is required after startup reconciliation');
  if(state.leader_generation==='0')await call(primary,'hierarchy.leader.acquire',{idempotency_key:randomUUID(),expected_generation:'0',reason:'Acquire the explicitly configured Primary supervisory identity'},'3.1');
  if(!restore){const cohort=await call(primary,'fleet.cohort.bind',{cohort_id:config.cohort_id,host_id:config.host_id,leader_generation:config.leader_generation,expected_generation:state.cohort_generation});state.cohort_generation=String(cohort.cohort_generation);state.actors={};await persist();}
  const observe=async(actor:Actor,session:ActorState):Promise<{view:RecordValue;ids:string[]}>=>{
   const ids:string[]=[],pages:RecordValue[]=[];let after:string|null=null;
   do{
    if(ids.length>=64)fail('FLEET_OBSERVATION_TOO_LARGE','Observation pagination exceeds the admitted context bound');
    const page=await call(actor,'fleet.observe',{binding:session.binding,after,limit:100});
    if(typeof page.observation_id!=='string'||!object(page.page)||typeof page.page.has_more!=='boolean')fail('FLEET_OBSERVATION_INVALID','Versioned observation page required');
    ids.push(page.observation_id);pages.push(page);
    if(!page.page.has_more)break;
    if(typeof page.page.next!=='string'||page.page.next===after)fail('FLEET_OBSERVATION_INVALID','Observation pagination did not advance');
    after=page.page.next;
   }while(true);
   const view={...pages[0],tasks:pages.flatMap(page=>Array.isArray(page.tasks)?page.tasks:[]),dependencies:[...new Map(pages.flatMap(page=>Array.isArray(page.dependencies)?page.dependencies:[]).map(dependency=>[canonical(dependency),dependency])).values()],page:pages.at(-1)!.page};
   if(Buffer.byteLength(canonical(view))>262144)fail('FLEET_OBSERVATION_TOO_LARGE','Complete observation exceeds the admitted context bound');
   return {view,ids};
  };
  const bind=async(actor:Actor,delegation:RecordValue|null):Promise<ActorState>=>{
   const currentBinding=binding(actor,config,delegation),old=state.actors[actor.session_id];
   if(old&&JSON.stringify(old.binding)===JSON.stringify(currentBinding))return old;
   await call(actor,'fleet.session.bind',{binding:currentBinding});const current={binding:currentBinding,reasoning:null,observed_state:null};state.actors[actor.session_id]=current;await persist();return current;
  };
  const drainInstallDeliveries=async():Promise<void>=>{
   if(!operator)return;let after:string|null=null,bootstrapAfter:string|null=null,codingAfter:string|null=null;
   for(let page=0;page<64;page++){
    const pending=await call(operator,'fleet.install.delivery.pending',{after,limit:100,bootstrap_after:bootstrapAfter,coding_after:codingAfter},'fleet-install-delivery');
    if(!Array.isArray(pending.items))fail('FLEET_DELIVERY_RESPONSE','Versioned install delivery observation required');
    if(!Array.isArray(pending.bootstrap_commands)||pending.bootstrap_commands.length>200)fail('FLEET_DELIVERY_RESPONSE','Bounded explicit bootstrap commands required');
    for(const command of pending.bootstrap_commands){if(!object(command)||!uuid(command.operation_id)||!['fleet.install.delivery.prepare.allocate','fleet.install.delivery.verify.allocate','fleet.install.delivery.register'].includes(String(command.action))||!object(command.input))fail('FLEET_DELIVERY_RESPONSE','Only exact install registration commands are permitted');await call(operator,String(command.action),command.input,'fleet-install-delivery',String(command.operation_id));event('bootstrap_install',null,{operation_id:command.operation_id,action:command.action});}
    const coding=pending.coding_commands??[];if(!Array.isArray(coding)||coding.length>100)fail('FLEET_COMPLETION_RESPONSE','Bounded mechanical completion commands required');
    for(const command of coding){if(!object(command)||!object(command.input)||!(command.component==='12.4'&&command.action==='runner.control.issue'&&uuid(command.operation_id)||command.component==='16.1'&&command.action==='submission.archive.register'&&command.operation_id===null))fail('FLEET_COMPLETION_RESPONSE','Only exact admitted completion commands are permitted');await call(operator,String(command.action),command.input,String(command.component),command.operation_id===null?undefined:String(command.operation_id));event('coding_completion',null,{operation_id:command.operation_id,action:command.action});}
    for(const item of pending.items){
     if(!object(item)||!uuid(item.operation_id))fail('FLEET_DELIVERY_RESPONSE','Exact admitted install operation identity required');
     if(item.delivery_state==='UNKNOWN'||item.runner_state==='UNKNOWN')continue;
     let state:string|null=null;
     if(['REGISTERED','QUEUED'].includes(String(item.delivery_state))){const scheduled=await call(operator,'fleet.install.delivery.schedule',{operation_id:item.operation_id},'fleet-install-delivery');state=String(scheduled.state);event('install_delivery',null,{operation_id:item.operation_id,state});}
     if(state==='COMPLETED'||item.runner_state==='COMPLETED'){const collected=await call(operator,'fleet.install.delivery.collect',{operation_id:item.operation_id},'fleet-install-delivery');event('install_delivery',null,{operation_id:item.operation_id,state:collected.state});}
    }
    if(pending.next_cursor===null&&pending.bootstrap_next_cursor===null&&(pending.coding_next_cursor??null)===null)return;
    if(pending.coding_next_cursor!==undefined&&pending.coding_next_cursor!==null){if(!uuid(pending.coding_next_cursor)||pending.coding_next_cursor===codingAfter)fail('FLEET_COMPLETION_RESPONSE','Coding pagination did not advance');codingAfter=String(pending.coding_next_cursor);}
    if(pending.bootstrap_next_cursor!==null){if(!uuid(pending.bootstrap_next_cursor)||pending.bootstrap_next_cursor===bootstrapAfter)fail('FLEET_DELIVERY_RESPONSE','Bootstrap pagination did not advance');bootstrapAfter=String(pending.bootstrap_next_cursor);}
    if(pending.next_cursor===null){after=pending.items.at(-1)?.operation_id??after;continue;}
    if(typeof pending.next_cursor!=='string'||pending.next_cursor===after)fail('FLEET_DELIVERY_RESPONSE','Install delivery pagination did not advance');after=pending.next_cursor;
   }
   fail('FLEET_DELIVERY_TOO_LARGE','Install delivery observation exceeds the bounded wake budget');
  };
  const drainTestCommands=async():Promise<void>=>{
   if(!operator)return;let after:string|null=null;
   const allowed:Record<string,string[]>={'fleet-install-delivery':['fleet.install.delivery.prepare.allocate','fleet.install.delivery.verify.allocate'],'16.2':['qualification.preparation.plan','qualification.job.assign'],'fleet-test-executor':['fleet.test.executor.retire']};
   for(let page=0;page<64;page++){
    const pending=await call(operator,'fleet.test.pending',{after,limit:100},'fleet-test-executor');
    if(!Array.isArray(pending.commands)||pending.commands.length>100)fail('FLEET_TEST_RESPONSE','Bounded accepted TEST commands required');
    for(const command of pending.commands){if(!object(command)||!uuid(command.operation_id)||typeof command.component!=='string'||typeof command.action!=='string'||!allowed[command.component]?.includes(command.action)||!object(command.input))fail('FLEET_TEST_RESPONSE','Only scoped TEST resource and qualification commands are permitted');await call(operator,command.action,command.input,command.component,command.operation_id);event('independent_verification',null,{operation_id:command.operation_id,action:command.action});}
    if(pending.next_cursor===null)return;if(!uuid(pending.next_cursor)||pending.next_cursor===after)fail('FLEET_TEST_RESPONSE','TEST pagination did not advance');after=String(pending.next_cursor);
   }
   fail('FLEET_TEST_TOO_LARGE','TEST command observation exceeds the bounded wake budget');
  };
  await bind(primary,null);event('started',primary.session_id,{cohort_id:config.cohort_id,cohort_generation:state.cohort_generation});
  do{
   try{
    primary=await enrolled(config.primary,'PRIMARY',null);
    const primaryState=state.actors[primary.session_id]!;let primaryObservation=await observe(primary,primaryState),observed=primaryObservation.view;
    let acknowledged=false;
    for(const handoff of Array.isArray(observed.manager_handoffs)?observed.manager_handoffs:[]){
     if(!object(handoff)||!uuid(handoff.handoff_id)||!Array.isArray(handoff.package_snapshot)||handoff.package_snapshot.length!==1||!object(handoff.package_snapshot[0]))fail('FLEET_HANDOFF_INVALID','Exact admitted replacement observation required');
     const reference=config.managers.find(m=>m.session_id===handoff.successor_id);if(!reference){event('manager_credentials_required',String(handoff.successor_id),{handoff_id:handoff.handoff_id});continue;}
     const snapshot=handoff.package_snapshot[0],successor=await enrolled(reference,'WAVE_MANAGER',{package_id:snapshot.package_id,manager_generation:(BigInt(String(snapshot.owner_generation))+1n).toString(),handoff_id:handoff.handoff_id});
     await call(successor,'hierarchy.package.handoff.acknowledge',{idempotency_key:'fleet-manager-handoff:'+handoff.handoff_id,leader_generation:config.leader_generation,handoff_id:handoff.handoff_id},'3.1');acknowledged=true;
    }
    if(acknowledged){primaryObservation=await observe(primary,primaryState);observed=primaryObservation.view;}
    const delegations=Array.isArray(observed.delegations)?observed.delegations:[];
    for(const delegation of delegations)if(object(delegation)&&typeof delegation.manager_session_id==='string'){
     const reference=config.managers.find(m=>m.session_id===delegation.manager_session_id);if(reference){const manager=await enrolled(reference,'WAVE_MANAGER',delegation);await bind(manager,delegation);}
    }
    const active=[primary,...[...actors.values()].filter(a=>a.role==='WAVE_MANAGER'&&state.actors[a.session_id]&&delegations.some(d=>object(d)&&d.manager_session_id===a.session_id&&canonical(state.actors[a.session_id]!.binding)===canonical(binding(a,config,d))))];
    for(const current of active){
     if(signal.aborted)break;const session=state.actors[current.session_id]!;
     const observation=current===primary?primaryObservation:await observe(current,session),view=observation.view;
     const fingerprint=observationState(view);if(!session.reasoning&&session.observed_state===fingerprint)continue;
     session.reasoning??={binding:session.binding,operation_id:randomUUID(),observation_id:observation.ids[0],context_observation_ids:observation.ids};await persist();
     let result:RecordValue;
     try{result=await call(current,'fleet.session.reason',session.reasoning);}
     catch(error){if(error instanceof SupervisorRpcError&&!error.uncertain){event('decision_refused',current.session_id,{operation_id:session.reasoning.operation_id,code:error.code});session.reasoning=null;session.observed_state=null;await persist();}throw error;}
     event('reasoned',current.session_id,{operation_id:result.operation_id,state:result.state,action:result.decision?.action??null});
     if(!['PREPARED','RUNNING','UNKNOWN'].includes(String(result.state))){session.reasoning=null;session.observed_state=result.state==='WAITING_FOR_MANAGER'?null:fingerprint;await persist();}
     if(result.decision?.action==='DELEGATE_WAVE'&&object(result.effect)){
      const effect=result.effect,reference=config.managers.find(m=>m.session_id===effect.manager_session_id),manager=reference?await enrolled(reference,'WAVE_MANAGER',effect):undefined;
      if(manager&&manager.role==='WAVE_MANAGER'){await bind(manager,effect);if(!active.some(a=>a.session_id===manager.session_id))active.push(manager);event('manager_activated',manager.session_id,{package_id:effect.package_id,manager_generation:effect.manager_generation});}
      else event('manager_credentials_required',String(effect.manager_session_id));
     }
    }
   }catch(error){if(signal.aborted)break;const code=error instanceof SupervisorRpcError?error.code:'FLEET_SUPERVISOR_FAILED';event('waiting',null,{code});if(state.pending)break;}
   if(!signal.aborted)try{await drainInstallDeliveries();}catch(error){const code=error instanceof SupervisorRpcError?error.code:'FLEET_DELIVERY_FAILED';event('waiting',null,{code});if(state.pending)break;}
   if(!signal.aborted)try{await drainTestCommands();}catch(error){const code=error instanceof SupervisorRpcError?error.code:'FLEET_TEST_DELIVERY_FAILED';event('waiting',null,{code});if(state.pending)break;}
   if(once||signal.aborted)break;
   await new Promise<void>(resolve=>{const timer=setTimeout(done,config.poll_interval_ms);function done(){clearTimeout(timer);signal.removeEventListener('abort',done);resolve();}signal.addEventListener('abort',done,{once:true});});
  }while(!signal.aborted);
  if(state.pending&&!signal.aborted)throw new SupervisorRpcError('FLEET_RECONCILIATION_REQUIRED',true);
 }finally{await release();}
}
async function main():Promise<void>{
 const args=process.argv.slice(2);
 if(args.length===1&&['--help','-h'].includes(args[0]!)){process.stdout.write('Usage: fleet-supervisor --config /absolute/private/config.json [--once | --check-config]\n');return;}
 if(args.length<2||args.length>3||args[0]!=='--config'||!absolute(args[1])||args[2]!==undefined&&!['--once','--check-config'].includes(args[2]))fail('INVALID_REQUEST','Usage: fleet-supervisor --config /absolute/private/config.json [--once | --check-config]');
 if(args[2]==='--check-config'){const config=await readFleetSupervisorConfig(args[1]!);await loadActors(config);await readTrustedAgentFile(config.ca_file,65536);process.stdout.write(JSON.stringify({ok:true,run_id:config.run_id,actors:config.managers.length+1})+'\n');return;}
 const controller=new AbortController(),stop=()=>controller.abort();process.on('SIGTERM',stop);process.on('SIGINT',stop);
 try{await runFleetSupervisor(args[1]!,controller.signal,args[2]==='--once');}finally{process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))void main().catch(error=>{const code=error instanceof Error&&'code' in error?String(error.code):'FLEET_SUPERVISOR_FAILED';process.stderr.write(JSON.stringify({ok:false,error:{code}})+'\n');process.exitCode=error instanceof SupervisorRpcError&&error.uncertain?75:78;});
