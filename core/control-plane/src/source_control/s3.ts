import {createHash,createHmac} from 'node:crypto';
import {SourceControlError,sourceError,SOURCE_FORMAT} from './contracts.js';
import type {BackendRead,SourceMultipartBackend} from './storage_contract.js';
export interface SourceS3Configuration {endpoint:string|URL;region:string;bucket:string;accessKey:string;secretKey:string;sessionToken?:string;allowLoopbackHTTP?:boolean;timeoutMs?:number}
const encode=(v:string)=>encodeURIComponent(v).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
const hash=(v:Uint8Array)=>createHash('sha256').update(v).digest('hex');
const hmac=(k:Uint8Array|string,v:string)=>createHmac('sha256',k).update(v).digest();
const xml=(v:string)=>v.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
function decodeXML(v:string):string{return v.replace(/&(amp|lt|gt|quot|apos);/g,(_m,n:string)=>({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"})[n]!);}
export function sourceS3Configuration(env:Readonly<NodeJS.ProcessEnv>):SourceS3Configuration {
 const required=(...names:string[])=>{for(const name of names){const value=env[name];if(value)return value;}sourceError('SOURCE_STORAGE_CONFIG','Missing source object backend configuration');};
 const token=env.HF_SOURCE_S3_SESSION_TOKEN??env.HF_ARTIFACT_S3_SESSION_TOKEN;
 return {endpoint:required('HF_SOURCE_S3_ENDPOINT','HF_ARTIFACT_S3_ENDPOINT','HF_ARTIFACT_S3_URL'),region:required('HF_SOURCE_S3_REGION','HF_ARTIFACT_S3_REGION'),bucket:required('HF_SOURCE_S3_BUCKET','HF_ARTIFACT_S3_BUCKET'),accessKey:required('HF_SOURCE_S3_ACCESS_KEY_ID','HF_ARTIFACT_S3_ACCESS_KEY_ID','HF_ARTIFACT_S3_ACCESS_KEY'),secretKey:required('HF_SOURCE_S3_SECRET_ACCESS_KEY','HF_ARTIFACT_S3_SECRET_ACCESS_KEY','HF_ARTIFACT_S3_SECRET_KEY'),...(token?{sessionToken:token}:{}),allowLoopbackHTTP:env.HF_SOURCE_ALLOW_LOOPBACK_HTTP==='1'};
}
export class S3SourceObjectBackend implements SourceMultipartBackend {
 readonly identity:string;
 private readonly endpoint:URL;
 private readonly timeout:number;
 constructor(private readonly config:SourceS3Configuration){
  this.endpoint=new URL(config.endpoint);const loopback=['127.0.0.1','[::1]','localhost'].includes(this.endpoint.hostname);
  if(this.endpoint.username||this.endpoint.password||this.endpoint.pathname!=='/'||this.endpoint.search||this.endpoint.hash||this.endpoint.protocol!=='https:'&&!(config.allowLoopbackHTTP&&loopback&&this.endpoint.protocol==='http:')||!config.region||!config.bucket||/[\x00-\x20\x7f/]/.test(config.bucket)||![config.accessKey,config.secretKey].every(v=>v.length>0&&v.length<16384&&!/[\x00-\x1f\x7f]/.test(v)))sourceError('SOURCE_STORAGE_CONFIG','Invalid trusted S3 endpoint or credentials');
  this.timeout=config.timeoutMs??10000;if(!Number.isInteger(this.timeout)||this.timeout<100||this.timeout>60000)sourceError('SOURCE_STORAGE_CONFIG','Object request timeout is outside its supported bound');
  this.identity='s3-v1:'+this.endpoint.origin+'/'+config.bucket;
 }
 private async request(method:'GET'|'PUT'|'POST'|'DELETE',key:string,body:Uint8Array=Buffer.alloc(0),query:readonly [string,string][]=[],conditional=false,signal?:AbortSignal,etag?:string):Promise<Response>{
  if(!/^source\/v1\/[a-f0-9-]{36}\/(blob|chunk|file|tree-leaf|tree-index|manifest|revision)\/[a-f0-9]{2}\/[a-f0-9]{64}\/[a-f0-9-]{36}$/.test(key))sourceError('INVALID_STORAGE_KEY','Expected an exact native source placement key');
  const pathname='/'+encode(this.config.bucket)+'/'+key.split('/').map(encode).join('/');
  const canonicalQuery=query.map(([k,v])=>[encode(k),encode(v)] as const).sort(([a,av],[b,bv])=>a<b?-1:a>b?1:av<bv?-1:av>bv?1:0).map(([k,v])=>k+'='+v).join('&');
  const url=new URL(pathname+(canonicalQuery?'?'+canonicalQuery:''),this.endpoint),now=new Date().toISOString().replace(/[:-]|\.\d{3}/g,''),day=now.slice(0,8),payloadHash=hash(body);
  const headers:Record<string,string>={host:url.host,'x-amz-content-sha256':payloadHash,'x-amz-date':now};if(this.config.sessionToken)headers['x-amz-security-token']=this.config.sessionToken;if(conditional)headers['if-none-match']='*';if(etag)headers['if-match']=etag;
  const names=Object.keys(headers).sort(),canonicalHeaders=names.map(n=>n+':'+headers[n]!.trim()+'\n').join(''),scope=day+'/'+this.config.region+'/s3/aws4_request';
  const canonicalRequest=[method,pathname,canonicalQuery,canonicalHeaders,names.join(';'),payloadHash].join('\n'),toSign='AWS4-HMAC-SHA256\n'+now+'\n'+scope+'\n'+hash(Buffer.from(canonicalRequest));
  const keyBytes=hmac(hmac(hmac(hmac('AWS4'+this.config.secretKey,day),this.config.region),'s3'),'aws4_request');headers.authorization='AWS4-HMAC-SHA256 Credential='+this.config.accessKey+'/'+scope+', SignedHeaders='+names.join(';')+', Signature='+hmac(keyBytes,toSign).toString('hex');
  return fetch(url,{method,headers,...(method==='GET'||method==='DELETE'?{}:{body:new Uint8Array(body)}),redirect:'manual',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(this.timeout)]):AbortSignal.timeout(this.timeout)});
 }
 async put(key:string,bytes:Uint8Array,signal?:AbortSignal):Promise<'ACKNOWLEDGED'|'EXISTS'|'UNKNOWN'>{
  if(bytes.length>SOURCE_FORMAT.max_object_bytes)sourceError('OBJECT_LIMIT','Bounded source object required');
  try{const response=await this.request('PUT',key,bytes,[],true,signal);await response.body?.cancel();if(response.status>=200&&response.status<300)return 'ACKNOWLEDGED';if(response.status===412)return 'EXISTS';if(response.status===409||response.status===429||response.status>=500)return 'UNKNOWN';sourceError('OBJECT_BACKEND_REJECTED','S3 rejected conditional source upload');}catch(error){if(error instanceof SourceControlError)throw error;return 'UNKNOWN';}
 }
 async read(key:string,maxBytes:number,signal?:AbortSignal):Promise<BackendRead>{
  if(!Number.isInteger(maxBytes)||maxBytes<0||maxBytes>SOURCE_FORMAT.max_object_bytes)sourceError('OBJECT_LIMIT','Bounded source read required');
  try{
   const response=await this.request('GET',key,undefined,[],false,signal);if(response.status===404){await response.body?.cancel();return {state:'ABSENT'};}if(response.status===429||response.status>=500){await response.body?.cancel();return {state:'UNKNOWN'};}if(response.status!==200){await response.body?.cancel();sourceError('OBJECT_BACKEND_REJECTED','S3 rejected source retrieval');}
   const declared=response.headers.get('content-length');if(declared!==null&&(!/^(0|[1-9][0-9]*)$/.test(declared)||BigInt(declared)>BigInt(maxBytes))){await response.body?.cancel();sourceError('OBJECT_INTEGRITY','S3 source response exceeds declared bounds');}
   if(!response.body)sourceError('OBJECT_INTEGRITY','S3 source response body is absent');const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0;
   try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>maxBytes){await reader.cancel();sourceError('OBJECT_INTEGRITY','S3 source response exceeds read limit');}parts.push(next.value);}}finally{reader.releaseLock();}
   if(declared!==null&&BigInt(declared)!==BigInt(size))sourceError('OBJECT_INTEGRITY','S3 source response was truncated');return {state:'PRESENT',bytes:Buffer.concat(parts),etag:response.headers.get('etag')};
  }catch(error){if(error instanceof SourceControlError)throw error;return {state:'UNKNOWN'};}
 }
 async delete(key:string,expectedDigest:string,maxBytes:number,signal?:AbortSignal):Promise<'ABSENT'|'UNKNOWN'>{
  const existing=await this.read(key,maxBytes,signal);if(existing.state==='ABSENT')return 'ABSENT';if(existing.state!=='PRESENT')return 'UNKNOWN';
  if('sha256:'+hash(existing.bytes)!==expectedDigest)sourceError('OBJECT_INTEGRITY','Refusing deletion of a changed exact placement');
  if(!existing.etag||!/^"[\x21\x23-\x7e]{1,1024}"$/.test(existing.etag))sourceError('OBJECT_BACKEND_PROTOCOL','Exact-placement deletion requires a strong ETag');
  try{const response=await this.request('DELETE',key,undefined,[],false,signal,existing.etag);await response.body?.cancel();if(response.status===412||response.status===409||response.status>=500)return 'UNKNOWN';if(![200,204,404].includes(response.status))sourceError('OBJECT_BACKEND_REJECTED','S3 rejected conditional exact-placement deletion');}catch(error){if(error instanceof SourceControlError)throw error;return 'UNKNOWN';}
  return (await this.read(key,maxBytes,signal)).state==='ABSENT'?'ABSENT':'UNKNOWN';
 }
 async initiateMultipart(key:string,signal?:AbortSignal):Promise<{state:'ACKNOWLEDGED';upload_id:string}|{state:'UNKNOWN'}>{
  try{const response=await this.request('POST',key,undefined,[['uploads','']],false,signal);if(response.status>=500||response.status===429){await response.body?.cancel();return {state:'UNKNOWN'};}const text=await response.text();if(response.status!==200||text.length>65536)sourceError('OBJECT_BACKEND_REJECTED','S3 rejected multipart initiation');const id=/<UploadId>([^<]{1,4096})<\/UploadId>/.exec(text)?.[1];if(!id)return {state:'UNKNOWN'};return {state:'ACKNOWLEDGED',upload_id:decodeXML(id)};}catch(error){if(error instanceof SourceControlError)throw error;return {state:'UNKNOWN'};}
 }
 async uploadPart(key:string,id:string,part:number,bytes:Uint8Array,signal?:AbortSignal):Promise<{state:'ACKNOWLEDGED';etag:string}|{state:'UNKNOWN'}>{
  if(!id||id.length>4096||!Number.isInteger(part)||part<1||part>10000||bytes.length>SOURCE_FORMAT.max_object_bytes)sourceError('INVALID_MULTIPART','Exact bounded multipart part required');
  try{const response=await this.request('PUT',key,bytes,[['partNumber',String(part)],['uploadId',id]],false,signal);await response.body?.cancel();if(response.status>=500||response.status===429)return {state:'UNKNOWN'};if(response.status!==200)sourceError('OBJECT_BACKEND_REJECTED','S3 rejected multipart part');const etag=response.headers.get('etag');if(!etag)return {state:'UNKNOWN'};return {state:'ACKNOWLEDGED',etag};}catch(error){if(error instanceof SourceControlError)throw error;return {state:'UNKNOWN'};}
 }
 async completeMultipart(key:string,id:string,parts:readonly {part:number;etag:string}[],signal?:AbortSignal):Promise<'ACKNOWLEDGED'|'EXISTS'|'UNKNOWN'>{
  if(!id||id.length>4096||!parts.length||parts.length>10000||parts.some((p,i)=>p.part!==i+1||!p.etag||p.etag.length>1024))sourceError('INVALID_MULTIPART','Ordered exact part receipt list required');
  const body=Buffer.from('<CompleteMultipartUpload>'+parts.map(p=>'<Part><PartNumber>'+p.part+'</PartNumber><ETag>'+xml(p.etag)+'</ETag></Part>').join('')+'</CompleteMultipartUpload>');
  try{const response=await this.request('POST',key,body,[['uploadId',id]],true,signal),text=await response.text();if(response.status===412)return 'EXISTS';if(response.status>=500||response.status===429||response.status===409||text.includes('<Error>'))return 'UNKNOWN';if(response.status!==200)sourceError('OBJECT_BACKEND_REJECTED','S3 rejected multipart completion');return 'ACKNOWLEDGED';}catch(error){if(error instanceof SourceControlError)throw error;return 'UNKNOWN';}
 }
 async abortMultipart(key:string,id:string,signal?:AbortSignal):Promise<'ACKNOWLEDGED'|'UNKNOWN'>{try{const response=await this.request('DELETE',key,undefined,[['uploadId',id]],false,signal);await response.body?.cancel();if(response.status===204||response.status===404)return 'ACKNOWLEDGED';return 'UNKNOWN';}catch(error){if(error instanceof SourceControlError)throw error;return 'UNKNOWN';}}
}
export {S3SourceObjectBackend as SourceS3Backend};
