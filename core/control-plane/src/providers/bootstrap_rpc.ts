import fs from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import {constants} from 'node:fs';
import {createPrivateKey,randomUUID,sign} from 'node:crypto';
import {FoundationError,object} from '../policy/programme.js';
import {assertInvocation,exact,hash,signingBytes,strictJSON,uuid} from '../transport/protocol.js';
import type {InvocationContext} from '../transport/protocol.js';

export interface BootstrapRpcDescriptor {origin:string;ca_file:string}
export interface BootstrapIdentityRequest {
 organisation_id:string;run_id:string;credential_id:string;operation_id:string;idempotency_key:string;
 action:'identity.binding.observe'|'identity.grant.issue';input:Record<string,unknown>;
}
export interface BootstrapRejectionEvidence {schema_version:1;kind:'BOOTSTRAP_RPC_REJECTION_V1';organisation_id:string;run_id:string;credential_id:string;origin:string;action:string;operation_id:string;input_digest:string;payload_digest:string;response_digest:string;http_status:number;code:string;observed_at:string}
export class BootstrapRpcRejection extends FoundationError{constructor(public readonly evidence:BootstrapRejectionEvidence){super(evidence.code,evidence.code);}}
function denied(code:string):never {throw new FoundationError(code,code);}
async function privateBytes(filename:unknown,limit:number):Promise<Buffer>{
 if(typeof filename!=='string'||!path.isAbsolute(filename)||path.normalize(filename)!==filename||await fs.realpath(filename)!==filename)denied('BOOTSTRAP_RPC_CONFIG');
 const file=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const before=await file.stat();if(!before.isFile()||before.nlink!==1||before.uid!==process.getuid?.()||(before.mode&0o777)!==0o600||before.size<1||before.size>limit)denied('BOOTSTRAP_RPC_CONFIG');
  const bytes=await file.readFile(),after=await file.stat(),current=await fs.lstat(filename);
  if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||bytes.length!==before.size||current.isSymbolicLink()||current.dev!==before.dev||current.ino!==before.ino)denied('BOOTSTRAP_RPC_CONFIG');
  return bytes;
 }finally{await file.close();}
}

