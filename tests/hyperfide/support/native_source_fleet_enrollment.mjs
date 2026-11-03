import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const installed=new WeakSet();
const sourceActions=['source.objects.put','source.workspaces.detail','source.workspaces.checkpoint','source.operations.read','source.fleet.read','source.fleet.submit','source.fleet.submission'];
const digest=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');

export async function enrollNativeFleetWorker({f,resources,controlRoot,identity,identityAuthority,scope,ids,assignment,request,origin,signal=new AbortController().signal}) {
  const load=name=>import(pathToFileURL(path.join(controlRoot,name+'.js')));
  const [{signingBytes},{FoundationError},{guardFleetLaunch}]=await Promise.all([load('transport/protocol'),load('policy/programme'),load('runner/fleet')]);
  if(!installed.has(identityAuthority)){
    identityAuthority.installSourceWorkerEnroller(async(tx,invocation,credential)=>{
      try{return await f.service.fleet.enrollWorker(tx,invocation,credential);}
      catch(error){if(error?.name==='SourceControlError')throw new FoundationError(error.code,error.message);throw error;}
    });
    identityAuthority.sealTrustedRegistrations();installed.add(identityAuthority);
  }
  const task=assignment.assignment.tasks[0],workerId=assignment.assignment.worker_id;
  const runner=(await f.pool.query('SELECT * FROM hyperfide.runner_registry WHERE organisation_id=$1 AND run_id=$2 AND sandbox_id=$3 AND slot_id=$4 AND boot_generation=$5 AND state=\'CURRENT\'',[scope.organisation_id,scope.run_id,assignment.sandbox_id,assignment.tasks[0].slot_id,assignment.boot_generation])).rows[0];
  assert(runner,'The actual selected workspace must have a current runner binding');
  const runnerKey=generateKeyPairSync('ed25519'),workerKey=generateKeyPairSync('ed25519');
  await f.pool.query(`INSERT INTO hyperfide.identity_principals(credential_id,organisation_id,run_id,actor_id,role,public_key_b64,deployment_epoch,sandbox_id,boot_id,boot_generation,allowed_actions,expires_at)
    VALUES($1,$2,$3,$4,'RUNNER',$5,$6,$7,$8,$9,$10,clock_timestamp()+interval '20 minutes')`,[runner.credential_id,scope.organisation_id,scope.run_id,runner.session_id,runnerKey.publicKey.export({format:'jwk'}).x,ids.epoch,runner.sandbox_id,runner.boot_id,String(runner.boot_generation),['identity.worker.source.delegate',...sourceActions]]);
  await f.pool.query('INSERT INTO hyperfide.identity_runner_status(credential_id,preparation_digest,inventory) VALUES($1,$2,$3)',[runner.credential_id,runner.boot_preparation_digest,JSON.stringify([])]);
  const authenticate=async(action,input,operation)=>{
    const payload=Buffer.from(JSON.stringify({run_id:scope.run_id,component:'14.1',action,input,expected_version:null,authority:null}));
    const body=Buffer.from(JSON.stringify({protocol_version:1,operation_id:operation,idempotency_key:operation,payload_digest:digest(payload),correlation_id:operation,causation_id:null,payload_b64:payload.toString('base64url')}));
    const proof={id:runner.credential_id,time:String(Math.floor(Date.now()/1000)),nonce:randomUUID()};
    const headers=['HF-Credential-Id',proof.id,'HF-Request-Time',proof.time,'HF-Request-Nonce',proof.nonce,'HF-Request-Signature',sign(null,signingBytes(origin,'/v1/invoke',proof,body),runnerKey.privateKey).toString('base64url')];
    return identityAuthority.authenticate(body,headers,signal);
  };
  const token={...scope,task_id:task.task_id,attempt_id:task.attempt_id,attempt_generation:task.attempt_generation,sandbox_id:assignment.sandbox_id,slot_id:assignment.tasks[0].slot_id,sandbox_boot_generation:assignment.boot_generation};
  const plan={agent_session_id:workerId,slot_id:token.slot_id};
  let controller;
  if(request){
    const signed=await request('operator','12.2','runner.dispatch.consume',{event_id:randomUUID(),attempt_count:'1'});
    controller=await identityAuthority.authenticate(signed.body,Object.entries(signed.headers).flat(),signal);
    await resources.gateway.withPrimaryTransaction({timeoutMs:15000},tx=>guardFleetLaunch(tx,controller,token,plan,'PREPARE'));
    await assert.rejects(()=>resources.gateway.withPrimaryTransaction({timeoutMs:15000},tx=>guardFleetLaunch(tx,controller,token,plan,'EXECUTE')),error=>error.code==='FLEET_SOURCE_ASSIGNMENT_REQUIRED');
    await assert.rejects(()=>resources.gateway.withPrimaryTransaction({timeoutMs:15000},tx=>guardFleetLaunch(tx,controller,token,{...plan,agent_session_id:randomUUID()},'PREPARE')),error=>error.code==='FLEET_ASSIGNMENT_STALE');
  }
  const operation=randomUUID(),input={session_id:workerId,public_key_b64:workerKey.publicKey.export({format:'jwk'}).x};
  const invoke=async()=>{const invocation=await authenticate('identity.worker.source.delegate',input,operation);return identity.actions['identity.worker.source.delegate'](input,{invocation,resources,signal});};
  const response=await invoke(),replayed=await invoke();
  assert.deepEqual(replayed,response);
  assert.equal(response.actor_id,workerId);assert.equal(response.role,'WORKER');
  assert.equal(response.native_source.schema_version,1);
  const bound=response.native_source.assignment;
  assert.equal(bound.assignment_id,assignment.assignment.assignment_id);
  assert.equal(bound.workspace_id,assignment.assignment.source.workspace_id);
  assert.equal(bound.attempt_id,task.attempt_id);
  assert.equal(bound.attempt_generation,task.attempt_generation);
  assert.equal((await f.pool.query('SELECT count(*)::int AS count FROM hyperfide.source_fleet_assignments WHERE organisation_id=$1 AND assignment_id=$2',[scope.organisation_id,bound.assignment_id])).rows[0].count,1);
  const credentials=(await f.pool.query('SELECT allowed_actions FROM hyperfide.identity_principals WHERE credential_id=$1',[response.credential_id])).rows;
  assert.deepEqual([...credentials[0].allowed_actions].sort(),[...sourceActions].sort());
  assert.equal((await f.pool.query('SELECT count(*)::int AS count FROM hyperfide.source_principal_credentials WHERE credential_id=$1',[response.credential_id])).rows[0].count,0);
  const invokeSource=async(action,value,{operation_id=randomUUID(),idempotency_key,authority=bound.authority}={})=>{
    const request={protocol_version:1,scope:f.scope,operation_id,idempotency_key:idempotency_key??operation_id,action,input:value,authority};
    const body=Buffer.from(JSON.stringify(request)),proof={id:response.credential_id,time:String(Math.floor(Date.now()/1000)),nonce:randomUUID()};
    const headers=['HF-Credential-Id',proof.id,'HF-Request-Time',proof.time,'HF-Request-Nonce',proof.nonce,'HF-Request-Signature',sign(null,signingBytes(origin,'/api/v1/source-control',proof,body),workerKey.privateKey).toString('base64url')];
    const invocation=await identityAuthority.authenticateSource(body,headers,signal);
    return f.service.api.invoke(action,request,invocation);
  };
  const observed=await invokeSource('source.workspaces.detail',{workspace_id:bound.workspace_id});
  assert.equal(observed.workspace.workspace_id,bound.workspace_id);
  assert.equal(observed.workspace.base_revision_id,bound.base_revision_id);
  if(controller)await resources.gateway.withPrimaryTransaction({timeoutMs:15000},tx=>guardFleetLaunch(tx,controller,token,plan,'EXECUTE'));
  return {bound,identity:{principal_id:workerId,credential_id:response.credential_id,kind:'worker'},keyPair:workerKey,invokeSource,checks:[
    'signed source-only worker delegation invokes actual source enrollment and replays one immutable workspace without a source JWT mirror',
    ...(controller?['signed controller preparation requires the exact recorded worker and executable dispatch waits for issued source authority']:[]),
  ]};
}
