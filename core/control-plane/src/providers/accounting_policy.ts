import {object,FoundationError} from '../policy/programme.js';
import {exact,hash,strictJSON,DIGEST} from '../transport/protocol.js';
import {readProtectedFile} from '../preparation/fleet_client.js';
export interface ProviderAccountingPolicy{digest:string;document:{schema_version:1;provider:'blaxel';provider_account_id:string;mode:'SEPARATE_FLEET_BUDGET_PROVIDER_QUOTA';provider_quota_dimensions:['SANDBOX']}}
const policies=new WeakMap<object,ProviderAccountingPolicy>();
export async function readProviderAccountingPolicy(env:Readonly<NodeJS.ProcessEnv>):Promise<ProviderAccountingPolicy|null>{
 const file=env.HF_PROVIDER_ACCOUNTING_POLICY_FILE,pin=env.HF_PROVIDER_ACCOUNTING_POLICY_DIGEST;if(!file&&!pin)return null;
 const invalid=():never=>{throw new FoundationError('PROVIDER_ACCOUNTING_POLICY_INVALID','Protected explicitly scoped account accounting policy required');};
 if(!file||!pin||!DIGEST.test(pin))invalid();const raw=await readProtectedFile(file!,1048576,true);if(hash(raw)!==pin)invalid();const d=strictJSON(raw);if(!object(d))invalid();exact(d,['schema_version','provider','provider_account_id','mode','provider_quota_dimensions']);
 if(d.schema_version!==1||d.provider!=='blaxel'||typeof d.provider_account_id!=='string'||!d.provider_account_id||d.mode!=='SEPARATE_FLEET_BUDGET_PROVIDER_QUOTA'||!Array.isArray(d.provider_quota_dimensions)||d.provider_quota_dimensions.length!==1||d.provider_quota_dimensions[0]!=='SANDBOX')invalid();return{digest:pin!,document:d as unknown as ProviderAccountingPolicy['document']};
}
export function bindProviderAccountingPolicy(config:object,policy:ProviderAccountingPolicy|null):void{if(policy)policies.set(config,policy);}
export function providerAccountingPolicy(config:object,provider:string,account:string):ProviderAccountingPolicy|null{const p=policies.get(config);return p&&p.document.provider===provider&&p.document.provider_account_id===account?p:null;}
