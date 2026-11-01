import {exact,fail} from '../transport/protocol.js';
type RecordValue=Record<string,any>;
const nativeCounters=['rpc_calls','http_responses','http_response_body_bytes','verified_object_reads','verified_object_bytes','staged_artifacts','staged_payload_bytes','cache_hits'];
function count(v:unknown):boolean{return Number.isSafeInteger(v)&&Number(v)>=0;}
export function verifyNativeArtifactTransfer(value:unknown,operation:string):RecordValue{
 exact(value,['schema_version','kind','operation_id','measurement','cache_mode',...nativeCounters]);const v=value as RecordValue;
 if(v.schema_version!==1||v.kind!=='hyperfide.artifact-stage-transfer'||v.operation_id!==operation||v.measurement!=='NATIVE_ARTIFACT_RPC_HTTP_BODY'||v.cache_mode!=='UNCACHED'||nativeCounters.some(k=>!count(v[k]))||v.cache_hits!==0||v.http_responses>v.rpc_calls||v.verified_object_reads>v.rpc_calls||v.staged_payload_bytes!==v.verified_object_bytes)fail('FLEET_TRANSFER_INVALID','Measured native staging counters differ');return v;
}
export function createFleetTransfer(operation:string,native:unknown,manifestBytes:number,cache:RecordValue|null,commandsExecuted:number,commandsReused:number):RecordValue{
 return {schema_version:1,kind:'hyperfide.fleet-install-transfer',operation_id:operation,native_stage:native==null?null:verifyNativeArtifactTransfer(native,operation),source_local:{manifest_file_bytes:manifestBytes,cache:cache?{hits:cache.hits,misses:cache.misses,cache_hit_payload_bytes:cache.read_bytes,inline_source_payload_bytes:cache.source_bytes,evicted_entries:cache.evicted_entries,evicted_bytes:cache.evicted_bytes}:null},dependency_io:{commands_executed:commandsExecuted,commands_reused:commandsReused,network_bytes:null,network_requests:null,observation:'UNOBSERVED_SUBPROCESS_NETWORK'}};
}
export function verifyFleetTransfer(value:unknown,operation:string):RecordValue{
 exact(value,['schema_version','kind','operation_id','native_stage','source_local','dependency_io']);const v=value as RecordValue;
 if(v.schema_version!==1||v.kind!=='hyperfide.fleet-install-transfer'||v.operation_id!==operation)fail('FLEET_TRANSFER_INVALID','Transfer operation differs');if(v.native_stage!==null)verifyNativeArtifactTransfer(v.native_stage,operation);
 exact(v.source_local,['manifest_file_bytes','cache']);if(!count(v.source_local.manifest_file_bytes))fail('FLEET_TRANSFER_INVALID','Measured manifest bytes required');
 if(v.source_local.cache!==null){const fields=['hits','misses','cache_hit_payload_bytes','inline_source_payload_bytes','evicted_entries','evicted_bytes'];exact(v.source_local.cache,fields);if(fields.some(k=>!count(v.source_local.cache[k])))fail('FLEET_TRANSFER_INVALID','Measured source cache counters required');}
 exact(v.dependency_io,['commands_executed','commands_reused','network_bytes','network_requests','observation']);const d=v.dependency_io;if(!count(d.commands_executed)||!count(d.commands_reused)||d.network_bytes!==null||d.network_requests!==null||d.observation!=='UNOBSERVED_SUBPROCESS_NETWORK')fail('FLEET_TRANSFER_INVALID','Dependency subprocess network must remain unobserved');return v;
}

/** Capability payload accounting is distinct from HTTP and physical object-store I/O. */
export function observeArtifactCapability<T extends {invoke:(...args:any[])=>Promise<unknown>}>(store:T,operation:string):{store:T;snapshot:()=>RecordValue}{
 const counters={successful_calls:0,object_read_calls:0,object_read_payload_bytes:0,manifest_read_calls:0,object_put_calls:0,object_put_accepted_payload_bytes:0};
 const wrapped={...store,invoke:async(...args:any[])=>{const result=await store.invoke(...args),[action,input]=args;const r=result as RecordValue;
  if(r?.outcome==='SUCCEEDED'&&r?.availability==='VERIFIED'){
   counters.successful_calls++;
   if(action==='artifact.object.read'&&typeof r.data_base64==='string'){const bytes=Buffer.from(r.data_base64,'base64');if(bytes.toString('base64')!==r.data_base64)fail('FLEET_TRANSFER_INVALID','Canonical actual read bytes required');counters.object_read_calls++;counters.object_read_payload_bytes+=bytes.length;}
   if(action==='artifact.manifest.read')counters.manifest_read_calls++;
   if(action==='artifact.object.put'&&typeof input?.data_base64==='string'){const bytes=Buffer.from(input.data_base64,'base64');if(bytes.toString('base64')!==input.data_base64)fail('FLEET_TRANSFER_INVALID','Canonical accepted put bytes required');counters.object_put_calls++;counters.object_put_accepted_payload_bytes+=bytes.length;}
  }return result;}} as T;
 return {store:wrapped,snapshot:()=>({schema_version:1,kind:'hyperfide.artifact-capability-payload',operation_id:operation,measurement:'SUCCESSFUL_CAPABILITY_PAYLOAD_NOT_TRANSPORT',...counters})};
}
