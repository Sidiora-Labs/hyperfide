import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const [runtime,nativeLog]=process.argv.slice(2);
if(!runtime||!nativeLog)throw Error('Explicit isolated runtime and actual native gate log required');
const {verifyNativeArtifactTransfer,createFleetTransfer,verifyFleetTransfer}=await import(pathToFileURL(path.resolve(runtime,'preparation/fleet_transfer.js')));
const bytes=await fs.readFile(nativeLog),native=JSON.parse(bytes.toString()).native_transfer;
assert.ok(native&&native.http_response_body_bytes>native.verified_object_bytes);
verifyNativeArtifactTransfer(native,native.operation_id);
const transfer=createFleetTransfer(native.operation_id,native,bytes.length,null,0,0);
verifyFleetTransfer(transfer,native.operation_id);
let assertions=3;
for(const [key,value]of [['operation_id','00000000-0000-4000-8000-000000000000'],['rpc_calls',-1],['http_responses',native.rpc_calls+1],['verified_object_bytes',native.verified_object_bytes+1],['cache_hits',1],['wire_bytes',native.http_response_body_bytes]]){
 const changed={...native,[key]:value};assert.throws(()=>verifyNativeArtifactTransfer(changed,native.operation_id));assertions++;
}
for(const mutate of [v=>v.dependency_io.network_bytes=0,v=>v.dependency_io.network_requests=0,v=>v.dependency_io.observation='MEASURED',v=>v.source_local.manifest_file_bytes=-1,v=>v.operation_id='other']){
 const changed=structuredClone(transfer);mutate(changed);assert.throws(()=>verifyFleetTransfer(changed,native.operation_id));assertions++;
}
const legacy=createFleetTransfer(native.operation_id,null,bytes.length,null,0,0);verifyFleetTransfer(legacy,native.operation_id);assert.equal(legacy.native_stage,null);assertions++;
console.log(JSON.stringify({status:'PASS',assertions,scope:'actual native measured counters and strict transfer contract',native_operation_id:native.operation_id}));
