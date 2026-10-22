import type {ComponentContext} from '../components/registry.js';
import type {InvocationContext,AuthorityTransaction} from '../transport/protocol.js';
import {object} from '../policy/programme.js';
// Type-only: human_interface imports the 3.6 policy table from admission.ts, which imports this module.
import type {AskSubject,AskRaiseCapability} from '../policy/human_interface.js';

// hyperfide-v21 4.1 (req 4 ac_1): a question or approval prompt a native agent emits becomes an Ask. Unlike the
// admission classification, which keeps only normalized codes, an Ask must carry the agent's own words: the human
// answers the question as asked. The text lives only in the Ask row and its operator delivery.
export type NativeAskKind='question'|'permission'|'variable'|'secret';
export interface NativeAskRequest {
 native_id:string|null;kind:NativeAskKind;title:string;body:string;options:string[];recommended:string|null;
}
const isAskRaiser=(value:unknown):value is AskRaiseCapability=>object(value)&&value.schema_version===1&&typeof value.raiseInTransaction==='function';
const CODEX_APPROVALS:Readonly<Record<string,string>>=Object.freeze({
 'item/commandExecution/requestApproval':'run a command','execCommandApproval':'run a command',
 'item/fileChange/requestApproval':'change files','applyPatchApproval':'apply a patch',
 'item/permissions/requestApproval':'widen its permissions','mcpServer/elicitation/request':'answer an MCP server request'
});
const PERMISSION_OPTIONS=['deny','approve'];
const field=(value:unknown,key:string):unknown=>object(value)?value[key]:undefined;
const clean=(value:string):string=>value.replace(/\u0000/g,'');
const clip=(value:string,max:number):string=>{const v=clean(value);return v.length>max?v.slice(0,max-1)+'…':v;};
const str=(value:unknown):string|null=>typeof value==='string'&&value.trim().length?clean(value):null;
const nativeId=(value:unknown):string|null=>typeof value==='string'||typeof value==='number'?String(value).replace(/[^A-Za-z0-9._-]/g,'_').slice(0,40)||null:null;
function questionAsk(id:string|null,q:unknown):NativeAskRequest|null{
 const question=str(field(q,'question'));
 if(!question)return null;
 const header=str(field(q,'header'));
 const offered=Array.isArray(field(q,'options'))?field(q,'options') as unknown[]:[];
 const options:string[]=[],lines:string[]=[];
 for(const option of offered){
  const label=str(field(option,'label'))??str(option);
  if(!label)continue;
  const bounded=clip(label.trim(),512);
  if(options.includes(bounded)||options.length>=64)continue;
  options.push(bounded);
  const description=str(field(option,'description'));
  lines.push('- '+bounded+(description?': '+description:''));
 }
 const multi=field(q,'multiSelect')===true,other=field(q,'isOther')===true;
 const body=[question,...(lines.length?['','Options:',...lines]:[]),...(multi?['','More than one option may be chosen.']:[]),...(other?['','A free-text answer is also accepted.']:[])].join('\n');
 const title=clip((header?header+': ':'')+question,512);
 // A secret is never a proceed-on-default question (D11); a question without options has no default to proceed on.
 if(field(q,'isSecret')===true)return {native_id:id,kind:'secret',title,body:clip(body,65536),options:[],recommended:null};
 if(!options.length)return {native_id:id,kind:'variable',title,body:clip(body,65536),options:[],recommended:null};
 // Claude Code marks its suggested option "(Recommended)" and otherwise lists it first.
 const recommended=options.find(o=>/\(recommended\)\s*$/i.test(o))??options[0]!;
 return {native_id:id,kind:'question',title,body:clip(body,65536),options,recommended};
}
function permissionAsk(id:string|null,title:string,detail:unknown):NativeAskRequest{
 return {native_id:id,kind:'permission',title:clip(title,512),body:clip(JSON.stringify(detail,null,1)??'',65536),options:[...PERMISSION_OPTIONS],recommended:'deny'};
}
/** The Asks one native protocol message calls for, with the agent's text preserved: Claude AskUserQuestion (as a
 * tool_use or a can_use_tool control request) and Codex item/tool/requestUserInput are questions; every approval
 * prompt the admission classifier escalates is a permission. Any other message yields none. */
