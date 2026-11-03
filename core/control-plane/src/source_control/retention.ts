import {parseObjectId,parseUUID,SourceControlError} from './contracts.js';
import {SourceCollector,type SourceRetentionPolicy} from './gc.js';
import {SourceMetadata,type SourceContext} from './metadata.js';
import {retainSourceObject,releaseSourceObject,retentionScope,reserveSourceChild,reconcileSourceReservation} from './pins.js';
import type {SourceDeletionBackend} from './storage_contract.js';
const rootView=(row:Record<string,any>)=>({...row,expires_at:row.expires_at===null?null:new Date(row.expires_at).toISOString()});
export type SourceRootKind='WORKSPACE'|'CUSTODY'|'CANDIDATE'|'EVIDENCE'|'IMPORT'|'EXPORT'|'BACKUP'|'HOLD';
export class SourceRetentionService {
 constructor(private readonly metadata:SourceMetadata,private readonly backend:SourceDeletionBackend){}
 private collector(context:SourceContext,action:string){return new SourceCollector({transaction:body=>this.metadata.transaction(async tx=>{await this.metadata.guard(tx,context,action);return body(tx);})},this.backend);}
 configure(context:SourceContext,input:SourceRetentionPolicy){return this.collector(context,'source.retention.configure').configure(context.scope,input);}
 discover(context:SourceContext,input:{partition:number;limit:number}){return this.collector(context,'source.collection.discover').discover(context.scope,input);}
 collect(context:SourceContext,input:{partition:number;limit:number},signal?:AbortSignal){return this.collector(context,'source.collection.collect').collect(context.scope,input,signal);}
 inspect(context:SourceContext,input:{partition:number;limit:number;after?:string}){return this.collector(context,'source.collection.inspect').inspect(context.scope,input);}
 async reserve(context:SourceContext,input:Parameters<typeof reserveSourceChild>[2]){return this.metadata.transaction(async tx=>{await this.metadata.guard(tx,context,'source.retention.reserve');return reserveSourceChild(tx,context.scope,input);});}
 async reconcile(context:SourceContext,input:{reservation_id:string}){return this.metadata.transaction(async tx=>{await this.metadata.guard(tx,context,'source.retention.reconcile');return reconcileSourceReservation(tx,context.scope,input.reservation_id);});}
 async acquire(context:SourceContext,input:{root_id:string;owner_kind:SourceRootKind;owner_id:string;object_id:string;expires_at?:string|null}){
  parseUUID(input.root_id,'root_id');parseObjectId(input.object_id);
  if(!['WORKSPACE','CUSTODY','CANDIDATE','EVIDENCE','IMPORT','EXPORT','BACKUP','HOLD'].includes(input.owner_kind)||typeof input.owner_id!=='string'||!input.owner_id||Buffer.byteLength(input.owner_id)>256)throw new SourceControlError('INVALID_REQUEST','Explicit bounded retention owner required');
  return this.metadata.transaction(async tx=>{
   await this.metadata.guard(tx,context,'source.retention.acquire');
   const current=(await tx.query('SELECT * FROM hyperfide.source_retention_roots WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND root_id=$4 FOR UPDATE',[...retentionScope(context.scope),input.root_id])).rows[0];
   if(current){if(current.owner_kind!==input.owner_kind||current.owner_id!==input.owner_id||current.object_id!==input.object_id||current.state!=='ACTIVE'||((current.expires_at===null)!==(input.expires_at==null))||current.expires_at&&new Date(current.expires_at).getTime()!==Date.parse(input.expires_at!))throw new SourceControlError('IDEMPOTENCY_CONFLICT','Retention root identity differs');return rootView(current);}
   const row=await retainSourceObject(tx,context.scope,{object_id:input.object_id,owner_id:'root:'+input.root_id,...(input.expires_at!==undefined?{expires_at:input.expires_at}:{})});
   const inserted=(await tx.query(`INSERT INTO hyperfide.source_retention_roots(organisation_id,repository_id,security_domain_id,root_id,owner_kind,owner_id,object_id,incarnation_id,expires_at,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'ACTIVE') ON CONFLICT DO NOTHING RETURNING *`,[...retentionScope(context.scope),input.root_id,input.owner_kind,input.owner_id,row.object_id,row.incarnation_id,input.expires_at??null])).rows[0];
   if(inserted)return rootView(inserted);
   const replay=(await tx.query('SELECT * FROM hyperfide.source_retention_roots WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND root_id=$4',[...retentionScope(context.scope),input.root_id])).rows[0];
   if(!replay||replay.owner_kind!==input.owner_kind||replay.owner_id!==input.owner_id||replay.state!=='ACTIVE')throw new SourceControlError('IDEMPOTENCY_CONFLICT','Concurrent retention owner differs');return rootView(replay);
  });
 }
 async release(context:SourceContext,input:{root_id:string;owner_kind:SourceRootKind;owner_id:string}){
  parseUUID(input.root_id,'root_id');
  return this.metadata.transaction(async tx=>{
   await this.metadata.guard(tx,context,'source.retention.release');
   const row=(await tx.query('SELECT * FROM hyperfide.source_retention_roots WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND root_id=$4 FOR UPDATE',[...retentionScope(context.scope),input.root_id])).rows[0];
   if(!row||row.owner_kind!==input.owner_kind||row.owner_id!==input.owner_id)throw new SourceControlError('RETENTION_OWNER_MISMATCH','Exact retention owner required');
   if(row.state==='ACTIVE'){
    await releaseSourceObject(tx,context.scope,{object_id:row.object_id,incarnation_id:row.incarnation_id,owner_id:'root:'+input.root_id});
    await tx.query(`UPDATE hyperfide.source_retention_roots SET state='RELEASED' WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND root_id=$4`,[...retentionScope(context.scope),input.root_id]);
   }return {root_id:input.root_id,state:'RELEASED'};
  });
 }
}
