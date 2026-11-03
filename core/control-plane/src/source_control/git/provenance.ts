import {parseObjectId,parseRepositoryPath,parseUUID,SourceControlError} from '../contracts.js';
import {sourceDigest,sourceScopeValues,type SourceContext,type SourceMetadata,type SourceSQL} from '../metadata.js';

export interface ProjectPathMapping {source_path:string;target_path:string}
export interface SourceProjectionPolicy {
 schema_version:1;policy_id:string;version:number;project_id:string;repository_identity:string;
 mappings:ProjectPathMapping[];
 dependencies:{path:string;treatment:'INCLUDE'|'EXTERNAL_PIN';revision_id?:string}[];
 no_visible_change:'KEEP'|'COLLAPSE_TO_FIRST_PARENT';merge_parents:'ORDERED_UNIQUE';
 public_metadata:'NATIVE_PUBLIC_V1';signature_policy:'REJECT'|'PRESERVE_OBSERVATION';
 tag_signing:'REJECT';object_format:'sha1';
}
function fail(message:string):never {throw new SourceControlError('INVALID_PROJECTION_POLICY',message);}
function bounded(value:unknown,name:string,max=256):string {if(typeof value!=='string'||!value||Buffer.byteLength(value)>max||/[\u0000-\u001f\u007f]/u.test(value))fail('Invalid '+name);return value;}
function rootPath(value:unknown):string {if(value==='')return '';if(typeof value!=='string')fail('Explicit project path required');return parseRepositoryPath(value);}
export function parseProjectionPolicy(value:unknown):SourceProjectionPolicy {
 if(!value||typeof value!=='object'||Array.isArray(value))fail('Policy object required');
 const v=value as Record<string,any>,allowed=['schema_version','policy_id','version','project_id','repository_identity','mappings','dependencies','no_visible_change','merge_parents','public_metadata','signature_policy','tag_signing','object_format'];
 if(Object.keys(v).some(k=>!allowed.includes(k))||allowed.some(k=>!Object.hasOwn(v,k)))fail('Exact versioned policy fields required');
 parseUUID(v.policy_id,'policy_id');bounded(v.project_id,'project identity');bounded(v.repository_identity,'repository identity');
 if(v.schema_version!==1||!Number.isSafeInteger(v.version)||v.version<1||v.version>2147483647||v.object_format!=='sha1'||v.public_metadata!=='NATIVE_PUBLIC_V1'||v.merge_parents!=='ORDERED_UNIQUE'||!['KEEP','COLLAPSE_TO_FIRST_PARENT'].includes(v.no_visible_change)||!['REJECT','PRESERVE_OBSERVATION'].includes(v.signature_policy)||v.tag_signing!=='REJECT')fail('Unsupported projection policy');
 if(!Array.isArray(v.mappings)||v.mappings.length<1||v.mappings.length>32||!Array.isArray(v.dependencies)||v.dependencies.length>64)fail('Bounded explicit mappings and dependencies required');
 const mappings=v.mappings.map((m:any)=>{if(!m||typeof m!=='object'||Object.keys(m).sort().join(',')!=='source_path,target_path')fail('Exact path mapping required');return {source_path:rootPath(m.source_path),target_path:rootPath(m.target_path)};});
 const overlap=(left:string,right:string)=>{const a=left.normalize('NFC').toLowerCase(),b=right.normalize('NFC').toLowerCase();return a===''||b===''||a===b||a.startsWith(b+'/')||b.startsWith(a+'/');};
 for(let i=0;i<mappings.length;i++)for(let j=0;j<i;j++)if(overlap(mappings[i]!.target_path,mappings[j]!.target_path))fail('Target mappings overlap');
 const dependencies=v.dependencies.map((d:any)=>{if(!d||typeof d!=='object'||Object.keys(d).some(k=>!['path','treatment','revision_id'].includes(k))||!['INCLUDE','EXTERNAL_PIN'].includes(d.treatment))fail('Explicit dependency treatment required');const result:{path:string;treatment:'INCLUDE'|'EXTERNAL_PIN';revision_id?:string}={path:rootPath(d.path),treatment:d.treatment};if(d.treatment==='EXTERNAL_PIN'){parseObjectId(d.revision_id);result.revision_id=d.revision_id;}else if(d.revision_id!==undefined||!mappings.some((m:ProjectPathMapping)=>m.source_path===''||d.path===m.source_path||d.path.startsWith(m.source_path+'/')))fail('Included dependency must be within a mapped root');return result;});
 return {...v,mappings,dependencies} as SourceProjectionPolicy;
}
export class SourceGitProvenance {
 constructor(readonly metadata:SourceMetadata){}
 async createPolicy(context:SourceContext,input:unknown){const policy=parseProjectionPolicy(input),digest=sourceDigest(policy);return this.metadata.transaction(async tx=>{
  await this.metadata.guard(tx,context,'source.projections.create');
  await tx.query('INSERT INTO hyperfide.source_projection_policies(organisation_id,repository_id,security_domain_id,policy_id,version,policy_digest,policy) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',[...sourceScopeValues(context.scope),policy.policy_id,policy.version,digest,policy]);
  const retained=await this.readPolicyInTransaction(tx,context,policy.policy_id,policy.version);if(retained.policy_digest!==digest)throw new SourceControlError('PROJECTION_POLICY_CONFLICT','Policy version is immutable; create a new version');return retained;
 });}
 async readPolicyInTransaction(tx:SourceSQL,context:SourceContext,id:string,version:number){parseUUID(id,'policy_id');if(!Number.isSafeInteger(version)||version<1)fail('Positive policy version required');const row=(await tx.query('SELECT policy_digest,policy FROM hyperfide.source_projection_policies WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND policy_id=$4 AND version=$5',[...sourceScopeValues(context.scope),id,version])).rows[0];if(!row)throw new SourceControlError('NOT_FOUND','Projection policy version unavailable');return {policy_digest:String(row.policy_digest),policy:parseProjectionPolicy(row.policy)};}
 async readPolicy(context:SourceContext,id:string,version:number){return this.metadata.transaction(async tx=>{await this.metadata.guard(tx,context,'source.projections.read');return this.readPolicyInTransaction(tx,context,id,version);});}
}
