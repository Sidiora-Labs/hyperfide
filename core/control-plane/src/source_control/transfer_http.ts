import type {IncomingMessage,ServerResponse} from 'node:http';
import {SourceControlError} from './contracts.js';
import {SOURCE_TRANSFER_PATH,SOURCE_TRANSFER_PART_BYTES,type SourceTransferService} from './transfers.js';

export function isSourceTransferPath(url:string|undefined):boolean{return typeof url==='string'&&url.startsWith(SOURCE_TRANSFER_PATH+'/');}

export async function handleSourceTransferHttp(service:SourceTransferService|undefined,request:IncomingMessage,response:ServerResponse,signal:AbortSignal):Promise<boolean>{
 if(!isSourceTransferPath(request.url))return false;
 const match=new RegExp('^'+SOURCE_TRANSFER_PATH+'/([0-9a-f-]{36})$').exec(request.url!);
 const grantId=match?.[1]??'00000000-0000-0000-0000-000000000000';
 try{
  if(!match)throw new SourceControlError('INVALID_TRANSFER_GRANT','Invalid source transfer path');
  if(!service)throw new SourceControlError('SERVICE_UNAVAILABLE','Source transfers are not configured');
  if(request.method!=='GET'&&request.method!=='PUT')throw new SourceControlError('INVALID_REQUEST','Source transfer grants accept GET or PUT only');
  const names=['authorization','range','content-range','content-length','content-type','content-encoding'];
  for(const name of names)if(request.rawHeaders.filter((_value,index)=>index%2===0&&request.rawHeaders[index]!.toLowerCase()===name).length>1)throw new SourceControlError('INVALID_TRANSFER_GRANT','Duplicate transfer request header');
  const authorization=request.headers.authorization;
  if(typeof authorization!=='string'||!/^SourceTransfer [A-Za-z0-9_.-]{1,16384}$/.test(authorization))throw new SourceControlError('INVALID_TRANSFER_GRANT','An exact source transfer grant is required');
  if(request.headers['content-encoding']!==undefined||request.method==='PUT'&&request.headers['content-type']!=='application/octet-stream')throw new SourceControlError('INVALID_REQUEST','Transfer bytes require uncompressed application/octet-stream');
  const limit=request.method==='GET'?0:SOURCE_TRANSFER_PART_BYTES,parts:Buffer[]=[];let size=0;
  for await(const chunk of request){signal.throwIfAborted();size+=chunk.length;if(size>limit)throw new SourceControlError('LIMIT_EXCEEDED','Transfer body exceeds its part limit');parts.push(Buffer.from(chunk));}
  signal.throwIfAborted();
  const output=await service.redeem({grant_id:grantId,token:authorization.slice('SourceTransfer '.length),url:new URL(request.url!,new URL(service.endpoint()).origin).toString(),method:request.method,...(typeof request.headers.range==='string'?{range:request.headers.range}:{}),...(typeof request.headers['content-range']==='string'?{content_range:request.headers['content-range']}:{}),...(request.method==='PUT'?{body:Buffer.concat(parts)}:{})},signal);
  if(!response.destroyed&&!response.writableEnded){response.writeHead(output.status,{...output.headers,'cache-control':'no-store','x-content-type-options':'nosniff'});response.end(output.body);}
 }catch(error){
  const failure=error instanceof SourceControlError?error:signal.aborted?new SourceControlError('OUTCOME_UNKNOWN','Transfer response was interrupted','RETRY_SAME_OPERATION','UNKNOWN'):new SourceControlError('INTERNAL_ERROR','Source transfer failed');
  const code=failure.code,status=code==='INVALID_TRANSFER_GRANT'||code.includes('DENIED')?403:code.includes('NOT_FOUND')?404:code.includes('LIMIT')?413:code.includes('CONFLICT')?409:code.includes('UNAVAILABLE')?503:failure.outcome==='UNKNOWN'?504:code==='INTERNAL_ERROR'?500:400;
  if(!response.destroyed&&!response.writableEnded){const body=Buffer.from(JSON.stringify({protocol_version:1,operation_id:grantId,error:{code,message:failure.message,retry:failure.retry,outcome:failure.outcome}}));response.writeHead(status,{'content-type':'application/json','content-length':body.length,'cache-control':'no-store'});response.end(body);}
 }
 return true;
}
