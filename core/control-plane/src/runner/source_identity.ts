import {object} from '../policy/programme.js';
import {DIGEST,exact,fail,uuid} from '../transport/protocol.js';

interface SourcePins {repository_key:string;source_object_id:string;source_tree_id:string|null;source_manifest_digest:string}
export type RunnerPreparationSource =
 | (SourcePins & {source_backend?:'git';security_domain_id?:never})
 | (SourcePins & {source_backend:'native';security_domain_id:string});

export function validateRunnerPreparationSource(value:unknown,allowUnmeasuredTree=false):asserts value is RunnerPreparationSource {
 if(!object(value))fail('INVALID_PREPARATION_SOURCE','Explicit immutable source pins required');
 const native=value.source_backend==='native';
 exact(value,['repository_key','source_object_id','source_tree_id','source_manifest_digest',...(value.source_backend===undefined?[]:['source_backend']),...(native?['security_domain_id']:[])]);
 if(value.source_backend!==undefined&&!['git','native'].includes(String(value.source_backend)))fail('INVALID_PREPARATION_SOURCE','Unknown source backend');
 const identity=(id:unknown)=>typeof id==='string'&&(native?DIGEST:/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/).test(id);
 if(typeof value.repository_key!=='string'||!value.repository_key.trim()||value.repository_key.length>128||native&&(!uuid(value.repository_key)||!uuid(value.security_domain_id))||!identity(value.source_object_id)||!(value.source_tree_id===null?allowUnmeasuredTree&&!native:identity(value.source_tree_id))||typeof value.source_manifest_digest!=='string'||!DIGEST.test(value.source_manifest_digest))
  fail('INVALID_PREPARATION_SOURCE','Source identities must match their explicit backend');
}
