import {parseObjectId,parseUUID,SourceControlError} from './contracts.js';
import {sourceDigest,sourceScopeValues,SourceMetadata,type SourceContext} from './metadata.js';
import type {SourceBackupService} from './backup.js';
import type {SourceTransaction} from './storage_contract.js';
export interface SourceRecoveryProfile {
 schema_version:1;profile_id:string;
 metadata:{failure_domain:string;evidence_digest:string;acknowledgment:'FSYNC_PRIMARY'|'SYNC_REPLICA';replica_failure_domains:string[];supported_failures:('PROCESS_LOSS'|'PRIMARY_INSTANCE_LOSS'|'FAILURE_DOMAIN_LOSS')[]};
 placements:{backend_id:string;region:string;failure_domain:string;capabilities:{conditional_create:true;conditional_delete:true;strong_read_after_write:true};evidence_digest:string}[];
 backup:{retention_seconds:number;maximum_age_seconds:number;external_journal_id:string};
 objectives:{rpo_seconds:number;rto_seconds:number};
}
const fail=(message:string):never=>{throw new SourceControlError('RECOVERY_PROFILE_INVALID',message);};
export function parseRecoveryProfile(value:unknown):SourceRecoveryProfile{
 if(!value||typeof value!=='object'||Array.isArray(value))fail('Explicit durability profile required');const v=value as SourceRecoveryProfile;
 const exact=(obj:unknown,names:string[])=>{if(!obj||typeof obj!=='object'||Array.isArray(obj)||Object.keys(obj).some(k=>!names.includes(k))||names.some(k=>!Object.hasOwn(obj,k)))fail('Recovery profile fields differ from the supported schema');};
 exact(v,['schema_version','profile_id','metadata','placements','backup','objectives']);exact(v.metadata,['failure_domain','evidence_digest','acknowledgment','replica_failure_domains','supported_failures']);exact(v.backup,['retention_seconds','maximum_age_seconds','external_journal_id']);exact(v.objectives,['rpo_seconds','rto_seconds']);
 const text=(s:unknown)=>typeof s==='string'&&s.length>0&&Buffer.byteLength(s)<=256;
 const positive=(n:unknown)=>typeof n==='number'&&Number.isSafeInteger(n)&&n>0&&n<=31536000;
 if(v.schema_version!==1||!text(v.profile_id)||!v.metadata||!text(v.metadata.failure_domain)||!['FSYNC_PRIMARY','SYNC_REPLICA'].includes(v.metadata.acknowledgment)||!Array.isArray(v.metadata.replica_failure_domains)||v.metadata.replica_failure_domains.some(d=>!text(d))||new Set(v.metadata.replica_failure_domains).size!==v.metadata.replica_failure_domains.length||!Array.isArray(v.metadata.supported_failures)||!v.metadata.supported_failures.length||v.metadata.supported_failures.some(f=>!['PROCESS_LOSS','PRIMARY_INSTANCE_LOSS','FAILURE_DOMAIN_LOSS'].includes(f))||new Set(v.metadata.supported_failures).size!==v.metadata.supported_failures.length)fail('Metadata failure domain and acknowledgment policy required');
 parseObjectId(v.metadata.evidence_digest);
 if(v.metadata.acknowledgment==='SYNC_REPLICA'&&!v.metadata.replica_failure_domains.length)fail('Synchronous replica failure domains required');
 if(v.metadata.supported_failures.includes('FAILURE_DOMAIN_LOSS'))throw new SourceControlError('RECOVERY_PROFILE_UNQUALIFIED','Failure-domain loss requires a qualified external topology verifier');
 if(v.metadata.supported_failures.includes('FAILURE_DOMAIN_LOSS')&&(v.metadata.acknowledgment!=='SYNC_REPLICA'||!v.metadata.replica_failure_domains.some(d=>d!==v.metadata.failure_domain)))fail('Failure-domain loss requires independent synchronous metadata placement');
 if(!Array.isArray(v.placements)||!v.placements.length||v.placements.length>8||v.placements.some(p=>!p||typeof p!=='object'||Array.isArray(p))||new Set(v.placements.map(p=>p.backend_id)).size!==v.placements.length)fail('Distinct object placement declarations required');
 for(const p of v.placements){exact(p,['backend_id','region','failure_domain','capabilities','evidence_digest']);exact(p.capabilities,['conditional_create','conditional_delete','strong_read_after_write']);if(!text(p.backend_id)||!text(p.region)||!text(p.failure_domain)||!p.capabilities||Object.values(p.capabilities).some(x=>x!==true)||p.capabilities.conditional_create!==true||p.capabilities.conditional_delete!==true||p.capabilities.strong_read_after_write!==true)fail('Verified backend capability declaration required');parseObjectId(p.evidence_digest);}
 if(v.metadata.supported_failures.includes('FAILURE_DOMAIN_LOSS')&&new Set(v.placements.map(p=>p.failure_domain)).size<2)fail('Failure-domain loss requires independent object placements');
 if(!v.backup||!positive(v.backup.retention_seconds)||!positive(v.backup.maximum_age_seconds)||v.backup.maximum_age_seconds>v.backup.retention_seconds||!text(v.backup.external_journal_id)||!v.objectives||!Number.isSafeInteger(v.objectives.rpo_seconds)||v.objectives.rpo_seconds<0||!positive(v.objectives.rto_seconds))fail('Explicit backup retention, independent journal and recovery objectives required');
 parseUUID(v.backup.external_journal_id,'external journal deployment_id');return structuredClone(v);
}

