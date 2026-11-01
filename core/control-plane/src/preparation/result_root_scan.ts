import {createHash} from 'node:crypto';
import type {PreparationManifest} from './manifests.js';
import {scanPreparationBytes,validateManifestMetadata} from './manifests.js';
import {preparationPinInputs} from './profile_pin_inputs.js';
import {readProtectedFile} from './fleet_client.js';
import {validateFleetSourceArchive,sourceArchiveCanonical} from '../artifacts/fleet_source_archive.js';
import {deriveArchiveGitIdentity} from './result_source_archive.js';
import {object} from '../policy/programme.js';
import {exact,fail,strictJSON,uuid,DIGEST} from '../transport/protocol.js';
type Data=Record<string,any>;
const hash=(bytes:Uint8Array|string)=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
export interface ResultRootScanPolicy {
 readonly summary:{schema_version:1;policy_id:string;policy_digest:string;canary_set_digest:string};
 readonly max_archive_bytes:number;readonly max_total_bytes:number;readonly max_files:number;
 scan:(name:string,bytes:Uint8Array)=>ReturnType<typeof scanPreparationBytes>;
}
/** The capability closes over real canaries; serializing it never exposes their values. */
export async function loadResultRootScanPolicy(env:Readonly<NodeJS.ProcessEnv>,required=false):Promise<ResultRootScanPolicy|null>{
 const filename=env.HF_RESULT_ROOT_SCAN_POLICY_FILE,pin=env.HF_RESULT_ROOT_SCAN_POLICY_DIGEST;
 if(!filename&&!pin){if(required)fail('RESULT_ROOT_SCAN_POLICY_REQUIRED','Protected ROOT-only scan policy required');return null;}
 if(!filename||!pin||!DIGEST.test(pin))fail('RESULT_ROOT_SCAN_POLICY_REQUIRED','Protected ROOT scan file and exact digest required');
 const bytes=await readProtectedFile(filename,262144,true);if(hash(bytes)!==pin)fail('RESULT_ROOT_SCAN_POLICY_CHANGED','ROOT scan policy differs from deployment pin');
 const value=strictJSON(bytes);if(!object(value))fail('RESULT_ROOT_SCAN_POLICY_INVALID','Typed ROOT scan policy required');exact(value,['schema_version','kind','policy_id','secret_env_refs','identity_canaries','lease_canaries','max_files','max_archive_bytes','max_total_bytes']);
 if(value.schema_version!==1||value.kind!=='hyperfide.result-root-scan-policy'||typeof value.policy_id!=='string'||!value.policy_id||value.policy_id.length>128||!Array.isArray(value.secret_env_refs)||!value.secret_env_refs.length||value.secret_env_refs.length>64||new Set(value.secret_env_refs).size!==value.secret_env_refs.length||value.secret_env_refs.some(name=>typeof name!=='string'||!/^[A-Z][A-Z0-9_]{0,127}$/.test(name))||!Number.isSafeInteger(value.max_files)||Number(value.max_files)<1||Number(value.max_files)>100000)fail('RESULT_ROOT_SCAN_POLICY_INVALID','Explicit bounded ROOT scan authority required');
 const limit=(name:string)=>{const n=value[name];if(!Number.isSafeInteger(n)||Number(n)<1||Number(n)>67108864)fail('RESULT_ROOT_SCAN_POLICY_INVALID','Explicit bounded scan bytes required');return Number(n);};
 const secret_canaries=[...new Set(value.secret_env_refs.map(name=>{const secret=env[String(name)];if(typeof secret!=='string'||secret.length<8||secret.length>4096)fail('RESULT_ROOT_SCAN_SECRET_REQUIRED','Configured ROOT scan canary is unavailable');return secret;}))];
 const scan={secret_canaries,identity_canaries:value.identity_canaries,lease_canaries:value.lease_canaries};scanPreparationBytes('scan-policy-validation.txt',Buffer.alloc(0),scan);
 return Object.freeze({summary:{schema_version:1 as const,policy_id:value.policy_id,policy_digest:pin,canary_set_digest:hash(sourceArchiveCanonical(scan))},max_archive_bytes:limit('max_archive_bytes'),max_total_bytes:limit('max_total_bytes'),max_files:Number(value.max_files),scan:(name:string,data:Uint8Array)=>scanPreparationBytes(name,data,scan)});
}
export interface RootProfileInput {path:string;bytes:Uint8Array;artifact_id:string;artifact_digest:string}
export async function scanResultRootInputs(policy:ResultRootScanPolicy,input:{organisation_id:string;run_id:string;job_id:string;operation_id:string;session_id:string;context_digest:string;result:Data;parent_profile_id:string;parent_preparation_digest:string;parent_manifest:PreparationManifest;repository_key:string;archive_bytes:Uint8Array;profile_files:RootProfileInput[]}):Promise<Data>{
 for(const id of [input.organisation_id,input.run_id,input.job_id,input.operation_id,input.session_id,input.parent_profile_id])if(!uuid(id))fail('RESULT_ROOT_SCAN_SCOPE','Exact actual scan scope required');
 if(!DIGEST.test(input.context_digest)||!DIGEST.test(input.parent_preparation_digest)||input.archive_bytes.byteLength>policy.max_archive_bytes)fail('RESULT_ROOT_SCAN_SCOPE','Bounded actual archive/context required');
 const bytes=Buffer.from(input.archive_bytes),archive=validateFleetSourceArchive(strictJSON(bytes,policy.max_archive_bytes)) as Data,origin=input.result.archive_source,derived=deriveArchiveGitIdentity(archive),parent=validateManifestMetadata(input.parent_manifest);
 if(!object(origin)||origin.kind!=='FLEET_SOURCE_ARCHIVE_V1'||hash(bytes)!==origin.archive_digest||bytes.toString('utf8')!==sourceArchiveCanonical(archive)||sourceArchiveCanonical(origin.binding)!==sourceArchiveCanonical(archive.binding)||sourceArchiveCanonical(origin.baseline)!==sourceArchiveCanonical(archive.baseline)||origin.inventory_digest!==derived.inventory_digest||derived.source_object_id!==input.result.source_object_id||derived.source_tree_id!==input.result.source_tree_id||archive.binding.organisation_id!==input.organisation_id||archive.binding.run_id!==input.run_id||archive.binding.custody_id!==input.result.custody_id||archive.binding.custody_generation!==input.result.custody_generation||parent.digest!==input.parent_preparation_digest||parent.profile.repositories.filter(repository=>repository.id===input.repository_key).length!==1)fail('RESULT_ROOT_SCAN_SCOPE','Archive must bind current admitted custody and accepted TEST profile');
 const inputs=preparationPinInputs(parent.profile);if(inputs.some(pin=>pin.origin==='SOURCE'&&!archive.files.some((file:Data)=>file.path===pin.path)))fail('RESULT_ROOT_SCAN_SOURCE_INPUTS','Every source-owned preparation pin must exist in actual captured code');
 const external=inputs.filter(pin=>pin.origin==='PROFILE_ARTIFACT'),externalPaths=new Set(external.map(pin=>pin.path));
 if(input.profile_files.length!==external.length||new Set(input.profile_files.map(file=>file.path)).size!==input.profile_files.length||input.profile_files.some(file=>!externalPaths.has(file.path)))fail('RESULT_ROOT_SCAN_PROFILE_INPUTS','Exact external parent pin bytes required');
 let total=0,count=0,declaration:ReturnType<typeof scanPreparationBytes>|undefined;const inventory:Data[]=[];
 const check=(name:string,data:Uint8Array,mode:string)=>{total+=data.byteLength;if(++count>policy.max_files||total>policy.max_total_bytes)fail('RESULT_ROOT_SCAN_LIMIT','Actual scan input exceeds protected bounds');try{policy.scan('path-metadata.txt',Buffer.from(name));declaration=policy.scan(name,data);}catch{fail('RESULT_ROOT_SCAN_REJECTED','Privileged preparation byte scan refused input');}inventory.push({path:name,mode,size:String(data.byteLength),digest:hash(data)});};
 for(const file of archive.files){const content=Buffer.from(file.content_base64,'base64');check(input.repository_key+'/'+file.path,content,file.mode);}
 const refs:Data[]=[];for(const file of input.profile_files){const expected=external.find(pin=>pin.path===file.path)!;if(hash(file.bytes)!==expected.digest||!uuid(file.artifact_id)||!DIGEST.test(file.artifact_digest))fail('RESULT_ROOT_SCAN_PROFILE_INPUTS','External profile bytes differ from accepted file pin');check(file.path,file.bytes,'100644');refs.push({path:file.path,artifact_id:file.artifact_id,artifact_digest:file.artifact_digest,content_digest:expected.digest,size_bytes:String(file.bytes.byteLength)});}
 if(!declaration)declaration=policy.scan('empty-source-validation.txt',Buffer.alloc(0));inventory.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);refs.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
 const receipt={schema_version:1,kind:'FLEET_TEST_ROOT_SCAN_V1',status:'PASSED',organisation_id:input.organisation_id,run_id:input.run_id,job_id:input.job_id,operation_id:input.operation_id,session_id:input.session_id,custody_id:input.result.custody_id,custody_generation:input.result.custody_generation,archive_digest:origin.archive_digest,inventory_digest:origin.inventory_digest,context_digest:input.context_digest,parent_profile_id:input.parent_profile_id,parent_preparation_digest:input.parent_preparation_digest,profile_input_references:refs,scanned_inventory_digest:hash(sourceArchiveCanonical(inventory)),scanned_files:count,scanned_bytes:String(total),policy:policy.summary,canary_counts:declaration.canary_counts,checks:declaration.checks,scanned_at:new Date().toISOString(),authority:'SANITIZED_ROOT_INPUT_SCAN_ONLY'};
 try{policy.scan('sanitized-root-scan-receipt.json',Buffer.from(sourceArchiveCanonical(receipt)));}catch{fail('RESULT_ROOT_SCAN_PRIVATE_RECEIPT','Sanitized scan metadata contains protected content');}
 return receipt;
}
