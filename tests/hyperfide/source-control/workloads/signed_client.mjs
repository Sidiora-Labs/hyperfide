import assert from 'node:assert/strict';
import {randomUUID,createHash,createPrivateKey,createPublicKey} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {readPrivate} from './deployment.mjs';

async function publicKeyIdentity(filename){
 const file=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);let bytes;
 try{const stat=await file.stat();assert(stat.isFile()&&stat.size>0&&stat.size<=65536&&stat.nlink===1&&!(stat.mode&0o077)&&stat.uid===process.getuid());bytes=await file.readFile();const key=createPublicKey(createPrivateKey(bytes)).export({type:'spki',format:'der'});return createHash('sha256').update(key).digest('hex');}finally{bytes?.fill(0);await file.close();}
}

/** Uses the shipped signed SDK and reloads issuer-owned configuration between attempts. */
export async function reloadingSignedClient(config,{sdkRoot,signal,observe,credentialVersion}){
 const {createSignedSourceClient}=await import(pathToFileURL(path.join(sdkRoot,'signed.js')));
 const {encodeSourceRequest,encodeSourceResponse}=await import(pathToFileURL(path.join(sdkRoot,'contracts.js')));
 async function call(action,input,options={}){
  const operation_id=options.operation_id??randomUUID(),started=performance.now();
  const effectiveSignal=options.signal?AbortSignal.any([signal(),options.signal]):signal();
  const request=encodeSourceRequest({protocol_version:1,scope:config.scope,operation_id,action,input,...(options.idempotency_key?{idempotency_key:options.idempotency_key}:{}),...(options.authority?{authority:options.authority}:{})});
  for(let attempt=0;;attempt++){
   effectiveSignal.throwIfAborted();
   const raw=await readPrivate(config.signed_config_file),selected=JSON.parse(raw);
   assert.equal(selected.endpoint,config.endpoint);assert.deepEqual(selected.scope,config.scope);
   const keyIdentity=await publicKeyIdentity(selected.key_file);
   const client=await createSignedSourceClient(selected);
   if(keyIdentity!==await publicKeyIdentity(selected.key_file)){assert(performance.now()-started<300000,'Issuer rotated continuously during client installation');continue;}
   const before=performance.now();
   try{
    const result=await client.call(action,input,{...options,operation_id,signal:effectiveSignal});
    const response=encodeSourceResponse({protocol_version:1,operation_id,result},{action});
    credentialVersion(selected.credential_id+':'+keyIdentity);
    await observe({operation_id,attempt,elapsed_ms:performance.now()-before,status:'ACKNOWLEDGED',request_bytes:request.byteLength,response_bytes:response.byteLength,measurement:'canonical verified SDK envelopes'});
    return result;
   }catch(error){
    await observe({operation_id,attempt,elapsed_ms:performance.now()-before,status:'REFUSED_OR_UNKNOWN',error_code:error.code??error.message,request_bytes:request.byteLength,response_bytes:null,measurement:'failed response bytes unavailable through signed SDK'});
    if(effectiveSignal.aborted||performance.now()-started>=300000||!(error.code==='OUTCOME_UNKNOWN'||error.retry==='RETRY_SAME_OPERATION'||error.retry==='RESUME'&&['OVERLOADED','SERVICE_UNAVAILABLE','SOURCE_UNAVAILABLE','STORAGE_UNAVAILABLE','RATE_LIMITED'].includes(error.code)))throw error;
    await delay(Math.min(5000,100*2**Math.min(attempt,6)),undefined,{signal:effectiveSignal});
   }
  }
 }
 return {call,capabilities:()=>call('source.capabilities',{}),revision:revision_id=>call('source.revisions.read',{revision_id}),object:object_id=>call('source.objects.read',{object_id}),tree:(tree_id,page={})=>call('source.trees.entries',{tree_id,...page}),lookup:(tree_id,value)=>call('source.trees.lookup',{tree_id,path:value})};
}