/** Descriptor is supplied exclusively by the protected provider bootstrap configuration loader. */
export async function bootstrapIdentityRpc(env:Readonly<NodeJS.ProcessEnv>,invocation:InvocationContext,descriptor:BootstrapRpcDescriptor,input:BootstrapIdentityRequest,signal:AbortSignal):Promise<unknown>{
 try{
  assertInvocation(invocation);exact(descriptor,['origin','ca_file']);exact(input,['organisation_id','run_id','credential_id','operation_id','idempotency_key','action','input']);
  const principal=invocation.principal;
  if(principal.role!=='PROVISIONER'||input.organisation_id!==principal.organisation_id||input.run_id!==principal.run_id||input.credential_id!==principal.credential_id||!uuid(input.operation_id)||!uuid(input.idempotency_key)||!['identity.binding.observe','identity.grant.issue'].includes(input.action)||!object(input.input)||!principal.allowed_actions.includes(input.action))denied('BOOTSTRAP_RPC_SCOPE');
  if(typeof descriptor.origin!=='string')denied('BOOTSTRAP_RPC_CONFIG');
  const origin=new URL(descriptor.origin);if(origin.protocol!=='https:'||origin.origin!==descriptor.origin||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)denied('BOOTSTRAP_RPC_CONFIG');
  const config=strictJSON(await privateBytes(env.HF_PROVISIONER_EXECUTOR_CONFIG_FILE,65536));exact(config,['schema_version','principals','concurrency']);
  if(config.schema_version!==1||!Array.isArray(config.principals)||config.principals.length!==1||!Number.isSafeInteger(config.concurrency)||Number(config.concurrency)<1||Number(config.concurrency)>16)denied('BOOTSTRAP_RPC_CONFIG');
  const signer=config.principals[0];exact(signer,['credential_id','key_path']);if(signer.credential_id!==principal.credential_id)denied('BOOTSTRAP_RPC_SCOPE');
  const raw=await privateBytes(signer.key_path,16384);let key:ReturnType<typeof createPrivateKey>;
  try{key=raw[0]===45?createPrivateKey(raw):createPrivateKey({key:raw,format:'der',type:'pkcs8'});}finally{raw.fill(0);}
  if(key.asymmetricKeyType!=='ed25519')denied('BOOTSTRAP_RPC_CONFIG');
  const ca=await privateBytes(descriptor.ca_file,1048576),payload=Buffer.from(JSON.stringify({run_id:input.run_id,component:'14.1',action:input.action,input:input.input,expected_version:null,authority:null}));
  if(payload.length>65536)denied('BOOTSTRAP_RPC_LIMIT');
  const body=Buffer.from(JSON.stringify({protocol_version:1,operation_id:input.operation_id,idempotency_key:input.idempotency_key,payload_digest:hash(payload),correlation_id:input.operation_id,causation_id:null,payload_b64:payload.toString('base64url')}));
  const proof={id:principal.credential_id,time:String(Math.floor(Date.now()/1000)),nonce:randomUUID()},signature=sign(null,signingBytes(descriptor.origin,'/v1/invoke',proof,body),key).toString('base64url');
  const combined=AbortSignal.any([signal,invocation.signal,AbortSignal.timeout(15000)]);
  const result=await new Promise<unknown>((resolve,reject)=>{
   const request=https.request(new URL('/v1/invoke',origin),{method:'POST',ca,rejectUnauthorized:true,agent:false,signal:combined,headers:{'content-type':'application/json','content-length':body.length,'HF-Credential-Id':proof.id,'HF-Request-Time':proof.time,'HF-Request-Nonce':proof.nonce,'HF-Request-Signature':signature}},response=>{
    const chunks:Buffer[]=[];let size=0;
    response.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>1048576){request.destroy();reject(new FoundationError('BOOTSTRAP_RPC_LIMIT','BOOTSTRAP_RPC_LIMIT'));}else chunks.push(chunk);});
    response.on('error',()=>reject(new FoundationError('BOOTSTRAP_RPC_TRANSPORT','BOOTSTRAP_RPC_TRANSPORT')));
    response.on('end',()=>{try{
     const responseBytes=Buffer.concat(chunks),value=strictJSON(responseBytes);if(!object(value)||value.protocol_version!==1||(Object.hasOwn(value,'operation_id')&&value.operation_id!==input.operation_id))denied('BOOTSTRAP_RPC_RESPONSE');
     if(response.statusCode!==200||value.ok!==true){const code=object(value.error)&&typeof value.error.code==='string'&&/^[A-Z][A-Z0-9_]{0,95}$/.test(value.error.code)?value.error.code:'BOOTSTRAP_RPC_REFUSED';if([200,400].includes(response.statusCode??0)&&value.ok===false&&code==='INVALID_REQUEST'&&input.action==='identity.grant.issue')throw new BootstrapRpcRejection({schema_version:1,kind:'BOOTSTRAP_RPC_REJECTION_V1',organisation_id:input.organisation_id,run_id:input.run_id,credential_id:input.credential_id,origin:descriptor.origin,action:input.action,operation_id:input.operation_id,input_digest:hash(Buffer.from(JSON.stringify(input.input))),payload_digest:hash(payload),response_digest:hash(responseBytes),http_status:response.statusCode!,code,observed_at:new Date().toISOString()});denied(code);}
     if(value.operation_id!==input.operation_id)denied('BOOTSTRAP_RPC_RESPONSE');
     if(!Object.hasOwn(value,'result'))denied('BOOTSTRAP_RPC_RESPONSE');resolve(value.result);
    }catch(error){reject(error);}});
   });
   request.on('error',()=>reject(new FoundationError('BOOTSTRAP_RPC_TRANSPORT','BOOTSTRAP_RPC_TRANSPORT')));request.end(body);
  });
  return result;
 }catch(error){if(error instanceof BootstrapRpcRejection)throw error;const code=error instanceof FoundationError&&/^[A-Z][A-Z0-9_]{0,95}$/.test(error.code)?error.code:'BOOTSTRAP_RPC_FAILED';return denied(code);}
}
