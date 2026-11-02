import {randomUUID} from 'node:crypto';
import {SourceControlError,canonicalBytes,parseObjectId,parseSourceScope,type SourceScope} from './contracts.js';
import type {SourceAuthorization,SourceSQL} from './capabilities.js';

export interface SourceAuditRecord {schema_version:1;id:string;scope:SourceScope;principal_id:string;capability_id:string;action:string;operation_id:string;request_digest:string;authority_epoch:string;policy_version:string;result:'ALLOWED'|'DENIED'|'SUCCEEDED'|'FAILED'|'OUTCOME_UNKNOWN';source_ids:readonly string[];error_code:string|null}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function sourceAuditRecord(authorization:Pick<SourceAuthorization,'scope'|'principal_id'|'capability_id'|'authority_epoch'|'policy_version'>,input:Pick<SourceAuditRecord,'action'|'operation_id'|'request_digest'|'result'>&{source_ids?:readonly string[];error_code?:string}):SourceAuditRecord {
 if(!UUID.test(input.operation_id)||!/^sha256:[0-9a-f]{64}$/.test(input.request_digest)||!/^source\.[a-z][a-z.-]{0,95}$/.test(input.action)||!['ALLOWED','DENIED','SUCCEEDED','FAILED','OUTCOME_UNKNOWN'].includes(input.result)||input.error_code!==undefined&&!/^[A-Z][A-Z0-9_]{0,63}$/.test(input.error_code))throw new SourceControlError('INVALID_AUDIT_RECORD','Bounded source audit identities are required');
 const source_ids=(input.source_ids??[]).map(parseObjectId);if(source_ids.length>64)throw new SourceControlError('LIMIT_EXCEEDED','Source audit reference limit exceeded');
 const record:SourceAuditRecord={schema_version:1,id:randomUUID(),scope:parseSourceScope(authorization.scope),principal_id:authorization.principal_id,capability_id:authorization.capability_id,action:input.action,operation_id:input.operation_id,request_digest:input.request_digest,authority_epoch:authorization.authority_epoch,policy_version:authorization.policy_version,result:input.result,source_ids,error_code:input.error_code??null};
 if(canonicalBytes(record).byteLength>16384)throw new SourceControlError('LIMIT_EXCEEDED','Source audit record limit exceeded');return record;
}
export async function appendSourceAudit(tx:SourceSQL,record:SourceAuditRecord):Promise<void> {
 const names=['schema_version','id','scope','principal_id','capability_id','action','operation_id','request_digest','authority_epoch','policy_version','result','source_ids','error_code'];
 if(!record||Object.keys(record).sort().join(',')!==names.sort().join(',')||record.schema_version!==1||![record.id,record.principal_id,record.capability_id].every(x=>UUID.test(x))||!/^[1-9][0-9]{0,18}$/.test(record.authority_epoch)||typeof record.policy_version!=='string'||record.policy_version.length>256||!Array.isArray(record.source_ids))throw new SourceControlError('INVALID_AUDIT_RECORD','Source audit fields differ from the public allowlist');
 const validated=sourceAuditRecord(record,{action:record.action,operation_id:record.operation_id,request_digest:record.request_digest,result:record.result,source_ids:record.source_ids,...(record.error_code?{error_code:record.error_code}:{})});
 if(canonicalBytes({...validated,id:record.id}).byteLength>16384)throw new SourceControlError('INVALID_AUDIT_RECORD','Source audit record exceeds its limit');
 const s=record.scope;await tx.query('INSERT INTO hyperfide.source_audit(organisation_id,repository_id,security_domain_id,id,principal_id,operation_id,record) VALUES($1,$2,$3,$4,$5,$6,$7)',[s.organisation_id,s.repository_id,s.security_domain_id,record.id,record.principal_id,record.operation_id,record]);
}
export async function readSourceAudit(tx:SourceSQL,authorization:SourceAuthorization,input:{after_id?:string;limit?:number}={}):Promise<SourceAuditRecord[]> {
 await authorization.assertCurrent(tx,'source.audit.read');const limit=input.limit??100;if(!Number.isSafeInteger(limit)||limit<1||limit>1000||input.after_id!==undefined&&!UUID.test(input.after_id))throw new SourceControlError('INVALID_REQUEST','Invalid source audit page');const s=authorization.scope;
 return(await tx.query('SELECT record FROM hyperfide.source_audit WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND ($4::uuid IS NULL OR id>$4) ORDER BY id LIMIT $5',[s.organisation_id,s.repository_id,s.security_domain_id,input.after_id??null,limit])).rows.map(row=>row.record);
}
