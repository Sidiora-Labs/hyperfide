import {feedbackDetails} from './fleet_worker_feedback.js';
import type {PrimaryTransaction} from '../storage/transactions.js';
import type {InvocationContext} from '../transport/protocol.js';
import {object} from '../policy/programme.js';
import {canonical,hash,record,uuid} from '../hierarchy/packages.js';
import {fleetError,type FleetActorBinding} from './fleet_authority.js';

const PAGE_BYTES=49152;
const summaryKeys=['kind','state','outcome','recipient_package_id','sender_actor_id','sender_role','delegation_id','package_id','sandbox_id','provider_intent_id','task_id','attempt_id','attempt_generation','worker_id','manager_session_id','manager_generation','handoff_id','successor_id','operation_id','environment_id','environment_generation','receipt_digest','input_digest','boot_generation','execution_confirmed','task_qualified','ownership_changed'];
function boundedSummary(value:unknown):Record<string,unknown>{
 if(!object(value))return {};
 const result:Record<string,unknown>={};
 for(const key of summaryKeys){const item=value[key];if(item===null||typeof item==='boolean'||typeof item==='number'||typeof item==='string'&&Buffer.byteLength(item)<=128)result[key]=item;}
 const assignment=value.assignment;if(object(assignment))result.assignment=Object.fromEntries(['worker_id','assignment_id'].filter(key=>typeof assignment[key]==='string').map(key=>[key,assignment[key]]));
 if(Array.isArray(value.tasks))result.tasks=value.tasks.slice(0,1).map(t=>object(t)?Object.fromEntries(['task_id','attempt_id','attempt_generation','slot_id'].filter(k=>t[k]!==undefined).map(k=>[k,t[k]])):{});
 return result;
}
export function effectSummary(row:Record<string,any>):Record<string,unknown>{
 const result=boundedSummary(row.result),out:Record<string,any>={decision_id:row.decision_id,operation_id:row.operation_id,action:row.action,result,result_digest:hash(row.result),result_bytes:Buffer.byteLength(canonical(row.result)),projection:'TYPED_SUMMARY_V1',...(typeof row.created_at==='string'?{created_at:row.created_at}:{})};
 for(const key of Object.keys(result).reverse()){if(Buffer.byteLength(canonical(out))<=512)break;delete result[key];}
 return out;
}
export function coordinationSummary(row:Record<string,any>):Record<string,unknown>{
 const payload=boundedSummary(row.payload),out:Record<string,any>={id:row.id,event_type:row.event_type,payload,payload_digest:hash(row.payload),payload_bytes:Buffer.byteLength(canonical(row.payload)),projection:'TYPED_SUMMARY_V1',...(typeof row.created_at==='string'?{created_at:row.created_at}:{})};
 for(const key of Object.keys(payload).reverse()){if(Buffer.byteLength(canonical(out))<=512)break;delete payload[key];}
 return out;
}
export async function readFleetHistory(tx:PrimaryTransaction,i:InvocationContext,b:FleetActorBinding,raw:unknown):Promise<Record<string,unknown>>{
 const request=record(raw,['collection','cursor','limit','entry_id','offset','attempt_id'],['collection','cursor','limit']);
 if(!['effect_receipts','coordination','worker_feedback','worker_events','worker_checkpoints','findings'].includes(String(request.collection))||!Number.isSafeInteger(request.limit)||Number(request.limit)<1||Number(request.limit)>8)fleetError('FLEET_HISTORY_REQUEST_INVALID');
 let at:string|null=null,id:string|null=null;
 if(request.cursor!==null){const cursor=record(request.cursor,['created_at','id']);if(typeof cursor.created_at!=='string'||cursor.created_at.length>64||!Number.isFinite(Date.parse(cursor.created_at)))fleetError('FLEET_HISTORY_REQUEST_INVALID');at=cursor.created_at;id=uuid(cursor.id);}
 if(['worker_feedback','worker_events','worker_checkpoints','findings'].includes(String(request.collection))){if(request.entry_id!==undefined||request.offset!==undefined)fleetError('FLEET_HISTORY_REQUEST_INVALID');return {kind:'FLEET_HISTORY_PAGE',collection:request.collection,...await feedbackDetails(tx,{organisation_id:i.principal.organisation_id,run_id:i.principal.run_id,package_id:b.delegation_id},String(request.collection),{...request,cursor:at===null?null:{created_at:at,id:id!}})};}
 const entry=request.entry_id===undefined?null:uuid(request.entry_id),offset=request.offset===undefined?0:request.offset;
 if(!Number.isSafeInteger(offset)||Number(offset)<0||Number(offset)>1048576||!entry&&offset!==0)fleetError('FLEET_HISTORY_REQUEST_INVALID');
 const scope=[i.principal.organisation_id,i.principal.run_id,b.actor_role==='PRIMARY'?null:b.actor_id,b.delegation_id,at,id,entry,Number(request.limit)+1];
 const rows=request.collection==='effect_receipts'?(await tx.query(`SELECT e.operation_id::text AS id,e.created_at::text,e.decision_id::text,d.action,e.result AS content FROM hyperfide.fleet_effect_receipts e JOIN hyperfide.fleet_decisions d ON d.organisation_id=e.organisation_id AND d.run_id=e.run_id AND d.id=e.decision_id WHERE e.organisation_id=$1 AND e.run_id=$2 AND ($3::uuid IS NULL OR d.actor_id=$3) AND COALESCE(e.result->>'kind','')<>'FLEET_HISTORY_PAGE' AND ($6::uuid IS NULL OR e.operation_id=$6) AND ($4::timestamptz IS NULL OR (e.created_at,e.operation_id)<($4::timestamptz,$5::uuid)) ORDER BY e.created_at DESC,e.operation_id DESC LIMIT $7`,[scope[0],scope[1],scope[2],scope[4],scope[5],scope[6],scope[7]])).rows:(await tx.query(`SELECT id,created_at::text,content FROM (
 SELECT e.operation_id AS id,e.created_at,e.result AS content FROM hyperfide.fleet_effect_receipts e JOIN hyperfide.fleet_decisions d ON d.organisation_id=e.organisation_id AND d.run_id=e.run_id AND d.id=e.decision_id WHERE e.organisation_id=$1 AND e.run_id=$2 AND d.action='COORDINATE_DEPENDENCY' AND e.result->>'kind'='COORDINATE_DEPENDENCY' AND e.result->>'delivery'='SCOPED_OBSERVATION' AND e.result->>'decision_id'=d.id::text AND e.result->>'sender_actor_id'=d.actor_id::text AND e.result->>'recipient_package_id'=d.body->'input'->>'recipient_package_id' AND ($3::uuid IS NULL OR e.result->>'recipient_package_id'=$3::text)
 UNION ALL SELECT o.id,o.created_at,o.payload FROM hyperfide.outbox_events o WHERE o.organisation_id=$1 AND o.run_id=$2 AND o.event_type='fleet.manager.coordination' AND ($3::uuid IS NULL OR o.payload->>'recipient_package_id'=$3::text) AND NOT EXISTS(SELECT 1 FROM hyperfide.fleet_effect_receipts e JOIN hyperfide.fleet_decisions d ON d.organisation_id=e.organisation_id AND d.run_id=e.run_id AND d.id=e.decision_id WHERE e.organisation_id=o.organisation_id AND e.run_id=o.run_id AND e.operation_id=o.id AND d.action='COORDINATE_DEPENDENCY' AND e.result->>'delivery'='SCOPED_OBSERVATION')
 ) messages WHERE ($6::uuid IS NULL OR id=$6) AND ($4::timestamptz IS NULL OR (created_at,id)<($4::timestamptz,$5::uuid)) ORDER BY created_at DESC,id DESC LIMIT $7`,[scope[0],scope[1],scope[3],scope[4],scope[5],scope[6],scope[7]])).rows;
 if(entry&&!rows.length)fleetError('FLEET_HISTORY_ENTRY_UNAVAILABLE');
 if(entry){
  const row=rows[0]!,bytes=Buffer.from(canonical(row.content));if(Number(offset)>bytes.length)fleetError('FLEET_HISTORY_REQUEST_INVALID');
  let end=Math.min(bytes.length,Number(offset)+16384),text:string|null=null;
  for(let trim=0;trim<4&&end>=Number(offset);trim++,end--)try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(Number(offset),end));break;}catch{}
  if(text===null||end===Number(offset)&&Number(offset)<bytes.length)fleetError('FLEET_HISTORY_REQUEST_INVALID');
  return {kind:'FLEET_HISTORY_PAGE',collection:request.collection,entry_id:entry,content_digest:hash(row.content),content_bytes:bytes.length,encoding:'UTF8_CANONICAL_JSON',offset,content:text,next_offset:end<bytes.length?end:null,has_more:end<bytes.length};
 }
 const items:Record<string,unknown>[]=[];
 for(const row of rows.slice(0,Number(request.limit))){
  const item={id:String(row.id),created_at:String(row.created_at),...(row.decision_id?{decision_id:row.decision_id,action:row.action}:{}),content_digest:hash(row.content),content_bytes:Buffer.byteLength(canonical(row.content)),content:row.content};
  if(Buffer.byteLength(canonical({...item}))+512>PAGE_BYTES){const placeholder={id:item.id,created_at:item.created_at,content_digest:item.content_digest,content_bytes:item.content_bytes,projection:'CHUNK_READ_REQUIRED',request:{collection:request.collection,cursor:null,limit:1,entry_id:item.id,offset:0}};if(Buffer.byteLength(canonical([...items,placeholder]))+512>PAGE_BYTES)break;items.push(placeholder);continue;}
  if(Buffer.byteLength(canonical([...items,item]))+512>PAGE_BYTES)break;
  items.push(item);
 }
 const more=rows.length>items.length,last=items.at(-1);
 return {kind:'FLEET_HISTORY_PAGE',collection:request.collection,items,has_more:more,next_cursor:more&&last?{created_at:last.created_at,id:last.id}:null,details_complete:items.every(item=>item.projection!=='CHUNK_READ_REQUIRED'),advisory_only:true,execution_authority:false};
}
