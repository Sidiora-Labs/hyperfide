import path from 'node:path';
import type {ComponentContext} from '../../components/registry.js';
import {hash,strictJSON} from '../../transport/protocol.js';
import {object} from '../../policy/programme.js';
import {digestDocument,fail} from '../pools.js';
import {validateProviderOperation} from '../contract.js';
import {configuredBlaxelSDK} from './images.js';
import {boundedBlaxelOperation,blaxelCreateName} from './processes.js';
import type {ProviderActivationDelivery,ProviderActivationTransport} from '../bootstrap_activation.js';
import type {BootstrapDelivery,BootstrapTransport} from '../bootstrap.js';
type Data=Record<string,any>;
function quoted(value:string):string{return "'"+value.replaceAll("'","'\\''")+"'";}
function nativeCode(process:Data):string{
 if(typeof process.stderr==='string'&&process.stderr.length<=16384){const matches=[...process.stderr.matchAll(/^hyperfide native: ([A-Z][A-Z0-9_]{0,63})\r?$/gm)];if(matches.length)return matches.at(-1)![1]!;}
 for(const text of [process.stderr,process.stdout,process.logs]){if(typeof text!=='string'||text.length>16384)continue;try{const value=strictJSON(Buffer.from(text));if(object(value)&&object(value.error)&&typeof value.error.code==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(value.error.code))return value.error.code;}catch{}}
 return 'FAILED';
}
function processOutcome(process:Data,receipt:unknown,prefix:string):{state:'RUNNING'|'COMPLETED'|'UNKNOWN';receipt:unknown|null}{
 if(['failed','killed','stopped'].includes(process.status)||process.status==='completed'&&Number.isInteger(process.exitCode)&&process.exitCode!==0)fail(prefix+'_'+nativeCode(process),'Native process failed; retain original process identity');
 if(process.status==='completed'&&process.exitCode===0){if(receipt===null)fail(prefix+'_RECEIPT_UNCONFIRMED','Native process exited without its durable completion receipt');return {state:'COMPLETED',receipt};}
 return {state:process.status==='running'?'RUNNING':'UNKNOWN',receipt};
}
async function verifiedSandbox(context:ComponentContext,input:Pick<BootstrapDelivery,'operation'|'binding'|'deadline_at'>,signal:AbortSignal){
  const op=validateProviderOperation(input.operation);
  if(op.kind!=='create'||op.scope.provider!=='blaxel'||op.scope.environment_id!==context.env.HF_BLAXEL_WORKSPACE||op.scope.provider_account_id!==context.env.HF_BLAXEL_ACCOUNT_ID||input.binding.provisioning_intent_id!==op.identity.operation_id||input.binding.configuration_digest!==op.scope.configuration_digest||input.binding.preparation_digest!==op.preparation_digest||input.binding.native_sandbox_id!==blaxelCreateName(op,input.binding.boot_generation))fail('PROVIDER_BOOTSTRAP_SCOPE','Bootstrap requires exact trusted CREATE/resource scope');
  const deadline=Date.parse(input.deadline_at),call=<T>(fn:(signal:AbortSignal)=>Promise<T>)=>boundedBlaxelOperation(fn,signal,deadline);
  const api=await configuredBlaxelSDK(context) as unknown as Data;
  const actual=await call<Data>(s=>api.getSandbox({path:{sandboxName:input.binding.native_sandbox_id},throwOnError:false,signal:s}));
  if(actual.response.status!==200||actual.error!==undefined||!object(actual.data))fail('PROVIDER_BOOTSTRAP_IDENTITY','Actual provider resource metadata unavailable');
  const observed=actual.data as Data,labels=observed.metadata?.labels;
  if(observed.metadata?.name!==input.binding.native_sandbox_id||observed.metadata?.workspace!==op.scope.environment_id||observed.spec?.region!==op.scope.region||labels?.['hyperfide-operation']!==op.identity.operation_id||labels?.['hyperfide-payload']!==op.identity.payload_digest||labels?.['hyperfide-scope']!==digestDocument(op.scope)||labels?.['hyperfide-boot']!==input.binding.boot_generation||labels?.['hyperfide-preparation']!==op.preparation_digest)fail('PROVIDER_BOOTSTRAP_IDENTITY','Observed resource ownership differs from admitted CREATE');
  const sandbox=await call<Data>(()=>api.SandboxInstance.get(input.binding.native_sandbox_id));
 return {sandbox,call};
}
export function createBlaxelBootstrapTransport(context:ComponentContext):BootstrapTransport{
 return {async deliverBootstrap(input:BootstrapDelivery,signal:AbortSignal){
  const {sandbox,call}=await verifiedSandbox(context,input,signal);
  const manifest=strictJSON(input.manifest);if(!object(manifest)||!object(manifest.template))fail('PROVIDER_BOOTSTRAP_MANIFEST','Exact native bootstrap manifest required');
  const receiptPath=path.join(String(manifest.template.state_root),input.binding.sandbox_id,input.binding.boot_id,'bootstrap-receipt.json');
  const readReceipt=async()=>{try{const blob=await call<Blob>(()=>sandbox.fs.readBinary(receiptPath));if(blob.size>1024*1024)fail('PROVIDER_BOOTSTRAP_RECEIPT','Bounded native receipt required');return strictJSON(Buffer.from(await blob.arrayBuffer()));}catch{return null;}};
  const command=(action:string)=>quoted(input.native_path)+' --component 12.1 --action '+action+' --request-base64 '+quoted(Buffer.from(JSON.stringify({manifest_path:input.manifest_path,manifest_digest:input.manifest_digest})).toString('base64url'));
  const lookup=async(name:string)=>{try{return await call<Data>(s=>sandbox.process.get(name,{signal:s,retry:false}));}catch(error){if(error&&typeof error==='object'&&((error as Data).status===404||(error as Data).statusCode===404))return null;throw error;}};
  const existing=await lookup(input.process_id);
  if(existing){if(existing.command!==command('supervisor.bootstrap'))fail('PROVIDER_BOOTSTRAP_PROCESS','Retained process differs from immutable bootstrap command');return processOutcome(existing,await readReceipt(),'BOOTSTRAP_NATIVE');}
  if(input.resume_only)return {state:'UNKNOWN',receipt:await readReceipt()};
  for(const file of input.files){await input.assertCurrent();if(hash(file.bytes)!==file.digest)fail('PROVIDER_BOOTSTRAP_ARTIFACT','Bootstrap artifact bytes changed');await call(()=>sandbox.fs.uploadWithMultipart(file.path,new Blob([new Uint8Array(file.bytes)]),file.mode));const read=await call<Blob>(()=>sandbox.fs.readBinary(file.path));if(read.size!==file.bytes.length||hash(Buffer.from(await read.arrayBuffer()))!==file.digest)fail('PROVIDER_BOOTSTRAP_ARTIFACT','Provider readback differs from delivered artifact');}
  await input.assertCurrent();
  await call(()=>sandbox.fs.mkdir(path.dirname(input.manifest_path),'0700'));
  await call(()=>sandbox.fs.uploadWithMultipart(input.manifest_path,new Blob([new Uint8Array(input.manifest)]),'0600'));
  const stageName=input.process_id+'-stage',stageCommand=command('supervisor.bootstrap.stage');let staged=await lookup(stageName);
  if(staged&&staged.command!==stageCommand)fail('PROVIDER_BOOTSTRAP_PROCESS','Retained staging process differs');
  await input.assertCurrent();
  if(!staged)staged=await call<Data>(()=>sandbox.process.exec({name:stageName,command:stageCommand,workingDir:'/',waitForCompletion:true,timeout:15,keepAlive:false}));
  if(staged.status!=='completed'||staged.exitCode!==0)fail('BOOTSTRAP_STAGE_'+nativeCode(staged),'Native protected bootstrap staging is unconfirmed');
  await input.assertCurrent();
  await call(()=>sandbox.fs.uploadWithMultipart(input.secret_path,new Blob([new Uint8Array(input.secret)]),'0600'));
  await input.markSubmitting();
  const launched=await call<Data>(()=>sandbox.process.exec({name:input.process_id,command:command('supervisor.bootstrap'),workingDir:'/',waitForCompletion:false,timeout:0,keepAlive:true}));
  if(launched.name!==input.process_id||launched.command!==command('supervisor.bootstrap'))fail('PROVIDER_BOOTSTRAP_PROCESS','Provider did not retain exact bootstrap process identity');
  return processOutcome(launched,await readReceipt(),'BOOTSTRAP_NATIVE');
 }};
}

