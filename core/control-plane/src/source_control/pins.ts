import {parseObjectId,parseUUID,SourceControlError} from './contracts.js';
import {validateStorageScope} from './object_catalog.js';
import type {SourceStorageScope,SourceTransaction} from './storage_contract.js';
export const retentionScope=(scope:SourceStorageScope)=>[scope.organisation_id,scope.repository_id,scope.security_domain_id];
export async function lockSourcePlacement(tx:SourceTransaction,scope:SourceStorageScope,objectId:string,incarnationId?:string):Promise<Record<string,any>>{
 validateStorageScope(scope);parseObjectId(objectId);if(incarnationId)parseUUID(incarnationId,'incarnation_id');
 const row=(await tx.query(`SELECT o.object_id,o.current_incarnation AS incarnation_id,o.state,o.generation::text,p.storage_key,p.verified_at,o.size_bytes FROM hyperfide.source_native_objects o JOIN hyperfide.source_object_placements p ON p.organisation_id=o.organisation_id AND p.repository_id=o.repository_id AND p.security_domain_id=o.security_domain_id AND p.object_id=o.object_id AND p.incarnation_id=o.current_incarnation WHERE o.organisation_id=$1 AND o.repository_id=$2 AND o.security_domain_id=$3 AND o.object_id=$4 FOR UPDATE OF o`,[...retentionScope(scope),objectId])).rows[0];
 if(!row||incarnationId&&row.incarnation_id!==incarnationId)throw new SourceControlError('OBJECT_RECLAIMED','Exact source placement is no longer current');return row;
}
export async function retainSourceObject(tx:SourceTransaction,scope:SourceStorageScope,input:{object_id:string;incarnation_id?:string;owner_id:string;position?:number;expires_at?:string|null}):Promise<Record<string,any>>{
 const row=await lockSourcePlacement(tx,scope,input.object_id,input.incarnation_id);
 if(!['VERIFIED','QUARANTINED'].includes(row.state)||row.state==='QUARANTINED'&&!row.verified_at)throw new SourceControlError('OBJECT_NOT_READY','Source placement cannot accept retention');
 const position=input.position??0;if(!Number.isSafeInteger(position)||position<0)throw new SourceControlError('INVALID_REQUEST','Nonnegative pin position required');
 if(input.expires_at!==undefined&&input.expires_at!==null&&(!Number.isFinite(Date.parse(input.expires_at))||!(await tx.query('SELECT $1::timestamptz>clock_timestamp() AS valid',[input.expires_at])).rows[0]?.valid))throw new SourceControlError('EXPIRED_GRANT','Retention expiry must be in the future');
 const inserted=await tx.query(`INSERT INTO hyperfide.source_object_pins(organisation_id,repository_id,security_domain_id,object_id,incarnation_id,owner_kind,owner_id,position,expires_at) VALUES($1,$2,$3,$4,$5,'HOLD',$6,$7,$8) ON CONFLICT DO NOTHING RETURNING object_id`,[...retentionScope(scope),row.object_id,row.incarnation_id,input.owner_id,position,input.expires_at??null]);
 if(!inserted.rowCount){const old=(await tx.query(`SELECT object_id,incarnation_id,expires_at FROM hyperfide.source_object_pins WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND owner_kind='HOLD' AND owner_id=$4 AND position=$5`,[...retentionScope(scope),input.owner_id,position])).rows[0];if(!old||old.object_id!==row.object_id||old.incarnation_id!==row.incarnation_id||((old.expires_at===null)!==(input.expires_at==null))||old.expires_at&&new Date(old.expires_at).getTime()!==Date.parse(input.expires_at!))throw new SourceControlError('PIN_CONFLICT','Existing retention binding differs');}
 return {...row,state:'VERIFIED'};
}
export async function releaseSourceObject(tx:SourceTransaction,scope:SourceStorageScope,input:{object_id:string;incarnation_id:string;owner_id:string;position?:number}){
 await lockSourcePlacement(tx,scope,input.object_id);
 await tx.query(`DELETE FROM hyperfide.source_object_pins WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND object_id=$4 AND incarnation_id=$5 AND owner_kind='HOLD' AND owner_id=$6 AND position=$7`,[...retentionScope(scope),input.object_id,input.incarnation_id,input.owner_id,input.position??0]);
}
export async function reserveSourceChild(tx:SourceTransaction,scope:SourceStorageScope,input:{reservation_id:string;parent_object_id:string;parent_incarnation_id:string;child_object_id:string;child_incarnation_id:string;position:number}){
 parseUUID(input.reservation_id,'reservation_id');
 const prior=(await tx.query('SELECT * FROM hyperfide.source_child_reservations WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND reservation_id=$4 FOR UPDATE',[...retentionScope(scope),input.reservation_id])).rows[0];
 if(prior){if(Object.entries(input).some(([key,value])=>prior[key]!==value))throw new SourceControlError('PIN_CONFLICT','Reservation identity changed');if(prior.state!=='RESERVED')return {reservation_id:input.reservation_id,state:prior.state};}
 if(input.parent_object_id===input.child_object_id)throw new SourceControlError('OBJECT_CYCLE','A parent cannot reserve itself');
 const parent=await lockSourcePlacement(tx,scope,input.parent_object_id,input.parent_incarnation_id);
 if(!['UPLOADING','VERIFIED'].includes(parent.state))throw new SourceControlError('OBJECT_RECLAIMED','Parent no longer accepts child reservations');
 await retainSourceObject(tx,scope,{object_id:input.child_object_id,incarnation_id:input.child_incarnation_id,owner_id:'reservation:'+input.reservation_id});
 const existing=await tx.query(`INSERT INTO hyperfide.source_child_reservations(organisation_id,repository_id,security_domain_id,reservation_id,parent_object_id,parent_incarnation_id,child_object_id,child_incarnation_id,position,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'RESERVED') ON CONFLICT DO NOTHING RETURNING reservation_id`,[...retentionScope(scope),input.reservation_id,input.parent_object_id,input.parent_incarnation_id,input.child_object_id,input.child_incarnation_id,input.position]);
 if(!existing.rowCount){const prior=(await tx.query(`SELECT * FROM hyperfide.source_child_reservations WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND reservation_id=$4`,[...retentionScope(scope),input.reservation_id])).rows[0];if(!prior||Object.entries(input).some(([key,value])=>prior[key]!==value))throw new SourceControlError('PIN_CONFLICT','Reservation identity changed');}
 return {reservation_id:input.reservation_id,state:'RESERVED'};
}
export async function reconcileSourceReservation(tx:SourceTransaction,scope:SourceStorageScope,reservationId:string){
 parseUUID(reservationId,'reservation_id');const row=(await tx.query(`SELECT * FROM hyperfide.source_child_reservations WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND reservation_id=$4 FOR UPDATE`,[...retentionScope(scope),reservationId])).rows[0];
 if(!row)throw new SourceControlError('NOT_FOUND','Child reservation unavailable');if(row.state!=='RESERVED')return {state:row.state};
 const parent=(await tx.query(`SELECT state FROM hyperfide.source_object_placements WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND object_id=$4 AND incarnation_id=$5 FOR UPDATE`,[...retentionScope(scope),row.parent_object_id,row.parent_incarnation_id])).rows[0];
 if(parent?.state==='VERIFIED'){
  await lockSourcePlacement(tx,scope,row.child_object_id,row.child_incarnation_id);
  await tx.query(`INSERT INTO hyperfide.source_object_pins(organisation_id,repository_id,security_domain_id,object_id,incarnation_id,owner_kind,owner_id,position) VALUES($1,$2,$3,$4,$5,'OBJECT',$6,$7) ON CONFLICT DO NOTHING`,[...retentionScope(scope),row.child_object_id,row.child_incarnation_id,row.parent_object_id+'/'+row.parent_incarnation_id,row.position]);
  const adopted=(await tx.query("SELECT object_id,incarnation_id FROM hyperfide.source_object_pins WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND owner_kind='OBJECT' AND owner_id=$4 AND position=$5",[...retentionScope(scope),row.parent_object_id+'/'+row.parent_incarnation_id,row.position])).rows[0];
  if(!adopted||adopted.object_id!==row.child_object_id||adopted.incarnation_id!==row.child_incarnation_id)throw new SourceControlError('PIN_CONFLICT','Parent child binding differs from reserved child');
 }else if(parent?.state!=='ABSENT')return {state:'RESERVED',debt:'PARENT_OUTCOME_UNKNOWN'};
 await releaseSourceObject(tx,scope,{object_id:row.child_object_id,incarnation_id:row.child_incarnation_id,owner_id:'reservation:'+reservationId});
 const state=parent?.state==='VERIFIED'?'ADOPTED':'RELEASED';await tx.query(`UPDATE hyperfide.source_child_reservations SET state=$5 WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND reservation_id=$4`,[...retentionScope(scope),reservationId,state]);return {state};
}
