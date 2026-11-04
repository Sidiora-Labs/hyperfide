/** Private deployment preload. Measures actual fetch response bytes consumed by the source service. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const filename=process.env.HF_SOURCE_INSTRUMENTATION_LOG;
const endpoint=process.env.HF_SOURCE_INSTRUMENTATION_S3_ENDPOINT;
const bucket=process.env.HF_SOURCE_INSTRUMENTATION_S3_BUCKET??process.env.HF_ARTIFACT_S3_BUCKET;
if(!filename||!path.isAbsolute(filename)||!endpoint||!bucket||/[\x00-\x20\x7f/]/.test(bucket))throw new Error('Explicit private instrumentation log and S3 endpoint required');
const origin=new URL(endpoint).origin;
const scope=JSON.parse(process.env.HF_SOURCE_CAMPAIGN_SCOPE??'null');
if(!scope?.organisation_id||!scope?.repository_id||!scope?.security_domain_id)throw new Error('Instrumentation requires dedicated source scope');
const descriptor=fs.openSync(filename,'ax',0o600);
const emit=value=>fs.writeSync(descriptor,JSON.stringify({schema_version:1,scope,pid:process.pid,at:new Date().toISOString(),...value})+'\n');
const original=globalThis.fetch;
let sequence=0;
emit({event:'start',measurement:'actual S3 fetch calls and response body bytes consumed; cache/materialization require separate witnesses'});
globalThis.fetch=async function(input,init){
 const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
 const parts=url.pathname.split('/');
 if(url.origin!==origin||parts.length!==9||parts[1]!==encodeURIComponent(bucket)||parts[2]!=='source'||parts[3]!=='v1'||parts[4]!==scope.security_domain_id)return original(input,init);
 const request_id=++sequence,method=init?.method??(input instanceof Request?input.method:'GET');
 emit({event:'request',request_id,method,key_digest:'sha256:'+createHash('sha256').update(url.pathname).digest('hex')});
 let response;
 try{response=await original(input,init);}catch(error){emit({event:'error',request_id,name:error?.name??'Error'});throw error;}
 emit({event:'response',request_id,status:response.status});
 if(!response.body)return response;
 const reader=response.body.getReader();
 const body=new ReadableStream({
  async pull(controller){try{const result=await reader.read();if(result.done){emit({event:'body_end',request_id});controller.close();}else{emit({event:'bytes',request_id,bytes:result.value.byteLength});controller.enqueue(result.value);}}catch(error){emit({event:'body_error',request_id});controller.error(error);}},
  async cancel(reason){emit({event:'body_cancel',request_id});await reader.cancel(reason);},
 });
 return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
};
