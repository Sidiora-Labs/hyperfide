import { randomUUID } from 'node:crypto';
import type { ComponentContext } from '../components/registry.js';
import type { PrimaryTransaction, TransactionGateway } from '../storage/transactions.js';
import type { InvocationContext } from '../transport/protocol.js';
import { object } from '../policy/programme.js';
import { fields,scope,uuid,integer,bounded,canonical,digest,fail,authorizedRun,lockRun,requireInvocation } from './outbox.js';
import { instruction,instructionRecipient,runnerMatches,registerRunnerConsumer,handoff,recordRunnerAcknowledgement } from './instructions.js';
import { pollRunnerCommands } from './runner_commands.js';
import { classifyNativeEvent } from '../agents/admission.js';
import { nativeAskRequests,raiseNativeAsks } from '../agents/native_asks.js';
import type { RaisedNativeAsk } from '../agents/native_asks.js';

// Authenticated coordinator API binding for runner-facing command operations.
// Every handler derives organisation/run, sandbox, boot and boot generation from
// the authenticated RUNNER principal and attempt/generation/epoch from durable
// rows; caller-supplied identity is only ever compared, never trusted.
type Action=(input:unknown,context:ComponentContext)=>Promise<unknown>|unknown;

async function nativeInvocation<T>(g:TransactionGateway,context:ComponentContext,input:unknown,
    operation:'HANDOFF'|'ACK',apply:(tx:PrimaryTransaction,invocation:InvocationContext)=>Promise<T>):Promise<T> {
  const invocation=requireInvocation(context,input,['RUNNER']);
  return g.withPrimaryTransaction({timeoutMs:10000,maxRetries:3,signal:invocation.signal,guard:tx=>invocation.identityGuard(tx)},async tx=>{
    const v=input as Record<string,unknown>,s=scope(v),id=uuid(operation==='HANDOFF'?v.event_id:v.command_id);
    const row=(await tx.query("SELECT * FROM hyperfide.outbox_events WHERE organisation_id=$1 AND run_id=$2 AND id=$3 AND aggregate_type='attempt.instructions'",
      [s.organisation_id,s.run_id,id])).rows[0];
    if(!row)fail('INSTRUCTION_EVENT_INVALID','Native cleanup requires an already committed exact instruction');
    const p=row.payload as Record<string,unknown>,i=instruction({...s,id:p.instruction_id,attempt_id:p.attempt_id,
      attempt_generation:p.attempt_generation,authority_epoch:p.authority_epoch,sandbox_boot_generation:p.sandbox_boot_generation,kind:p.kind,body:p.body}),
      target={sandbox_id:uuid(p.sandbox_id),boot_id:uuid(p.boot_id)};
    if(i.id!==id||i.attempt_id!==row.aggregate_id||row.event_type!=='instruction.'+i.kind.toLowerCase())
      fail('INSTRUCTION_EVENT_INVALID','Stored native instruction metadata is inconsistent');
    runnerMatches(invocation.principal,i,target);
    const consumer=await instructionRecipient(tx,s,target,i.sandbox_boot_generation,false);
    if(operation==='HANDOFF'&&uuid(v.consumer_id)!==consumer)fail('AUTH_SCOPE_DENIED','Handoff does not address the authenticated boot consumer');
    // The exception is selected only by immutable server state. ACKs report observations, never execution permission.
    if(operation==='HANDOFF'&&i.kind!=='CANCEL')await invocation.guard(tx);
    const result=await apply(tx,invocation);
    if(operation==='HANDOFF'&&i.kind!=='CANCEL')await invocation.guard(tx);else await invocation.identityGuard(tx);
    return result;
  });
}

// Structured event ingress (execution contract section 7). Events are data
// only: they are retained in the runner's receipt namespace, never in the
// instruction stream, so untrusted payload text cannot become a command.
export const RUNNER_EVENT_BOUNDS=Object.freeze({payload_bytes:16384,events_per_stream:4096});
const EVENT_FIELDS=['organisation_id','run_id','event_id','attempt_id','attempt_generation','authority_epoch','session_id',
  'sequence','observed_at','event_type','schema_version','payload','payload_digest','causation_id'] as const;
