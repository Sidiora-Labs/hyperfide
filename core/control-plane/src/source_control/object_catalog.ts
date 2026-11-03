import {createHash,randomUUID} from 'node:crypto';
import {parseObjectId,sourceError} from './contracts.js';
import type {ObjectUpload,SourceCatalogDatabase,SourceObjectCatalog,SourceStorageScope,SourceTransaction,StoredObject,VerifiedObject} from './storage_contract.js';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function validateStorageScope(scope:SourceStorageScope):void{if(!scope||![scope.organisation_id,scope.repository_id,scope.security_domain_id].every(v=>typeof v==='string'&&UUID.test(v)))sourceError('INVALID_SCOPE','Canonical source scope required');}
const keys=(s:SourceStorageScope)=>[s.organisation_id,s.repository_id,s.security_domain_id];
const selected=`o.organisation_id,o.repository_id,o.security_domain_id,o.object_id,o.kind,o.size_bytes::text,o.tree_prefix,CASE WHEN o.state='VERIFIED' AND p.state<>'VERIFIED' THEN p.state ELSE o.state END AS state,o.generation::text,p.incarnation_id,p.storage_key,p.verified_at`;
const join=' FROM hyperfide.source_native_objects o JOIN hyperfide.source_object_placements p ON p.organisation_id=o.organisation_id AND p.repository_id=o.repository_id AND p.security_domain_id=o.security_domain_id AND p.object_id=o.object_id AND p.incarnation_id=o.current_incarnation';
const where=' WHERE o.organisation_id=$1 AND o.repository_id=$2 AND o.security_domain_id=$3 AND o.object_id=$4';
async function load(tx:SourceTransaction,scope:SourceStorageScope,id:string,lock=false):Promise<StoredObject|null>{return(await tx.query<StoredObject>('SELECT '+selected+join+where+(lock?' FOR UPDATE OF o,p':''),[...keys(scope),id])).rows[0]??null;}
async function ready(tx:SourceTransaction,scope:SourceStorageScope,id:string):Promise<VerifiedObject>{const row=await load(tx,scope,id,true);if(!row||!['VERIFIED','QUARANTINED'].includes(row.state)||row.state==='QUARANTINED'&&!row.verified_at)sourceError('OBJECT_NOT_READY','Source object is not referenceable');return row as VerifiedObject;}
async function pin(tx:SourceTransaction,scope:SourceStorageScope,row:VerifiedObject,kind:string,owner:string,position:number,expires:string|null):Promise<void>{
 const existing=await tx.query('INSERT INTO hyperfide.source_object_pins(organisation_id,repository_id,security_domain_id,object_id,incarnation_id,owner_kind,owner_id,position,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING object_id',[...keys(scope),row.object_id,row.incarnation_id,kind,owner,position,expires]);
 if(!existing.rows.length){const old=(await tx.query('SELECT object_id,incarnation_id,expires_at FROM hyperfide.source_object_pins WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND owner_kind=$4 AND owner_id=$5 AND position=$6',[...keys(scope),kind,owner,position])).rows[0];if(!old||old.object_id!==row.object_id||old.incarnation_id!==row.incarnation_id||((old.expires_at===null)!==(expires===null))||expires!==null&&new Date(old.expires_at).getTime()<Date.parse(expires))sourceError('PIN_CONFLICT','Retained source pin binding differs');}
}
export async function protectSourceRoot(tx:SourceTransaction,scope:SourceStorageScope,treeId:string,ownerId:string):Promise<VerifiedObject>{validateStorageScope(scope);parseObjectId(treeId);const row=await ready(tx,scope,treeId);if(!['tree-leaf','tree-index'].includes(row.kind)||row.tree_prefix!=='')sourceError('INVALID_TREE','Revision root must be a verified directory tree');await pin(tx,scope,row,'REVISION',ownerId,0,null);return {...row,state:'VERIFIED'};}
export async function acquireReadPin(tx:SourceTransaction,input:{scope:SourceStorageScope;object_id:string;incarnation_id:string;expires_at:string;owner_id:string}):Promise<VerifiedObject>{
 validateStorageScope(input.scope);parseObjectId(input.object_id);if(!UUID.test(input.incarnation_id)||!Number.isFinite(Date.parse(input.expires_at)))sourceError('INVALID_PIN','Exact read pin required');
 const row=await ready(tx,input.scope,input.object_id);if(row.incarnation_id!==input.incarnation_id)sourceError('OBJECT_RECLAIMED','Requested source placement changed');
 const clock=(await tx.query('SELECT clock_timestamp()<$1::timestamptz AS valid',[input.expires_at])).rows[0];if(!clock?.valid)sourceError('EXPIRED_GRANT','Read pin deadline has passed');await pin(tx,input.scope,row,'READ',input.owner_id,0,input.expires_at);return {...row,state:'VERIFIED'};
}
export class PostgresSourceObjectCatalog implements SourceObjectCatalog {
 constructor(private readonly database:SourceCatalogDatabase){}
 async lookup(scope:SourceStorageScope,id:string):Promise<StoredObject|null>{validateStorageScope(scope);parseObjectId(id);return this.database.transaction(tx=>load(tx,scope,id));}
 async begin(scope:SourceStorageScope,request:{operation_id:string;object_id:string;kind:StoredObject['kind'];size_bytes:string;owner_principal_id?:string}):Promise<ObjectUpload>{
 validateStorageScope(scope);parseObjectId(request.object_id);if(request.owner_principal_id!==undefined&&!UUID.test(request.owner_principal_id)||!UUID.test(request.operation_id)||!['blob','chunk','file','tree-leaf','tree-index','manifest','revision'].includes(request.kind)||!/^(0|[1-9][0-9]*)$/.test(request.size_bytes)||BigInt(request.size_bytes)>8388608n)sourceError('INVALID_UPLOAD','Bounded canonical object upload required');
 const requestDigest='sha256:'+createHash('sha256').update(JSON.stringify([request.object_id,request.kind,request.size_bytes,request.owner_principal_id??null])).digest('hex');
 return this.database.transaction(async tx=>{
  const prior=(await tx.query('SELECT upload_id,request_digest FROM hyperfide.source_object_uploads WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND operation_id=$4',[...keys(scope),request.operation_id])).rows[0];
  if(prior){if(prior.request_digest!==requestDigest)sourceError('IDEMPOTENCY_CONFLICT','Upload operation has different canonical bytes');return this.loadUpload(tx,scope,prior.upload_id);}
  let incarnation=randomUUID();
  await tx.query("INSERT INTO hyperfide.source_native_objects(organisation_id,repository_id,security_domain_id,object_id,kind,size_bytes,state,current_incarnation) VALUES($1,$2,$3,$4,$5,$6,'UPLOADING',$7) ON CONFLICT DO NOTHING",[...keys(scope),request.object_id,request.kind,request.size_bytes,incarnation]);
  const object=(await tx.query('SELECT kind,size_bytes::text,state,generation::text,current_incarnation FROM hyperfide.source_native_objects WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND object_id=$4 FOR UPDATE',[...keys(scope),request.object_id])).rows[0]!;
  if(object.kind!==request.kind||object.size_bytes!==request.size_bytes)sourceError('OBJECT_CONFLICT','Native identity metadata differs');
  let generation=object.generation;
  if(object.state==='ABSENT'){generation=String(BigInt(generation)+1n);await tx.query("UPDATE hyperfide.source_native_objects SET state='UPLOADING',generation=$5,current_incarnation=$6 WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND object_id=$4",[...keys(scope),request.object_id,generation,incarnation]);}
  else{if(!['UPLOADING','VERIFIED'].includes(object.state))sourceError('OBJECT_RECLAIMED','Object lifecycle prevents new references');incarnation=object.current_incarnation;}
  const key='source/v1/'+scope.security_domain_id+'/'+request.kind+'/'+request.object_id.slice(7,9)+'/'+request.object_id.slice(7)+'/'+incarnation;
  await tx.query('INSERT INTO hyperfide.source_object_placements(organisation_id,repository_id,security_domain_id,object_id,incarnation_id,generation,storage_key,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING',[...keys(scope),request.object_id,incarnation,generation,key,object.state==='VERIFIED'?'VERIFIED':'UPLOADING']);
  const upload=randomUUID();
  await tx.query("INSERT INTO hyperfide.source_object_uploads(organisation_id,repository_id,security_domain_id,upload_id,operation_id,object_id,incarnation_id,request_digest,status,owner_principal_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(organisation_id,repository_id,security_domain_id,operation_id) DO NOTHING",[...keys(scope),upload,request.operation_id,request.object_id,incarnation,requestDigest,object.state==='VERIFIED'?'VERIFIED':'UPLOADING',request.owner_principal_id??null]);
  const retained=(await tx.query('SELECT upload_id,request_digest FROM hyperfide.source_object_uploads WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND operation_id=$4',[...keys(scope),request.operation_id])).rows[0]!;
  if(retained.request_digest!==requestDigest)sourceError('IDEMPOTENCY_CONFLICT','Concurrent upload operation differs');
  const result=await this.loadUpload(tx,scope,retained.upload_id);
  await tx.query("INSERT INTO hyperfide.source_object_pins(organisation_id,repository_id,security_domain_id,object_id,incarnation_id,owner_kind,owner_id,position,expires_at) VALUES($1,$2,$3,$4,$5,'UPLOAD',$6,0,$7) ON CONFLICT DO NOTHING",[...keys(scope),request.object_id,incarnation,result.upload_id,result.expires_at]);return result;
 });
 }
 private async loadUpload(tx:SourceTransaction,scope:SourceStorageScope,id:string):Promise<ObjectUpload>{
 const row=(await tx.query<ObjectUpload>('SELECT '+selected+',u.upload_id,u.operation_id,u.owner_principal_id,u.status,u.expires_at::text'+join+' JOIN hyperfide.source_object_uploads u ON u.organisation_id=o.organisation_id AND u.repository_id=o.repository_id AND u.security_domain_id=o.security_domain_id AND u.object_id=o.object_id AND u.incarnation_id=p.incarnation_id WHERE o.organisation_id=$1 AND o.repository_id=$2 AND o.security_domain_id=$3 AND u.upload_id=$4',[...keys(scope),id])).rows[0];if(!row)sourceError('UPLOAD_NOT_FOUND','Upload is unavailable in this source scope');return {...row,expires_at:new Date(row.expires_at).toISOString()};
 }
 async upload(scope:SourceStorageScope,id:string):Promise<ObjectUpload>{validateStorageScope(scope);if(!UUID.test(id))sourceError('INVALID_UPLOAD','Canonical upload identity required');return this.database.transaction(tx=>this.loadUpload(tx,scope,id));}
 async unknown(scope:SourceStorageScope,id:string):Promise<void>{await this.database.transaction(async tx=>{await this.loadUpload(tx,scope,id);await tx.query("UPDATE hyperfide.source_object_uploads SET status='UNKNOWN' WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND upload_id=$4 AND status<>'VERIFIED'",[...keys(scope),id]);});}
 async verify(scope:SourceStorageScope,id:string,children:readonly string[],metadata:{tree_prefix:string|null}={tree_prefix:null}):Promise<VerifiedObject>{
 if(children.length>4096)sourceError('OBJECT_LIMIT','Source child list exceeds its format bound');children.forEach(parseObjectId);
 return this.database.transaction(async tx=>{
  const upload=await this.loadUpload(tx,scope,id);if(upload.status!=='VERIFIED'&&!(await tx.query('SELECT expires_at>clock_timestamp() AS valid FROM hyperfide.source_object_uploads WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND upload_id=$4',[...keys(scope),id])).rows[0]?.valid)sourceError('UPLOAD_EXPIRED','Upload session expired before verification');const parent=await load(tx,scope,upload.object_id,true);if(!parent||parent.incarnation_id!==upload.incarnation_id||!['UPLOADING','VERIFIED'].includes(parent.state))sourceError('OBJECT_RECLAIMED','Upload placement cannot become referenceable');
  if(['tree-leaf','tree-index'].includes(parent.kind)!==(metadata.tree_prefix!==null)||parent.tree_prefix!==null&&parent.tree_prefix!==metadata.tree_prefix)sourceError('INVALID_TREE','Verified tree prefix metadata differs');
  if(children.includes(parent.object_id))sourceError('OBJECT_CYCLE','A source object cannot reference itself');
  const childRows=new Map<string,VerifiedObject>();for(const child of [...new Set(children)].sort())childRows.set(child,await ready(tx,scope,child));
  for(let position=0;position<children.length;position++)await pin(tx,scope,childRows.get(children[position]!)!,'OBJECT',parent.object_id+'/'+parent.incarnation_id,position,null);
  await tx.query("UPDATE hyperfide.source_object_placements SET state='VERIFIED',verified_at=COALESCE(verified_at,clock_timestamp()) WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND object_id=$4 AND incarnation_id=$5",[...keys(scope),parent.object_id,parent.incarnation_id]);
  await tx.query("UPDATE hyperfide.source_native_objects SET state='VERIFIED',tree_prefix=$5 WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND object_id=$4",[...keys(scope),parent.object_id,metadata.tree_prefix]);
  await tx.query("UPDATE hyperfide.source_object_uploads SET status='VERIFIED' WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND upload_id=$4",[...keys(scope),id]);
  return {...parent,tree_prefix:metadata.tree_prefix,state:'VERIFIED'};
 });
 }
}