export async function assertSourceRecoveryAdmission(tx:SourceTransaction,scope:SourceContext['scope'],action:string,mutation=true):Promise<void>{
 const readOnly=action==='source.capabilities'||action.startsWith('source.queries.')||action==='source.changes.revisions'||['.read','.inspect','.detail','.query','.entries','.lookup','.poll','.manifest'].some(suffix=>action.endsWith(suffix));
 const recovery=['source.backups.read','source.backups.verify','source.recovery.profile','source.recovery.readiness','source.recovery.prepare','source.recovery.activate','source.workspaces.close','source.operations.cancel','source.publications.cancel'].includes(action);
 if(!mutation||readOnly||recovery)return;
 if(!(await tx.query("SELECT to_regclass('hyperfide.source_recovery_state') IS NOT NULL AS present")).rows[0]?.present)return;
 const state=(await tx.query('SELECT state,deployment_id,external_epoch FROM hyperfide.source_recovery_state WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 FOR SHARE',sourceScopeValues(scope))).rows[0];
 if(state){if(!(await tx.query("SELECT to_regclass('hyperfide.authority_epochs') IS NOT NULL AS present")).rows[0]?.present||!(await tx.query("SELECT 1 FROM hyperfide.authority_epochs WHERE deployment_id=$1 AND epoch=$2 AND state='ACTIVE' FOR SHARE",[state.deployment_id,state.external_epoch])).rows.length)throw new SourceControlError('RECOVERY_NOT_READY','Source authority is not activated for the current external epoch');}
 if(state?.state==='VERIFYING')throw new SourceControlError('RECOVERY_NOT_READY','Source mutation is fenced until restored closure verification and activation complete');
}

