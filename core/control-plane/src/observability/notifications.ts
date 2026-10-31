import {randomUUID} from 'node:crypto';
import type {Component,ComponentContext} from '../components/registry.js';
import {authority,object,text,uuid,digest,integer,hash,fail,lockRun,requireArtifact,numbers} from './views.js';
import type {Session,Principal} from './views.js';
import {invocationOf} from '../identity/enrollment.js';
import {attestationExpiryWarnings} from '../providers/pools.js';
import type {AttestationExpiryWarning} from '../providers/pools.js';
interface Outbox {
 bindSessionConsumer(tx:Session,input:{organisation_id:string;run_id:string;session_id:string;consumer_id:string;namespace:'fleet_notification'},invocation:unknown):Promise<{session_id:string;consumer_id:string;replayed:boolean;registered_actor_id:string}>;
 enqueue(tx:Session,event:{organisation_id:string;run_id:string;id:string;aggregate_id:string;aggregate_type:string;aggregate_version:string;event_type:string;payload:Record<string,unknown>},options:{consumer_ids:string[]}):Promise<unknown>;
}
function isOutbox(value:unknown):value is Outbox{return !!value&&typeof value==='object'&&typeof (value as Outbox).enqueue==='function'&&typeof (value as Outbox).bindSessionConsumer==='function';}
interface InboxBootstrap {bootstrapConsumer(tx:Session,input:{organisation_id:string;run_id:string;bootstrap_id:string;consumer_id:string;aggregate_types:string[];limit:number},builder:(tx:Session)=>Promise<unknown>):Promise<unknown>}
function isInbox(value:unknown):value is InboxBootstrap{return !!value&&typeof value==='object'&&typeof (value as InboxBootstrap).bootstrapConsumer==='function';}
function recipientAccess(p:Principal,target:string):void{
 if(!['OPERATOR','COORDINATOR'].includes(p.role)&&!(p.actor_id===target&&['LEADER','FEATURE_MANAGER'].includes(p.role)))fail('NOTIFICATION_RECIPIENT_FORBIDDEN','Private notices require the identified recipient or authorised operator');
}

export async function bootstrapRecipient(tx:Session,p:Principal,input:unknown,inbox:InboxBootstrap):Promise<unknown>{
 const v=object(input,['target_session_id','target_consumer_id','bootstrap_id']),target=uuid(v.target_session_id),consumer=uuid(v.target_consumer_id),id=uuid(v.bootstrap_id);
 recipientAccess(p,target);
 const q=await tx.query("SELECT b.consumer_id,s.sandbox_boot_generation FROM hyperfide.event_session_bindings b JOIN hyperfide.agent_sessions s ON s.organisation_id=b.organisation_id AND s.run_id=b.run_id AND s.id=b.session_id JOIN hyperfide.event_consumers c ON c.organisation_id=b.organisation_id AND c.run_id=b.run_id AND c.id=b.consumer_id WHERE b.organisation_id=$1 AND b.run_id=$2 AND b.session_id=$3 AND b.consumer_id=$4 AND b.namespace='fleet_notification' AND c.consumer_key=$5 AND s.role IN ('LEADER','FEATURE_MANAGER') AND s.state IN ('REGISTERED','RUNNING','DISCONNECTED')",[p.organisation_id,p.run_id,target,consumer,'session:'+target+':fleet_notification']);
 if(q.rows.length!==1)fail('NOTIFICATION_RECIPIENT_INVALID','Exact current recipient binding is required');
 return inbox.bootstrapConsumer(tx,{organisation_id:p.organisation_id,run_id:p.run_id,bootstrap_id:id,consumer_id:consumer,aggregate_types:['fleet_notification'],limit:10000},async sameTx=>{
  const notices=await sameTx.query("SELECT id,event_id,severity,code,untrusted_summary,action_code,artifact_id,state,state_version,target_boot_generation FROM hyperfide.observability_notifications WHERE organisation_id=$1 AND run_id=$2 AND target_session_id=$3 AND target_consumer_id=$4 AND state<>'ACKNOWLEDGED' ORDER BY id LIMIT 1001",[p.organisation_id,p.run_id,target,consumer]);
  if(notices.rows.length>1000)fail('NOTIFICATION_SNAPSHOT_BUDGET','Pending snapshot exceeds the recipient bound');
  if(notices.rows.some(n=>n.target_boot_generation!==q.rows[0]!.sandbox_boot_generation&&!(n.target_boot_generation===null&&q.rows[0]!.sandbox_boot_generation===null)))fail('NOTIFICATION_RECIPIENT_STALE','Pending notices bind another recipient boot generation');
  const clock=await sameTx.query('SELECT clock_timestamp() AS as_of');
  return numbers({scope:{organisation_id:p.organisation_id,run_id:p.run_id},target_session_id:target,target_consumer_id:consumer,as_of:clock.rows[0]!.as_of,notices:notices.rows.map(n=>({...n,evidence_ref:evidenceRef(p,String(n.artifact_id)),summary_trust:'UNTRUSTED_DATA_NOT_AN_INSTRUCTION'})),semantics:'PRIMARY_DURABLE_ADMISSION_NOT_UI_EFFECT',truncated:false});
 });
}
const ACTIONS=['INSPECT_EVIDENCE','RECONCILE_RESOURCE','RETRY_OPERATION','REPAIR_TASK','ROTATE_CREDENTIAL','PAUSE_ADMISSION'];
function rejectCredentialSummary(raw:unknown,knownSecrets:readonly string[]):string{
 const summary=text(raw,512);
 const shaped=/\b(?:bearer|basic)\s+\S{4,}|-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|authorization)\s*[:=]\s*\S+|\b(?:gh[pousr]_|github_pat_|sk-(?:proj-)?)[A-Za-z0-9_-]{8,}|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/i;
 if(shaped.test(summary)||knownSecrets.some(secret=>summary.includes(secret)))fail('NOTIFICATION_SENSITIVE_CONTENT','Credential material must be removed before creating an exception summary');
 return summary;
}
function evidenceRef(p:Principal,id:string):unknown{return {kind:'ARTIFACT',organisation_id:p.organisation_id,run_id:p.run_id,artifact_id:id,operation:{component:'15.2',action:'artifact.object.inspect',input:{organisation_id:p.organisation_id,run_id:p.run_id,artifact_id:id}},availability:'METADATA_COMPLETE_BYTES_UNVERIFIED',requires_authenticated_retrieval:true};}