const LIVE=['PLANNED','RESERVED','PREPARING','START_REQUESTED','RUNNING'];
function observedAt(value:unknown):string {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(value)||Number.isNaN(Date.parse(value)))
    fail('EVENT_INPUT_INVALID','Local observation time must be a bounded UTC timestamp');
  return value;
}
export async function ingestRunnerEvent(g:TransactionGateway,context:ComponentContext,input:unknown):Promise<unknown> {
  const invocation=requireInvocation(context,input,['RUNNER']),p=invocation.principal;
  const v=fields(input,EVENT_FIELDS),s=scope(v);
  if(!p.sandbox_id||!p.boot_id||!p.boot_generation)
    fail('AUTH_SCOPE_DENIED','A genuine current sandbox boot is required for event ingress');
  if(typeof v.event_type!=='string'||!/^runner\.[a-z0-9][a-z0-9._-]{0,95}$/.test(v.event_type))
    fail('RUNNER_EVENT_TYPE_INVALID','Runner events use the bounded runner.* data namespace');
  if(!object(v.payload))fail('EVENT_INPUT_INVALID','Runner event payload must be a JSON object');
  if(Buffer.byteLength(canonical(v.payload))>RUNNER_EVENT_BOUNDS.payload_bytes)
    fail('RUNNER_EVENT_TOO_LARGE','Runner event payload exceeds the ingress bound');
  const e={...s,event_id:uuid(v.event_id),attempt_id:uuid(v.attempt_id),attempt_generation:integer(v.attempt_generation),
    authority_epoch:uuid(v.authority_epoch),session_id:uuid(v.session_id),sequence:integer(v.sequence),observed_at:observedAt(v.observed_at),
    event_type:v.event_type,schema_version:bounded(v.schema_version,1,1024),causation_id:v.causation_id===null?null:uuid(v.causation_id),
    sandbox_id:uuid(p.sandbox_id),boot_id:uuid(p.boot_id),sandbox_boot_generation:integer(p.boot_generation),payload_digest:digest(v.payload)};
  if(v.payload_digest!==e.payload_digest)fail('RUNNER_EVENT_DIGEST_MISMATCH','Payload hash does not match the canonical payload bytes');
  if(p.attempt_id!==null&&p.attempt_id!==e.attempt_id||p.attempt_generation!==null&&p.attempt_generation!==e.attempt_generation)
    fail('AUTH_SCOPE_DENIED','Authenticated runner is bound to a different attempt');
  const principal='runner:'+e.sandbox_id+':'+e.boot_id,stream=e.attempt_id+':'+e.attempt_generation,requestHash=digest({...e,payload:v.payload});
  return g.withPrimaryTransaction({timeoutMs:10000,maxRetries:3,signal:invocation.signal,guard:tx=>invocation.identityGuard(tx)},async tx=>{
    await lockRun(tx,s);
    // The attempt row lock serialises one producer stream's dedupe and cursor.
    const a=(await tx.query(`SELECT a.generation,a.authority_epoch,a.sandbox_id,a.sandbox_boot_generation,a.execution_state,
      t.current_attempt_id,t.generation AS current_generation,r.authority_epoch AS current_epoch,
      sb.boot_generation AS current_boot,b.boot_id AS attempt_boot_id
      FROM hyperfide.attempts a JOIN hyperfide.runs r ON(r.organisation_id=a.organisation_id AND r.id=a.run_id)
      JOIN hyperfide.tasks t ON(t.organisation_id=a.organisation_id AND t.run_id=a.run_id AND t.id=a.task_id)
      JOIN hyperfide.sandboxes sb ON(sb.organisation_id=a.organisation_id AND sb.id=a.sandbox_id)
      JOIN hyperfide.sandbox_boots b ON(b.organisation_id=a.organisation_id AND b.sandbox_id=a.sandbox_id AND b.boot_generation=a.sandbox_boot_generation)
      WHERE a.organisation_id=$1 AND a.run_id=$2 AND a.id=$3 FOR UPDATE OF a`,[s.organisation_id,s.run_id,e.attempt_id])).rows[0];
    if(!a||a.sandbox_id!==e.sandbox_id||a.sandbox_boot_generation!==e.sandbox_boot_generation||a.attempt_boot_id!==e.boot_id)
      fail('AUTH_SCOPE_DENIED','Attempt is not placed on the authenticated sandbox boot');
    if(a.current_boot!==e.sandbox_boot_generation)fail('AUTH_SCOPE_DENIED','Authenticated sandbox boot is no longer current');
    if(a.generation!==e.attempt_generation||a.current_attempt_id!==e.attempt_id||a.current_generation!==e.attempt_generation||
      a.authority_epoch!==e.authority_epoch||a.current_epoch!==e.authority_epoch)
      fail('RUNNER_EVENT_FENCED','Event attempt generation or authority epoch is stale');
    const prior=await tx.query(`SELECT principal_scope,request_digest,result FROM hyperfide.command_inbox
      WHERE organisation_id=$1 AND run_id=$2 AND operation='runner.event' AND idempotency_key=$3 FOR UPDATE`,[s.organisation_id,s.run_id,e.event_id]);
    if(prior.rows.length){
      const r=prior.rows[0]!;
      if(r.principal_scope!==principal||r.request_digest!==requestHash)
        fail('RUNNER_EVENT_CONFLICT','Event identity was reused with different immutable contents or producer');
      return receipt(r.result,'DUPLICATE');
    }
    const cursor=(await tx.query(`SELECT result FROM hyperfide.command_inbox WHERE organisation_id=$1 AND run_id=$2
      AND principal_scope=$3 AND operation='runner.event-cursor' AND idempotency_key=$4 FOR UPDATE`,
      [s.organisation_id,s.run_id,principal,stream])).rows[0]?.result as Record<string,unknown>|undefined;
    const last=BigInt(cursor?integer(cursor.last_sequence,true):'0'),sequence=BigInt(e.sequence);
    if(sequence<=last)fail('RUNNER_EVENT_SEQUENCE_CONFLICT','Producer sequence was already admitted for another event');
    // Gaps are reported, never silently admitted: the producer resends from expected_sequence.
    if(sequence>last+1n)return {status:'GAP',admitted:false,event_id:e.event_id,expected_sequence:(last+1n).toString(),
      received_sequence:e.sequence,last_sequence:last.toString(),execution_authority:false,task_qualified:false};
    if(last>=BigInt(RUNNER_EVENT_BOUNDS.events_per_stream))
      fail('RUNNER_EVENT_BACKPRESSURE','Central runner event retention for this stream is full');
    const fence=await tx.query(`SELECT 1 FROM hyperfide.outbox_events WHERE organisation_id=$1 AND run_id=$2
      AND aggregate_type='attempt.instructions' AND aggregate_id=$3 AND event_type='instruction.cancel' LIMIT 1`,[s.organisation_id,s.run_id,e.attempt_id]);
    const clock=(await tx.query('SELECT clock_timestamp() AS now')).rows[0]!.now as Date;
    const record={...e,payload:v.payload,receipt_cursor:e.sequence,received_at:clock.toISOString(),
      publication_fenced:fence.rows.length>0||!LIVE.includes(String(a.execution_state)),execution_authority:false};
    await tx.query(`INSERT INTO hyperfide.command_inbox(organisation_id,run_id,id,principal_scope,operation,idempotency_key,request_digest,state,result)
      VALUES($1,$2,$3,$4,'runner.event',$5,$6,'COMPLETED',$7::jsonb)`,[s.organisation_id,s.run_id,randomUUID(),principal,e.event_id,requestHash,canonical(record)]);
    const next=canonical({stream_attempt_id:e.attempt_id,attempt_generation:e.attempt_generation,last_sequence:e.sequence,last_event_id:e.event_id});
    if(cursor)await tx.query(`UPDATE hyperfide.command_inbox SET result=$5::jsonb,state_version=state_version+1 WHERE organisation_id=$1 AND run_id=$2
      AND principal_scope=$3 AND operation='runner.event-cursor' AND idempotency_key=$4`,[s.organisation_id,s.run_id,principal,stream,next]);
    else await tx.query(`INSERT INTO hyperfide.command_inbox(organisation_id,run_id,id,principal_scope,operation,idempotency_key,request_digest,state,result)
      VALUES($1,$2,$3,$4,'runner.event-cursor',$5,$6,'COMPLETED',$7::jsonb)`,
      [s.organisation_id,s.run_id,randomUUID(),principal,stream,digest({principal,stream}),next]);
    return receipt(record,'ADMITTED');
  });
}
function receipt(value:unknown,status:'ADMITTED'|'DUPLICATE'):Record<string,unknown> {
  const r=value as Record<string,unknown>;
  return {status,admitted:true,event_id:r.event_id,sequence:r.sequence,receipt_cursor:r.receipt_cursor,
    payload_digest:r.payload_digest,received_at:r.received_at,publication_fenced:r.publication_fenced,execution_authority:false,task_qualified:false};
}

