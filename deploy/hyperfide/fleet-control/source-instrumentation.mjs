/** Private deployment preload. Measures offered write bodies, acknowledged write payloads, and consumed response bytes. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
const filename=process.env.HF_SOURCE_INSTRUMENTATION_LOG;
const endpoint=process.env.HF_SOURCE_INSTRUMENTATION_S3_ENDPOINT;
const bucket=process.env.HF_SOURCE_INSTRUMENTATION_S3_BUCKET??process.env.HF_ARTIFACT_S3_BUCKET;
if(!filename||!path.isAbsolute(filename)||!endpoint||!bucket||/[\x00-\x20\x7f/]/.test(bucket))throw new Error('Explicit private instrumentation log and S3 endpoint required');
const origin=new URL(endpoint).origin;
const scope=JSON.parse(process.env.HF_SOURCE_CAMPAIGN_SCOPE??'null');
if(!scope?.organisation_id||!scope?.repository_id||!scope?.security_domain_id)throw new Error('Instrumentation requires dedicated source scope');

const counterFile=process.env.HF_SOURCE_HTTP_COUNTERS_FILE??filename+'.requests.json';
if(!path.isAbsolute(counterFile))throw new Error('Private HTTP counter path must be absolute');
const counters={schema_version:1,scope,pid:process.pid,boot_id:randomUUID(),deployment_id:process.env.RAILWAY_DEPLOYMENT_ID??null,service_id:process.env.RAILWAY_SERVICE_ID??null,started_at:new Date().toISOString(),sampled_at:'',state:'RUNNING',coverage:'UNKNOWN',listeners:[],requests:0,completed:0,disconnected:0,inflight:0,statuses:{}};
const flushCounters=(stopped=false)=>{counters.sampled_at=new Date().toISOString();counters.state=stopped?'STOPPED':'RUNNING';counters.coverage=counters.deployment_id&&counters.service_id&&counters.listeners.length&&Number.isSafeInteger(counters.requests)?'COMPLETE':'UNKNOWN';const temporary=counterFile+'.tmp';const fd=fs.openSync(temporary,'w',0o600);try{fs.writeFileSync(fd,JSON.stringify(counters));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temporary,counterFile);};
const requestsSeen=new WeakSet();
for(const prototype of [http.Server.prototype,https.Server.prototype]){
 const originalEmit=prototype.emit;
 prototype.emit=function(event,...args){
  if(event==='listening'){const address=this.address?.(),listener=typeof address==='object'&&address?address.family+':'+address.address+':'+address.port:String(address??'unknown');if(!counters.listeners.includes(listener)&&counters.listeners.length<16)counters.listeners.push(listener);}
  if(event==='request'){
   const [request,response]=args;
   if(request?.method==='POST'&&request.url==='/api/v1/source-control'&&!requestsSeen.has(request)){
    requestsSeen.add(request);counters.requests++;counters.inflight++;
    const address=this.address?.(),listener=typeof address==='object'&&address?address.family+':'+address.address+':'+address.port:String(address??'unknown');
    if(!counters.listeners.includes(listener)&&counters.listeners.length<16)counters.listeners.push(listener);
    let finished=false;response.once('finish',()=>{if(finished)return;finished=true;counters.inflight--;counters.completed++;const status=String(response.statusCode);counters.statuses[status]=(counters.statuses[status]??0)+1;});response.once('close',()=>{if(finished)return;finished=true;counters.inflight--;counters.disconnected++;});
   }
  }
  return originalEmit.call(this,event,...args);
 };
}
flushCounters();const counterTimer=setInterval(()=>flushCounters(),1000);counterTimer.unref();process.once('exit',()=>{clearInterval(counterTimer);flushCounters(true);});

const descriptor=fs.openSync(filename,'ax',0o600);
const emit=value=>fs.writeSync(descriptor,JSON.stringify({schema_version:1,scope,pid:process.pid,at:new Date().toISOString(),...value})+'\n');
const original=globalThis.fetch;
let sequence=0;
emit({event:'start',measurement:'actual S3 PUT request payloads offered and acknowledged, plus response bytes consumed; excludes TCP/TLS framing'});
const bodyBytes=body=>body===null||body===undefined?0:typeof body==='string'?Buffer.byteLength(body):body instanceof ArrayBuffer?body.byteLength:ArrayBuffer.isView(body)?body.byteLength:typeof Blob!=='undefined'&&body instanceof Blob?body.size:null;
globalThis.fetch=async function(input,init){
 const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
 const parts=url.pathname.split('/');
 if(url.origin!==origin||parts.length!==9||parts[1]!==encodeURIComponent(bucket)||parts[2]!=='source'||parts[3]!=='v1'||parts[4]!==scope.security_domain_id)return original(input,init);
 const request_id=++sequence,method=(init?.method??(input instanceof Request?input.method:'GET')).toUpperCase();
 const request_body_bytes=init&&Object.hasOwn(init,'body')?bodyBytes(init.body):input instanceof Request&&input.body!==null?null:0;
 emit({event:'request',request_id,method,request_body_bytes,key_digest:'sha256:'+createHash('sha256').update(url.pathname).digest('hex')});
 let response;
 try{response=await original(input,init);}catch(error){emit({event:'error',request_id,method,request_body_bytes,name:error?.name??'Error'});throw error;}
 emit({event:'response',request_id,method,request_body_bytes,status:response.status});
 if(!response.body)return response;
 const reader=response.body.getReader();
 const body=new ReadableStream({
  async pull(controller){try{const result=await reader.read();if(result.done){emit({event:'body_end',request_id});controller.close();}else{emit({event:'bytes',request_id,bytes:result.value.byteLength});controller.enqueue(result.value);}}catch(error){emit({event:'body_error',request_id});controller.error(error);}},
  async cancel(reason){emit({event:'body_cancel',request_id});await reader.cancel(reason);},
 });
 return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
};
