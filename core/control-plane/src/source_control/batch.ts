import {FoundationError} from '../policy/programme.js';
import {canonicalBytes,SourceControlError,type SourceRequest,type SourceAction,type SourceError} from './contracts.js';
import type {SourceApiPrincipal} from './api.js';

export const SOURCE_BATCH_READ_ACTIONS=new Set<SourceAction>(['source.revisions.read','source.changes.revisions','source.operations.read','source.trees.entries','source.trees.lookup','source.objects.inspect','source.workspaces.detail','source.queries.ancestry','source.queries.merge-bases','source.queries.history','source.queries.diff','source.queries.blame','source.queries.line-map','source.domains.read','source.candidates.read','source.acceptance.read','source.transforms.read','source.graph.query']);
const fault=(code:string,message:string):SourceError=>({code,message,retry:'NEVER',outcome:'KNOWN'});
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
export async function runSourceReadBatch(request:SourceRequest,principal:SourceApiPrincipal,invoke:(request:SourceRequest,principal:SourceApiPrincipal,signal:AbortSignal)=>Promise<unknown>) {
 const input=request.input;
 if(!object(input)||Object.keys(input).some(k=>!['items','budget'].includes(k))||!Array.isArray(input.items)||input.items.length<1||input.items.length>16)
  throw new SourceControlError('LIMIT_EXCEEDED','Read batch requires one through sixteen items');
 const budget=input.budget??{};
 if(!object(budget)||Object.keys(budget).some(k=>!['max_bytes','max_ms'].includes(k)))throw new SourceControlError('INVALID_REQUEST','Read batch budget is malformed');
 const maxBytes=budget.max_bytes??262144,maxMs=budget.max_ms??5000;
 if(!Number.isSafeInteger(maxBytes)||Number(maxBytes)<16384||Number(maxBytes)>524288||!Number.isSafeInteger(maxMs)||Number(maxMs)<1||Number(maxMs)>5000)
  throw new SourceControlError('LIMIT_EXCEEDED','Read batch exceeds its byte or time budget');
 const identities=new Set<string>();
 const members=input.items.map(value=>{
  if(!object(value)||Object.keys(value).some(k=>!['id','action','input'].includes(k))||typeof value.id!=='string'||!/^[A-Za-z0-9_.:-]{1,64}$/.test(value.id)||identities.has(value.id)||typeof value.action!=='string'||value.action.length>96||!Object.hasOwn(value,'input'))
   throw new SourceControlError('INVALID_REQUEST','Unique bounded batch identities, actions and inputs are required');
  identities.add(value.id);return {id:value.id,action:value.action as SourceAction,input:value.input};
 });
 const deadline=Date.now()+Number(maxMs),controller=new AbortController();
 const signal=principal.signal?AbortSignal.any([principal.signal,controller.signal]):controller.signal;
 const actor='operation' in principal?principal:{...principal,signal};
 const timer=setTimeout(()=>controller.abort(),Number(maxMs));timer.unref();
 const results:({id:string;action:SourceAction}&({result:unknown}|{error:SourceError}))[]=[];
 let remaining=Number(maxBytes)-256,exhausted=false;
 try {
  for(const member of members){
   let outcome:{result:unknown}|{error:SourceError};
   if(signal.aborted||exhausted)outcome={error:fault(signal.aborted?'BATCH_CANCELLED':'BATCH_BYTE_LIMIT','Batch admission budget exhausted')};
   else if(!SOURCE_BATCH_READ_ACTIONS.has(member.action))outcome={error:fault('BATCH_ACTION_DENIED','Batch member is not an admitted metadata read')};
   else {
    const child:SourceRequest={protocol_version:1,scope:request.scope,operation_id:request.operation_id,action:member.action,input:member.input,
     ...(request.authority?{authority:request.authority}:{}),...(request.causal_token?{causal_token:request.causal_token}:{})};
    if(object(child.input)&&(child.input.budget===undefined||object(child.input.budget))&&member.action.startsWith('source.queries.')){
     const prior=object(child.input.budget)?child.input.budget:{};
     if(prior.max_ms===undefined||Number.isSafeInteger(prior.max_ms)&&Number(prior.max_ms)>=1&&Number(prior.max_ms)<=30000)
      child.input={...child.input,budget:{...prior,max_ms:Math.max(1,Math.min(Number(prior.max_ms??5000),deadline-Date.now()))}};
    }
    try {
     const result=await new Promise<unknown>((resolve,reject)=>{
      const abort=()=>reject(new SourceControlError('BATCH_CANCELLED','Batch time or cancellation budget exhausted'));
      if(signal.aborted){abort();return;}
      signal.addEventListener('abort',abort,{once:true});
      invoke(child,actor,signal).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
     });
     outcome={result};
    }catch(error){outcome={error:error instanceof SourceControlError?{code:error.code,message:error.message.slice(0,200),retry:error.retry,outcome:error.outcome}:error instanceof FoundationError&&error.code!=='HANDLER_FAILED'?fault(error.code,error.message.slice(0,200)):fault('INTERNAL_ERROR','Batch member failed')};}
   }
   let row={id:member.id,action:member.action,...outcome};
   const reserved=(members.length-results.length-1)*768;
   try {if(canonicalBytes(row,Math.max(1,remaining-reserved)).byteLength>remaining-reserved)throw new Error('Batch bytes exceeded');}
   catch {exhausted=true;row={id:member.id,action:member.action,error:fault('BATCH_BYTE_LIMIT','Batch aggregate response byte budget exhausted')};}
   remaining-=canonicalBytes(row).byteLength;results.push(row);
  }
 }finally {clearTimeout(timer);}
 return {items:results,coverage:results.some(row=>'error'in row)?'PARTIAL':'COMPLETE'};
}
