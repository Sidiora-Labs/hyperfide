import {randomUUID} from 'node:crypto';
import {parseGeneration,parseObjectId,SourceControlError} from './contracts.js';
import {validateStorageScope} from './object_catalog.js';
import {retentionScope} from './pins.js';
import type {SourceCatalogDatabase,SourceDeletionBackend,SourceStorageScope} from './storage_contract.js';
export interface SourceRetentionPolicy {expected_generation:string;minimum_age_seconds:number;quarantine_seconds:number;backup_until:string;backend_identity:string;independent_expiration:boolean}
const bounded=(value:number,maximum:number)=>{if(!Number.isSafeInteger(value)||value<0||value>maximum)throw new SourceControlError('INVALID_REQUEST','Collection limit is out of bounds');};
export class SourceCollector {
 constructor(private readonly database:SourceCatalogDatabase,private readonly backend:SourceDeletionBackend){}
 async configure(scope:SourceStorageScope,input:SourceRetentionPolicy){
  validateStorageScope(scope);parseGeneration(input.expected_generation);bounded(input.minimum_age_seconds,31536000);bounded(input.quarantine_seconds,31536000);
  if(!Number.isFinite(Date.parse(input.backup_until))||input.independent_expiration!==false||input.backend_identity!==this.backend.identity)throw new SourceControlError('RETENTION_POLICY_INVALID','Retention requires exact backend identity and no independent expiration');
  return this.database.transaction(async tx=>{
   await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[retentionScope(scope).join('/')]);
   const row=(await tx.query('SELECT *,generation::text FROM hyperfide.source_retention_policies WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 FOR UPDATE',retentionScope(scope))).rows[0];
   if(row&&row.generation===String(BigInt(input.expected_generation)+1n)&&row.minimum_age_seconds===input.minimum_age_seconds&&row.quarantine_seconds===input.quarantine_seconds&&new Date(row.backup_until).getTime()===Date.parse(input.backup_until)&&row.backend_identity===input.backend_identity)return {generation:row.generation};
   if((row?.generation??'0')!==input.expected_generation)throw new SourceControlError('STALE_GENERATION','Retention policy generation changed');
   if((await tx.query("SELECT 1 FROM hyperfide.source_collection_work WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND state='DELETE_PENDING' LIMIT 1",retentionScope(scope))).rowCount)throw new SourceControlError('COLLECTION_IN_PROGRESS','Resolve admitted deletions before changing retention policy');
   const generation=String(BigInt(input.expected_generation)+1n);
   await tx.query(`INSERT INTO hyperfide.source_retention_policies(organisation_id,repository_id,security_domain_id,generation,minimum_age_seconds,quarantine_seconds,backup_until,backend_identity,independent_expiration) VALUES($1,$2,$3,$4,$5,$6,$7,$8,false) ON CONFLICT(organisation_id,repository_id,security_domain_id) DO UPDATE SET generation=EXCLUDED.generation,minimum_age_seconds=EXCLUDED.minimum_age_seconds,quarantine_seconds=EXCLUDED.quarantine_seconds,backup_until=EXCLUDED.backup_until,backend_identity=EXCLUDED.backend_identity`,[...retentionScope(scope),generation,input.minimum_age_seconds,input.quarantine_seconds,input.backup_until,input.backend_identity]);return {generation};
  });
 }
 async discover(scope:SourceStorageScope,input:{partition:number;limit:number}){
  validateStorageScope(scope);bounded(input.partition,15);bounded(input.limit,256);if(!input.limit)throw new SourceControlError('INVALID_REQUEST','Positive collection limit required');
  return this.database.transaction(async tx=>{
   const policy=(await tx.query('SELECT *,generation::text FROM hyperfide.source_retention_policies WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND backup_until<=clock_timestamp() FOR SHARE',retentionScope(scope))).rows[0];
   if(!policy)return {quarantined:[],blocked:'RETENTION_POLICY_OR_BACKUP_HORIZON'};
   const rows=(await tx.query(`SELECT o.*,o.generation::text,p.storage_key FROM hyperfide.source_native_objects o JOIN hyperfide.source_object_placements p ON p.organisation_id=o.organisation_id AND p.repository_id=o.repository_id AND p.security_domain_id=o.security_domain_id AND p.object_id=o.object_id AND p.incarnation_id=o.current_incarnation WHERE o.organisation_id=$1 AND o.repository_id=$2 AND o.security_domain_id=$3 AND o.gc_partition=$4 AND o.state IN ('VERIFIED','UPLOADING') AND o.created_at<=clock_timestamp()-($5::integer*interval '1 second') AND NOT EXISTS(SELECT 1 FROM hyperfide.source_object_pins pin WHERE pin.organisation_id=o.organisation_id AND pin.repository_id=o.repository_id AND pin.security_domain_id=o.security_domain_id AND pin.object_id=o.object_id AND pin.incarnation_id=o.current_incarnation AND (pin.expires_at IS NULL OR pin.expires_at>clock_timestamp())) ORDER BY o.created_at,o.object_id FOR UPDATE OF o,p SKIP LOCKED LIMIT $6`,[...retentionScope(scope),input.partition,policy.minimum_age_seconds,input.limit])).rows;
   const quarantined=[];
   for(const row of rows){
    const referenced=(await tx.query(`SELECT 1 FROM hyperfide.source_object_pins WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND object_id=$4 AND incarnation_id=$5 AND (expires_at IS NULL OR expires_at>clock_timestamp()) LIMIT 1`,[...retentionScope(scope),row.object_id,row.current_incarnation])).rowCount;
    if(referenced)continue;
    await tx.query(`UPDATE hyperfide.source_native_objects SET state='QUARANTINED' WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND object_id=$4`,[...retentionScope(scope),row.object_id]);
    await tx.query(`UPDATE hyperfide.source_object_placements SET state='QUARANTINED' WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND object_id=$4 AND incarnation_id=$5`,[...retentionScope(scope),row.object_id,row.current_incarnation]);
    const work=(await tx.query(`INSERT INTO hyperfide.source_collection_work(organisation_id,repository_id,security_domain_id,object_id,incarnation_id,generation,partition,operation_id,storage_key,size_bytes,policy_generation,state,eligible_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'QUARANTINED',clock_timestamp()+($12::integer*interval '1 second')) ON CONFLICT(organisation_id,repository_id,security_domain_id,object_id,incarnation_id) DO UPDATE SET state='QUARANTINED',policy_generation=EXCLUDED.policy_generation,eligible_at=EXCLUDED.eligible_at,quarantined_at=clock_timestamp() RETURNING operation_id`,[...retentionScope(scope),row.object_id,row.current_incarnation,row.generation,input.partition,randomUUID(),row.storage_key,row.size_bytes,policy.generation,policy.quarantine_seconds])).rows[0];quarantined.push({object_id:row.object_id,incarnation_id:row.current_incarnation,operation_id:work!.operation_id});
   }
   return {quarantined};
  });
 }
 async collect(scope:SourceStorageScope,input:{partition:number;limit:number},signal?:AbortSignal){
  validateStorageScope(scope);bounded(input.partition,15);bounded(input.limit,256);if(!input.limit)throw new SourceControlError('INVALID_REQUEST','Positive collection limit required');
  const work=await this.database.transaction(async tx=>{
   const policy=(await tx.query('SELECT *,generation::text FROM hyperfide.source_retention_policies WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND backup_until<=clock_timestamp() FOR SHARE',retentionScope(scope))).rows[0];if(!policy)return [];
   if(policy.backend_identity!==this.backend.identity||policy.independent_expiration)throw new SourceControlError('RETENTION_POLICY_INVALID','Backend retention policy changed');
   const rows=(await tx.query(`SELECT w.* FROM hyperfide.source_collection_work w JOIN hyperfide.source_native_objects o ON o.organisation_id=w.organisation_id AND o.repository_id=w.repository_id AND o.security_domain_id=w.security_domain_id AND o.object_id=w.object_id AND o.current_incarnation=w.incarnation_id AND o.generation=w.generation WHERE w.organisation_id=$1 AND w.repository_id=$2 AND w.security_domain_id=$3 AND w.partition=$4 AND w.state IN ('QUARANTINED','DELETE_PENDING') AND w.eligible_at<=clock_timestamp() AND w.quarantined_at<=clock_timestamp()-($6::integer*interval '1 second') AND o.created_at<=clock_timestamp()-($7::integer*interval '1 second') ORDER BY w.eligible_at,w.object_id FOR UPDATE OF o,w SKIP LOCKED LIMIT $5`,[...retentionScope(scope),input.partition,input.limit,policy.quarantine_seconds,policy.minimum_age_seconds])).rows;
   const selected=[];
   for(const row of rows){
    const pins=(await tx.query(`SELECT 1 FROM hyperfide.source_object_pins WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND object_id=$4 AND incarnation_id=$5 AND (expires_at IS NULL OR expires_at>clock_timestamp()) LIMIT 1`,[...retentionScope(scope),row.object_id,row.incarnation_id])).rowCount;
    if(pins){if(row.state==='DELETE_PENDING')throw new SourceControlError('RETENTION_INVARIANT','Deletion intent has an acquired live pin');continue;}
    await tx.query(`UPDATE hyperfide.source_native_objects SET state='DELETE_PENDING' WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND object_id=$4 AND current_incarnation=$5`,[...retentionScope(scope),row.object_id,row.incarnation_id]);
    await tx.query(`UPDATE hyperfide.source_object_placements SET state='DELETE_PENDING' WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND object_id=$4 AND incarnation_id=$5`,[...retentionScope(scope),row.object_id,row.incarnation_id]);
    await tx.query(`UPDATE hyperfide.source_collection_work SET state='DELETE_PENDING',policy_generation=$6,attempts=attempts+1,last_attempt_at=clock_timestamp() WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND object_id=$4 AND incarnation_id=$5`,[...retentionScope(scope),row.object_id,row.incarnation_id,policy.generation]);selected.push(row);
   }return selected;
  });
  const results=[];
  for(const row of work){
   if(signal?.aborted)break;
   let outcome:'ABSENT'|'UNKNOWN'='UNKNOWN';
   try{outcome=await this.backend.delete(row.storage_key,row.object_id,Number(row.size_bytes),signal);}catch(error){if(error instanceof SourceControlError&&error.code==='OBJECT_INTEGRITY')outcome='UNKNOWN';else if(error instanceof SourceControlError)throw error;}
   await this.database.transaction(async tx=>{
    await tx.query(`SELECT 1 FROM hyperfide.source_native_objects WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND object_id=$4 FOR UPDATE`,[...retentionScope(scope),row.object_id]);
    await tx.query(`UPDATE hyperfide.source_collection_work SET last_outcome=$6,state=CASE WHEN $6='ABSENT' THEN 'ABSENT' ELSE state END WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND object_id=$4 AND incarnation_id=$5 AND operation_id=$7`,[...retentionScope(scope),row.object_id,row.incarnation_id,outcome,row.operation_id]);
    if(outcome==='ABSENT'){
     await tx.query(`UPDATE hyperfide.source_object_placements SET state='ABSENT' WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND object_id=$4 AND incarnation_id=$5`,[...retentionScope(scope),row.object_id,row.incarnation_id]);
     await tx.query(`UPDATE hyperfide.source_native_objects SET state='ABSENT' WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND object_id=$4 AND current_incarnation=$5 AND generation=$6`,[...retentionScope(scope),row.object_id,row.incarnation_id,row.generation]);
     await tx.query(`DELETE FROM hyperfide.source_object_pins WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND owner_kind='OBJECT' AND owner_id=$4`,[...retentionScope(scope),row.object_id+'/'+row.incarnation_id]);
    }
   });results.push({object_id:row.object_id,incarnation_id:row.incarnation_id,operation_id:row.operation_id,outcome});
  }return {results};
 }
 async inspect(scope:SourceStorageScope,input:{partition:number;limit:number;after?:string}){
  validateStorageScope(scope);bounded(input.partition,15);bounded(input.limit,256);if(!input.limit)throw new SourceControlError('INVALID_REQUEST','Positive inspection limit required');if(input.after)parseObjectId(input.after);
  return this.database.transaction(async tx=>{const work=(await tx.query(`SELECT object_id,incarnation_id,generation::text,operation_id,state,attempts,last_outcome,eligible_at FROM hyperfide.source_collection_work WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND partition=$4 AND state IN ('QUARANTINED','DELETE_PENDING') AND ($6::text IS NULL OR object_id>$6) ORDER BY object_id,incarnation_id LIMIT $5`,[...retentionScope(scope),input.partition,input.limit,input.after??null])).rows;return {work:work.map(row=>({...row,eligible_at:new Date(row.eligible_at).toISOString()})),next_cursor:work.length===input.limit?work.at(-1)!.object_id:null};});
 }
}
