import {parseGeneration,parseObjectId,parseUUID,SourceControlError} from './contracts.js';
import {PostgresSourceObjectCatalog} from './object_catalog.js';
import {SourceMetadata,sourceDigest,sourceScopeValues,type SourceContext} from './metadata.js';
import type {SourceCatalogDatabase,SourceObjectCatalog,SourceStorageScope,SourceTransaction,StoredObject} from './storage_contract.js';
const owner=(value:unknown)=>{if(typeof value!=='string'||!value.length||Buffer.byteLength(value)>256)throw new SourceControlError('INVALID_REQUEST','Explicit bounded route owner required');return value;};
export const sourceObjectPartition=(id:string)=>{parseObjectId(id);return parseInt(id.slice(7,9),16)%16;};
export async function assertSourcePartitionOwner(tx:SourceTransaction,scope:SourceStorageScope,objectId:string,ownerId:string|null){
 const partition=sourceObjectPartition(objectId);
 if(!(await tx.query("SELECT to_regclass('hyperfide.source_partition_routes') IS NOT NULL AS present")).rows[0]?.present){if(ownerId===null)return null;throw new SourceControlError('STALE_ROUTE','Configured source owner requires partition routing');}
 await tx.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',[sourceScopeValues(scope).join('/')+'/'+partition]);
 const route=(await tx.query('SELECT owner_id,generation::text FROM hyperfide.source_partition_routes WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND partition=$4 FOR SHARE',[...sourceScopeValues(scope),sourceObjectPartition(objectId)])).rows[0];
 if(!route&&ownerId===null)return null;
 if(!route||route.owner_id!==ownerId)throw new SourceControlError('STALE_ROUTE','Object partition belongs to another current owner','REFRESH_AUTHORITY','KNOWN',{partition:sourceObjectPartition(objectId),generation:route?.generation??null});return route;
}
export class SourceRoutedObjectCatalog implements SourceObjectCatalog {
 constructor(private readonly database:SourceCatalogDatabase,private readonly ownerId:string|null=null){if(ownerId!==null)owner(ownerId);}
 private bound(scope:SourceStorageScope,target:{object_id?:string;upload_id?:string}){
  return new PostgresSourceObjectCatalog({transaction:body=>this.database.transaction(async tx=>{
   const objectId=target.object_id??(await tx.query('SELECT object_id FROM hyperfide.source_object_uploads WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND upload_id=$4',[...sourceScopeValues(scope),target.upload_id])).rows[0]?.object_id;
   if(!objectId)throw new SourceControlError('UPLOAD_NOT_FOUND','Scoped upload unavailable');await assertSourcePartitionOwner(tx,scope,objectId,this.ownerId);return body(tx);
  })});
 }
 begin(scope:SourceStorageScope,request:{operation_id:string;object_id:string;kind:StoredObject['kind'];size_bytes:string;owner_principal_id?:string}){return this.bound(scope,{object_id:request.object_id}).begin(scope,request);}
 lookup(scope:SourceStorageScope,id:string){return new PostgresSourceObjectCatalog(this.database).lookup(scope,id);}
 lookupMany(scope:SourceStorageScope,ids:readonly string[]){return new PostgresSourceObjectCatalog(this.database).lookupMany(scope,ids);}
 upload(scope:SourceStorageScope,id:string){return new PostgresSourceObjectCatalog(this.database).upload(scope,id);}
 unknown(scope:SourceStorageScope,id:string){return this.bound(scope,{upload_id:id}).unknown(scope,id);}
 verify(scope:SourceStorageScope,id:string,children:readonly string[],metadata?:{tree_prefix:string|null}){return this.bound(scope,{upload_id:id}).verify(scope,id,children,metadata);}
}
export class SourceRoutingService {
 constructor(private readonly metadata:SourceMetadata){}
 async read(context:SourceContext,input:{partition:number}){if(!Number.isInteger(input.partition)||input.partition<0||input.partition>15)throw new SourceControlError('INVALID_REQUEST','Partition must be from0to15');return this.metadata.transaction(async tx=>{await this.metadata.guard(tx,context,'source.routing.read');const row=(await tx.query('SELECT partition,generation::text,owner_id FROM hyperfide.source_partition_routes WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND partition=$4',[...sourceScopeValues(context.scope),input.partition])).rows[0];if(!row)throw new SourceControlError('ROUTE_UNAVAILABLE','Partition route is not configured');return row;});}
 async move(context:SourceContext,input:{operation_id:string;partition:number;expected_generation:string;owner_id:string}){
  parseUUID(input.operation_id,'operation_id');parseGeneration(input.expected_generation);owner(input.owner_id);if(!Number.isInteger(input.partition)||input.partition<0||input.partition>15)throw new SourceControlError('INVALID_REQUEST','Partition must be from0to15');
  return this.metadata.transaction(async tx=>{
   await this.metadata.guard(tx,context,'source.routing.move');await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[sourceScopeValues(context.scope).join('/')+'/'+input.partition]);
   const request=sourceDigest(input),prior=(await tx.query('SELECT request_digest,result FROM hyperfide.source_partition_moves WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND operation_id=$4',[...sourceScopeValues(context.scope),input.operation_id])).rows[0];if(prior){if(prior.request_digest!==request)throw new SourceControlError('IDEMPOTENCY_CONFLICT','Route move identity differs');return prior.result;}
   const row=(await tx.query('SELECT generation::text FROM hyperfide.source_partition_routes WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND partition=$4 FOR UPDATE',[...sourceScopeValues(context.scope),input.partition])).rows[0];if((row?.generation??'0')!==input.expected_generation)throw new SourceControlError('STALE_ROUTE','Partition generation changed');
   const generation=String(BigInt(input.expected_generation)+1n);await tx.query('INSERT INTO hyperfide.source_partition_routes(organisation_id,repository_id,security_domain_id,partition,generation,owner_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(organisation_id,repository_id,security_domain_id,partition) DO UPDATE SET generation=EXCLUDED.generation,owner_id=EXCLUDED.owner_id,updated_at=clock_timestamp()',[...sourceScopeValues(context.scope),input.partition,generation,input.owner_id]);
   const result={partition:input.partition,generation,owner_id:input.owner_id,storage:'SHARED_IMMUTABLE_PLACEMENTS'};await tx.query('INSERT INTO hyperfide.source_partition_moves(organisation_id,repository_id,security_domain_id,operation_id,partition,request_digest,result) VALUES($1,$2,$3,$4,$5,$6,$7)',[...sourceScopeValues(context.scope),input.operation_id,input.partition,request,result]);return result;
  });
 }
}