async function reconcileAcknowledgements(tx:Session,p:Principal):Promise<void>{
 await tx.query("UPDATE hyperfide.observability_notifications n SET state='ACKNOWLEDGED',state_version=n.state_version+1 FROM hyperfide.event_deliveries d WHERE n.organisation_id=$1 AND n.run_id=$2 AND n.state='ENQUEUED' AND d.organisation_id=n.organisation_id AND d.run_id=n.run_id AND d.event_id=n.event_id AND d.consumer_id=n.target_consumer_id AND d.state='ACKNOWLEDGED'",[p.organisation_id,p.run_id]);
}
export async function bindRecipient(tx:Session,p:Principal,input:unknown,outbox:Outbox,invocation:unknown):Promise<unknown>{
 const v=object(input,['target_session_id','target_consumer_id']),session=uuid(v.target_session_id),consumer=uuid(v.target_consumer_id);
 recipientAccess(p,session);
 const bound=await outbox.bindSessionConsumer(tx,{organisation_id:p.organisation_id,run_id:p.run_id,session_id:session,consumer_id:consumer,namespace:'fleet_notification'},invocation);
 return {registered:true,replayed:bound.replayed,session_id:bound.session_id,consumer_id:bound.consumer_id,registrar_actor_id:bound.registered_actor_id};
}

