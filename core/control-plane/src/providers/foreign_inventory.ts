import {createHash} from 'node:crypto';
import {object,FoundationError} from '../policy/programme.js';
import {exact,hash,strictJSON,DIGEST} from '../transport/protocol.js';
import {readProtectedFile} from '../preparation/fleet_client.js';
import {canonicalJSON} from '../preparation/manifests.js';
import type {ProviderScope} from './contract.js';
type Data=Record<string,any>;
export interface ForeignInventoryPolicy {digest:string;document:{schema_version:1;provider:'blaxel';provider_account_id:string;environment_id:string;max_age_seconds:number;owners:Array<{owner_id:string;labels:Record<string,string>;identity_label:string}>}}
export interface ForeignResource {owner_id:string;identity_digest:string;resources:{SANDBOX:string;CPU_MILLIS:string|null;MEMORY_BYTES:string|null;DISK_BYTES:string|null}}
const policies=new WeakMap<object,ForeignInventoryPolicy>();
function fail():never{throw new FoundationError('FOREIGN_INVENTORY_POLICY_INVALID','Explicit protected foreign ownership policy and digest required');}
export async function readForeignInventoryPolicy(env:Readonly<NodeJS.ProcessEnv>):Promise<ForeignInventoryPolicy|null>{
 const file=env.HF_BLAXEL_FOREIGN_OWNERSHIP_CONFIG_FILE,pin=env.HF_BLAXEL_FOREIGN_OWNERSHIP_CONFIG_DIGEST;if(!file&&!pin)return null;if(!file||!pin||!DIGEST.test(pin))fail();const raw=await readProtectedFile(file,1048576,true);if(hash(raw)!==pin)fail();const d=strictJSON(raw);if(!object(d))fail();exact(d,['schema_version','provider','provider_account_id','environment_id','max_age_seconds','owners']);if(d.schema_version!==1||d.provider!=='blaxel'||typeof d.provider_account_id!=='string'||!d.provider_account_id||typeof d.environment_id!=='string'||!d.environment_id||!Number.isSafeInteger(d.max_age_seconds)||Number(d.max_age_seconds)<1||Number(d.max_age_seconds)>3600||!Array.isArray(d.owners)||!d.owners.length||d.owners.length>64)fail();const seen=new Set<string>();for(const owner of d.owners){if(!object(owner))fail();exact(owner,['owner_id','labels','identity_label']);if(typeof owner.owner_id!=='string'||!/^[a-z][a-z0-9-]{0,63}$/.test(owner.owner_id)||owner.owner_id==='hyperfide'||seen.has(owner.owner_id)||!object(owner.labels)||!Object.keys(owner.labels).length||Object.keys(owner.labels).length>16||typeof owner.identity_label!=='string'||!owner.identity_label||owner.identity_label.startsWith('hyperfide-'))fail();for(const [k,v]of Object.entries(owner.labels))if(!k||k.startsWith('hyperfide-')||typeof v!=='string'||!v||v.length>256||/[\x00-\x1f]/.test(v))fail();seen.add(owner.owner_id);}return{digest:pin,document:d as unknown as ForeignInventoryPolicy['document']};
}
export function bindForeignInventoryPolicy(config:object,policy:ForeignInventoryPolicy|null):void{if(policy)policies.set(config,policy);}
export function foreignInventoryPolicy(config:object):ForeignInventoryPolicy|null{return policies.get(config)??null;}
export function classifyForeignResource(policy:ForeignInventoryPolicy,scope:ProviderScope,metadata:Data,spec:Data,status:unknown):ForeignResource|null{
 if(scope.provider!==policy.document.provider||scope.provider_account_id!==policy.document.provider_account_id||scope.environment_id!==policy.document.environment_id||metadata.workspace!==scope.environment_id||spec.region!==scope.region||!object(metadata.labels)||Object.keys(metadata.labels).some(k=>k.toLowerCase().startsWith('hyperfide')))return null;
 const matches=policy.document.owners.filter(owner=>Object.entries(owner.labels).every(([k,v])=>metadata.labels[k]===v)&&typeof metadata.labels[owner.identity_label]==='string'&&metadata.labels[owner.identity_label].length>0&&metadata.labels[owner.identity_label].length<=256);if(matches.length!==1)return null;const owner=matches[0]!,runtime=object(spec.runtime)?spec.runtime:{},memory=runtime.memory;
 const absent=status==='TERMINATED'&&spec.enabled===false;
 return{owner_id:owner.owner_id,identity_digest:'sha256:'+createHash('sha256').update(canonicalJSON({owner_id:owner.owner_id,identity:metadata.labels[owner.identity_label]})).digest('hex'),resources:{SANDBOX:absent?'0':'1',CPU_MILLIS:absent?'0':null,MEMORY_BYTES:absent?'0':typeof memory==='number'&&Number.isSafeInteger(memory)&&memory>0?String(BigInt(memory)*1048576n):null,DISK_BYTES:absent?'0':null}};
}
