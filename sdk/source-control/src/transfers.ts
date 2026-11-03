import {SourceControlClient,type SourceCallOptions} from './client.js';
import {SourceControlError,decodeSourceResponse,type SourceObjectKind,SOURCE_API_PATH} from './contracts.js';
export interface SourceTransfer {
 schema_version:1;transfer_id:string;direction:'UPLOAD'|'DOWNLOAD';object_id:string;size_bytes:string;
 state:'PREPARING'|'ACTIVE'|'FINALIZING'|'COMPLETED'|'CANCELLED'|'FAILED'|'EXPIRED';part_bytes:number;
 transferred_bytes:string;verified:boolean;expires_at:string;error_code:string|null;
 parts:{part_index:number;offset_bytes:string;size_bytes:string;state:'PENDING'|'COMPLETE'}[];
 grant?:{url:string;token:string};
}
export interface SourceTransferInput {transfer_id:string;direction:'UPLOAD'|'DOWNLOAD';object_id:string;kind?:SourceObjectKind;size_bytes?:string;expires_at:string;paths?:string[];revision_id?:string}
export class SourceTransferClient {
 private readonly origin:string;
 constructor(private readonly source:SourceControlClient,endpoint:string,private readonly transport:typeof globalThis.fetch=globalThis.fetch){
  const parsed=new URL(endpoint);if(parsed.protocol!=='https:'||parsed.pathname!==SOURCE_API_PATH||parsed.search||parsed.hash||parsed.username||parsed.password)throw new SourceControlError('INVALID_ENDPOINT','Transfers require the trusted HTTPS source endpoint');this.origin=parsed.origin;
 }
 create(input:SourceTransferInput,options?:SourceCallOptions){return this.source.call<SourceTransfer>('source.transfers.create',input,options);}
 read(transfer_id:string,options?:SourceCallOptions){return this.source.call<SourceTransfer>('source.transfers.read',{transfer_id},options);}
 complete(transfer_id:string,object_id:string,options?:SourceCallOptions){return this.source.call<SourceTransfer>('source.transfers.complete',{transfer_id,object_id},options);}
 cancel(transfer_id:string,options?:SourceCallOptions){return this.source.call<SourceTransfer>('source.transfers.cancel',{transfer_id},options);}
 private grant(transfer:SourceTransfer):{url:string;token:string}{
  if(transfer.state!=='ACTIVE'||!transfer.grant)throw new SourceControlError('TRANSFER_NOT_READY','Transfer has no active data grant');
  const url=new URL(transfer.grant.url);if(url.origin!==this.origin||!/^\/api\/v1\/source-control\/transfers\/[0-9a-f-]{36}$/.test(url.pathname)||url.search||url.hash||url.username||url.password||transfer.grant.token.length>16384||!/^[A-Za-z0-9_.-]+$/.test(transfer.grant.token))throw new SourceControlError('INVALID_TRANSFER_GRANT','Transfer grant is outside the trusted source endpoint');return transfer.grant;
 }
 private range(transfer:SourceTransfer,offset:number):{end:number;size:number}{const size=Number(transfer.size_bytes);if(!Number.isSafeInteger(size)||size<1||size>8388608||transfer.part_bytes!==1048576||!Number.isSafeInteger(offset)||offset<0||offset>=size||offset%transfer.part_bytes!==0)throw new SourceControlError('INVALID_RANGE','Select one exact bounded transfer part');return{end:Math.min(size,offset+transfer.part_bytes),size};}
 private async request(transfer:SourceTransfer,init:RequestInit,maximum:number):Promise<{response:Response;bytes:Uint8Array}>{
  const grant=this.grant(transfer);let response:Response;
  try{response=await this.transport(grant.url,{...init,signal:AbortSignal.any([AbortSignal.timeout(30000),...(init.signal?[init.signal]:[])]),redirect:'error',headers:{...init.headers,authorization:'SourceTransfer '+grant.token}});}catch{throw new SourceControlError('OUTCOME_UNKNOWN','Transfer response was lost; inspect progress before retrying the same part','RETRY_SAME_OPERATION','UNKNOWN',{transfer_id:transfer.transfer_id});}
  const limit=response.ok?maximum:1048576,chunks:Uint8Array[]=[];let size=0;
  try{const reader=response.body?.getReader();if(reader)for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>limit){await reader.cancel();throw Error();}chunks.push(part.value);}}catch{throw new SourceControlError('OUTCOME_UNKNOWN','Transfer response could not be verified','RETRY_SAME_OPERATION','UNKNOWN',{transfer_id:transfer.transfer_id});}
  const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
  if(!response.ok){let value;try{value=decodeSourceResponse(bytes);}catch{throw new SourceControlError('OUTCOME_UNKNOWN','Transfer error could not be verified','RETRY_SAME_OPERATION','UNKNOWN',{transfer_id:transfer.transfer_id});}if('error'in value)throw new SourceControlError(value.error.code,value.error.message,value.error.retry,value.error.outcome,{transfer_id:transfer.transfer_id});throw new SourceControlError('OUTCOME_UNKNOWN','Transfer error could not be verified','RETRY_SAME_OPERATION','UNKNOWN',{transfer_id:transfer.transfer_id});}
  return{response,bytes};
 }
 private async verify(transfer:SourceTransfer,bytes:Uint8Array):Promise<void>{const hash=await globalThis.crypto.subtle.digest('SHA-256',Uint8Array.from(bytes).buffer),id='sha256:'+Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join('');if(bytes.length!==Number(transfer.size_bytes)||id!==transfer.object_id)throw new SourceControlError('OBJECT_INTEGRITY','Transfer bytes differ from the immutable object');}
 async upload(transfer:SourceTransfer,bytes:Uint8Array,options?:SourceCallOptions):Promise<SourceTransfer>{this.range(transfer,0);await this.verify(transfer,bytes);for(let offset=0;offset<bytes.length;offset+=transfer.part_bytes){const index=offset/transfer.part_bytes;if(!transfer.parts.some(part=>part.part_index===index&&part.state==='COMPLETE'))await this.uploadPart(transfer,offset,bytes.subarray(offset,Math.min(bytes.length,offset+transfer.part_bytes)),options?.signal);}return this.complete(transfer.transfer_id,transfer.object_id,options);}
 async download(transfer:SourceTransfer,options?:SourceCallOptions):Promise<Uint8Array>{this.range(transfer,0);const bytes=new Uint8Array(Number(transfer.size_bytes));for(let offset=0;offset<bytes.length;offset+=transfer.part_bytes)bytes.set(await this.downloadPart(transfer,offset,options?.signal),offset);await this.verify(transfer,bytes);await this.complete(transfer.transfer_id,transfer.object_id,options);return bytes;}
 async uploadPart(transfer:SourceTransfer,offset:number,bytes:Uint8Array,signal?:AbortSignal):Promise<void>{
  if(transfer.direction!=='UPLOAD')throw new SourceControlError('INVALID_TRANSFER_GRANT','Upload requires an upload grant');const range=this.range(transfer,offset);if(bytes.byteLength!==range.end-offset)throw new SourceControlError('INVALID_RANGE','Upload bytes differ from the selected part');
  const result=await this.request(transfer,{method:'PUT',headers:{'content-type':'application/octet-stream','content-range':`bytes ${offset}-${range.end-1}/${range.size}`},body:bytes as unknown as BodyInit,...(signal?{signal}:{})},0);if(result.response.status!==204)throw new SourceControlError('OUTCOME_UNKNOWN','Upload acknowledgment was invalid','RETRY_SAME_OPERATION','UNKNOWN',{transfer_id:transfer.transfer_id});
 }
 async downloadPart(transfer:SourceTransfer,offset:number,signal?:AbortSignal):Promise<Uint8Array>{
  if(transfer.direction!=='DOWNLOAD')throw new SourceControlError('INVALID_TRANSFER_GRANT','Download requires a download grant');const range=this.range(transfer,offset);const result=await this.request(transfer,{method:'GET',headers:{range:`bytes=${offset}-${range.end-1}`},...(signal?{signal}:{})},range.end-offset);
  if(result.response.status!==206||result.bytes.length!==range.end-offset||result.response.headers.get('content-range')!==`bytes ${offset}-${range.end-1}/${range.size}`||result.response.headers.get('x-source-object-id')!==transfer.object_id)throw new SourceControlError('OUTCOME_UNKNOWN','Download range could not be verified','RETRY_SAME_OPERATION','UNKNOWN',{transfer_id:transfer.transfer_id});return result.bytes;
 }
}
