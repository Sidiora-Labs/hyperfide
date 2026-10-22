import fs from 'node:fs/promises';
import path from 'node:path';
import {constants} from 'node:fs';
import {createPrivateKey,createPublicKey,randomUUID,sign} from 'node:crypto';
import type {IdentityAuthority} from '../identity/enrollment.js';
import {exact,hash,signingBytes,strictJSON,uuid} from '../transport/protocol.js';
import type {InvocationContext} from '../transport/protocol.js';
import {assertInvocation} from '../transport/protocol.js';
import {FoundationError} from '../policy/programme.js';
import {PROVIDER_METHODS} from './contract.js';
import {bindProviderInvocation,configuredScope,currentPool,fail,readDeployment,transaction} from './pools.js';
import type {DeploymentConfig,ProviderDatabase,ProviderPersistenceHooks} from './pools.js';

/** Persistent provisioner-role worker. It owns no state of its own: durable
 * provisioning intents are the only work queue, claims are short SKIP LOCKED
 * transactions, and every effect goes through the 8.3 execute/reconcile paths
 * under the authenticated provisioner credential that started it. */
export interface ProvisionerWorkerSettings {concurrency:number;poll_ms:number;retry_ms:number;lease_ms:number;escalate_ms:number}
export interface ProvisionerWorkerDriver {
 execute(database:ProviderDatabase,config:DeploymentConfig,id:string,signal:AbortSignal):Promise<unknown>;
 reconcile(database:ProviderDatabase,config:DeploymentConfig,id:string,signal:AbortSignal):Promise<unknown>;
 /** provider.resolutions.escalate (D15): one decision Ask per overdue orphan or quarantined
  * intent, idempotent per open subject; refuses RESOLUTION_WINDOW_REQUIRED without the window. */
 escalate?(database:ProviderDatabase,config:DeploymentConfig,env:Readonly<NodeJS.ProcessEnv>):Promise<{raised:string[]}>;
}
export interface PoolAdapterReadiness {
 pool_id:string;provider:string;configuration_current:boolean;adapter_registered:boolean;adapter_compatible:boolean;
 ownership_probe_registered:boolean;operational_ready:boolean;reason:string|null;
}
function bounded(env:Readonly<NodeJS.ProcessEnv>,name:string,fallback:number,min:number,max:number):number{
 const raw=env[name];if(raw===undefined||raw==='')return fallback;
 const value=Number(raw);if(!/^\d+$/.test(raw)||!Number.isSafeInteger(value)||value<min||value>max)fail('WORKER_CONFIG_INVALID',name+' is outside its approved bound');
 return value;
}
export function workerSettings(env:Readonly<NodeJS.ProcessEnv>):ProvisionerWorkerSettings{
 const settings={concurrency:bounded(env,'HYPERFIDE_PROVISIONER_CONCURRENCY',4,1,64),poll_ms:bounded(env,'HYPERFIDE_PROVISIONER_POLL_MS',1000,50,60000),
  retry_ms:bounded(env,'HYPERFIDE_PROVISIONER_RETRY_MS',5000,100,3600000),lease_ms:bounded(env,'HYPERFIDE_PROVISIONER_LEASE_MS',60000,1000,3600000),
  // 0 disables escalation; the 60 s default is the Ask 2.16 recommendation, not an operator-approved value.
  escalate_ms:bounded(env,'HYPERFIDE_RESOLUTION_ESCALATE_INTERVAL_MS',60000,0,86400000)};
 if(settings.lease_ms<settings.poll_ms)fail('WORKER_CONFIG_INVALID','Reconciliation lease must exceed the poll interval');
 if(settings.escalate_ms>0&&settings.escalate_ms<100)fail('WORKER_CONFIG_INVALID','HYPERFIDE_RESOLUTION_ESCALATE_INTERVAL_MS is outside its approved bound');
 return settings;
}
/** Adapter compatibility is measured by instantiating the registered factory
 * with hooks that refuse every persistence effect; no provider method is called. */