export async function enqueueNotice(tx:Session,p:Principal,input:unknown,knownSecrets:readonly string[]=[]):Promise<unknown>{
 if(!['OPERATOR','COORDINATOR','RUNNER','PROVISIONER','DISPATCH','LEADER','FEATURE_MANAGER'].includes(p.role))fail('NOTIFICATION_PRODUCER_FORBIDDEN','A trusted supervisory producer must emit fleet exceptions');
 const v=object(input,['id','target_session_id','target_consumer_id','dedup_key','severity','code','untrusted_summary','action_code','artifact_id']);
 const id=uuid(v.id),target=uuid(v.target_session_id),consumer=uuid(v.target_consumer_id),key=digest(v.dedup_key),severity=text(v.severity),code=text(v.code,64),summary=rejectCredentialSummary(v.untrusted_summary,knownSecrets),action=text(v.action_code),artifact=uuid(v.artifact_id);
 if(!['INFO','WARNING','ERROR','CRITICAL'].includes(severity)||!/^[A-Z][A-Z0-9_]{0,63}$/.test(code)||!ACTIONS.includes(action))fail('OBSERVABILITY_INPUT_INVALID','Typed notification severity, code or action is invalid');
 await lockRun(tx,p,'notifications');await reconcileAcknowledgements(tx,p);
 const session=await tx.query("SELECT id,role,state,sandbox_boot_generation FROM hyperfide.agent_sessions WHERE organisation_id=$1 AND run_id=$2 AND id=$3 AND role IN ('LEADER','FEATURE_MANAGER') AND state IN ('REGISTERED','RUNNING','DISCONNECTED') FOR SHARE",[p.organisation_id,p.run_id,target]);
 if(session.rows.length!==1)fail('NOTIFICATION_RECIPIENT_INVALID','An identified current leader or feature manager session is required');
 const registered=await tx.query("SELECT id FROM hyperfide.event_consumers WHERE organisation_id=$1 AND run_id=$2 AND id=$3 AND consumer_key=$4 AND state IN ('ACTIVE','BUFFERING') FOR SHARE",[p.organisation_id,p.run_id,consumer,'session:'+target+':fleet_notification']);
 const binding=await tx.query('SELECT consumer_id FROM hyperfide.event_session_bindings WHERE organisation_id=$1 AND run_id=$2 AND consumer_id=$3 AND session_id=$4 AND namespace=\'fleet_notification\'',[p.organisation_id,p.run_id,consumer,target]);
 if(registered.rows.length!==1||binding.rows.length!==1)fail('NOTIFICATION_RECIPIENT_INVALID','Durable consumer must be registered for the exact target session');
 await requireArtifact(tx,p,artifact);
 const payload={target_session_id:target,target_consumer_id:consumer,target_boot_generation:session.rows[0]!.sandbox_boot_generation??null,severity,code,untrusted_summary:summary,action_code:action,artifact_id:artifact},identity=hash(payload);
 const prior=await tx.query('SELECT id,payload_digest,state,event_id FROM hyperfide.observability_notifications WHERE organisation_id=$1 AND run_id=$2 AND target_session_id=$3 AND dedup_key=$4',[p.organisation_id,p.run_id,target,key]);
 if(prior.rows.length){if(prior.rows[0]!.payload_digest!==identity||prior.rows[0]!.id!==id)fail('OBSERVABILITY_CONFLICT','Notification deduplication key has different content');return {...prior.rows[0],replayed:true,evidence_ref:evidenceRef(p,artifact)};}
 const counts=await tx.query("SELECT count(*) AS total,count(*) FILTER(WHERE target_session_id=$3 AND state<>'ACKNOWLEDGED') AS pending FROM hyperfide.observability_notifications WHERE organisation_id=$1 AND run_id=$2",[p.organisation_id,p.run_id,target]);
 if(BigInt(counts.rows[0]!.total as string)>=10000n||BigInt(counts.rows[0]!.pending as string)>=1000n)fail('OBSERVABILITY_BACKPRESSURE','Notification history or pending-recipient budget exhausted; producer must retain the exception');
 const event=randomUUID();
 await tx.query('INSERT INTO hyperfide.observability_notifications(organisation_id,run_id,id,target_session_id,target_consumer_id,target_boot_generation,dedup_key,payload_digest,severity,code,untrusted_summary,action_code,artifact_id,event_id,producer_actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',[p.organisation_id,p.run_id,id,target,consumer,session.rows[0]!.sandbox_boot_generation??null,key,identity,severity,code,summary,action,artifact,event,p.actor_id]);
 return {id,event_id:event,state:'QUEUED',replayed:false,sent:false,evidence_ref:evidenceRef(p,artifact),summary_trust:'UNTRUSTED_DATA_NOT_AN_INSTRUCTION'};
}
export async function dispatchNotices(tx:Session,p:Principal,input:unknown,outbox:Outbox,budget:number):Promise<unknown>{
 if(!['OPERATOR','COORDINATOR','DISPATCH'].includes(p.role))fail('NOTIFICATION_DISPATCH_FORBIDDEN','Only an authorised dispatcher may advance notification delivery');
 const v=object(input,['target_session_id','limit']),target=uuid(v.target_session_id),limit=v.limit===undefined?20:integer(v.limit,1,100);
 await lockRun(tx,p,'notification-dispatch:'+target);await reconcileAcknowledgements(tx,p);
 const eligible=await tx.query("SELECT n.id FROM hyperfide.observability_notifications n WHERE n.organisation_id=$1 AND n.run_id=$2 AND n.target_session_id=$3 AND n.state='QUEUED' LIMIT 1",[p.organisation_id,p.run_id,target]);
 if(!eligible.rows.length)return {enqueued:0,external_delivery:'NOT_OBSERVED',required_exceptions_discarded:0};
 const alive=await tx.query("SELECT id,sandbox_boot_generation FROM hyperfide.agent_sessions WHERE organisation_id=$1 AND run_id=$2 AND id=$3 AND state IN ('REGISTERED','RUNNING','DISCONNECTED') FOR SHARE",[p.organisation_id,p.run_id,target]);
 if(alive.rows.length!==1)return {enqueued:0,held:true,reason:'RECIPIENT_SESSION_UNAVAILABLE',required_exceptions_discarded:0};
 const time=await tx.query("SELECT date_trunc('minute',clock_timestamp()) AS window_start"),window=time.rows[0]!.window_start;
 await tx.query('INSERT INTO hyperfide.observability_notification_budgets(organisation_id,run_id,target_session_id,window_start,page_count) VALUES($1,$2,$3,$4,0) ON CONFLICT DO NOTHING',[p.organisation_id,p.run_id,target,window]);
 await tx.query('DELETE FROM hyperfide.observability_notification_budgets WHERE organisation_id=$1 AND run_id=$2 AND target_session_id=$3 AND window_start<$4',[p.organisation_id,p.run_id,target,window]);
 const used=await tx.query('SELECT page_count FROM hyperfide.observability_notification_budgets WHERE organisation_id=$1 AND run_id=$2 AND target_session_id=$3 AND window_start=$4 FOR UPDATE',[p.organisation_id,p.run_id,target,window]);
 const remaining=Math.max(0,budget-Number(used.rows[0]!.page_count));if(!remaining)return {enqueued:0,held:true,reason:'PAGE_BUDGET_EXHAUSTED',retry_after:new Date(new Date(window as Date).getTime()+60000).toISOString(),required_exceptions_discarded:0};
 const notices=await tx.query("SELECT * FROM hyperfide.observability_notifications WHERE organisation_id=$1 AND run_id=$2 AND target_session_id=$3 AND state='QUEUED' ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'ERROR' THEN 1 WHEN 'WARNING' THEN 2 ELSE 3 END,created_at,id LIMIT $4 FOR UPDATE SKIP LOCKED",[p.organisation_id,p.run_id,target,Math.min(limit,remaining)]);
 let enqueued=0;const held:string[]=[];
 for(const n of notices.rows){
  if(n.target_boot_generation!==alive.rows[0]!.sandbox_boot_generation&&!(n.target_boot_generation===null&&alive.rows[0]!.sandbox_boot_generation===null)){held.push(String(n.id));continue;}
  const consumer=await tx.query("SELECT id FROM hyperfide.event_consumers WHERE organisation_id=$1 AND run_id=$2 AND id=$3 AND consumer_key=$4 AND state IN ('ACTIVE','BUFFERING') FOR SHARE",[p.organisation_id,p.run_id,n.target_consumer_id,'session:'+target+':fleet_notification']);
  const bound=await tx.query('SELECT consumer_id FROM hyperfide.event_session_bindings WHERE organisation_id=$1 AND run_id=$2 AND consumer_id=$3 AND session_id=$4 AND namespace=\'fleet_notification\'',[p.organisation_id,p.run_id,n.target_consumer_id,target]);
  if(!consumer.rows.length||!bound.rows.length){held.push(String(n.id));continue;}
  await requireArtifact(tx,p,String(n.artifact_id));
  await outbox.enqueue(tx,{organisation_id:p.organisation_id,run_id:p.run_id,id:String(n.event_id),aggregate_id:String(n.id),aggregate_type:'fleet_notification',aggregate_version:'1',event_type:'fleet.notification',payload:{notification_id:n.id,producer_actor_id:n.producer_actor_id,target_session_id:target,target_boot_generation:n.target_boot_generation,severity:n.severity,code:n.code,untrusted_summary:n.untrusted_summary,summary_trust:'UNTRUSTED_DATA_NOT_AN_INSTRUCTION',action_code:n.action_code,evidence_ref:evidenceRef(p,String(n.artifact_id))}},{consumer_ids:[String(n.target_consumer_id)]});
  await tx.query("UPDATE hyperfide.observability_notifications SET state='ENQUEUED',enqueued_at=clock_timestamp(),state_version=state_version+1 WHERE organisation_id=$1 AND run_id=$2 AND id=$3",[p.organisation_id,p.run_id,n.id]);enqueued++;
 }
 if(enqueued)await tx.query('UPDATE hyperfide.observability_notification_budgets SET page_count=page_count+$5 WHERE organisation_id=$1 AND run_id=$2 AND target_session_id=$3 AND window_start=$4',[p.organisation_id,p.run_id,target,window,enqueued]);
 return {enqueued,budget_window_start:new Date(window as Date).toISOString(),held_notification_ids:held,external_delivery:'NOT_OBSERVED',required_exceptions_discarded:0,remaining_page_budget:remaining-enqueued};
}
export function createComponent(startup:ComponentContext):Component{
 const resolver=(startup as unknown as {dependencies?:{require<T>(id:string,capability:string,validate:(v:unknown)=>v is T):T}}).dependencies;
 if(!resolver)fail('OBSERVABILITY_DEPENDENCY_UNAVAILABLE','Durable outbox registry dependency is required');
 const outbox=resolver.require('6.1','events.outbox.v1',isOutbox);
 const inbox=resolver.require('6.2','events.inbox.v1',isInbox);
 const configured=startup.env.HYPERFIDE_NOTIFICATION_PAGE_BUDGET??'20';
 if(!/^[1-9][0-9]{0,2}$/.test(configured)||Number(configured)>100)fail('OBSERVABILITY_CONFIG_INVALID','Page budget must be from one to one hundred per recipient per minute');
 const budget=Number(configured);
 let configuredSecrets:unknown=[];
 try{configuredSecrets=JSON.parse(startup.env.HYPERFIDE_NOTIFICATION_REDACTION_SECRETS??'[]');}catch{fail('OBSERVABILITY_CONFIG_INVALID','Invalid private redaction configuration');}
 if(!Array.isArray(configuredSecrets)||configuredSecrets.length>128||configuredSecrets.some(s=>typeof s!=='string'||s.length<8||s.length>65536))fail('OBSERVABILITY_CONFIG_INVALID','Bounded private redaction secrets required');
 const knownSecrets=Object.freeze([...new Set([...(configuredSecrets as string[]),...Object.entries(startup.env).filter(([key,value])=>/(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY)/i.test(key)&&typeof value==='string'&&value.length>=8&&value.length<=65536&&key!=='HYPERFIDE_NOTIFICATION_REDACTION_SECRETS').map(([,value])=>value!)])]);
 if(knownSecrets.length>128)fail('OBSERVABILITY_CONFIG_INVALID','Private redaction secret count exceeds budget');
 return {apiVersion:1,actions:{
 'fleet.notifications.describe':async input=>{object(input,[]);return {schema_version:1,page_budget_per_recipient_per_minute:budget,pending_limit_per_recipient:1000,total_history_limit:10000,summary_trust:'UNTRUSTED_DATA',delivery_semantics:'DURABLE_TARGETED_OUTBOX_NOT_EXTERNAL_SEND',backpressure:'REFUSE_WITHOUT_ACKNOWLEDGING_EXCEPTION'};},
 'fleet.notifications.bootstrap-recipient':(input,ctx)=>authority(ctx,'fleet.notifications.bootstrap-recipient',(tx,p)=>bootstrapRecipient(tx,p,input,inbox)),
 'fleet.notifications.bind-recipient':(input,ctx)=>authority(ctx,'fleet.notifications.bind-recipient',(tx,p)=>bindRecipient(tx,p,input,outbox,(ctx as unknown as {invocation:unknown}).invocation)),
 'fleet.notifications.enqueue':(input,ctx)=>authority(ctx,'fleet.notifications.enqueue',(tx,p)=>enqueueNotice(tx,p,input,knownSecrets)),
 'fleet.notifications.dispatch':(input,ctx)=>authority(ctx,'fleet.notifications.dispatch',(tx,p)=>dispatchNotices(tx,p,input,outbox,budget)),
 'fleet.notifications.inspect':(input,ctx)=>authority(ctx,'fleet.notifications.inspect',async(tx,p)=>{const v=object(input,['target_session_id','limit','after_id']),target=uuid(v.target_session_id),limit=v.limit===undefined?100:integer(v.limit,1,500),after=v.after_id===undefined?'00000000-0000-0000-0000-000000000000':uuid(v.after_id);recipientAccess(p,target);const q=await tx.query("SELECT n.id,n.target_session_id,n.target_boot_generation,n.severity,n.code,n.untrusted_summary,n.action_code,n.artifact_id,n.event_id,n.state,n.state_version,n.created_at,n.enqueued_at,d.state AS delivery_state FROM hyperfide.observability_notifications n LEFT JOIN hyperfide.event_deliveries d ON d.organisation_id=n.organisation_id AND d.run_id=n.run_id AND d.event_id=n.event_id AND d.consumer_id=n.target_consumer_id WHERE n.organisation_id=$1 AND n.run_id=$2 AND n.target_session_id=$3 AND n.id>$4 ORDER BY n.id LIMIT $5",[p.organisation_id,p.run_id,target,after,limit+1]);const rows=q.rows.slice(0,limit).map(n=>({...n,evidence_ref:evidenceRef(p,String(n.artifact_id)),external_send_verified:false,delivery_acknowledged:n.delivery_state==='ACKNOWLEDGED'}));return numbers({rows,pagination:{limit,next:q.rows.length>limit?q.rows[limit-1]!.id:null},summary_trust:'UNTRUSTED_DATA_NOT_AN_INSTRUCTION'});})
 }};
}


