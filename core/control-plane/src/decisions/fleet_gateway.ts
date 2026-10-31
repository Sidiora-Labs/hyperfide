import {createHash} from 'node:crypto';
import {hostname} from 'node:os';
import {object} from '../policy/programme.js';
import {fleetError,localProcessIdentity} from '../agents/fleet_authority.js';
import {strictJson} from './adapters.js';
import type {FleetModelResult} from './fleet_runtime.js';

export interface FleetGatewayProfile {backend:'gateway';host_id:string;profile_id:string;endpoint:string;model:string;key_env:string;timeout_ms:number;max_output_bytes:number}
/** Select one profile before admission. Failure never selects another backend. */
export function fleetGatewayProfile(env:Readonly<NodeJS.ProcessEnv>):FleetGatewayProfile|null{
 const backend=env.HYPERFIDE_FLEET_MODEL_BACKEND??(env.CHAT_COMPLETIONS_URL?'gateway':'codex');
 if(!['gateway','codex'].includes(backend))fleetError('FLEET_MODEL_BACKEND_INVALID');
 if(backend==='codex')return null;
 const endpoint=env.HYPERFIDE_FLEET_GATEWAY_ENDPOINT??env.CHAT_COMPLETIONS_URL;
 const model=env.MODEL,key_env=env.HYPERFIDE_FLEET_GATEWAY_KEY_ENV??'CLUSTER_1_GATEWAY_API_KEY';
 if(!endpoint||!model||!/^CLUSTER_[1-5]_GATEWAY_API_KEY$/.test(key_env)||!env[key_env])fleetError('FLEET_GATEWAY_CONFIG_MISSING');
 let url:URL;try{url=new URL(endpoint);}catch{fleetError('FLEET_GATEWAY_CONFIG_INVALID');}
 if(url.protocol!=='https:'||url.username||url.password||url.hash||url.search||model.length>256)fleetError('FLEET_GATEWAY_CONFIG_INVALID');
 return {backend:'gateway',host_id:env.HYPERFIDE_FLEET_HOST_ID??hostname(),profile_id:env.HYPERFIDE_FLEET_GATEWAY_PROFILE??'configured-primary',endpoint:url.href,model,key_env,timeout_ms:90000,max_output_bytes:1048576};
}
export async function reasonWithGateway(profile:FleetGatewayProfile,env:Readonly<NodeJS.ProcessEnv>,actorId:string,prompt:string,signal:AbortSignal,onStart:(identity:ReturnType<typeof localProcessIdentity>)=>Promise<void>):Promise<FleetModelResult>{
 const identity=localProcessIdentity();await onStart(identity);
 const token=env[profile.key_env];if(!token)fleetError('FLEET_GATEWAY_CONFIG_MISSING');
 const controller=new AbortController(),abort=()=>controller.abort();
 const timer=setTimeout(abort,profile.timeout_ms);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
 try{
  const response=await fetch(profile.endpoint,{method:'POST',redirect:'error',signal:controller.signal,headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({model:profile.model,messages:[{role:'system',content:'Choose one bounded fleet action. You have no executable tools. Return only the requested JSON object.'},{role:'user',content:prompt}],response_format:{type:'json_object'},stream:false,max_completion_tokens:4096})});
  if(!response.ok){await response.body?.cancel();fleetError('FLEET_GATEWAY_HTTP_'+response.status);}
  if(!response.body)fleetError('FLEET_GATEWAY_OUTPUT_INVALID');
  const reader=response.body.getReader();let bytes=0;const chunks:Buffer[]=[];
  while(true){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>profile.max_output_bytes){await reader.cancel();fleetError('FLEET_GATEWAY_OUTPUT_TOO_LARGE');}chunks.push(Buffer.from(chunk.value));}
  const body=strictJson(Buffer.concat(chunks).toString('utf8'),profile.max_output_bytes);
  if(!object(body)||typeof body.id!=='string'||!body.id||body.id.length>512||!Array.isArray(body.choices)||body.choices.length!==1)fleetError('FLEET_GATEWAY_OUTPUT_INVALID');
  const choice=body.choices[0];if(!object(choice)||choice.finish_reason!=='stop'||!object(choice.message)||typeof choice.message.content!=='string'||choice.message.tool_calls!==undefined)fleetError('FLEET_GATEWAY_OUTPUT_INVALID');
  const result=strictJson(choice.message.content,131072);
  if(!object(result)||Object.keys(result).sort().join(',')!=='action,input,rationale_summary'||typeof result.action!=='string'||!object(result.input)||typeof result.rationale_summary!=='string'||!result.rationale_summary.trim()||Buffer.byteLength(result.rationale_summary)>4096)fleetError('FLEET_GATEWAY_OUTPUT_INVALID');
  return {action:result.action,input:result.input,rationale_summary:result.rationale_summary,native_session_id:'gateway:'+actorId,process_identity:identity,model:profile.model,profile_digest:'sha256:'+createHash('sha256').update('gateway-profile:'+JSON.stringify(profile)).digest('hex'),backend:'gateway',session_kind:'LOGICAL_GATEWAY',upstream_response_id:body.id,profile_id:profile.profile_id,endpoint:profile.endpoint,key_env:profile.key_env};
 }catch(error){if(error instanceof Error&&'code' in error)throw error;fleetError('FLEET_GATEWAY_OUTCOME_UNKNOWN');}
 finally{clearTimeout(timer);signal.removeEventListener('abort',abort);}
}