export async function poolAdapterReadiness(database:ProviderDatabase,config:DeploymentConfig,invocation:InvocationContext,running:boolean):Promise<PoolAdapterReadiness[]>{
 const refuse=async()=>fail('PROVIDER_READINESS_PROBE','Readiness probing cannot persist provider effects');
 const hooks:ProviderPersistenceHooks={invocation,persistOutputArchive:refuse,assertResourceBinding:refuse,resolveResourceBinding:refuse,resolvePreparation:refuse,
  claimProcess:refuse,resolveProcess:refuse,persistEarlyProcess:refuse,assignedBootGeneration:refuse,persistEarlyResource:refuse,recordObservation:refuse};
 const result:PoolAdapterReadiness[]=[];
 for(const pool of config.pools){
  const scope=configuredScope(config,pool),factory=database.runtime.adapters.get(pool.provider);
  let current=false,compatible=false,reason:string|null=null;
  try{await currentPool(database,config,pool.id);current=true;}catch(error){reason=error instanceof FoundationError?error.code:'POOL_CONFIG_UNAVAILABLE';}
  if(!factory)reason??='PROVIDER_ADAPTER_MISSING';
  else try{
   const adapter=factory(scope,hooks) as unknown as Record<string,unknown>;
   compatible=!!adapter&&typeof adapter==='object'&&adapter.provider===pool.provider&&PROVIDER_METHODS.every(m=>typeof adapter[m]==='function');
   if(!compatible)reason??='PROVIDER_ADAPTER_INCOMPATIBLE';
  }catch{reason??='PROVIDER_ADAPTER_INCOMPATIBLE';}
  if(!running)reason??='PROVISIONER_WORKER_STOPPED';
  result.push({pool_id:pool.id,provider:pool.provider,configuration_current:current,adapter_registered:!!factory,adapter_compatible:compatible,
   ownership_probe_registered:database.runtime.probes.has(pool.provider),operational_ready:running&&current&&compatible,reason});
 }
 return result;
}
// Claimable work, all scoped to the authenticated run:
//  RECORDED with a live deadline -> execute (its own FOR UPDATE transition is the submission claim);
//  SUBMITTING / ID_KNOWN without outcome only after the submitter's deadline (it can no longer be in flight);
//  ID_KNOWN with a create outcome, UNKNOWN and acknowledged DESTROY after the retry interval;
//  RECONCILING only once its lease lapsed (a crashed reconciler).
const CLAIM=`SELECT id,state FROM hyperfide.provisioning_intents
 WHERE organisation_id=$1 AND run_id=$2 AND NOT (id=ANY($3::uuid[])) AND operation->'scope'->>'provider'=ANY($4::text[]) AND (
  (state='RECORDED' AND (operation->>'deadline_at')::timestamptz>clock_timestamp())
  OR (state='SUBMITTING' AND (operation->>'deadline_at')::timestamptz<=clock_timestamp())
  OR (state='ID_KNOWN' AND (last_outcome IS NOT NULL OR (operation->>'deadline_at')::timestamptz<=clock_timestamp()) AND updated_at<=clock_timestamp()-make_interval(secs=>$5::double precision/1000))
  OR (state='UNKNOWN' AND updated_at<=clock_timestamp()-make_interval(secs=>$5::double precision/1000))
  OR (state='ACKNOWLEDGED' AND kind='DESTROY' AND updated_at<=clock_timestamp()-make_interval(secs=>$5::double precision/1000))
  OR (state='RECONCILING' AND updated_at<=clock_timestamp()-make_interval(secs=>$6::double precision/1000)))
 ORDER BY updated_at,id LIMIT $7 FOR UPDATE SKIP LOCKED`;
const START_MIGRATION='0707-provisioner-worker-starts';
const START_COLUMNS='state,owner_credential_id,start_count::text,resume_count::text,started_at,updated_at';
export interface DurableWorkerStart {state:'STARTED'|'STOPPED';owner_credential_id:string;start_count:string;resume_count:string;started_at:string;updated_at:string}
async function assertStartSchema(database:ProviderDatabase):Promise<void>{
 const expected=hash(await fs.readFile(new URL('../../migrations/'+START_MIGRATION+'.sql',import.meta.url)));
 const row=(await database.query<{name:string;checksum:string}>('SELECT name,checksum FROM hyperfide.schema_migrations WHERE version=$1',[Number(START_MIGRATION.slice(0,4))])).rows[0];
 if(!row||row.name!==START_MIGRATION||row.checksum!==expected)fail('PROVISIONER_WORKER_SCHEMA_REQUIRED','Apply the trusted provisioner worker start migration before service startup');
}
function durableStart(row:Record<string,unknown>|undefined):DurableWorkerStart|null{
 return row?{state:row.state as DurableWorkerStart['state'],owner_credential_id:String(row.owner_credential_id),start_count:String(row.start_count),resume_count:String(row.resume_count),
  started_at:new Date(row.started_at as string).toISOString(),updated_at:new Date(row.updated_at as string).toISOString()}:null;
}
/** Records the start for the authenticated run. A live local loop changes nothing; a
 * process boot resumes its own STARTED record (resume_count only); a STOPPED record, or
 * one owned by a credential that is no longer current, is a new start. */
