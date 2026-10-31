import fs from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import {createPrivateKey,randomUUID,sign} from 'node:crypto';
import {constants} from 'node:fs';
import {canonicalOrigin,fail,hash,signingBytes,strictJSON,uuid} from '../transport/protocol.js';
import {object} from '../policy/programme.js';
export interface InstallAdmission{schema_version:1;kind:'hyperfide.fleet-install-admission';operation_id:string;organisation_id:string;run_id:string;environment_id:string;environment_generation:number;sandbox_id:string;boot_id:string;boot_generation:string;authority_epoch:string;input_digest:string;environment_root:string;slot_bindings:Array<{slot:number;worker_slot_id:string;uid:number;gid:number;slot_generation:string;worker_root:string;source:string;home:string;build:string;temporary:string;dirty:string}>;package_digest:string;source_config_digest:string;plan_digest:string;source_revision:string;source_manifest_digest:string;read_scope:string[];write_scope:string[];expires_at:string;admission_digest:string}
export interface InstallAuthorityClient{status(operationId:string):Promise<{admission:InstallAdmission;state:string;receipt:Record<string,any>|null;receipt_digest:string|null}>;complete(operationId:string,receipt:Record<string,any>,isolation?:unknown):Promise<{state:string;receipt:Record<string,any>;receipt_digest:string}>}
export async function readProtectedFile(filename:string,maximum=4*1024*1024,privateFile=false):Promise<Buffer>{
 if(!path.isAbsolute(filename)||path.resolve(filename)!==filename||await fs.realpath(filename)!==filename)fail('FLEET_BOOTSTRAP_PATH','Absolute non-symlink bootstrap path required');
 const handle=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const before=await handle.stat();if(!before.isFile()||before.uid!==process.getuid?.()||(before.mode&0o022)!==0||privateFile&&(before.mode&0o077)!==0||before.size>maximum)fail('FLEET_BOOTSTRAP_PERMISSIONS','Bounded owned bootstrap file without untrusted writes required');const bytes=await handle.readFile(),after=await handle.stat();if(before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||bytes.length!==before.size)fail('FLEET_BOOTSTRAP_CHANGED','Bootstrap input changed while read');return bytes;}finally{await handle.close();}
}
export async function createInstallAuthorityClient(filename:string):Promise<InstallAuthorityClient>{
 const parsed=strictJSON(await readProtectedFile(filename,65536,true));
 if(!object(parsed)||parsed.schema_version!==1||typeof parsed.origin!=='string'||typeof parsed.ca_file!=='string'||typeof parsed.key_file!=='string'||!uuid(parsed.credential_id)||!uuid(parsed.run_id)||typeof parsed.auth_profile!=='string')fail('FLEET_AUTHORITY_CONFIG','Existing enrolled identity transport configuration required');
 const config=parsed as Record<string,any>,origin=canonicalOrigin(config.origin),ca=await readProtectedFile(config.ca_file,65536),keyBytes=await readProtectedFile(config.key_file,16384,true),key=createPrivateKey(keyBytes);keyBytes.fill(0);if(key.asymmetricKeyType!=='ed25519')fail('FLEET_AUTHORITY_CONFIG','Existing Ed25519 identity required');
 const invoke=async(action:string,input:Record<string,unknown>,operationId=randomUUID()):Promise<Record<string,any>>=>{
  const payload=Buffer.from(JSON.stringify({run_id:config.run_id,component:'fleet-install',action,input,expected_version:null,authority:null}));
  const body=Buffer.from(JSON.stringify({protocol_version:1,operation_id:operationId,idempotency_key:operationId,payload_digest:hash(payload),correlation_id:operationId,causation_id:null,payload_b64:payload.toString('base64url')}));
  const proof={id:config.credential_id as string,time:String(Math.floor(Date.now()/1000)),nonce:randomUUID()},signature=sign(null,signingBytes(origin,'/v1/invoke',proof,body),key).toString('base64url');
  return await new Promise<Record<string,any>>((resolve,reject)=>{
   const request=https.request(new URL('/v1/invoke',origin),{method:'POST',ca,rejectUnauthorized:true,minVersion:'TLSv1.3',agent:false,signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json','Content-Length':body.length,'HF-Credential-Id':proof.id,'HF-Request-Time':proof.time,'HF-Request-Nonce':proof.nonce,'HF-Request-Signature':signature}},response=>{
    const chunks:Buffer[]=[];let length=0;response.on('data',(part:Buffer)=>{length+=part.length;if(length>1024*1024)response.destroy();else chunks.push(part);});response.once('error',()=>reject(Object.assign(new Error('Authority response uncertain; reconcile original install operation'),{code:'FLEET_AUTHORITY_UNKNOWN'})));response.once('end',()=>{try{const value=strictJSON(Buffer.concat(chunks));if(!object(value)||value.protocol_version!==1||value.operation_id!==operationId||value.ok!==true||!object(value.result))fail('FLEET_AUTHORITY_REJECTED','Current authenticated authority refused install operation');resolve(value.result as Record<string,any>);}catch(error){reject(error);}});
   });request.once('error',()=>reject(Object.assign(new Error('Authority outcome unknown; preserve staging and retry operation'),{code:'FLEET_AUTHORITY_UNKNOWN'})));request.end(body);
  });
 };
 return {status:async operationId=>await invoke('fleet.install.status',{operation_id:operationId}) as Awaited<ReturnType<InstallAuthorityClient['status']>>,complete:async(operationId,receipt,isolation)=>await invoke('fleet.install.complete',{operation_id:operationId,receipt,receipt_digest:receipt.receipt_digest,isolation}) as Awaited<ReturnType<InstallAuthorityClient['complete']>>};
}