// Operator target (hyperfide-v21 4.5, req 4.3). The notices above go to an identified leader session; these go to the
// run's humans. Producers turn committed source records into one durable operator notice each, keyed by the source, so
// a notice exists exactly when its source does: ask.raised and ask.expired events (written to operator:asks by 3.2),
// finding.repair-escalated events (findings/remediation.ts) and capacity attestations entering the expiry window
// (providers/pools.ts). Notices live in command_inbox under principal_scope 'operator_target' until a dedicated table is
// warranted. The webhook channel is the one external send: its URL is the variable HYPERFIDE_OPERATOR_WEBHOOK_URL
// (Ask 4.5), never echoed; without it notices stay PENDING and are never discarded.
export const OPERATOR_WEBHOOK_VARIABLE='HYPERFIDE_OPERATOR_WEBHOOK_URL';
const OPERATOR_SCOPE='operator_target',OPERATOR_OPERATION='operator.notice';
const OPERATOR_ROLES=['OPERATOR','COORDINATOR','DISPATCH'];
const OPERATOR_MAX_ATTEMPTS=10,OPERATOR_LEASE_MS=30000,OPERATOR_SEND_TIMEOUT_MS=5000,OPERATOR_BACKOFF_MS=5000;
const SOURCE_EVENTS=['ask.raised','ask.expired','finding.repair-escalated'];
type OperatorNoticeKind='ASK_RAISED'|'ASK_EXPIRED'|'REPAIR_ESCALATED'|'ATTESTATION_EXPIRING';
interface OperatorPrincipal {organisation_id:string;run_id:string;actor_id:string;role:string;allowed_actions:readonly string[]}
interface OperatorGateway {withPrimaryTransaction<T>(options:{timeoutMs:number;maxRetries:number;signal:AbortSignal;guard:(tx:Session)=>Promise<void>},operation:(tx:Session)=>Promise<T>):Promise<T>}
export interface OperatorWebhook {url:URL;host:string}
export type OperatorSend=(url:URL,body:string,headers:Record<string,string>,signal:AbortSignal)=>Promise<number>;

