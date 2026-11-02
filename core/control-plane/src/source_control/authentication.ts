import {createPublicKey,verify, type KeyObject} from 'node:crypto';
import {SourceControlError,parseSourceScope,type SourceScope} from './contracts.js';
import {strictJSON} from '../transport/protocol.js';
import type {SourcePrincipal,SourcePrincipalKind,SourceSQL} from './capabilities.js';

export interface SourceTokenTrust {issuer:string;audience:string;keys:Readonly<Record<string,string|KeyObject>>;max_ttl_seconds?:number;clock_skew_seconds?:number}
declare const verifiedPrincipal:unique symbol;
export interface AuthenticatedSourcePrincipal extends SourcePrincipal {readonly [verifiedPrincipal]:true;readonly scope:SourceScope;readonly credential_version:string;readonly capability_id?:string}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function denied():never {throw new SourceControlError('UNAUTHENTICATED','Source authentication failed');}
function record(value:unknown):value is Record<string,unknown> {return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function bytes(value:string):Buffer {if(!/^[A-Za-z0-9_-]+$/.test(value)||value.length%4===1)denied();const result=Buffer.from(value,'base64url');if(result.toString('base64url')!==value)denied();return result;}
function object(value:string):Record<string,unknown> {try{const decoded=strictJSON(bytes(value),8192);if(!record(decoded))denied();return decoded;}catch{return denied();}}
export function verifySourcePrincipalToken(token:string,trust:SourceTokenTrust,expectedScope:SourceScope,now=Date.now()):AuthenticatedSourcePrincipal {
 if(typeof token!=='string'||token.length>12288||!trust.issuer||!trust.audience)denied();
 const maximum=trust.max_ttl_seconds??300,skew=trust.clock_skew_seconds??0;
 if(!Number.isInteger(maximum)||maximum<1||maximum>900||!Number.isInteger(skew)||skew<0||skew>30)throw new SourceControlError('CONFIGURATION_INVALID','Invalid source token lifetime policy');
 const parts=token.split('.');if(parts.length!==3)denied();
 const header=object(parts[0]!),payload=object(parts[1]!);
 if(Object.keys(header).sort().join(',')!=='alg,kid,typ'||header.alg!=='EdDSA'||header.typ!=='HF-SOURCE-1'||typeof header.kid!=='string'||!/^[a-zA-Z0-9._-]{1,128}$/.test(header.kid))denied();
 const configured=trust.keys[header.kid];if(!configured)denied();
 let publicKey:KeyObject;try{publicKey=typeof configured==='string'?createPublicKey(configured):configured;if(publicKey.asymmetricKeyType!=='ed25519'||!verify(null,Buffer.from(parts[0]+'.'+parts[1]),publicKey,bytes(parts[2]!)))denied();}catch{return denied();}
 const required=['schema_version','iss','aud','sub','credential_id','credential_version','principal_kind','scope','iat','nbf','exp'];
 if(required.some(k=>!Object.hasOwn(payload,k))||Object.keys(payload).some(k=>!required.includes(k)&&k!=='capability_id')||payload.schema_version!==1||payload.iss!==trust.issuer||payload.aud!==trust.audience||typeof payload.sub!=='string'||!UUID.test(payload.sub)||typeof payload.credential_id!=='string'||!UUID.test(payload.credential_id)||typeof payload.credential_version!=='string'||!/^[1-9][0-9]{0,18}$/.test(payload.credential_version)||!['human','automation','import','worker','service'].includes(String(payload.principal_kind)))denied();
 if(BigInt(payload.credential_version as string)>9223372036854775807n)denied();
 if(![payload.iat,payload.nbf,payload.exp].every(Number.isSafeInteger))denied();
 const issued=payload.iat as number,notBefore=payload.nbf as number,expires=payload.exp as number,second=Math.floor(now/1000);
 if(expires<=issued||expires-issued>maximum||notBefore<issued||notBefore>=expires||issued>second+skew||notBefore>second+skew||expires<=second-skew)denied();
 const scope=parseSourceScope(payload.scope),expected=parseSourceScope(expectedScope);
 if(scope.organisation_id!==expected.organisation_id||scope.repository_id!==expected.repository_id||scope.security_domain_id!==expected.security_domain_id)denied();
 if(payload.capability_id!==undefined&&(typeof payload.capability_id!=='string'||!UUID.test(payload.capability_id)))denied();
 const result={id:payload.sub,credential_id:payload.credential_id,organisation_id:scope.organisation_id,kind:payload.principal_kind as SourcePrincipalKind,expires_at:new Date(expires*1000).toISOString(),scope,credential_version:payload.credential_version,
  ...(payload.capability_id?{capability_id:payload.capability_id as string}:{}),
  async assertCurrent(tx:SourceSQL):Promise<void>{
   const current=await tx.query(`SELECT 1 FROM hyperfide.source_principal_credentials WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3
    AND credential_id=$4 AND principal_id=$5 AND principal_kind=$6 AND credential_version=$7 AND issuer=$8 AND audience=$9 AND signing_key_id=$10
    AND revoked_at IS NULL AND expires_at>clock_timestamp() AND clock_timestamp()<$11::timestamptz FOR SHARE`,[scope.organisation_id,scope.repository_id,scope.security_domain_id,payload.credential_id,payload.sub,payload.principal_kind,payload.credential_version,trust.issuer,trust.audience,header.kid,new Date(expires*1000).toISOString()]);
   if(current.rows.length!==1)denied();
  }};
 return Object.freeze(result) as AuthenticatedSourcePrincipal;
}
export function sourceBearerToken(header:string|undefined):string {if(typeof header!=='string'||!/^Bearer [A-Za-z0-9_.-]+$/.test(header))return denied();return header.slice(7);}
