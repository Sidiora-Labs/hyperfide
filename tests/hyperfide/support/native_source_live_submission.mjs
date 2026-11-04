import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import https from 'node:https';
import {createHash} from 'node:crypto';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');

export async function interruptSignedResponseOnce({invoke, action, request, operationId}) {
  assert.equal(typeof invoke,'function');
  assert.match(operationId,/^[0-9a-f-]{36}$/i);
  const originalRequest=https.request;
  let observed,unknown;
  https.request=function(...args) {
    const callbackIndex=args.findLastIndex(value=>typeof value==='function');
    if(callbackIndex<0)return originalRequest.apply(this,args);
    const callback=args[callbackIndex],url=args[0];
    let outgoing,credential;
    args[callbackIndex]=incoming=>{
      if(outgoing?.action!==action||outgoing.operation_id!==operationId) {callback(incoming);return;}
      const chunks=[];let size=0;
      incoming.on('data',chunk=>{
        size+=chunk.length;
        if(size>1048576) {req.destroy(new Error('Live interruption response exceeded bound'));return;}
        chunks.push(chunk);
      });
      incoming.on('error',error=>req.destroy(error));
      incoming.on('end',()=>{
        try {
          const body=Buffer.concat(chunks),response=JSON.parse(body.toString());
          assert.equal(incoming.statusCode,200);
          assert.equal(response.operation_id,operationId);
          assert(Object.hasOwn(response,'result')&&!Object.hasOwn(response,'error'));
          observed={endpoint:new URL(url).origin,credential_id:credential,request:outgoing,response,response_sha256:digest(body),interrupted_at:new Date().toISOString()};
          // No Response or body reaches the SDK. Its native request rejects after
          // the real server has returned the committed operation result.
          req.destroy(new Error('Injected live source response interruption'));
        }catch(error){req.destroy(error);}
      });
    };
    const req=originalRequest.apply(this,args);
    const originalEnd=req.end;
    req.end=function(body,...args){
      if(body){try{outgoing=JSON.parse(Buffer.from(body).toString());}catch{}}
      credential=req.getHeader('HF-Credential-Id');
      return originalEnd.call(this,body,...args);
    };
    return req;
  };
  try {
    await assert.rejects(()=>invoke(action,request,{operation_id:operationId,idempotency_key:operationId}),error=>{
      unknown={code:error.code,outcome:error.outcome,retry:error.retry,operation_id:error.details?.operation_id};
      return error.code==='OUTCOME_UNKNOWN'&&error.outcome==='UNKNOWN'&&error.details?.operation_id===operationId;
    });
    assert(observed,'Exact real source response was not intercepted');
    return {observed,unknown};
  } finally {https.request=originalRequest;}
}

/** Run inside the actual current worker before its first submission. */
export async function witnessLiveSubmissionReplay({invoke, request, operationId, outputFile}) {
  assert(request.assignment_id&&request.revision_id);
  const startedAt=new Date().toISOString();
  const interruption=await interruptSignedResponseOnce({invoke,action:'source.fleet.submit',request,operationId});
  const replay=await invoke('source.fleet.submit',request,{operation_id:operationId,idempotency_key:operationId});
  assert.equal(replay.assignment_id,request.assignment_id);
  assert.equal(replay.revision_id,request.revision_id);
  assert.deepEqual(replay,interruption.observed.response.result);
  const receipt={schema_version:1,kind:'live-worker-submission-transport-interruption',operation_id:operationId,request,started_at:startedAt,...interruption,reconciled_at:new Date().toISOString(),response:replay,response_sha256:digest(JSON.stringify(replay))};
  await fs.writeFile(outputFile,JSON.stringify(receipt,null,2)+'\n',{mode:0o600,flag:'wx'});
  return replay;
}