export interface SourceExternalActivation {operation_id:string;expected_external_epoch:string;expected_database_epoch:string|null;activated_epoch:string}
export interface SourceRecoveryAuthority {verify(input:SourceExternalActivation):Promise<{epoch:string;proof_digest:string;deployment_id:string}>}
export class SourceRecoveryService {
 constructor(private readonly metadata:SourceMetadata,private readonly backups:SourceBackupService,private readonly authority?:SourceRecoveryAuthority){}
 profile(input:unknown){const profile=parseRecoveryProfile(input);return {profile,profile_digest:sourceDigest(profile)};}
 async readiness(context:SourceContext,input:{backup_id:string}){return this.backups.read(context,input.backup_id);}
 async prepare(context:SourceContext,input:SourceExternalActivation&{backup_id:string}){
  if(!this.authority)throw new SourceControlError('EXTERNAL_AUTHORITY_REQUIRED','A trusted independent activation verifier is required');
  const proof=await this.authority.verify(input);if(proof.epoch!==input.activated_epoch)throw new SourceControlError('STALE_AUTHORITY','External activation differs');
  return this.backups.invalidateVerification(context,input.backup_id,input.operation_id,{deployment_id:proof.deployment_id,epoch:proof.epoch});
 }
 async activate(context:SourceContext,input:SourceExternalActivation&{backup_id:string}){
  parseUUID(input.backup_id,'backup_id');parseUUID(input.operation_id,'operation_id');parseUUID(input.expected_external_epoch,'expected_external_epoch');parseUUID(input.activated_epoch,'activated_epoch');if(input.expected_database_epoch!==null)parseUUID(input.expected_database_epoch,'expected_database_epoch');
  if(!this.authority)throw new SourceControlError('EXTERNAL_AUTHORITY_REQUIRED','A trusted independent activation verifier is required');
  const proof=await this.authority.verify(input);if(proof.epoch!==input.activated_epoch)throw new SourceControlError('STALE_AUTHORITY','External activation differs');parseObjectId(proof.proof_digest);
  return this.metadata.transaction(async tx=>{
   await this.metadata.guard(tx,context,'source.recovery.activate',true);
   parseUUID(proof.deployment_id,'deployment_id');const current=(await tx.query("SELECT epoch FROM hyperfide.authority_epochs WHERE deployment_id=$1 AND epoch=$2 AND state='ACTIVE' FOR SHARE",[proof.deployment_id,proof.epoch])).rows[0];if(!current)throw new SourceControlError('STALE_AUTHORITY','External activation was superseded before source admission');
   const backup=(await tx.query('SELECT *,source_epoch::text,clock_timestamp() AS server_now FROM hyperfide.source_backups WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND backup_id=$4 FOR UPDATE',[...sourceScopeValues(context.scope),input.backup_id])).rows[0];
   if(!backup||backup.verification_operation_id!==input.operation_id||!['READY','ACTIVATED'].includes(backup.state)||new Date(backup.expires_at).getTime()<=new Date(backup.server_now).getTime())throw new SourceControlError('BACKUP_NOT_READY','Verified unexpired backup required');
   if(backup.state==='ACTIVATED'){if(backup.recovery_result.operation_id!==input.operation_id||backup.recovery_result.external_epoch!==proof.epoch)throw new SourceControlError('IDEMPOTENCY_CONFLICT','Backup already activated by another operation');return backup.recovery_result;}
   if(new Date(backup.server_now).getTime()-Date.parse(backup.manifest.captured_at)>backup.profile.backup.maximum_age_seconds*1000)throw new SourceControlError('BACKUP_TOO_OLD','Backup exceeds the declared recovery age');
   const runtime=(await tx.query("SELECT current_setting('fsync') AS fsync,current_setting('synchronous_commit') AS commit,(SELECT count(*)::integer FROM pg_stat_replication WHERE state='streaming' AND sync_state IN ('sync','quorum')) AS replicas")).rows[0];
   if(runtime?.fsync!=='on'||!['on','remote_apply'].includes(runtime.commit)||backup.profile.metadata.acknowledgment==='SYNC_REPLICA'&&runtime.replicas<1)throw new SourceControlError('DURABILITY_NOT_READY','Restored metadata does not satisfy the declared acknowledgment policy');
   if(backup.profile.backup.external_journal_id!==proof.deployment_id)throw new SourceControlError('STALE_AUTHORITY','Backup external authority deployment differs');
   if(backup.source_epoch!==context.authority_epoch)throw new SourceControlError('STALE_AUTHORITY','Backup source generation differs from restored authority');
   const next=String(BigInt(context.authority_epoch)+1n);if(BigInt(next)>9223372036854775807n)throw new SourceControlError('LIMIT_EXCEEDED','Source epoch exceeds metadata range');
   await tx.query('UPDATE hyperfide.source_repositories SET authority_epoch=$4 WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3',[...sourceScopeValues(context.scope),next]);
   await tx.query('UPDATE hyperfide.source_authority_domains SET authority_epoch=$4 WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3',[...sourceScopeValues(context.scope),next]);
   const state=await tx.query("UPDATE hyperfide.source_recovery_state SET state='READY',updated_at=clock_timestamp() WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND operation_id=$4 RETURNING operation_id",[...sourceScopeValues(context.scope),input.operation_id]);if(state.rowCount!==1)throw new SourceControlError('STALE_AUTHORITY','Recovery preparation changed');
   const result={backup_id:input.backup_id,operation_id:input.operation_id,external_epoch:proof.epoch,source_epoch:next,proof_digest:proof.proof_digest,mutations_ready:true};
   await tx.query("UPDATE hyperfide.source_backups SET state='ACTIVATED',recovery_result=$5 WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND backup_id=$4",[...sourceScopeValues(context.scope),input.backup_id,result]);return result;
  });
 }
}
