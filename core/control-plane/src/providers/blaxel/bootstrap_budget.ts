import {hash,strictJSON} from '../../transport/protocol.js';
import {object} from '../../policy/programme.js';
import {fail} from '../pools.js';
import type {ComponentContext} from '../../components/registry.js';
import type {BootstrapBudgetDelivery,BootstrapBudgetTransport} from '../bootstrap_budget.js';
import {BOOTSTRAP_BUDGET_PROBE} from '../bootstrap_budget_probe.js';
import {verifiedSandbox} from './bootstrap.js';
type Data=Record<string,any>;
const quote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'";
export function createBlaxelBootstrapBudgetTransport(context:ComponentContext):BootstrapBudgetTransport{
 return {async measureBudget(input:BootstrapBudgetDelivery,signal:AbortSignal){
  const {sandbox,call,observed}=await verifiedSandbox(context,input,signal);
  if(observed.status!=='DEPLOYED'||observed.spec?.enabled===false)fail('BOOTSTRAP_BUDGET_RESOURCE','Actual running provider VM required');
  let providerLimits:Data|null=null;const contractSources:string[]=[];
  if(input.measurement_mode==='BLAXEL_MICROVM_V1'){const memory=observed.spec?.runtime?.memory;if(!Number.isSafeInteger(memory)||memory<2048||memory%2048!==0)fail('BOOTSTRAP_BUDGET_VM_LIMITS','Actual provider VM memory and core ceiling required');providerLimits={cpu_millis:String(memory/2048*1000),memory_bytes:String(BigInt(memory)*1048576n)};contractSources.push('https://docs.blaxel.ai/Sandboxes/Non-root-user#why-the-sandbox-api-stays-root','https://docs.blaxel.ai/api-reference/compute/update-sandbox');}
  const node=await call<Blob>(()=>sandbox.fs.readBinary(input.node_path));if(node.size>128*1024*1024||hash(Buffer.from(await node.arrayBuffer()))!==input.node_digest)fail('BOOTSTRAP_BUDGET_NODE','Actual pinned ROOT probe runtime required');
  const command=quote(input.node_path)+' -e '+quote(BOOTSTRAP_BUDGET_PROBE)+' '+quote(JSON.stringify({manifest_path:input.manifest_path,manifest_digest:input.manifest_digest,binding:input.binding,kernel_boot_id:input.kernel_boot_id,measurement_mode:input.measurement_mode,storage_policy:input.storage_policy,provider_limits:providerLimits,contract_sources:contractSources}));
  let process:Data|null=null;try{process=await call<Data>(s=>sandbox.process.get(input.process_id,{signal:s,retry:false}));}catch(error){if(!object(error)||![error.status,error.statusCode].includes(404))throw error;}
  if(!process){if(input.resume_only)return {state:'UNKNOWN',receipt:null};await input.markSubmitting();process=await call<Data>(()=>sandbox.process.exec({name:input.process_id,command,workingDir:'/',waitForCompletion:true,timeout:15,keepAlive:false}));}
  if(process.name!==input.process_id||process.command!==command)fail('BOOTSTRAP_BUDGET_PROCESS','Measured process identity differs from retained fixed probe');
  if(process.status==='running')return {state:'RUNNING',receipt:null};
  if(process.status!=='completed'||process.exitCode!==0){const match=typeof process.stderr==='string'&&process.stderr.length<=16384?process.stderr.match(/Error: (BUDGET_[A-Z_]{1,64})(?:\r?\n|$)/):null;return {state:'UNKNOWN',receipt:{failure_code:match?.[1]??'BUDGET_PROCESS_UNCONFIRMED',process:{name:process.name,status:process.status,exit_code:process.exitCode??null}}};}
  if(typeof process.stdout!=='string'||Buffer.byteLength(process.stdout)>65536||typeof process.stderr==='string'&&process.stderr.length)fail('BOOTSTRAP_BUDGET_OUTPUT','Bounded successful physical measurement required');
  const receipt=strictJSON(Buffer.from(process.stdout));if(!object(receipt))fail('BOOTSTRAP_BUDGET_OUTPUT','Physical measurement required');
  return {state:'COMPLETED',receipt:{measurement:receipt,provider_observation:observed,process:{name:process.name,command_digest:hash(command),status:process.status,exit_code:process.exitCode,stdout:process.stdout,stdout_digest:hash(process.stdout)}}};
 }};
}
