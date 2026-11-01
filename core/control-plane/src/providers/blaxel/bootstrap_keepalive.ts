import type {ComponentContext} from '../../components/registry.js';
import {hash,strictJSON} from '../../transport/protocol.js';
import {object} from '../../policy/programme.js';
import {fail,digestDocument} from '../pools.js';
import {durationSeconds} from './lifetime.js';
import {verifiedSandbox} from './bootstrap.js';
import {fleetReadinessCanonical} from '../../preparation/fleet_readiness_contract.js';
import type {BootstrapKeepaliveTransport} from '../bootstrap_keepalive.js';
type Data=Record<string,any>;
const quote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'";
export function createBlaxelBootstrapKeepaliveTransport(context:ComponentContext):BootstrapKeepaliveTransport{return{
 async observeKeepalive(input,signal){
  const {sandbox,call,observed}=await verifiedSandbox(context,{...input,deadline_at:new Date(Date.now()+30000).toISOString()},signal),created=Date.parse(observed.metadata?.createdAt),runtime=observed.spec?.runtime,lifecycle=observed.spec?.lifecycle,bounds:number[]=[];
  if(runtime?.ttl!==undefined&&runtime.ttl!==null){if(!Number.isFinite(created))fail('BOOTSTRAP_KEEPALIVE_LIFETIME','Actual provider creation time required');bounds.push(created+durationSeconds(runtime.ttl)*1000);}
  if(runtime?.expires!==undefined&&runtime.expires!==null){const at=Date.parse(runtime.expires);if(!Number.isFinite(at))fail('BOOTSTRAP_KEEPALIVE_LIFETIME','Actual provider expiry invalid');bounds.push(at);}
  if(Array.isArray(lifecycle?.expirationPolicies))for(const policy of lifecycle.expirationPolicies){if(policy.type==='ttl-max-age'&&policy.action==='delete'){if(!Number.isFinite(created))fail('BOOTSTRAP_KEEPALIVE_LIFETIME','Actual provider creation time required');bounds.push(created+durationSeconds(policy.value)*1000);}else if(policy.type==='date'&&policy.action==='delete'){const at=Date.parse(policy.value);if(!Number.isFinite(at))fail('BOOTSTRAP_KEEPALIVE_LIFETIME','Actual provider deletion date invalid');bounds.push(at);}}
  if(!bounds.length||Math.min(...bounds)<=Date.now())fail('BOOTSTRAP_KEEPALIVE_LIFETIME','Existing bounded VM lifetime required');
  const wake=new Date().toISOString(),manifest=await call<Blob>(()=>sandbox.fs.readBinary(input.manifest_path));if(manifest.size>1048576||hash(Buffer.from(await manifest.arrayBuffer()))!==input.manifest_digest)fail('BOOTSTRAP_KEEPALIVE_MANIFEST','Original manifest changed');
  const node=await call<Blob>(()=>sandbox.fs.readBinary(input.node_path));if(node.size>128*1024*1024||hash(Buffer.from(await node.arrayBuffer()))!==input.node_digest)fail('BOOTSTRAP_KEEPALIVE_NODE','Pinned Node must physically exist before installation');
  return{vm_expires_at:new Date(Math.min(...bounds)).toISOString(),wake_observed_at:wake};
 },
 async keepObserver(input,signal){
  const {sandbox,call}=await verifiedSandbox(context,input,signal),remaining=Math.floor((Date.parse(input.deadline_at)-Date.now())/1000);
  if(hash(input.probe_script)!==input.probe_digest)fail('BOOTSTRAP_KEEPALIVE_PROCESS','Retained fixed keeper program changed');
  const payload={manifest_path:input.manifest_path,manifest_digest:input.manifest_digest,binding:input.binding,daemon:input.daemon,deadline_ms:Date.parse(input.deadline_at),request_digest:input.request_digest},command=quote(input.node_path)+' -e '+quote(input.probe_script)+' '+quote(fleetReadinessCanonical(payload));
  let existing:Data|null=null;try{existing=await call<Data>(s=>sandbox.process.get(input.process_id,{signal:s,retry:false}));}catch(error){if(!object(error)||![error.status,error.statusCode].includes(404))throw error;}
  const result=(process:Data)=>{if(process.name!==input.process_id||process.command!==command)fail('BOOTSTRAP_KEEPALIVE_PROCESS','Retained keeper command differs');let proof:Data|null=null;if(typeof process.stdout==='string'&&Buffer.byteLength(process.stdout)<=8192){const first=process.stdout.split('\n').filter(Boolean);if(first.length===1){const parsed=strictJSON(Buffer.from(first[0]!));if(object(parsed))proof=parsed;}}return{state:process.status==='running'?'RUNNING' as const:['completed','failed','killed','stopped'].includes(process.status)?'STOPPED' as const:'UNKNOWN' as const,proof};};
  if(existing)return result(existing);if(input.resume_only)return{state:'UNKNOWN',proof:null};
  if(remaining<1)fail('BOOTSTRAP_KEEPALIVE_LIFETIME','Keeper deadline already expired');
  await input.assertCurrent();const node=await call<Blob>(()=>sandbox.fs.readBinary(input.node_path));if(node.size>128*1024*1024||hash(Buffer.from(await node.arrayBuffer()))!==input.node_digest)fail('BOOTSTRAP_KEEPALIVE_NODE','Actual pinned runtime changed');
  await input.markSubmitting();const finalRemaining=Math.floor((Date.parse(input.deadline_at)-Date.now())/1000);if(finalRemaining<1)fail('BOOTSTRAP_KEEPALIVE_LIFETIME','Keeper deadline expired before execution');const launched=await call<Data>(()=>sandbox.process.exec({name:input.process_id,command,workingDir:'/',waitForCompletion:false,timeout:finalRemaining,keepAlive:true,restartOnFailure:false,maxRestarts:0}));return result(launched);
 }
};}
