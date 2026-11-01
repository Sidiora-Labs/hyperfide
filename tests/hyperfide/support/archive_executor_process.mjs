import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import readline from 'node:readline';
import {randomUUID,createPrivateKey,sign} from 'node:crypto';
const [dist,components,policyFile]=process.argv.slice(2),controller=new AbortController();
const {ComponentRegistry}=await import(pathToFileURL(dist+'/components/registry.js'));
const {hash,signingBytes}=await import(pathToFileURL(dist+'/transport/protocol.js'));
const {validatePolicy}=await import(pathToFileURL(dist+'/policy/programme.js'));
const raw=JSON.parse(fs.readFileSync(policyFile,'utf8')),policy=validatePolicy(raw,raw.spec_revision,'provisioner');
const registry=new ComponentRegistry({role:'provisioner',policy,signal:controller.signal,env:Object.freeze({...process.env})});
try {
 await registry.load(components,dist);
 const identity=registry.resolveCapability('14.1','identity.authority',value=>value&&typeof value.authorize==='function');
 registry.installInvocationAuthorizer(invocation=>identity.authorize(invocation));
 process.stderr.write(JSON.stringify({event:'archive-component-executor-ready'})+'\n');
 const config=JSON.parse(fs.readFileSync(process.env.HF_RUNNER_EXECUTOR_CONFIG_FILE,'utf8')),signer=config.principals[0],key=createPrivateKey(fs.readFileSync(signer.key_path));
 const lines=readline.createInterface({input:process.stdin});
 for await(const line of lines){let request;try{request=JSON.parse(line);if(request.operation==='close')break;
  const operation=randomUUID(),payload=Buffer.from(JSON.stringify({run_id:policy.programme_id,component:request.operation==='status'?'12.4-executor':'14.1',action:request.operation==='status'?'runner.executor.describe':'identity.describe',input:{},expected_version:null,authority:null})),body=Buffer.from(JSON.stringify({protocol_version:1,operation_id:operation,idempotency_key:operation,payload_digest:hash(payload),correlation_id:operation,causation_id:null,payload_b64:payload.toString('base64url')})),proof={id:signer.credential_id,time:String(Math.floor(Date.now()/1000)),nonce:randomUUID()};
  const signature=sign(null,signingBytes(identity.origin,'/v1/invoke',proof,body),key).toString('base64url'),invocation=await identity.authenticate(body,['hf-credential-id',proof.id,'hf-request-time',proof.time,'hf-request-nonce',proof.nonce,'hf-request-signature',signature],controller.signal);await identity.authorize(invocation);
  if(request.operation==='status'){const result=await registry.invoke('12.4-executor','runner.executor.describe',invocation.payload.input,invocation);const gateway=registry.resolveCapability('4.2','storage.transactions.v1',value=>value&&typeof value.withPrimaryTransaction==='function');const diagnostic=await gateway.withPrimaryTransaction({timeoutMs:5000},async tx=>{const connection=(await tx.query('SELECT current_database(),current_user')).rows;const principal=(await tx.query('SELECT * FROM hyperfide.identity_principals WHERE credential_id=$1',[signer.credential_id])).rows[0];try{const {nextFleetCompletion}=await import(pathToFileURL(dist+'/runner/fleet_completion.js'));const target=await nextFleetCompletion(tx,principal);const jobBindings=[];const {readRunnerPreparationBinding}=await import(pathToFileURL(dist+'/runner/bridge.js'));for(const job of (await tx.query("SELECT operation_id,job_class,state,claim_id,plan->'binding' AS binding FROM hyperfide.runner_remote_jobs")).rows){try{const current=await readRunnerPreparationBinding(tx,job.binding);jobBindings.push({operation_id:job.operation_id,state:job.state,claim_id:job.claim_id,differences:Object.keys(job.binding).filter(k=>JSON.stringify(job.binding[k])!==JSON.stringify(current[k])).map(k=>({key:k,admitted:job.binding[k],current:current[k],admitted_type:typeof job.binding[k],current_type:typeof current[k]}))});}catch(error){jobBindings.push({operation_id:job.operation_id,state:job.state,binding_error:error.code??error.name});}}return {connection,completion_target:target,job_bindings:jobBindings,provider_operations:(await tx.query('SELECT state,outcome FROM hyperfide.provider_remote_operations')).rows,admitted_jobs:(await tx.query("SELECT operation_id,state,plan?'binding' AS has_binding FROM hyperfide.runner_remote_jobs WHERE state='ADMITTED'")).rows}}catch(error){return {connection,completion_error:{code:error.code??error.name,message:error.message,stack:error.stack}}}});process.stdout.write(JSON.stringify({id:request.id,ok:true,result,diagnostic})+'\n');continue}
  if(request.operation!=='native')throw Error('Unsupported component control');
  const native=registry.resolveCapability('12.4-executor','runner.native.v1',value=>value&&typeof value.invokeNativeRunner==='function');
  const result=await native.invokeNativeRunner(invocation,request.input,controller.signal);process.stdout.write(JSON.stringify({id:request.id,ok:true,result})+'\n');
 }catch(error){process.stdout.write(JSON.stringify({id:request?.id??null,ok:false,error:{code:error.code??error.name,message:error.message}})+'\n')}}
}finally{controller.abort();await registry.close()}
