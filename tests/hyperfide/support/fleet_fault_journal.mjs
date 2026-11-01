#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import {createPrivateKey,createHash,randomUUID,sign} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {decodeInvoke,signingBytes,canonicalOrigin} from '../../../core/control-plane/dist/transport/protocol.js';

const actions=new Set(['artifact.object.put','identity.describe','fleet.install.register','fleet.install.admit','fleet.install.status','fleet.install.delivery.pending','fleet.install.delivery.collect','fleet.install.delivery.schedule','fleet.observe','fleet.decision.apply','fleet.session.reason','runner.job.status','runner.stop','runner.cancel','runner.observe']);
const digest=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
function demand(value,code){if(!value)throw new Error(code);}
async function protectedBytes(filename,maximum=4*1024*1024){
 const absolute=path.resolve(filename),s=await fs.lstat(absolute);
 demand(absolute===filename&&await fs.realpath(absolute)===absolute&&s.isFile()&&s.uid===process.getuid()&&(s.mode&0o077)===0&&s.nlink===1&&s.size>0&&s.size<=maximum,'PRIVATE_INPUT_REQUIRED');
 return fs.readFile(absolute);
}
async function exclusive(filename,value){
 const bytes=Buffer.from(JSON.stringify(value)+'\n');const handle=await fs.open(filename,'wx',0o600);
 try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
 return digest(bytes);
}
function exchange(origin,ca,body,headers,timeout){
 return new Promise((resolve,reject)=>{
  const request=https.request(new URL('/v1/invoke',origin),{method:'POST',ca,headers,timeout},response=>{
   const chunks=[];let total=0;
   response.on('data',bytes=>{total+=bytes.length;if(total>4*1024*1024){request.destroy(new Error('RESPONSE_BOUND'));return;}chunks.push(bytes);});
   response.on('end',()=>{try{const raw=Buffer.concat(chunks);resolve({http_status:response.statusCode,body:JSON.parse(raw.toString('utf8')),body_digest:digest(raw),body_base64:raw.toString('base64')});}catch{reject(new Error('INVALID_RESPONSE'));}});
  });
  request.on('timeout',()=>request.destroy(new Error('TRANSPORT_TIMEOUT')));request.on('error',()=>reject(new Error('TRANSPORT_UNCERTAIN')));request.end(body);
 });
}

export async function invokeFaultStep({configFile,requestFile,journalDirectory}){
 const config=JSON.parse((await protectedBytes(configFile,65536)).toString('utf8'));
 const body=await protectedBytes(requestFile);const decoded=decodeInvoke(body),origin=canonicalOrigin(config.origin);
 demand(decoded.payload&&actions.has(decoded.payload.action),'ACTION_NOT_REVIEWED');
 demand(decoded.payload.run_id===config.run_id,'RUN_MISMATCH');
 demand(typeof config.organisation_id==='string'&&typeof config.run_id==='string'&&typeof config.credential_id==='string','AUTHORITY_SCOPE_REQUIRED');
 if(decoded.payload.input.organisation_id!==undefined)demand(decoded.payload.input.organisation_id===config.organisation_id,'ORGANISATION_MISMATCH');
 if(decoded.payload.input.run_id!==undefined)demand(decoded.payload.input.run_id===config.run_id,'RUN_MISMATCH');
 demand(typeof config.case==='string'&&typeof config.authority_epoch==='string'&&/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(config.source_object_id),'CASE_SOURCE_BINDING_REQUIRED');
 demand(config.timeout_ms>=1&&config.timeout_ms<=120000,'BOUNDED_TIMEOUT_REQUIRED');
 const root=path.resolve(journalDirectory),st=await fs.lstat(root);demand(root===journalDirectory&&await fs.realpath(root)===root&&st.isDirectory()&&st.uid===process.getuid()&&(st.mode&0o077)===0,'PRIVATE_JOURNAL_REQUIRED');
 const filename=path.join(root,decoded.operation.operation_id+'.json');
 try{await fs.lstat(filename);throw new Error('OPERATION_ALREADY_RECORDED_NO_REPLAY');}catch(error){if(error.code!=='ENOENT')throw error;}
 const keyBytes=await protectedBytes(config.key_file,16384);let key;try{key=createPrivateKey(keyBytes);}finally{keyBytes.fill(0);}demand(key.asymmetricKeyType==='ed25519','EXISTING_ED25519_IDENTITY_REQUIRED');
 const item={id:config.credential_id,time:String(Math.floor(Date.now()/1000)),nonce:randomUUID()};
 const headers={'Content-Type':'application/json','HF-Credential-Id':item.id,'HF-Request-Time':item.time,'HF-Request-Nonce':item.nonce,'HF-Request-Signature':sign(null,signingBytes(origin,'/v1/invoke',item,body),key).toString('base64url')};
 const ca=await fs.readFile(config.ca_file);
 const retained={schema_version:1,kind:'hyperfide.authenticated-fault-step',origin,case:config.case,authority_epoch:config.authority_epoch,source_object_id:config.source_object_id,organisation_id:config.organisation_id,run_id:config.run_id,driver_digest:digest(await fs.readFile(new URL(import.meta.url))),operation_id:decoded.operation.operation_id,request_digest:digest(body),body_base64:body.toString('base64'),headers,state:'SUBMITTING'};
 await exclusive(filename,retained);
 let response;
 try{response=await exchange(origin,ca,body,headers,config.timeout_ms);}catch(error){await exclusive(filename+'.uncertain.json',{operation_id:retained.operation_id,state:'UNKNOWN',reason:error.message});throw error;}
 const result={...retained,state:'OBSERVED',response};const responseFile=filename+'.response.json';const responseDigest=await exclusive(responseFile,result);
 return {operation_id:retained.operation_id,state:'OBSERVED',receipt_path:responseFile,receipt_digest:responseDigest,http_status:response.http_status,ok:response.body.ok===true,qualification:'NOT_EVALUATED'};
}

async function main(){
 demand(process.argv.length===5,'USE_CONFIG_REQUEST_JOURNAL_ARGUMENTS');
 const result=await invokeFaultStep({configFile:process.argv[2],requestFile:process.argv[3],journalDirectory:process.argv[4]});process.stdout.write(JSON.stringify(result)+'\n');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(error=>{process.stderr.write(JSON.stringify({error:{code:/^[A-Z_]+$/.test(error.message)?error.message:'FAULT_DRIVER_FAILED'}})+'\n');process.exitCode=1;});