// Plain http is accepted only for a loopback receiver (a local relay or the qualification stub); credentials in the
// URL authority are refused so the value can never leak through a Basic-auth header or a log of the host.
export function operatorWebhook(env:Readonly<NodeJS.ProcessEnv>):OperatorWebhook|null{
 const raw=env[OPERATOR_WEBHOOK_VARIABLE];
 if(raw===undefined||raw==='')return null;
 let url:URL;
 try{url=new URL(raw);}catch{return fail('OBSERVABILITY_CONFIG_INVALID',OPERATOR_WEBHOOK_VARIABLE+' is not a URL');}
 const loopback=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
 if(raw.length>2048||url.username||url.password||url.hash||!(url.protocol==='https:'||url.protocol==='http:'&&loopback))
  fail('OBSERVABILITY_CONFIG_INVALID',OPERATOR_WEBHOOK_VARIABLE+' must be an https URL (http only for loopback) without credentials or fragment');
 return {url,host:url.host};
}
const CREDENTIAL_SHAPED=/\b(?:bearer|basic)\s+\S{4,}|-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|authorization)\s*[:=]\s*\S+|\b(?:gh[pousr]_|github_pat_|sk-(?:proj-)?)[A-Za-z0-9_-]{8,}|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/i;
// Agent-written text (an Ask title) leaves the system here, so credential-shaped content is withheld rather than sent.
function outbound(value:unknown,knownSecrets:readonly string[],max=256):string|null{
 if(typeof value!=='string')return null;
 if(CREDENTIAL_SHAPED.test(value)||knownSecrets.some(s=>value.includes(s)))return '[withheld: credential-shaped content]';
 return value.replace(/[\x00-\x1f\x7f]/g,' ').slice(0,max);
}
interface DraftNotice {key:string;kind:OperatorNoticeKind;severity:'INFO'|'WARNING'|'ERROR';action_code:string;source:Record<string,unknown>;subject:Record<string,unknown>;summary:string}
type SourceEvent={id:string;event_type:string;payload:Record<string,any>};
function askNotice(event:SourceEvent,knownSecrets:readonly string[]):DraftNotice|null{
 const ask=event.payload?.ask;
 if(!ask||typeof ask!=='object'||typeof ask.ask_id!=='string')return null;
 const blocking=ask.default_policy==='block',raised=event.event_type==='ask.raised',title=outbound(ask.title,knownSecrets);
 const subject={ask_id:ask.ask_id,ask_kind:ask.kind,title,default_policy:ask.default_policy,deadline:ask.deadline??null,state:ask.state,
  task:ask.task??null,attempt:ask.attempt??null,session:ask.session??null,
  options:Array.isArray(ask.options)?ask.options.slice(0,16).map((o:unknown)=>outbound(o,knownSecrets,128)):[],
  recommended:outbound(ask.recommended,knownSecrets,128),decided_by_default:ask.decided_by_default===true,
  default_answer:!raised&&ask.decided_by_default===true?outbound(ask.answer,knownSecrets,128):null,state_version:String(ask.state_version)};
 const source={type:'OUTBOX_EVENT',event_id:event.id,event_type:event.event_type};
 if(raised)return {key:event.id,kind:'ASK_RAISED',severity:blocking?'WARNING':'INFO',action_code:'ANSWER_ASK',source,subject,
  summary:(blocking?'Blocking ':'')+String(ask.kind)+' Ask raised: '+title};
 return {key:event.id,kind:'ASK_EXPIRED',severity:blocking?'ERROR':'WARNING',action_code:blocking?'ANSWER_ASK':'REVIEW_DEFAULT',source,subject,
  summary:blocking?String(ask.kind)+' Ask passed its deadline and still blocks: '+title:String(ask.kind)+' Ask expired; the recommended option was taken by default: '+title};
}
function repairNotice(event:SourceEvent,knownSecrets:readonly string[]):DraftNotice|null{
 const p=event.payload;
 if(!p||typeof p.finding_id!=='string'||typeof p.repair_id!=='string')return null;
 return {key:event.id,kind:'REPAIR_ESCALATED',severity:'ERROR',action_code:'DECIDE_REPAIR',source:{type:'OUTBOX_EVENT',event_id:event.id,event_type:event.event_type},
  subject:{finding_id:p.finding_id,repair_id:p.repair_id,reason:outbound(p.reason,knownSecrets),registry_version:p.registry_version??null},
  summary:'Repair escalated after its attempt budget for finding '+p.finding_id};
}
function attestationNotice(w:AttestationExpiryWarning):DraftNotice{
 // EXPIRING and LAPSED are distinct notices, so a lapse is reported even when the expiring warning was delivered.
 return {key:'attestation:'+w.attestation_id+':'+w.state,kind:'ATTESTATION_EXPIRING',severity:w.severity,action_code:w.action,source:{type:'CAPACITY_ATTESTATION',attestation_id:w.attestation_id},
  subject:{...w},summary:'Capacity attestation '+(w.state==='LAPSED'?'lapsed':'expires '+w.expires_at)+' for pool '+w.pool_id+' '+w.scope_kind+' '+w.dimension};
}
function operatorPrincipal(context:ComponentContext,action:string):OperatorPrincipal{
 const p=invocationOf(context).principal as unknown as OperatorPrincipal;
 if(!p||!Array.isArray(p.allowed_actions)||!p.allowed_actions.includes(action)||p.run_id!==context.policy.programme_id)fail('AUTHENTICATION_REQUIRED','Authenticated run-scoped invocation required');
 if(!OPERATOR_ROLES.includes(p.role))fail('NOTIFICATION_OPERATOR_FORBIDDEN','Role '+p.role+' cannot perform '+action);
 return p;
}
function operatorTransaction<T>(context:ComponentContext,p:OperatorPrincipal,operation:(tx:Session)=>Promise<T>):Promise<T>{
 const gateway=context.dependencies.require('4.2','storage.transactions.v1',(v:unknown):v is OperatorGateway=>!!v&&typeof (v as OperatorGateway).withPrimaryTransaction==='function');
 const invocation=invocationOf(context);
 return gateway.withPrimaryTransaction({timeoutMs:10000,maxRetries:2,signal:invocation.signal??context.signal,guard:tx=>invocation.guard(tx as never)},async tx=>{
  await lockRun(tx,p as unknown as Principal,'operator-target');return operation(tx);
 });
}
function noticeView(row:Record<string,any>):Record<string,unknown>{
 const r=row.result??{},d=r.delivery??{};
 return {...r.notice,state:row.state==='COMPLETED'?'DELIVERED':row.state==='FAILED'?'FAILED':'PENDING',attempts:d.attempts??0,next_attempt_at:d.next_attempt_at??null,
  last_status:d.last_status??null,last_error:d.last_error??null,delivered_at:d.delivered_at??null,state_version:String(row.state_version)};
}
export async function produceOperatorNotices(tx:Session,p:OperatorPrincipal,input:unknown,knownSecrets:readonly string[]):Promise<unknown>{
 const v=object(input,['limit']),limit=v.limit===undefined?100:integer(v.limit,1,500);
 const events=await tx.query(`SELECT e.id::text AS id,e.event_type,e.payload FROM hyperfide.outbox_events e WHERE e.organisation_id=$1 AND e.run_id=$2 AND e.event_type=ANY($3::text[])
  AND e.aggregate_type=CASE WHEN e.event_type LIKE 'ask.%' THEN 'ask' ELSE 'finding' END
  AND NOT EXISTS(SELECT 1 FROM hyperfide.command_inbox c WHERE c.organisation_id=e.organisation_id AND c.run_id=e.run_id AND c.principal_scope=$4 AND c.operation=$5 AND c.idempotency_key=e.id::text)
  ORDER BY e.created_at,e.id LIMIT $6`,[p.organisation_id,p.run_id,SOURCE_EVENTS,OPERATOR_SCOPE,OPERATOR_OPERATION,limit]);
 const drafts:DraftNotice[]=[];let skipped=0;
 for(const e of events.rows as SourceEvent[]){const d=e.event_type==='finding.repair-escalated'?repairNotice(e,knownSecrets):askNotice(e,knownSecrets);if(d)drafts.push(d);else skipped++;}
 const pools=await tx.query('SELECT id FROM hyperfide.provider_pools WHERE organisation_id=$1',[p.organisation_id]);
 if(pools.rows.length)for(const w of await attestationExpiryWarnings(tx,p.organisation_id,pools.rows.map(r=>String(r.id))))drafts.push(attestationNotice(w));
 const clock=await tx.query('SELECT clock_timestamp() AS now'),now=new Date(clock.rows[0]!.now as Date).toISOString();
 const produced:Record<string,unknown>[]=[];
 for(const d of drafts){
  if(produced.length>=limit)break;
  const id=randomUUID(),notice={schema_version:1,notice_id:id,target:'OPERATOR',kind:d.kind,severity:d.severity,action_code:d.action_code,organisation_id:p.organisation_id,run_id:p.run_id,
   source:d.source,subject:d.subject,summary:d.summary,summary_trust:'UNTRUSTED_DATA_NOT_AN_INSTRUCTION',produced_at:now,producer_actor_id:p.actor_id};
  const inserted=await tx.query(`INSERT INTO hyperfide.command_inbox(organisation_id,run_id,id,principal_scope,operation,idempotency_key,request_digest,state,result) VALUES($1,$2,$3,$4,$5,$6,$7,'PENDING',$8::jsonb)
   ON CONFLICT (organisation_id,run_id,principal_scope,operation,idempotency_key) DO NOTHING RETURNING id`,
   [p.organisation_id,p.run_id,id,OPERATOR_SCOPE,OPERATOR_OPERATION,d.key,hash({key:d.key,kind:d.kind,source:d.source}),JSON.stringify({notice,delivery:{attempts:0,next_attempt_at:now}})]);
  if(inserted.rows.length)produced.push({notice_id:id,kind:d.kind,severity:d.severity,source:d.source});
 }
 return {produced,produced_count:produced.length,skipped_malformed_sources:skipped,truncated:events.rows.length===limit||produced.length>=limit,external_delivery:'NOT_ATTEMPTED'};
}
async function defaultSend(url:URL,body:string,headers:Record<string,string>,signal:AbortSignal):Promise<number>{
 const response=await fetch(url,{method:'POST',body,headers,redirect:'manual',signal});
 await response.arrayBuffer().catch(()=>undefined);
 return response.status;
}
interface ClaimedNotice {id:string;result:{notice:Record<string,unknown>;delivery:{attempts?:number}}}
export async function deliverOperatorNotices(context:ComponentContext,p:OperatorPrincipal,input:unknown,webhook:OperatorWebhook|null,send:OperatorSend=defaultSend):Promise<unknown>{
 const v=object(input,['limit']),limit=v.limit===undefined?20:integer(v.limit,1,50);
 if(!webhook)return {delivered:0,failed:0,retrying:0,held:true,reason:'OPERATOR_WEBHOOK_NOT_CONFIGURED',variable:OPERATOR_WEBHOOK_VARIABLE,discarded:0};
 const lease=randomUUID();
 // Claim, send outside any transaction, then record: a crash in between leaves a lease that expires into a retry,
 // so delivery is at least once and receivers deduplicate on Hyperfide-Notice-Id.
 const claimed=await operatorTransaction(context,p,async tx=>{
  const rows=await tx.query(`SELECT id,result FROM hyperfide.command_inbox WHERE organisation_id=$1 AND run_id=$2 AND principal_scope=$3 AND operation=$4 AND state='PENDING'
   AND (result->'delivery'->>'next_attempt_at')::timestamptz<=clock_timestamp() AND coalesce((result->'delivery'->>'lease_until')::timestamptz<=clock_timestamp(),true)
   ORDER BY CASE result->'notice'->>'severity' WHEN 'ERROR' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END,created_at,id LIMIT $5 FOR UPDATE SKIP LOCKED`,
   [p.organisation_id,p.run_id,OPERATOR_SCOPE,OPERATOR_OPERATION,limit]);
  for(const r of rows.rows)await tx.query(`UPDATE hyperfide.command_inbox SET result=jsonb_set(result,'{delivery}',(result->'delivery')||jsonb_build_object('lease_id',$4::text,'lease_until',clock_timestamp()+make_interval(secs=>$5))),state_version=state_version+1
   WHERE organisation_id=$1 AND run_id=$2 AND id=$3`,[p.organisation_id,p.run_id,r.id,lease,OPERATOR_LEASE_MS/1000]);
  return rows.rows as ClaimedNotice[];
 });
 const outcomes=await Promise.all(claimed.map(async row=>{
  const attempt=(row.result.delivery.attempts??0)+1,notice=row.result.notice,body=JSON.stringify({...notice,delivery_attempt:attempt});
  try{
   const status=await send(webhook.url,body,{'Content-Type':'application/json','Hyperfide-Notice-Id':String(notice.notice_id),'Hyperfide-Notice-Kind':String(notice.kind)},AbortSignal.timeout(OPERATOR_SEND_TIMEOUT_MS));
   return {row,attempt,status:status as number|null,error:status>=200&&status<300?null:'HTTP_'+status};
  }catch(e){return {row,attempt,status:null,error:(e as Error)?.name==='TimeoutError'?'TIMEOUT':'NETWORK_ERROR'};}
 }));
 return operatorTransaction(context,p,async tx=>{
  let delivered=0,failed=0,retrying=0;const results:Record<string,unknown>[]=[];
  for(const o of outcomes){
   const ok=o.error===null,exhausted=!ok&&o.attempt>=OPERATOR_MAX_ATTEMPTS,backoff=Math.min(OPERATOR_BACKOFF_MS*2**(o.attempt-1),300000),state=ok?'COMPLETED':exhausted?'FAILED':'PENDING';
   const updated=await tx.query(`UPDATE hyperfide.command_inbox SET state=$5,result=jsonb_set(result,'{delivery}',((result->'delivery')-'lease_id'-'lease_until')||jsonb_build_object('attempts',$6::int,'last_status',$7::int,'last_error',$8::text,
     'last_attempt_at',clock_timestamp(),'next_attempt_at',CASE WHEN $9::boolean THEN NULL ELSE clock_timestamp()+make_interval(secs=>$10) END,'delivered_at',CASE WHEN $11::boolean THEN clock_timestamp() ELSE NULL END)),state_version=state_version+1
    WHERE organisation_id=$1 AND run_id=$2 AND id=$3 AND state='PENDING' AND result->'delivery'->>'lease_id'=$4 RETURNING id`,
    [p.organisation_id,p.run_id,o.row.id,lease,state,o.attempt,o.status,o.error,ok||exhausted,backoff/1000,ok]);
   if(!updated.rows.length)continue;
   if(ok)delivered++;else if(exhausted)failed++;else retrying++;
   results.push({notice_id:o.row.result.notice.notice_id,kind:o.row.result.notice.kind,state:ok?'DELIVERED':exhausted?'FAILED':'PENDING',attempts:o.attempt,last_status:o.status,last_error:o.error});
  }
  return {delivered,failed,retrying,results,webhook_host:webhook.host,held:false,discarded:0};
 });
}
export async function listOperatorNotices(tx:Session,p:OperatorPrincipal,input:unknown):Promise<unknown>{
 const v=object(input,['state','limit']),limit=v.limit===undefined?100:integer(v.limit,1,500);
 const state=v.state===undefined||v.state===null?null:text(v.state,16);
 if(state!==null&&!['PENDING','DELIVERED','FAILED'].includes(state))fail('OBSERVABILITY_INPUT_INVALID','Operator notice state filter is unknown');
 const stored=state===null?null:state==='DELIVERED'?'COMPLETED':state;
 const rows=await tx.query('SELECT id,state,result,state_version FROM hyperfide.command_inbox WHERE organisation_id=$1 AND run_id=$2 AND principal_scope=$3 AND operation=$4 AND ($5::text IS NULL OR state=$5) ORDER BY created_at,id LIMIT $6',
  [p.organisation_id,p.run_id,OPERATOR_SCOPE,OPERATOR_OPERATION,stored,limit+1]);
 return numbers({notices:rows.rows.slice(0,limit).map(noticeView),truncated:rows.rows.length>limit,summary_trust:'UNTRUSTED_DATA_NOT_AN_INSTRUCTION'});
}
// Registered as components/4.5-operator.json; it needs only storage (4.2), not the leader-recipient machinery of 23.4.
export function createOperatorComponent(startup:ComponentContext,send?:OperatorSend):Component{
 const webhook=operatorWebhook(startup.env);
 const knownSecrets=Object.freeze(Object.entries(startup.env).filter(([key,value])=>/(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY)/i.test(key)&&typeof value==='string'&&value.length>=8&&value.length<=65536).map(([,value])=>value!).slice(0,128));
 return {apiVersion:1,actions:{
  'fleet.notifications.operator.describe':async input=>{object(input,[]);return {schema_version:1,target:'OPERATOR',channel:'WEBHOOK',variable:OPERATOR_WEBHOOK_VARIABLE,configured:webhook!==null,webhook_host:webhook?.host??null,
   producers:['ASK_RAISED','ASK_EXPIRED','REPAIR_ESCALATED','ATTESTATION_EXPIRING'],max_attempts:OPERATOR_MAX_ATTEMPTS,delivery_semantics:'AT_LEAST_ONCE_DEDUPLICATE_ON_NOTICE_ID',unconfigured:'HOLD_PENDING_NEVER_DISCARD'};},
  'fleet.notifications.operator.produce':(input,ctx)=>{const p=operatorPrincipal(ctx,'fleet.notifications.operator.produce');return operatorTransaction(ctx,p,tx=>produceOperatorNotices(tx,p,input,knownSecrets));},
  'fleet.notifications.operator.deliver':(input,ctx)=>deliverOperatorNotices(ctx,operatorPrincipal(ctx,'fleet.notifications.operator.deliver'),input,webhook,send),
  'fleet.notifications.operator.list':(input,ctx)=>{const p=operatorPrincipal(ctx,'fleet.notifications.operator.list');return operatorTransaction(ctx,p,tx=>listOperatorNotices(tx,p,input));}
 }};
}
