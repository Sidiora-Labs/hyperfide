import {createHash,createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import {SourceControlError,canonicalBytes,parseObjectId,parseSourceScope,type SourceScope} from './contracts.js';
import {acquireReadPin} from './object_catalog.js';
import type {SourceAuthorization,SourceSQL} from './capabilities.js';

export interface TransferGrantConfiguration {key_id:string;signing_key:Uint8Array;endpoint:string;allowed_endpoints:readonly string[];maximum_lifetime_seconds?:number}
export interface SourceTransferGrant {schema_version:1;grant_id:string;scope:SourceScope;principal_id:string;capability_id:string;object_id:string;incarnation_id:string;storage_key:string;method:'GET'|'PUT';upload_id:string|null;issued_at:string;expires_at:string;authority_epoch:string;policy_version:string;key_id:string}
export interface SourceTransferRequest {object_id:string;incarnation_id:string;method:'GET'|'PUT';upload_id?:string;expires_at:string;paths?:readonly string[]}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function denied():never {throw new SourceControlError('INVALID_TRANSFER_GRANT','Source transfer is not authorized');}
function endpoint(config:TransferGrantConfiguration):URL {
 if(!/^[A-Za-z0-9._-]{1,128}$/.test(config.key_id)||config.signing_key.byteLength<32)throw new SourceControlError('CONFIGURATION_INVALID','A bounded transfer signing policy is required');
 let parsed:URL;try{parsed=new URL(config.endpoint);}catch{throw new SourceControlError('CONFIGURATION_INVALID','Trusted source transfer endpoint is required');}
 if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.search||parsed.hash||!config.allowed_endpoints.includes(parsed.origin))throw new SourceControlError('CONFIGURATION_INVALID','Source transfer endpoint is outside the trusted allowlist');
 return parsed;
}
function mac(bytes:Uint8Array,config:TransferGrantConfiguration):Buffer {return createHmac('sha256',config.signing_key).update(bytes).digest();}
function encode(grant:SourceTransferGrant,config:TransferGrantConfiguration):string {const bytes=canonicalBytes(grant);return Buffer.from(bytes).toString('base64url')+'.'+mac(bytes,config).toString('base64url');}
export async function issueSourceTransferGrant(tx:SourceSQL,authorization:SourceAuthorization,input:SourceTransferRequest,config:TransferGrantConfiguration):Promise<{grant:SourceTransferGrant;token:string;url:string;residual_validity_ms:number}> {
 const base=endpoint(config),maximum=config.maximum_lifetime_seconds??300;
 if(!Number.isInteger(maximum)||maximum<1||maximum>900)throw new SourceControlError('CONFIGURATION_INVALID','Transfer grant lifetime must be bounded');
 parseObjectId(input.object_id);if(!UUID.test(input.incarnation_id)||!['GET','PUT'].includes(input.method)||!Number.isFinite(Date.parse(input.expires_at)))denied();
 await authorization.assertCurrent(tx,input.method==='GET'?'source.objects.read':'source.objects.put',input.paths);
 if(input.method==='GET')await authorization.assertObjectAccess(tx,{object_id:input.object_id,...(input.paths?{paths:input.paths}:{})});
 const time=(await tx.query('SELECT clock_timestamp() AS now')).rows[0]!.now,now=new Date(time).getTime(),expires=Date.parse(input.expires_at);
 if(expires<=now||expires>now+maximum*1000||expires>Date.parse(authorization.expires_at))denied();
 const scope=authorization.scope,grantId=randomUUID();let storage_key:string,upload_id:string|null=null;
 if(input.method==='GET'){
  const object=await acquireReadPin(tx,{scope,object_id:input.object_id,incarnation_id:input.incarnation_id,expires_at:input.expires_at,owner_id:grantId});storage_key=object.storage_key;
 }else{
  if(!input.upload_id||!UUID.test(input.upload_id))denied();upload_id=input.upload_id;
  const row=(await tx.query(`SELECT p.storage_key FROM hyperfide.source_object_uploads u JOIN hyperfide.source_native_objects o USING(organisation_id,repository_id,security_domain_id,object_id)
   JOIN hyperfide.source_object_placements p ON p.organisation_id=u.organisation_id AND p.repository_id=u.repository_id AND p.security_domain_id=u.security_domain_id AND p.object_id=u.object_id AND p.incarnation_id=u.incarnation_id
   WHERE u.organisation_id=$1 AND u.repository_id=$2 AND u.security_domain_id=$3 AND u.upload_id=$4 AND u.object_id=$5 AND u.incarnation_id=$6
   AND u.owner_principal_id=$8 AND u.status='UPLOADING' AND p.state='UPLOADING' AND o.state='UPLOADING' AND o.current_incarnation=p.incarnation_id AND u.expires_at>=$7::timestamptz FOR SHARE OF u,o,p`,[scope.organisation_id,scope.repository_id,scope.security_domain_id,upload_id,input.object_id,input.incarnation_id,input.expires_at,authorization.principal_id])).rows[0];
  if(!row)denied();storage_key=row.storage_key;
 }
 const grant:SourceTransferGrant={schema_version:1,grant_id:grantId,scope,principal_id:authorization.principal_id,capability_id:authorization.capability_id,object_id:input.object_id,incarnation_id:input.incarnation_id,storage_key,method:input.method,upload_id,issued_at:new Date(now).toISOString(),expires_at:new Date(expires).toISOString(),authority_epoch:authorization.authority_epoch,policy_version:authorization.policy_version,key_id:config.key_id};
 const bytes=canonicalBytes(grant),digest='sha256:'+createHash('sha256').update(bytes).digest('hex');
 await tx.query(`INSERT INTO hyperfide.source_transfer_grants(organisation_id,repository_id,security_domain_id,id,principal_id,capability_id,object_id,incarnation_id,method,upload_id,grant_digest,expires_at)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[scope.organisation_id,scope.repository_id,scope.security_domain_id,grantId,authorization.principal_id,authorization.capability_id,input.object_id,input.incarnation_id,input.method,upload_id,digest,grant.expires_at]);
 const token=encode(grant,config);base.pathname=base.pathname.replace(/\/$/,'')+'/'+grantId;
 return {grant,token,url:base.toString(),residual_validity_ms:expires-now};
}
export function verifySourceTransferGrant(token:string,config:TransferGrantConfiguration,request:{scope:SourceScope;method:string;object_id:string;incarnation_id:string;storage_key:string;url:string},now=Date.now()):SourceTransferGrant {
 const base=endpoint(config);if(typeof token!=='string'||token.length>16384)denied();const parts=token.split('.');if(parts.length!==2)denied();
 const bytes=Buffer.from(parts[0]!,'base64url'),signature=Buffer.from(parts[1]!,'base64url');if(bytes.toString('base64url')!==parts[0]||signature.toString('base64url')!==parts[1])denied();
 const expected=mac(bytes,config);if(signature.length!==expected.length||!timingSafeEqual(signature,expected))denied();
 let grant:SourceTransferGrant;try{grant=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{return denied();}
 if(!grant||Buffer.compare(Buffer.from(canonicalBytes(grant)),bytes)!==0||grant.schema_version!==1||grant.key_id!==config.key_id||!UUID.test(grant.grant_id)||grant.method!==request.method||grant.object_id!==request.object_id||grant.incarnation_id!==request.incarnation_id||grant.storage_key!==request.storage_key)denied();
 const scope=parseSourceScope(request.scope),given=parseSourceScope(grant.scope);if(scope.organisation_id!==given.organisation_id||scope.repository_id!==given.repository_id||scope.security_domain_id!==given.security_domain_id)denied();
 base.pathname=base.pathname.replace(/\/$/,'')+'/'+grant.grant_id;let actual:URL;try{actual=new URL(request.url);}catch{return denied();}if(actual.toString()!==base.toString())denied();
 const issued=Date.parse(grant.issued_at),expires=Date.parse(grant.expires_at),maximum=config.maximum_lifetime_seconds??300;
 if(!Number.isFinite(issued)||!Number.isFinite(expires)||expires<=now||issued>now||expires<=issued||expires-issued>maximum*1000)denied();
 return grant;
}
export async function assertSourceTransferRetained(tx:SourceSQL,grant:SourceTransferGrant):Promise<void> {
 const s=grant.scope,digest='sha256:'+createHash('sha256').update(canonicalBytes(grant)).digest('hex');
 const row=(await tx.query(`SELECT 1 FROM hyperfide.source_transfer_grants g WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND id=$4 AND grant_digest=$5 AND expires_at>clock_timestamp()
 AND ((method='GET' AND EXISTS(SELECT 1 FROM hyperfide.source_object_pins p WHERE p.organisation_id=g.organisation_id AND p.repository_id=g.repository_id AND p.security_domain_id=g.security_domain_id AND p.object_id=g.object_id AND p.incarnation_id=g.incarnation_id AND p.owner_kind='READ' AND p.owner_id=g.id::text AND p.expires_at>=g.expires_at))
 OR (method='PUT' AND EXISTS(SELECT 1 FROM hyperfide.source_object_uploads u JOIN hyperfide.source_object_placements p ON p.organisation_id=u.organisation_id AND p.repository_id=u.repository_id AND p.security_domain_id=u.security_domain_id AND p.object_id=u.object_id AND p.incarnation_id=u.incarnation_id
 WHERE u.organisation_id=g.organisation_id AND u.repository_id=g.repository_id AND u.security_domain_id=g.security_domain_id AND u.upload_id=g.upload_id AND u.object_id=g.object_id AND u.incarnation_id=g.incarnation_id AND u.owner_principal_id=g.principal_id AND u.status='UPLOADING' AND p.state='UPLOADING' AND u.expires_at>=g.expires_at)))`,[s.organisation_id,s.repository_id,s.security_domain_id,grant.grant_id,digest])).rows[0];if(!row)denied();
}