async function claimDurableStart(database:ProviderDatabase,organisation:string,invocation:InvocationContext,local:boolean):Promise<{started:boolean;durable:DurableWorkerStart}>{
 const run=invocation.principal.run_id,owner=invocation.principal.credential_id;
 return transaction(database,async c=>{
  const row=(await c.query(`SELECT s.state,s.owner_credential_id,p.state='ACTIVE' AND p.expires_at>clock_timestamp() AND p.deployment_epoch=r.authority_epoch AS owner_current
   FROM hyperfide.provisioner_worker_starts s JOIN hyperfide.identity_principals p ON p.credential_id=s.owner_credential_id
   JOIN hyperfide.runs r ON r.organisation_id=s.organisation_id AND r.id=s.run_id WHERE s.organisation_id=$1 AND s.run_id=$2 FOR UPDATE OF s`,[organisation,run])).rows[0];
  let started=false,result;
  if(!row){
   started=true;
   result=await c.query(`INSERT INTO hyperfide.provisioner_worker_starts(organisation_id,run_id,owner_credential_id,state,start_count,resume_count,started_at)
    VALUES($1,$2,$3,'STARTED',1,0,clock_timestamp()) RETURNING ${START_COLUMNS}`,[organisation,run,owner]);
  }else if(row.state==='STARTED'&&row.owner_credential_id===owner){
   result=local?await c.query(`SELECT ${START_COLUMNS} FROM hyperfide.provisioner_worker_starts WHERE organisation_id=$1 AND run_id=$2`,[organisation,run]):
    await c.query(`UPDATE hyperfide.provisioner_worker_starts SET resume_count=resume_count+1,updated_at=clock_timestamp(),state_version=state_version+1
     WHERE organisation_id=$1 AND run_id=$2 RETURNING ${START_COLUMNS}`,[organisation,run]);
  }else{
   if(row.state==='STARTED'&&row.owner_current===true)fail('WORKER_ALREADY_RUNNING','Another current provisioner credential owns this worker');
   started=true;
   result=await c.query(`UPDATE hyperfide.provisioner_worker_starts SET state='STARTED',owner_credential_id=$3,start_count=start_count+1,
    started_at=clock_timestamp(),updated_at=clock_timestamp(),state_version=state_version+1 WHERE organisation_id=$1 AND run_id=$2 RETURNING ${START_COLUMNS}`,[organisation,run,owner]);
  }
  return{started,durable:durableStart(result.rows[0])!};
 });
}
async function readDurableStart(database:ProviderDatabase,organisation:string,run:string):Promise<DurableWorkerStart|null>{
 return durableStart((await database.query(`SELECT ${START_COLUMNS} FROM hyperfide.provisioner_worker_starts WHERE organisation_id=$1 AND run_id=$2`,[organisation,run])).rows[0]);
}
interface Signer {credential_id:string;key:import('node:crypto').KeyObject;public_key_b64:string}
type KeyObject=import('node:crypto').KeyObject;
async function privateBytes(filename:unknown,limit:number):Promise<Buffer>{
 try{return await checkedPrivateBytes(filename,limit);}catch{fail('PROVISIONER_EXECUTOR_CONFIG_INVALID','Private owned bounded single-link non-symlink credential required');}
}
async function checkedPrivateBytes(filename:unknown,limit:number):Promise<Buffer>{
 if(typeof filename!=='string'||!path.isAbsolute(filename)||path.normalize(filename)!==filename||await fs.realpath(filename)!==filename)fail('PROVISIONER_EXECUTOR_CONFIG_INVALID','Absolute non-symlink trusted file required');
 const fd=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const before=await fd.stat();if(!before.isFile()||before.nlink!==1||before.uid!==process.getuid?.()||(before.mode&0o777)!==0o600||before.size>limit)fail('PROVISIONER_EXECUTOR_CONFIG_INVALID','Private owned bounded regular file required');
 const bytes=await fd.readFile();const after=await fd.stat();
 if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||bytes.length!==before.size)fail('PROVISIONER_EXECUTOR_CONFIG_INVALID','Trusted file changed during read');
 return bytes;}finally{await fd.close();}
}
async function configuration(env:Readonly<NodeJS.ProcessEnv>):Promise<{signers:Signer[];concurrency:number}>{
 const value=strictJSON(await privateBytes(env.HF_PROVISIONER_EXECUTOR_CONFIG_FILE,65536));
 exact(value,['schema_version','principals','concurrency']);
 if(value.schema_version!==1||!Array.isArray(value.principals)||value.principals.length<1||value.principals.length>64||!Number.isSafeInteger(value.concurrency)||Number(value.concurrency)<1||Number(value.concurrency)>16)fail('PROVISIONER_EXECUTOR_CONFIG_INVALID','Bounded executor identity list and concurrency required');
 const signers:Signer[]=[];
 for(const item of value.principals){exact(item,['credential_id','key_path']);if(!uuid(item.credential_id)||signers.some(s=>s.credential_id===item.credential_id))fail('PROVISIONER_EXECUTOR_CONFIG_INVALID','Unique credential identity required');
 const raw=await privateBytes(item.key_path,16384);let key:KeyObject;
 try{key=raw[0]===45?createPrivateKey(raw):createPrivateKey({key:raw,format:'der',type:'pkcs8'});}finally{raw.fill(0);}
 if(key.asymmetricKeyType!=='ed25519')fail('PROVISIONER_EXECUTOR_CONFIG_INVALID','Ed25519 service key required');
 const der=createPublicKey(key).export({format:'der',type:'spki'}) as Buffer;
 if(der.length!==44||!der.subarray(0,12).equals(Buffer.from('302a300506032b6570032100','hex')))fail('PROVISIONER_EXECUTOR_CONFIG_INVALID','Canonical Ed25519 public key required');
 signers.push({credential_id:item.credential_id,key,public_key_b64:der.subarray(12).toString('base64url')});}
 return {signers,concurrency:Number(value.concurrency)};
}
export class ProvisionerWorker {
 private booting:Promise<unknown>|null=null;
 private starting:Promise<unknown>|null=null;
 boot(authority:IdentityAuthority):Promise<unknown>{
  return this.booting??=(async()=>{
   let config:Awaited<ReturnType<typeof configuration>>;
   try{config=await configuration(this.env);}catch{fail('PROVISIONER_EXECUTOR_CONFIG_INVALID','Valid private provisioner executor configuration required');}
   if(config.signers.length!==1)fail('PROVISIONER_EXECUTOR_CONFIG_INVALID','Exactly one worker owner required');
   const signer=config.signers[0]!;
   await assertStartSchema(this.database);
   const row=(await this.database.query('SELECT p.*,r.authority_epoch,clock_timestamp() AS db_now FROM hyperfide.identity_principals p JOIN hyperfide.runs r ON r.organisation_id=p.organisation_id AND r.id=p.run_id WHERE p.credential_id=$1',[signer.credential_id])).rows[0];
   if(!row||row.role!=='PROVISIONER'||row.public_key_b64!==signer.public_key_b64||row.state!=='ACTIVE'||row.deployment_epoch!==row.authority_epoch||row.attempt_id!==null||
      new Date(row.expires_at).getTime()<=new Date(row.db_now).getTime())fail('PROVISIONER_EXECUTOR_IDENTITY_MISMATCH','Current matching provisioner identity required');
   const payload=Buffer.from(JSON.stringify({run_id:row.run_id,component:'8.3',action:'provider.worker.start',input:{},expected_version:null,authority:null}));
   const operation=randomUUID(),body=Buffer.from(JSON.stringify({protocol_version:1,operation_id:operation,idempotency_key:operation,payload_digest:hash(payload),correlation_id:operation,causation_id:null,payload_b64:payload.toString('base64url')}));
   const proof={id:signer.credential_id,time:String(Math.floor(Date.now()/1000)),nonce:randomUUID()};
   const signature=sign(null,signingBytes(authority.origin,'/v1/invoke',proof,body),signer.key).toString('base64url');
   const invocation=await authority.authenticate(body,['hf-credential-id',proof.id,'hf-request-time',proof.time,'hf-request-nonce',proof.nonce,'hf-request-signature',signature],this.signal);
   await authority.authorize(invocation);assertInvocation(invocation);
   if(invocation.principal.role!=='PROVISIONER'||invocation.principal.credential_id!==signer.credential_id||invocation.principal.run_id!==row.run_id||invocation.principal.deployment_epoch!==row.authority_epoch)fail('PROVISIONER_EXECUTOR_IDENTITY_MISMATCH','Authenticated worker owner differs');
   return this.start(invocation);
  })();
 }

