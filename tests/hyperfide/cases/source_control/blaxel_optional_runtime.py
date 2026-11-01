#!/usr/bin/env python3
"""Pinned SDK GET recovery and production create validation; no provider mutation or persistence claim."""
import os,subprocess,tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4]
SCRIPT=r"""
import {createHash,randomUUID} from 'node:crypto';import {pathToFileURL} from 'node:url';
const root=process.argv[1],sha=v=>'sha256:'+createHash('sha256').update(v).digest('hex');let actual,requests=[];
const original=globalThis.fetch;globalThis.fetch=async(input,options)=>{const request=input instanceof Request?input:new Request(input,options);if(request.method!=='GET'||new URL(request.url).origin!=='https://api.blaxel.ai')throw Error('No provider mutation permitted');requests.push(request.method);return new Response(JSON.stringify(actual),{status:200,headers:{'Content-Type':'application/json'}})};
try{
 const {createBlaxelAdapter,planBlaxelCreate}=await import(pathToFileURL(root+'/providers/blaxel/processes.js'));const {operationPayloadDigest}=await import(pathToFileURL(root+'/providers/contract.js'));
 const scope={organisation_id:randomUUID(),pool_id:randomUUID(),provider:'blaxel',provider_account_id:'fixture-account',environment_id:'fixture-workspace',region:'fixture-region',configuration_digest:sha('config')},resources={cpu_millis:2000,memory_bytes:'4294967296',disk_bytes:'4294967296',persistent_volume_bytes:'0'},preparation=sha('preparation'),reference='sandbox/fixture:'+ 'a'.repeat(64);
 const op={schema_version:1,kind:'create',scope,deadline_at:new Date(Date.now()+20000).toISOString(),identity:{operation_id:randomUUID(),idempotency_key:randomUUID(),payload_digest:sha('pending'),correlation_id:randomUUID(),causation_id:randomUUID()},resource:null,preparation_digest:preparation,parameters:{preparation_reference:reference,resources,network:'ISOLATED',stdin_required:false}};op.identity.payload_digest=operationPayloadDigest(op);
 const base={qualification_status:'QUALIFIED',scope,preparation_digest:preparation,preparation_reference:reference,provider_prepared_digest:'sha256:'+'a'.repeat(64),resources,network_mode:'ISOLATED',network:{},volumes:[],runtime_extra_args:undefined,lifecycle:{schema_version:1,run_seconds:3600,checkpoint_lead_seconds:60,termination_grace_seconds:10,api_wait_seconds:5,process:{keep_alive:true,timeout_seconds:0},expiration_policies:[],runtime_ttl:null,runtime_expires_at:null}};
 let early=[],observations=[];const hooks={invocation:{signal:new AbortController().signal},assertResourceBinding:async()=>{},assignedBootGeneration:async()=> '1',persistEarlyResource:async(_op,name)=>{early.push(name);return{native_sandbox_id:name,sandbox_boot_generation:'1'}},recordObservation:async(_op,value)=>{observations.push(value)},persistEarlyProcess:async()=>{},resolvePreparation:async()=>{},resolveResourceBinding:async()=>{},claimProcess:async()=>{},resolveProcess:async()=>{}};
 const adapter=createBlaxelAdapter(scope,hooks,{resolvePreparedBase:async()=>base},{env:{HF_BLAXEL_LIVE_ENABLED:'true',HF_BLAXEL_API_KEY:'controlled-sdk-fixture-token-no-live-authority',HF_BLAXEL_WORKSPACE:scope.environment_id,HF_BLAXEL_ACCOUNT_ID:scope.provider_account_id},signal:new AbortController().signal});
 const cases=[{id:'omitted_optional_accepted',desired:undefined,observed:undefined,success:true},{id:'missing_vs_null_refused',desired:undefined,observed:null,success:false},{id:'defined_vs_missing_refused',desired:['--fixture'],observed:undefined,success:false},{id:'defined_vs_null_refused',desired:['--fixture'],observed:null,success:false},{id:'defined_exact_accepted',desired:['--fixture'],observed:['--fixture'],success:true}];
 const results=[];for(const c of cases){base.runtime_extra_args=c.desired;const expected=planBlaxelCreate(op,'1',base);actual=JSON.parse(JSON.stringify({...expected,status:'DEPLOYED',metadata:{...expected.metadata,workspace:scope.environment_id}}));if(c.observed===undefined)delete actual.spec.runtime.extraArgs;else actual.spec.runtime.extraArgs=c.observed;const result=await adapter.create(op);if((result.status==='SUCCEEDED')!==c.success)throw Error(c.id+': '+JSON.stringify(result));if(early.length!==results.length+1)throw Error('Candidate identity not retained before validation');results.push({id:c.id,status:result.status,failure_code:result.failure_code??null})}
 if(requests.length!==cases.length||requests.some(x=>x!=='GET'))throw Error('Recovery must use actual SDK GET only');console.log(JSON.stringify({status:'PASS',scope:'production adapter recovery plus pinned SDK controlled HTTP; prerequisite hooks are controlled metadata, persistence and cloud qualification not claimed',results,requests,provider_creates:0}));
}finally{globalThis.fetch=original}
"""
def main():
 root=Path(os.environ.get('HYPERFIDE_ADAPTER_DIST',str(ROOT/'core/control-plane/dist'))).resolve()
 with tempfile.TemporaryDirectory(prefix='hf-blaxel-optional-runtime-') as temporary:
  env={'PATH':os.environ.get('PATH','/usr/bin:/bin'),'HOME':temporary,'BL_DISABLE_H2':'true','BL_DISABLE_CONTROL_PLANE_H2':'true','BL_ENV':'prod'}
  result=subprocess.run(['node','--input-type=module','-e',SCRIPT,str(root)],cwd=temporary,env=env,text=True,capture_output=True,timeout=45);print(result.stdout,end='');print(result.stderr,end='',file=__import__('sys').stderr);return result.returncode
if __name__=='__main__':raise SystemExit(main())
