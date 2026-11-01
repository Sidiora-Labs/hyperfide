import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {createHash,createPrivateKey,createPublicKey,generateKeyPairSync,randomUUID} from 'node:crypto';

let controllerLock;
const VERIFIER_ACTIONS=['fleet.test.executor.pending','qualification.preparation.execute','qualification.preparation.inspect','qualification.job.claim','qualification.execute','qualification.execution.inspect'];
const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
const hash=value=>'sha256:'+createHash('sha256').update(value).digest('hex');
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const fail=(code,uncertain=false)=>{throw Object.assign(new Error(code),{code,uncertain});};
const absolute=value=>typeof value==='string'&&path.isAbsolute(value)&&path.resolve(value)===value&&!value.includes('\0');
async function protectedFile(filename,privateFile=false,maximum=2097152){
 if(!absolute(filename)||await fs.realpath(filename)!==filename)fail('TEST_CONTROLLER_PATH');
 const fd=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const before=await fd.stat();if(!before.isFile()||before.nlink!==1||before.uid!==0||(before.mode&0o022)!==0||privateFile&&(before.mode&0o077)!==0||before.size>maximum)fail('TEST_CONTROLLER_PERMISSIONS');const bytes=await fd.readFile(),after=await fd.stat();if(before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||bytes.length!==before.size)fail('TEST_CONTROLLER_INPUT_CHANGED');return bytes;}finally{await fd.close();}
}
async function atomic(filename,value){const temporary=filename+'.'+randomUUID(),fd=await fs.open(temporary,'wx',0o600);try{await fd.writeFile(JSON.stringify(value)+'\n');await fd.sync();}finally{await fd.close();}await fs.rename(temporary,filename);const directory=await fs.open(path.dirname(filename),'r');try{await directory.sync();}finally{await directory.close();}}
function event(name,fields={}){process.stdout.write(JSON.stringify({event:name,...fields})+'\n');}
async function main(){
 if(process.getuid?.()!==0)fail('TEST_CONTROLLER_ROOT_REQUIRED');
 const args=process.argv.slice(2);if(args.length!==4||args[0]!=='--manifest'||args[2]!=='--transport-config'||!absolute(args[1])||!absolute(args[3]))fail('TEST_CONTROLLER_ARGUMENTS');
 const manifestBytes=await protectedFile(args[1]),manifest=JSON.parse(manifestBytes),transport=JSON.parse(await protectedFile(args[3],true,65536));
 const slot=manifest.template?.slots?.[0],binding=manifest.binding;
 if(manifest.schema_version!==1||manifest.kind!=='FLEET_NATIVE_TEST_BOOTSTRAP_V1'||!uuid(manifest.bootstrap_id)||!binding||![binding.organisation_id,binding.run_id,binding.sandbox_id,binding.boot_id].every(uuid)||!Array.isArray(manifest.template?.slots)||manifest.template.slots.length!==1||slot.kind!=='TEST'||slot.credential_sensitive!==false||!uuid(slot.session_id)||!uuid(slot.slot_id)||!absolute(manifest.template.slot_root)||!absolute(manifest.template.runner_binary)||typeof manifest.template.runner_binary_digest!=='string'||!/^sha256:[0-9a-f]{64}$/.test(manifest.template.runner_binary_digest)||!uuid(transport.credential_id)||!absolute(transport.key_path)||typeof transport.origin!=='string'||!transport.origin.startsWith('https://')||!absolute(transport.ca_file)||transport.grant_path)fail('TEST_CONTROLLER_BINDING');
 const manifestDigest=hash(canonical(manifest));
 const native=manifest.template.runner_binary;if(hash(await protectedFile(native,false,16777216))!==manifest.template.runner_binary_digest)fail('TEST_CONTROLLER_NATIVE_PIN');
 const directory=path.join(path.dirname(args[3]),'test-controller');await fs.mkdir(directory,{mode:0o700,recursive:true});
 const stat=await fs.lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==0||(stat.mode&0o077)!==0||await fs.realpath(directory)!==directory)fail('TEST_CONTROLLER_STATE');
 const lock=net.createServer(socket=>socket.destroy());controllerLock=lock;await new Promise((resolve,reject)=>{lock.once('error',()=>reject(Object.assign(new Error('TEST_CONTROLLER_RUNNING'),{code:'TEST_CONTROLLER_RUNNING'})));lock.listen('\0hf-test:'+hash(directory).slice(7),resolve);});
 const stateFile=path.join(directory,'state.json'),keyFile=path.join(directory,'verifier.pem'),verifierConfig=path.join(directory,'verifier-transport.json');
 const identity={bootstrap_id:manifest.bootstrap_id,manifest_digest:hash(manifestBytes),organisation_id:binding.organisation_id,run_id:binding.run_id,sandbox_id:binding.sandbox_id,boot_id:binding.boot_id,boot_generation:String(binding.boot_generation),session_id:slot.session_id,slot_id:slot.slot_id};
 let state;try{state=JSON.parse(await protectedFile(stateFile,true));if(state.schema_version!==1||JSON.stringify(state.binding)!==JSON.stringify(identity))fail('TEST_CONTROLLER_STATE_BINDING');}catch(error){if(error.code!=='ENOENT')throw error;state={schema_version:1,binding:identity,pending:null,delegated:null,terminal:null};await atomic(stateFile,state);}
 const abort=new AbortController();process.on('SIGTERM',()=>abort.abort());process.on('SIGINT',()=>abort.abort());
 const save=()=>atomic(stateFile,state);
 const invoke=async command=>{
  if(hash(await protectedFile(native,false,16777216))!==manifest.template.runner_binary_digest)fail('TEST_CONTROLLER_NATIVE_PIN');
  const payload=JSON.stringify({run_id:binding.run_id,component:command.component,action:command.action,input:command.input,expected_version:null,authority:null});
  const request={config_path:command.actor==='RUNNER'?args[3]:verifierConfig,payload_json:payload,operation_id:command.operation_id,idempotency_key:command.operation_id,correlation_id:command.operation_id};
  const child=spawn(native,['--component','12.1','--action','supervisor.invoke'],{stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:directory,LANG:'C.UTF-8'},signal:abort.signal});const chunks=[];let size=0;
  child.stdout.on('data',part=>{size+=part.length;if(size>2097152)child.kill('SIGKILL');else chunks.push(part);});child.stderr.resume();child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(request));
  const exit=await new Promise((resolve,reject)=>{child.once('error',()=>reject(Object.assign(new Error('TEST_CONTROLLER_RPC_UNKNOWN'),{code:'TEST_CONTROLLER_RPC_UNKNOWN',uncertain:true})));child.once('close',resolve);});
  if(exit!==0||size>2097152)fail('TEST_CONTROLLER_RPC_UNKNOWN',true);
  let response;try{const envelope=JSON.parse(Buffer.concat(chunks));response=envelope.ok===true?envelope.result:null;}catch{fail('TEST_CONTROLLER_RPC_UNKNOWN',true);}
  if(!response||!response.completed||response.uncertain||!response.response)fail('TEST_CONTROLLER_RPC_UNKNOWN',true);
  const body=response.response;if(body.operation_id!==command.operation_id)fail('TEST_CONTROLLER_RPC_UNKNOWN',true);
  if(response.accepted!==true||body.ok!==true){const code=typeof body.error?.code==='string'?body.error.code:'TEST_CONTROLLER_RPC_REFUSED';fail(code,['OUTCOME_UNKNOWN','HANDLER_FAILED','RESPONSE_TOO_LARGE'].includes(code));}
  if(!body.result||typeof body.result!=='object')fail('TEST_CONTROLLER_RPC_UNKNOWN',true);
  return body.result;
 };
 const observeCleanup=async selected=>{
  if(!selected||selected.manifest_digest!==manifestDigest||selected.slot_id!==slot.slot_id||typeof selected.slot_generation!=='string'||!/^[1-9][0-9]*$/.test(selected.slot_generation))fail('TEST_CONTROLLER_CLEANUP_BINDING');
  if(hash(await protectedFile(native,false,16777216))!==manifest.template.runner_binary_digest)fail('TEST_CONTROLLER_NATIVE_PIN');
  const child=spawn(native,['--component','12.1','--action','supervisor.slot.release'],{stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:directory,LANG:'C.UTF-8'},signal:abort.signal}),chunks=[];let size=0;
  child.stdout.on('data',part=>{size+=part.length;if(size>16384)child.kill('SIGKILL');else chunks.push(part);});child.stderr.resume();child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({root:path.join(manifest.template.slot_root,binding.sandbox_id,binding.boot_id),slot_id:slot.slot_id}));
  const exit=await new Promise((resolve,reject)=>{child.once('error',()=>reject(Object.assign(new Error('TEST_CONTROLLER_CLEANUP_UNKNOWN'),{code:'TEST_CONTROLLER_CLEANUP_UNKNOWN',uncertain:true})));child.once('close',resolve);});
  if(exit!==0||size>16384)fail('TEST_CONTROLLER_CLEANUP_UNCONFIRMED');
  let receipt;try{const envelope=JSON.parse(Buffer.concat(chunks));if(envelope.ok!==true||!envelope.result||typeof envelope.result!=='object')fail('TEST_CONTROLLER_CLEANUP_UNCONFIRMED');receipt=envelope.result;}catch{fail('TEST_CONTROLLER_CLEANUP_UNCONFIRMED');}
  if(receipt.slot_id!==slot.slot_id||receipt.released!==true||receipt.observed_process_absent!==true)fail('TEST_CONTROLLER_CLEANUP_UNCONFIRMED');
  return {request_nonce:randomUUID(),observed_at:new Date().toISOString(),manifest_digest:manifestDigest,slot_id:slot.slot_id,slot_generation:selected.slot_generation,session_id:slot.session_id,sandbox_id:binding.sandbox_id,boot_id:binding.boot_id,boot_generation:String(binding.boot_generation),native_receipt:receipt};
 };
 const complete=async command=>{const result=await invoke(command);if(command.action==='identity.principal.delegate'){if(result.role!=='VERIFIER'||result.actor_id!==slot.session_id||result.run_id!==binding.run_id||result.sandbox_id!==binding.sandbox_id||result.boot_id!==binding.boot_id||String(result.boot_generation)!==String(binding.boot_generation)||!uuid(result.credential_id)||typeof result.expires_at!=='string')fail('TEST_CONTROLLER_DELEGATION_BINDING',true);state.delegated={...result,public_key_b64:command.input.public_key_b64};}state.pending=null;await save();return result;};
 const call=async(actor,component,action,input,operation=randomUUID())=>{const command={actor,component,action,input,operation_id:operation};if(state.pending&&JSON.stringify(state.pending)!==JSON.stringify(command))fail('TEST_CONTROLLER_RECONCILIATION_REQUIRED',true);state.pending??=command;await save();try{return await complete(state.pending);}catch(error){if(!error.uncertain){state.pending=null;await save();}throw error;}};
 const childConfig=async()=>{if(!state.delegated)return;const key=createPrivateKey(await protectedFile(keyFile,true,16384));if(createPublicKey(key).export({format:'jwk'}).x!==state.delegated.public_key_b64)fail('TEST_CONTROLLER_KEY_BINDING');await atomic(verifierConfig,{origin:transport.origin,ca_file:transport.ca_file,key_path:keyFile,credential_id:state.delegated.credential_id,timeout_ms:60000,run_id:binding.run_id});};
 try{
  await childConfig();if(state.pending){event('reconcile',{operation_id:state.pending.operation_id,action:state.pending.action});const command=state.pending;await call(command.actor,command.component,command.action,command.input,command.operation_id);await childConfig();}
  while(!abort.signal.aborted&&!state.terminal){
   const actor=!state.forceRunner&&state.delegated&&Date.parse(state.delegated.expires_at)>Date.now()+90000?'VERIFIER':'RUNNER';
   let pending;try{pending=await call(actor,'fleet-test-executor','fleet.test.executor.pending',{bootstrap_id:manifest.bootstrap_id,session_id:slot.session_id});}catch(error){if(actor==='VERIFIER'&&!error.uncertain&&['AUTH_STALE_SESSION','AUTH_REVOKED','AUTH_EXPIRED'].includes(error.code)){state.forceRunner=true;await save();continue;}if(!error.uncertain&&['BOOTSTRAP_TEST_NOT_READY','BOOTSTRAP_TEST_SLOT','RUNNER_PREPARATION_REQUIRED'].includes(error.code)){await new Promise(resolve=>setTimeout(resolve,1000));continue;}throw error;}
   if(pending.state==='DELEGATE_VERIFIER'){
    if(pending.session_id!==slot.session_id||!Array.isArray(pending.allowed_actions)||JSON.stringify([...pending.allowed_actions].sort())!==JSON.stringify([...VERIFIER_ACTIONS].sort())||!Number.isSafeInteger(pending.ttl_seconds)||pending.ttl_seconds<60||pending.ttl_seconds>3600||!Number.isSafeInteger(pending.required_lifetime_ms)||pending.required_lifetime_ms<1000||pending.required_lifetime_ms>pending.ttl_seconds*1000-60000)fail('TEST_CONTROLLER_DELEGATION_SCOPE');
    const renewed=await call('RUNNER','14.1','identity.principal.renew',{ttl_seconds:pending.ttl_seconds});
    if(renewed.role!=='RUNNER'||renewed.credential_id!==transport.credential_id||renewed.run_id!==binding.run_id||renewed.sandbox_id!==binding.sandbox_id||renewed.boot_id!==binding.boot_id||String(renewed.boot_generation)!==String(binding.boot_generation)||!Number.isFinite(Date.parse(renewed.expires_at))||Date.parse(renewed.expires_at)<Date.now()+pending.required_lifetime_ms+30000)fail('TEST_CONTROLLER_RUNNER_LIFETIME');
    let key;try{key=createPrivateKey(await protectedFile(keyFile,true,16384));}catch(error){if(error.code!=='ENOENT')throw error;const pair=generateKeyPairSync('ed25519');await fs.writeFile(keyFile,pair.privateKey.export({format:'pem',type:'pkcs8'}),{flag:'wx',mode:0o600});const fd=await fs.open(keyFile,'r');try{await fd.sync();}finally{await fd.close();}key=pair.privateKey;}
    const public_key_b64=createPublicKey(key).export({format:'jwk'}).x;
    await call('RUNNER','14.1','identity.principal.delegate',{session_id:slot.session_id,public_key_b64,allowed_actions:pending.allowed_actions,ttl_seconds:pending.ttl_seconds});if(!Number.isFinite(Date.parse(state.delegated.expires_at))||Date.parse(state.delegated.expires_at)<Date.now()+pending.required_lifetime_ms)fail('TEST_CONTROLLER_VERIFIER_LIFETIME');state.forceRunner=false;await save();await childConfig();event('verifier_delegated',{session_id:slot.session_id});continue;
   }
   if(['SUCCEEDED','FAILED','CANCELLED'].includes(pending.state)){
    if(pending.state==='CANCELLED')fail('TEST_CONTROLLER_CANCELLED_RECONCILIATION');
    if(pending.retired!==true){state.forceRunner=true;await save();if(actor!=='RUNNER')continue;const cleanup_observation=await observeCleanup(pending.cleanup_binding);const observed=await call('RUNNER','fleet-test-executor','fleet.test.executor.pending',{bootstrap_id:manifest.bootstrap_id,session_id:slot.session_id,cleanup_observation});if(observed.retired!==true){await new Promise(resolve=>setTimeout(resolve,5000));continue;}}
    state.terminal={state:pending.state,job_id:pending.job_id,outcome:pending.outcome};await save();event('terminal',state.terminal);break;
   }
   if(!Array.isArray(pending.commands)||pending.commands.length>1)fail('TEST_CONTROLLER_COMMAND_SCOPE');
   for(const command of pending.commands){if(actor!=='VERIFIER'||!command||!uuid(command.operation_id)||command.component!=='16.2'||!['qualification.preparation.execute','qualification.job.claim','qualification.execute'].includes(command.action)||!command.input||typeof command.input!=='object')fail('TEST_CONTROLLER_COMMAND_SCOPE');event('execute',{operation_id:command.operation_id,action:command.action});await call('VERIFIER',command.component,command.action,command.input,command.operation_id);}
   if(!pending.commands.length)await new Promise(resolve=>setTimeout(resolve,1000));
  }
 }finally{await new Promise(resolve=>lock.close(resolve));}
}
await main().catch(async error=>{if(controllerLock?.listening)await new Promise(resolve=>controllerLock.close(resolve));event('waiting',{code:typeof error?.code==='string'?error.code:'TEST_CONTROLLER_FAILED',uncertain:error?.uncertain===true});process.exitCode=error?.uncertain?75:78;});