 private invocation:InvocationContext|null=null;private controller:AbortController|null=null;private loop:Promise<void>|null=null;
 private readonly active=new Map<string,Promise<void>>();private readonly errors=new Map<string,string>();private readonly backoff=new Map<string,number>();
 private counters={claimed:0,executed:0,reconciled:0,failed:0};private stoppedReason:string|null=null;private lastTick:string|null=null;
 private escalation={passes:0,raised:0,last_at:null as string|null,last_raised:[] as string[]};private nextEscalation=0;
 constructor(private readonly database:ProviderDatabase,private readonly env:Readonly<NodeJS.ProcessEnv>,private readonly signal:AbortSignal,private readonly driver:ProvisionerWorkerDriver){}
 get running():boolean{return !!this.loop&&!!this.controller&&!this.controller.signal.aborted;}
 async start(invocation:InvocationContext):Promise<unknown>{
  // Serialize starts before any asynchronous configuration read can create a second loop.
  while(this.starting)await this.starting;
  const pending=this.startOnce(invocation);this.starting=pending;
  try{return await pending;}finally{if(this.starting===pending)this.starting=null;}
 }
 private async startOnce(invocation:InvocationContext):Promise<unknown>{
  assertInvocation(invocation);if(invocation.principal.role!=='PROVISIONER')fail('AUTH_SCOPE_DENIED','Only the provisioner principal can own provider effects');
  if(this.signal.aborted)fail('PROVIDER_CLOSED','Provisioner is shutting down');
  const settings=workerSettings(this.env),config=await readDeployment(this.env);
  const db=bindProviderInvocation(this.database,config,invocation,['PROVISIONER']);
  if(this.running){
   if(this.invocation!.principal.credential_id!==invocation.principal.credential_id||this.invocation!.principal.run_id!==invocation.principal.run_id)fail('WORKER_ALREADY_RUNNING','Another provisioner credential owns this worker');
   const claim=await claimDurableStart(db,config.organisation_id,invocation,true);
   return{started:claim.started,resumed:false,...await this.status(invocation)};
  }
  // The durable record decides whether this is a new start or a restart resuming one.
  const claim=await claimDurableStart(db,config.organisation_id,invocation,false);
  await this.stop();
  this.invocation=invocation;this.controller=new AbortController();this.stoppedReason=null;this.errors.clear();this.nextEscalation=0;
  const signal=AbortSignal.any([this.signal,this.controller.signal]);
  this.loop=this.run(settings,signal);
  return{started:claim.started,resumed:!claim.started,...await this.status(invocation)};
 }
 /** Explicit operator/provisioner stop: the durable record becomes STOPPED so the next
  * boot is a new start rather than a resume. Process shutdown uses stop() only. */
 async halt(invocation:InvocationContext):Promise<Record<string,unknown>>{
  assertInvocation(invocation);
  const config=await readDeployment(this.env),db=bindProviderInvocation(this.database,config,invocation,['OPERATOR','PROVISIONER']);
  await this.stop();
  await db.query("UPDATE hyperfide.provisioner_worker_starts SET state='STOPPED',updated_at=clock_timestamp(),state_version=state_version+1 WHERE organisation_id=$1 AND run_id=$2 AND state='STARTED'",[config.organisation_id,invocation.principal.run_id]);
  return this.status(invocation);
 }
 private async run(settings:ProvisionerWorkerSettings,signal:AbortSignal):Promise<void>{
  while(!signal.aborted){
   if(!await this.step('tick','WORKER_TICK_FAILED',()=>this.tick(settings,signal)))break;
   if(signal.aborted||!await this.step('escalate','WORKER_ESCALATE_FAILED',()=>this.escalate(settings)))break;
   await new Promise<void>(resolve=>{const timer=setTimeout(done,settings.poll_ms);function done(){clearTimeout(timer);signal.removeEventListener('abort',done);resolve();}signal.addEventListener('abort',done,{once:true});});
  }
 }
 /** Records a failed loop step under its name; false once the credential lost authority. */
 private async step(name:string,fallback:string,body:()=>Promise<void>):Promise<boolean>{
  try{await body();return true;}
  catch(error){
   const code=error instanceof FoundationError?error.code:fallback;this.errors.set(name,code);
   // A revoked or expired credential ends provider authority; never continue under it.
   if(code.startsWith('AUTH_')){this.stoppedReason=code;this.controller?.abort();return false;}
   return true;
  }
 }
 /** Unresolved provider uncertainty becomes a decision Ask on its own cadence, independent of
  * registered adapters. A refusal (an unset window) waits a full interval and stays in errors. */
 private async escalate(settings:ProvisionerWorkerSettings):Promise<void>{
  if(!settings.escalate_ms||!this.driver.escalate||Date.now()<this.nextEscalation)return;
  this.nextEscalation=Date.now()+settings.escalate_ms;
  const config=await readDeployment(this.env),db=bindProviderInvocation(this.database,config,this.invocation!,['PROVISIONER']);
  const result=await this.driver.escalate(db,config,this.env);
  this.escalation={passes:this.escalation.passes+1,raised:this.escalation.raised+result.raised.length,last_at:new Date().toISOString(),last_raised:[...result.raised]};
  this.errors.delete('escalate');
 }
 private async tick(settings:ProvisionerWorkerSettings,signal:AbortSignal):Promise<void>{
  this.lastTick=new Date().toISOString();
  const free=settings.concurrency-this.active.size;if(free<=0)return;
  const providers=[...this.database.runtime.adapters.keys()];if(!providers.length)return;
  const config=await readDeployment(this.env),db=bindProviderInvocation(this.database,config,this.invocation!,['PROVISIONER']),run=this.invocation!.principal.run_id;
  const claimed=await transaction(db,async c=>{
   const now=Date.now();for(const [id,until] of this.backoff)if(until<=now)this.backoff.delete(id);
   const rows=(await c.query<{id:string;state:string}>(CLAIM,[config.organisation_id,run,[...this.active.keys(),...this.backoff.keys()],providers,settings.retry_ms,settings.lease_ms,free])).rows;
   const reconcile=rows.filter(r=>r.state!=='RECORDED').map(r=>r.id);
   // RECONCILING plus updated_at is the reconciliation lease; an acknowledged destroy keeps its state.
   if(reconcile.length)await c.query("UPDATE hyperfide.provisioning_intents SET state=CASE WHEN state='ACKNOWLEDGED' THEN state ELSE 'RECONCILING' END,updated_at=clock_timestamp(),state_version=state_version+1 WHERE organisation_id=$1 AND run_id=$2 AND id=ANY($3::uuid[])",[config.organisation_id,run,reconcile]);
   return rows;
  });
  for(const row of claimed){
   if(signal.aborted||this.active.has(row.id))continue;
   this.counters.claimed++;
   const task=this.process(db,config,row,settings,signal).finally(()=>this.active.delete(row.id));
   this.active.set(row.id,task);
  }
 }
 private async process(db:ProviderDatabase,config:DeploymentConfig,row:{id:string;state:string},settings:ProvisionerWorkerSettings,signal:AbortSignal):Promise<void>{
  let heartbeat:ReturnType<typeof setInterval>|undefined;
  try{
   if(row.state==='RECORDED'){await this.driver.execute(db,config,row.id,signal);this.counters.executed++;}
   else{
    heartbeat=setInterval(()=>{void db.query("UPDATE hyperfide.provisioning_intents SET updated_at=clock_timestamp(),state_version=state_version+1 WHERE organisation_id=$1 AND id=$2 AND state='RECONCILING'",[config.organisation_id,row.id]).catch(()=>{});},Math.max(250,Math.floor(settings.lease_ms/3)));
    await this.driver.reconcile(db,config,row.id,signal);this.counters.reconciled++;
   }
   this.errors.delete(row.id);this.backoff.delete(row.id);
   await this.persistError(db,config,row.id,null);
  }catch(error){
   // The intent keeps its durable uncertain state; the error is surfaced, never retried blindly.
   const code=error instanceof FoundationError?error.code:'WORKER_INTENT_FAILED';
   this.counters.failed++;this.errors.set(row.id,code);
   if(this.errors.size>256)this.errors.delete(this.errors.keys().next().value!);
   await this.persistError(db,config,row.id,code);
   // A refused submission stays RECORDED; back off instead of re-claiming it every poll.
   this.backoff.set(row.id,Date.now()+settings.retry_ms);if(this.backoff.size>4096)this.backoff.delete(this.backoff.keys().next().value!);
  }finally{if(heartbeat)clearInterval(heartbeat);}
 }
 /** The intent row carries the worker's last failure so a restart or another reader still
  * sees it. A quarantined or settled intent keeps the reconciler's own failure_code; a
  * persistence failure stays in memory only and never masks the intent outcome. */
 private async persistError(db:ProviderDatabase,config:DeploymentConfig,id:string,code:string|null):Promise<void>{
  try{
   await db.query(`UPDATE hyperfide.provisioning_intents SET failure_code=$3,state_version=state_version+1 WHERE organisation_id=$1 AND id=$2
    AND state NOT IN ('QUARANTINED','TERMINAL','REJECTED') AND failure_code IS DISTINCT FROM $3`,[config.organisation_id,id,code===null?null:code.slice(0,128)]);
  }catch(error){this.errors.set('persist',error instanceof FoundationError?error.code:'WORKER_ERROR_PERSIST_FAILED');}
 }
 async status(invocation:InvocationContext):Promise<Record<string,unknown>>{
  assertInvocation(invocation);
  const config=await readDeployment(this.env),db=bindProviderInvocation(this.database,config,invocation);
  const settings=workerSettings(this.env),running=this.running;
  const pools=await poolAdapterReadiness(db,config,invocation,running);
  const counts=(await db.query<{state:string;n:number}>('SELECT state,count(*)::int AS n FROM hyperfide.provisioning_intents WHERE organisation_id=$1 AND run_id=$2 GROUP BY state ORDER BY state',[config.organisation_id,invocation.principal.run_id])).rows;
  const durable=await readDurableStart(db,config.organisation_id,invocation.principal.run_id);
  const persisted=(await db.query<{id:string;failure_code:string}>("SELECT id,failure_code FROM hyperfide.provisioning_intents WHERE organisation_id=$1 AND run_id=$2 AND failure_code IS NOT NULL AND state NOT IN ('TERMINAL','REJECTED') ORDER BY updated_at DESC,id LIMIT 256",[config.organisation_id,invocation.principal.run_id])).rows;
  return{running,role:'provisioner',owner_credential_id:running?this.invocation!.principal.credential_id:null,durable,settings,active:[...this.active.keys()].sort(),
   counters:{...this.counters},escalation:{...this.escalation,last_raised:[...this.escalation.last_raised]},errors:{...Object.fromEntries(persisted.map(r=>[r.id,r.failure_code])),...Object.fromEntries(this.errors)},stopped_reason:this.stoppedReason,last_tick_at:this.lastTick,
   intents:Object.fromEntries(counts.map(r=>[r.state,r.n])),pools,operational_ready:running&&pools.length>0&&pools.every(p=>p.operational_ready)};
 }
 async stop(timeoutMs=5000):Promise<void>{
  this.controller?.abort();
  const pending=[...(this.loop?[this.loop]:[]),...this.active.values()];
  if(pending.length){let timer:ReturnType<typeof setTimeout>|undefined;
   await Promise.race([Promise.allSettled(pending),new Promise<void>(resolve=>{timer=setTimeout(resolve,timeoutMs);})]);if(timer)clearTimeout(timer);}
  this.loop=null;
 }
}
export function createProvisionerWorker(database:ProviderDatabase,env:Readonly<NodeJS.ProcessEnv>,signal:AbortSignal,driver:ProvisionerWorkerDriver):ProvisionerWorker{
 return new ProvisionerWorker(database,env,signal,driver);
}