export function nativeAskRequests(connector:'codex'|'claude',event:unknown):NativeAskRequest[]{
 if(!object(event))return [];
 if(connector==='codex'){
  const method=event.method,params=field(event,'params');
  if(event.id===undefined||typeof method!=='string')return [];
  const id=nativeId(field(params,'itemId'))??nativeId(event.id);
  if(method==='item/tool/requestUserInput'){
   const questions=Array.isArray(field(params,'questions'))?field(params,'questions') as unknown[]:[];
   return questions.slice(0,16).map((q,n)=>questionAsk(id===null?null:id+'.'+(nativeId(field(q,'id'))??n),q)).filter((a):a is NativeAskRequest=>a!==null);
  }
  const action=CODEX_APPROVALS[method];
  return action?[permissionAsk(id,'Codex asks to '+action,{method,params:params??null})]:[];
 }
 const type=event.type;
 const questions=(input:unknown,id:string|null)=>{
  const list=Array.isArray(field(input,'questions'))?field(input,'questions') as unknown[]:[];
  return list.slice(0,16).map((q,n)=>questionAsk(id===null?null:id+'.'+n,q)).filter((a):a is NativeAskRequest=>a!==null);
 };
 if(type==='control_request'){
  const request=field(event,'request');
  if(field(request,'subtype')!=='can_use_tool')return [];
  const id=nativeId(field(request,'tool_use_id'))??nativeId(field(event,'request_id')),tool=str(field(request,'tool_name'))??'a tool';
  if(tool==='AskUserQuestion')return questions(field(request,'input'),id);
  return [permissionAsk(id,'Claude asks to use '+tool,request)];
 }
 if(type==='assistant'&&event.error===undefined){
  const content=field(field(event,'message'),'content');
  if(!Array.isArray(content))return [];
  return content.filter(part=>field(part,'type')==='tool_use'&&field(part,'name')==='AskUserQuestion').flatMap(part=>questions(field(part,'input'),nativeId(field(part,'id'))));
 }
 return [];
}
export interface RaisedNativeAsk {ask_id:unknown;kind:unknown;default_policy:unknown;state:unknown;replayed:boolean}
/** Raises each Ask through the 1.2-asks path inside the caller's guarded transaction; deadline and chain come from
 * the kind's 3.6 policy (ASK_POLICY). The idempotency key is the
 * native prompt's own id within the observed session, so the same prompt forwarded twice is one Ask. The returned
 * summary carries no native text: callers persist it as admission evidence. */
export async function raiseNativeAsks(ctx:ComponentContext,client:AuthorityTransaction,invocation:InvocationContext,subject:AskSubject,operationId:string,requests:readonly NativeAskRequest[]):Promise<RaisedNativeAsk[]>{
 if(!requests.length)return [];
 const asks=ctx.dependencies.require('1.2-asks','human.asks.v1',isAskRaiser);
 const raised:RaisedNativeAsk[]=[];
 for(const [n,r] of requests.entries()){
  const result=await asks.raiseInTransaction(client,invocation,{idempotency_key:'native:'+subject.session+':'+(r.native_id??operationId+'.'+n),kind:r.kind,title:r.title,body:r.body,
   options:r.options,recommended:r.recommended,deadline_seconds:null,chain:[],task_id:null},subject);
  const ask=result.ask as Record<string,unknown>;
  raised.push({ask_id:ask.ask_id,kind:ask.kind,default_policy:ask.default_policy,state:ask.state,replayed:result.replayed===true});
 }
 return raised;
}