export function createBlaxelBootstrapActivationTransport(context:ComponentContext):ProviderActivationTransport{
 return {async activateBootstrap(input:ProviderActivationDelivery,signal:AbortSignal){
  const {sandbox,call}=await verifiedSandbox(context,input,signal);
  const original=await call<Blob>(()=>sandbox.fs.readBinary(input.manifest_path));
  if(original.size>1024*1024)fail('WORKER_ACTIVATION_MANIFEST','Bounded original bootstrap manifest required');
  const manifestBytes=Buffer.from(await original.arrayBuffer());if(hash(manifestBytes)!==input.manifest_digest)fail('WORKER_ACTIVATION_MANIFEST','Original bootstrap manifest changed');
  const manifest=strictJSON(manifestBytes);if(!object(manifest)||!object(manifest.template))fail('WORKER_ACTIVATION_MANIFEST','Original native template required');
  const state=path.join(String(manifest.template.state_root),input.binding.sandbox_id,input.binding.boot_id),receiptPath=path.join(state,'activation-receipt.json');
  if(input.activation_path!==path.join(state,'activation-permit.json')||input.helper_path===manifest.template.runner_binary)fail('WORKER_ACTIVATION_SCOPE','Exact protected activation path and separate sidecar required');
  const readReceipt=async()=>{try{const blob=await call<Blob>(()=>sandbox.fs.readBinary(receiptPath));if(blob.size>1024*1024)return null;return strictJSON(Buffer.from(await blob.arrayBuffer()));}catch{return null;}};
  const request={manifest_path:input.manifest_path,manifest_digest:input.manifest_digest,activation_path:input.activation_path,activation_digest:input.activation_digest};
  const command=quoted(input.helper_path)+' --component 12.1 --action supervisor.bootstrap.activate --request-base64 '+quoted(Buffer.from(JSON.stringify(request)).toString('base64url'));
  let existing:Data|null=null;try{existing=await call<Data>(s=>sandbox.process.get(input.process_id,{signal:s,retry:false}));}catch(error){if(!error||typeof error!=='object'||![(error as Data).status,(error as Data).statusCode].includes(404))throw error;}
  if(existing){if(existing.command!==command)fail('WORKER_ACTIVATION_PROCESS','Retained activation process differs');return processOutcome(existing,await readReceipt(),'ACTIVATION_NATIVE');}
  if(input.resume_only)return {state:'UNKNOWN',receipt:await readReceipt()};
  if(hash(input.helper)!==input.helper_digest||hash(input.activation)!==input.activation_digest)fail('WORKER_ACTIVATION_ARTIFACT','Pinned activation bytes changed');
  await input.assertCurrent();await call(()=>sandbox.fs.mkdir(path.dirname(input.helper_path),'0700'));
  await call(()=>sandbox.fs.uploadWithMultipart(input.helper_path,new Blob([new Uint8Array(input.helper)]),input.helper_mode));
  const delivered=await call<Blob>(()=>sandbox.fs.readBinary(input.helper_path));if(delivered.size!==input.helper.length||hash(Buffer.from(await delivered.arrayBuffer()))!==input.helper_digest)fail('WORKER_ACTIVATION_ARTIFACT','Activation sidecar provider readback differs');
  await input.assertCurrent();await call(()=>sandbox.fs.uploadWithMultipart(input.activation_path,new Blob([new Uint8Array(input.activation)]),'0600'));
  await input.markSubmitting();
  const launched=await call<Data>(()=>sandbox.process.exec({name:input.process_id,command,workingDir:'/',waitForCompletion:false,timeout:0,keepAlive:true}));
  if(launched.name!==input.process_id||launched.command!==command)fail('WORKER_ACTIVATION_PROCESS','Provider did not retain exact activation process');
  return processOutcome(launched,await readReceipt(),'ACTIVATION_NATIVE');
 }};
}
