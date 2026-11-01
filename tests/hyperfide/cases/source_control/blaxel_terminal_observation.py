#!/usr/bin/env python3
"""Real pinned SDK and adapter over a controlled HTTP response boundary; no vendor calls."""
import json,os,subprocess,tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4]
SCRIPT=r"""
import {createHash,randomUUID} from 'node:crypto';import {pathToFileURL} from 'node:url';
const root=process.argv[1],sha=v=>'sha256:'+createHash('sha256').update(v).digest('hex');
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
let model,requests=[];const original=globalThis.fetch;
globalThis.fetch=async(input,options)=>{const request=input instanceof Request?input:new Request(input,options),url=new URL(request.url);if(request.method!=='GET'||url.origin!=='https://api.blaxel.ai'||!url.pathname.endsWith('/sandboxes/fixture-owned'))throw Error('Unexpected SDK transport request');requests.push({method:request.method,path:url.pathname});return new Response(JSON.stringify(model),{status:200,headers:{'Content-Type':'application/json'}})};
try {
 const {createBlaxelIsolationTransport}=await import(pathToFileURL(root+'/providers/blaxel/processes.js'));
 const {operationPayloadDigest}=await import(pathToFileURL(root+'/providers/contract.js'));
 const scope={organisation_id:randomUUID(),pool_id:randomUUID(),provider:'blaxel',provider_account_id:'fixture-account',environment_id:'fixture-workspace',region:'fixture-region',configuration_digest:sha('fixture-config')},preparation=sha('fixture-preparation');
 const ctx={env:{HF_BLAXEL_LIVE_ENABLED:'true',HF_BLAXEL_API_KEY:'controlled-sdk-fixture-token-no-live-authority',HF_BLAXEL_WORKSPACE:scope.environment_id,HF_BLAXEL_ACCOUNT_ID:scope.provider_account_id},signal:new AbortController().signal};
 const adapter=createBlaxelIsolationTransport(scope,ctx),op={schema_version:1,kind:'observe',scope,deadline_at:new Date(Date.now()+20000).toISOString(),identity:{operation_id:randomUUID(),idempotency_key:randomUUID(),payload_digest:sha('pending'),correlation_id:randomUUID(),causation_id:randomUUID()},resource:{native_sandbox_id:'fixture-owned',sandbox_boot_generation:'1'},preparation_digest:preparation,parameters:{}};op.identity.payload_digest=operationPayloadDigest(op);
 const base={metadata:{name:'fixture-owned',workspace:scope.environment_id,labels:{'hyperfide-scope':sha(canonical(scope)),'hyperfide-boot':'1','hyperfide-preparation':preparation}},spec:{region:scope.region,enabled:false},status:'TERMINATED'};
 const observations=[];
 for(const state of ['TERMINATED','STANDBY','DEACTIVATED','ARCHIVED']){model=structuredClone(base);model.status=state;const answer=await adapter.observe(op);if(answer.status!=='SUCCEEDED'||(state==='TERMINATED'?(answer.result.provider_state!=='DESTROYED'||answer.result.health!=='ABSENT'):answer.result.health!=='UNKNOWN'))throw Error(state+' normalization differs: '+JSON.stringify(answer));observations.push({state,enabled:false,result:answer.result})}
 model=structuredClone(base);model.spec.enabled=true;const enabled=await adapter.observe(op);if(enabled.status!=='SUCCEEDED'||enabled.result.health==='ABSENT')throw Error('Enabled TERMINATED record authorized absence');observations.push({state:'TERMINATED',enabled:true,result:enabled.result});
 for(const field of ['name','boot','workspace','region']){model=structuredClone(base);if(field==='name')model.metadata.name='other-resource';if(field==='boot')model.metadata.labels['hyperfide-boot']='2';if(field==='workspace')model.metadata.workspace='other-workspace';if(field==='region')model.spec.region='other-region';const answer=await adapter.observe(op);if(answer.status!=='UNKNOWN'||answer.result!==null||answer.acceptance!=='UNKNOWN')throw Error('Wrong '+field+' identity authorized absence');observations.push({wrong_identity:field,status:answer.status,result:answer.result})}
 if(requests.length!==observations.length)throw Error('SDK boundary not reached for every case');
 console.log(JSON.stringify({status:'PASS',scope:'actual pinned SDK plus production isolation adapter, controlled HTTP response fixtures',dist_root:root,observations,requests,provider_live:'UNRUN',provider_creates:0}));
}finally{globalThis.fetch=original}
"""
def main():
 root=Path(os.environ.get('HYPERFIDE_ADAPTER_DIST',str(ROOT/'core/control-plane/dist'))).resolve()
 with tempfile.TemporaryDirectory(prefix='hf-blaxel-terminal-adapter-') as temporary:
  env={'PATH':os.environ.get('PATH','/usr/bin:/bin'),'HOME':temporary,'BL_DISABLE_H2':'true','BL_DISABLE_CONTROL_PLANE_H2':'true','BL_ENV':'prod'}
  p=subprocess.run(['node','--input-type=module','-e',SCRIPT,str(root)],cwd=temporary,env=env,text=True,capture_output=True,timeout=45)
  print(p.stdout,end='');print(p.stderr,end='',file=__import__('sys').stderr);return p.returncode
if __name__=='__main__':raise SystemExit(main())