// hyperfide-v21 4.2 (req 4 ac_1): the launch broker (src/hyperfide/launch.c) spools every structured launch event
// and posts it here. Native question and approval prompts arrive as native.question / native.approval carrying the
// agent's raw protocol line; the 4.1 classifier and Ask path run on it so a prompt inside a sandbox becomes an Ask row
// attributed to the launch's session, attempt and sandbox. The broker retries until recorded:true, so content the
// classifier cannot read is recorded and acknowledged, never refused (a refusal would wedge the spool).
export const LAUNCH_EVENT_FIELDS=['schema_version','event_id','organisation_id','run_id','sandbox_id','boot_id','sandbox_boot_generation',
  'launch_id','command_id','sequence','kind','observed_at_seconds','data'] as const;
const NATIVE_KINDS=new Set(['native.question','native.approval']);
type LaunchStart={attempt_id:string;agent_session_id:string};
async function launchStart(tx:PrimaryTransaction,s:{organisation_id:string;run_id:string},command:string,launch:string,sandbox:string,boot:string):Promise<LaunchStart> {
  const row=(await tx.query(`SELECT aggregate_id,event_type,payload FROM hyperfide.outbox_events WHERE organisation_id=$1 AND run_id=$2 AND id=$3
    AND aggregate_type='attempt.instructions'`,[s.organisation_id,s.run_id,command])).rows[0];
  const p=row?.payload as Record<string,unknown>|undefined,body=p&&object(p.body)?p.body:undefined;
  if(!row||row.event_type!=='instruction.start'||!body||body.launch_id!==launch||p!.sandbox_id!==sandbox||p!.boot_id!==boot||
    p!.attempt_id!==row.aggregate_id||typeof body.agent_session_id!=='string')
    fail('RUNNER_EVENT_LAUNCH_UNKNOWN','Native events name the START instruction of a launch on the authenticated boot');
  return {attempt_id:uuid(row.aggregate_id),agent_session_id:uuid(body.agent_session_id)};
}
export async function recordLaunchEvent(g:TransactionGateway,component:ComponentContext,context:ComponentContext,input:unknown):Promise<unknown> {
  const invocation=requireInvocation(context,input,['RUNNER']),p=invocation.principal;
  const v=fields(input,LAUNCH_EVENT_FIELDS),s=scope(v);
  if(!p.sandbox_id||!p.boot_id||!p.boot_generation)fail('AUTH_SCOPE_DENIED','A genuine current sandbox boot is required for launch events');
  if(v.schema_version!==1||uuid(v.sandbox_id)!==p.sandbox_id||uuid(v.boot_id)!==p.boot_id||integer(v.sandbox_boot_generation)!==p.boot_generation)
    fail('AUTH_SCOPE_DENIED','Launch events come only from the authenticated sandbox boot');
  if(typeof v.kind!=='string'||!/^[a-z][a-z0-9._-]{0,95}$/.test(v.kind))fail('RUNNER_EVENT_TYPE_INVALID','Launch event kinds are bounded names');
  if(!object(v.data)||Buffer.byteLength(canonical(v.data))>RUNNER_EVENT_BOUNDS.payload_bytes)fail('RUNNER_EVENT_TOO_LARGE','Launch event data must be a bounded object');
  if(typeof v.observed_at_seconds!=='number'||!Number.isSafeInteger(v.observed_at_seconds)||v.observed_at_seconds<0)
    fail('EVENT_INPUT_INVALID','Observation time is whole seconds');
  const e={...s,event_id:uuid(v.event_id),launch_id:uuid(v.launch_id),command_id:v.command_id===null?null:uuid(v.command_id),
    sequence:integer(v.sequence),kind:v.kind,sandbox_id:p.sandbox_id,boot_id:p.boot_id};
  const native=NATIVE_KINDS.has(e.kind),data=v.data as Record<string,unknown>;
  if(native&&(e.command_id===null||(data.connector!=='codex'&&data.connector!=='claude')||typeof data.agent_session_id!=='string'||!object(data.event)))
    fail('EVENT_INPUT_INVALID','A native event names its START command, connector, session and protocol message');
  const principal='runner:'+e.sandbox_id+':'+e.boot_id,requestHash=digest(v);
  return g.withPrimaryTransaction({timeoutMs:10000,maxRetries:3,signal:invocation.signal,guard:tx=>invocation.identityGuard(tx)},async tx=>{
    await lockRun(tx,s);
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['runner.launch-event:'+s.organisation_id+':'+e.launch_id]);
    const prior=(await tx.query(`SELECT request_digest,result FROM hyperfide.command_inbox WHERE organisation_id=$1 AND run_id=$2
      AND operation='runner.launch-event' AND idempotency_key=$3`,[s.organisation_id,s.run_id,e.event_id])).rows[0];
    if(prior){
      if(prior.request_digest!==requestHash)fail('RUNNER_EVENT_CONFLICT','Event identity was reused with different contents');
      const {payload:_payload,...recorded}=prior.result as Record<string,unknown>;
      return {...recorded,replayed:true};
    }
    const slot=e.launch_id+':'+e.sequence;
    const taken=(await tx.query(`SELECT result FROM hyperfide.command_inbox WHERE organisation_id=$1 AND run_id=$2
      AND operation='runner.launch-event-sequence' AND idempotency_key=$3`,[s.organisation_id,s.run_id,slot])).rows[0];
    if(taken)fail('RUNNER_EVENT_SEQUENCE_CONFLICT','Launch sequence was already recorded for another event');
    let signal:string|null=null,asks:RaisedNativeAsk[]=[],session:string|null=null,attempt:string|null=null;
    if(native){
      const start=await launchStart(tx,s,e.command_id!,e.launch_id,e.sandbox_id,e.boot_id);
      if(data.agent_session_id!==start.agent_session_id)fail('AUTH_SCOPE_DENIED','Native event names another session than its launch');
      if(p.attempt_id!==null&&p.attempt_id!==start.attempt_id)fail('AUTH_SCOPE_DENIED','Authenticated runner is bound to a different attempt');
      session=start.agent_session_id;attempt=start.attempt_id;
      const connector=data.connector as 'codex'|'claude';
      try{signal=classifyNativeEvent(connector,data.event).signal;}catch{signal='UNCLASSIFIED';}
      asks=await raiseNativeAsks(component,tx,invocation,{session,attempt,sandbox:e.sandbox_id},e.event_id,nativeAskRequests(connector,data.event));
    }
    const result={recorded:true,event_id:e.event_id,launch_id:e.launch_id,sequence:e.sequence,kind:e.kind,
      agent_session_id:session,attempt_id:attempt,signal,asks,execution_authority:false};
    await tx.query(`INSERT INTO hyperfide.command_inbox(organisation_id,run_id,id,principal_scope,operation,idempotency_key,request_digest,state,result)
      VALUES($1,$2,$3,$4,'runner.launch-event',$5,$6,'COMPLETED',$7::jsonb)`,[s.organisation_id,s.run_id,randomUUID(),principal,e.event_id,requestHash,
      canonical({...result,payload:v})]);
    await tx.query(`INSERT INTO hyperfide.command_inbox(organisation_id,run_id,id,principal_scope,operation,idempotency_key,request_digest,state,result)
      VALUES($1,$2,$3,$4,'runner.launch-event-sequence',$5,$6,'COMPLETED',$7::jsonb)`,[s.organisation_id,s.run_id,randomUUID(),principal,slot,requestHash,
      canonical({event_id:e.event_id})]);
    return {...result,replayed:false};
  });
}

export function runnerApi(g:TransactionGateway):Record<string,Action> {
  return {
    'instructions.runner.poll':(input,context)=>pollRunnerCommands(context,input),
    'instructions.consumer.register':(input,context)=>authorizedRun(g,context,input,['RUNNER'],(tx,invocation)=>registerRunnerConsumer(tx,input,invocation)),
    'instructions.handoff':(input,context)=>nativeInvocation(g,context,input,'HANDOFF',(tx,invocation)=>handoff(tx,input,invocation.principal)),
    'instructions.ack':(input,context)=>nativeInvocation(g,context,input,'ACK',(tx,invocation)=>recordRunnerAcknowledgement(tx,input,invocation)),
    'instructions.events.ingest':(input,context)=>ingestRunnerEvent(g,context,input)
  };
}
