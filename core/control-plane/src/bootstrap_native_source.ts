import {createPublicKey,verify} from 'node:crypto';
import type {ServiceResources} from './storage/runtime.js';
import {assertCurrentAuthority} from './storage/durability.js';
import {assertCurrentPrincipal} from './identity/enrollment.js';
import {assertAcceptedBootstrap} from './spec/bootstrap.js';
import {canonical,digest} from './spec/import.js';
import {assertBootstrapExternalAuthority,assertFreshAttestation,type BootstrapPolicy} from './bootstrap_identity.js';
import {base64,exact,fail,uuid,type Principal} from './transport/protocol.js';
import {SOURCE_ACTIONS,parseRepositoryPath,parseSourceScope} from './source_control/contracts.js';

export async function bootstrapNativeSource(resources:ServiceResources,value:unknown,policy:BootstrapPolicy,signal?:AbortSignal):Promise<unknown>{return sourceApproval(resources,value,policy,signal,false);}
export async function manageNativeSourceCapability(resources:ServiceResources,value:unknown,policy:BootstrapPolicy,signal?:AbortSignal):Promise<unknown>{return sourceApproval(resources,value,policy,signal,true);}
async function sourceApproval(resources:ServiceResources,value:unknown,policy:BootstrapPolicy,signal:AbortSignal|undefined,manage:boolean):Promise<unknown>{
 exact(value,['schema_version','approval','signature_b64']);
 if(value.schema_version!==1)fail('INVALID_REQUEST','Native source bootstrap version required');
 exact(value.approval,['kind','approval_id','scope','run_id','authority_epoch','credential_id','accepted_revision_digest','actions','path_prefixes','expires_at',...(manage?['action','capability_id','expected_expires_at']:['policy_version','durability_profile'])]);
 const a=value.approval,scope=parseSourceScope(a.scope);
 if(a.kind!==(manage?'NATIVE_SOURCE_CAPABILITY_V1':'NATIVE_SOURCE_BOOTSTRAP_V1')||!['approval_id','run_id','authority_epoch','credential_id'].every(key=>uuid(a[key]))||typeof a.accepted_revision_digest!=='string'||!/^sha256:[0-9a-f]{64}$/.test(a.accepted_revision_digest))fail('INVALID_REQUEST','Exact native source approval scope required');
 if(!manage&&![a.policy_version,a.durability_profile].every(v=>typeof v==='string'&&Buffer.byteLength(v)>0&&Buffer.byteLength(v)<=256))fail('INVALID_REQUEST','Explicit bounded source profiles required');
 if(manage&&(!uuid(a.capability_id)||!['RENEW','REVOKE'].includes(String(a.action))||typeof a.expected_expires_at!=='string'||!Number.isFinite(Date.parse(a.expected_expires_at))||new Date(a.expected_expires_at).toISOString()!==a.expected_expires_at))fail('INVALID_REQUEST','Exact existing capability and lifecycle action required');
 if(!Array.isArray(a.actions)||a.actions.length<1||a.actions.length>64||new Set(a.actions).size!==a.actions.length||a.actions.some(v=>typeof v!=='string'||!(SOURCE_ACTIONS as readonly string[]).includes(v)))fail('INVALID_REQUEST','One explicit bounded native capability required');
 if(!Array.isArray(a.path_prefixes)||a.path_prefixes.length<1||a.path_prefixes.length>256||new Set(a.path_prefixes).size!==a.path_prefixes.length)fail('INVALID_REQUEST','Explicit unique source path prefixes required');
 const prefixes=a.path_prefixes.map(v=>v===''?'':parseRepositoryPath(v));
 if(manage&&a.action==='REVOKE'?a.expires_at!==null:typeof a.expires_at!=='string'||!Number.isFinite(Date.parse(a.expires_at))||new Date(a.expires_at).toISOString()!==a.expires_at)fail('INVALID_REQUEST','Canonical source capability expiry required');
 const signature=base64(value.signature_b64,64),requestDigest=digest(canonical(value));
 const {attestation}=await assertBootstrapExternalAuthority(resources,policy,signal);
 return resources.gateway.withPrimaryTransaction({timeoutMs:30000,maxRetries:2,...(signal?{signal}:{})},async tx=>{
  const authority={assertCurrent:async(currentTx:Parameters<typeof assertCurrentAuthority>[0],s:{organisation_id:string;run_id:string;authority_epoch:string})=>assertCurrentAuthority(currentTx,{deployment_id:policy.deployment_id,...s})};
  const runScope={organisation_id:scope.organisation_id,run_id:String(a.run_id),authority_epoch:String(a.authority_epoch)};
  await assertCurrentAuthority(tx,{deployment_id:policy.deployment_id,...runScope});
  await assertFreshAttestation(tx,policy.deployment_id,runScope.authority_epoch,attestation);
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['native-source-bootstrap:'+scope.organisation_id+':'+scope.repository_id+':'+scope.security_domain_id]);
  const row=(await tx.query('SELECT * FROM hyperfide.identity_principals WHERE credential_id=$1 FOR SHARE',[a.credential_id])).rows[0];
  if(!row||row.role!=='OPERATOR'||row.organisation_id!==scope.organisation_id||row.run_id!==a.run_id||row.sandbox_id!==null||row.attempt_id!==null)fail('AUTH_SCOPE_DENIED','Current run operator required');
  const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),base64(row.public_key_b64,32)]),format:'der',type:'spki'});
  if(!verify(null,Buffer.from(canonical(a)),key,signature))fail('AUTH_SIGNATURE_INVALID','Current operator must sign exact native source approval');
  const principal:Principal={credential_id:row.credential_id,organisation_id:row.organisation_id,run_id:row.run_id,actor_id:row.actor_id,role:row.role,credential_version:String(row.credential_version),deployment_epoch:row.deployment_epoch,sandbox_id:null,boot_id:null,boot_generation:null,attempt_id:null,attempt_generation:null,allowed_actions:row.allowed_actions,expires_at:new Date(row.expires_at).toISOString()};
  await assertCurrentPrincipal(tx,principal,authority);
  const issuance=(await tx.query('SELECT credential_id FROM hyperfide.identity_bootstrap_issuances WHERE organisation_id=$1 AND run_id=$2 FOR SHARE',[scope.organisation_id,a.run_id])).rows[0];
  const head=(await tx.query('SELECT credential_id FROM hyperfide.identity_bootstrap_recoveries WHERE organisation_id=$1 AND run_id=$2 ORDER BY generation DESC LIMIT 1 FOR SHARE',[scope.organisation_id,a.run_id])).rows[0];
  if(!issuance||(head?.credential_id??issuance.credential_id)!==a.credential_id)fail('AUTH_SCOPE_DENIED','Current bootstrap operator required');
  const accepted=await assertAcceptedBootstrap(tx,{...runScope,accepted_revision_digest:String(a.accepted_revision_digest)});
  if((a.actions as string[]).some(action=>!accepted.allowed_actions.includes(action)||!principal.allowed_actions.includes(action)))fail('AUTH_SCOPE_DENIED','Native capability exceeds accepted operator actions');
  if(!(await tx.query('SELECT 1 FROM hyperfide.run_repositories WHERE organisation_id=$1 AND run_id=$2 AND repository_id=$3 FOR SHARE',[scope.organisation_id,a.run_id,scope.repository_id])).rows.length)fail('AUTH_SCOPE_DENIED','Source repository is outside accepted run');
  if(manage){
   const values=[scope.organisation_id,scope.repository_id,scope.security_domain_id];
   const prior=(await tx.query('SELECT record FROM hyperfide.source_audit WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND id=$4 FOR SHARE',[...values,a.approval_id])).rows[0];
   if(prior){if(prior.record.request_digest!==requestDigest)fail('BOOTSTRAP_SOURCE_CONFLICT','Capability operation identity was reused');return {...prior.record.receipt,replayed:true};}
   const root=(await tx.query('SELECT approval_id,run_id FROM hyperfide.source_bootstrap_issuances WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 FOR SHARE',values)).rows[0];
   if(!root||root.approval_id!==a.capability_id||root.run_id!==a.run_id)fail('AUTH_SCOPE_DENIED','Only this run original bootstrap capability may be managed');
   const cap=(await tx.query('SELECT c.*,d.authority_epoch AS current_epoch,d.policy_version AS current_policy,d.enabled FROM hyperfide.source_capabilities c JOIN hyperfide.source_authority_domains d USING(organisation_id,repository_id,security_domain_id) WHERE c.organisation_id=$1 AND c.repository_id=$2 AND c.security_domain_id=$3 AND c.id=$4 FOR UPDATE OF c',[...values,a.capability_id])).rows[0];
   if(!cap||cap.principal_id!==row.actor_id||cap.principal_kind!=='automation'||cap.managed_binding!==null||cap.revision_ids!==null||!cap.enabled||String(cap.authority_epoch)!==String(cap.current_epoch)||cap.policy_version!==cap.current_policy||canonical(cap.actions)!==canonical(a.actions)||canonical(cap.path_prefixes)!==canonical(prefixes))fail('AUTH_SCOPE_DENIED','Capability owner, scope and grants cannot change');
   if(new Date(cap.expires_at).toISOString()!==a.expected_expires_at)fail('BOOTSTRAP_SOURCE_CONFLICT','Capability expiry changed');
   if(a.action==='RENEW'){
    const now=new Date((await tx.query('SELECT clock_timestamp() AS now')).rows[0]!.now).getTime(),expiry=Date.parse(String(a.expires_at));
    if(cap.revoked_at!==null)fail('AUTH_REVOKED','Revoked capability cannot be renewed');
    if(expiry<=Date.parse(String(a.expected_expires_at))||expiry<=now||expiry-now>policy.max_ttl_ms||expiry>Date.parse(principal.expires_at))fail('AUTH_EXPIRED','Renewal must extend expiry within current operator lifetime');
    await tx.query('UPDATE hyperfide.source_capabilities SET credential_id=$5,expires_at=$6 WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND id=$4',[...values,a.capability_id,row.credential_id,a.expires_at]);
   }else await tx.query('UPDATE hyperfide.source_capabilities SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND id=$4',[...values,a.capability_id]);
   const receipt={schema_version:1,approval_id:a.approval_id,scope,capability_id:a.capability_id,action:a.action,credential_id:row.credential_id,expires_at:a.action==='RENEW'?a.expires_at:a.expected_expires_at,replayed:false};
   await tx.query('INSERT INTO hyperfide.source_audit(organisation_id,repository_id,security_domain_id,id,principal_id,operation_id,record) VALUES($1,$2,$3,$4,$5,$4,$6)',[...values,a.approval_id,row.actor_id,JSON.stringify({request_digest:requestDigest,signed_approval:value,receipt})]);
   if(a.action==='RENEW'&&!(await tx.query('SELECT expires_at>clock_timestamp() AS live FROM hyperfide.source_capabilities WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND id=$4',[...values,a.capability_id])).rows[0]?.live)fail('AUTH_EXPIRED','Renewed capability expired before issuance');
   await assertCurrentPrincipal(tx,principal,authority);await assertFreshAttestation(tx,policy.deployment_id,runScope.authority_epoch,attestation);
   return receipt;
  }
  const clock=(await tx.query('SELECT clock_timestamp() AS now')).rows[0]!.now,ttl=Date.parse(String(a.expires_at))-new Date(clock).getTime();
  if(ttl<=0||ttl>policy.max_ttl_ms||Date.parse(String(a.expires_at))>Date.parse(principal.expires_at))fail('AUTH_EXPIRED','Native capability exceeds current operator lifetime');
  const prior=(await tx.query('SELECT request_digest,receipt FROM hyperfide.source_bootstrap_issuances WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 FOR SHARE',[scope.organisation_id,scope.repository_id,scope.security_domain_id])).rows[0];
  if(prior){if(prior.request_digest!==requestDigest)fail('BOOTSTRAP_SOURCE_CONFLICT','Native scope already bootstrapped with another approval');return {...prior.receipt,replayed:true};}
  if((await tx.query('SELECT 1 FROM hyperfide.source_authority_domains WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 UNION ALL SELECT 1 FROM hyperfide.source_repositories WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3',[scope.organisation_id,scope.repository_id,scope.security_domain_id])).rows.length)fail('BOOTSTRAP_SOURCE_CONFLICT','Existing native scope cannot be adopted');
  await tx.query('INSERT INTO hyperfide.source_repositories(organisation_id,repository_id,security_domain_id,authority_epoch,policy_version,durability_profile) VALUES($1,$2,$3,1,$4,$5)',[scope.organisation_id,scope.repository_id,scope.security_domain_id,a.policy_version,a.durability_profile]);
  await tx.query('INSERT INTO hyperfide.source_authority_domains(organisation_id,repository_id,security_domain_id,authority_epoch,policy_version) VALUES($1,$2,$3,1,$4)',[scope.organisation_id,scope.repository_id,scope.security_domain_id,a.policy_version]);
  await tx.query("INSERT INTO hyperfide.source_capabilities(organisation_id,repository_id,security_domain_id,id,principal_id,credential_id,principal_kind,authority_epoch,policy_version,actions,path_prefixes,expires_at) VALUES($1,$2,$3,$4,$5,$6,'automation',1,$7,$8,$9,$10)",[scope.organisation_id,scope.repository_id,scope.security_domain_id,a.approval_id,row.actor_id,row.credential_id,a.policy_version,a.actions,prefixes,a.expires_at]);
  const receipt={schema_version:1,approval_id:a.approval_id,scope,run_id:a.run_id,credential_id:a.credential_id,accepted_revision_digest:a.accepted_revision_digest,authority_epoch:'1',policy_version:a.policy_version,durability_profile:a.durability_profile,capability_id:a.approval_id,actions:a.actions,path_prefixes:prefixes,expires_at:a.expires_at,replayed:false};
  await tx.query('INSERT INTO hyperfide.source_bootstrap_issuances(organisation_id,repository_id,security_domain_id,approval_id,run_id,credential_id,request_digest,signed_approval,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[scope.organisation_id,scope.repository_id,scope.security_domain_id,a.approval_id,a.run_id,a.credential_id,requestDigest,JSON.stringify(value),JSON.stringify(receipt)]);
  if(!(await tx.query('SELECT expires_at>clock_timestamp() AS live FROM hyperfide.source_capabilities WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND id=$4',[scope.organisation_id,scope.repository_id,scope.security_domain_id,a.approval_id])).rows[0]?.live)fail('AUTH_EXPIRED','Native capability expired before issuance');
  await assertCurrentPrincipal(tx,principal,authority);await assertFreshAttestation(tx,policy.deployment_id,runScope.authority_epoch,attestation);
  return receipt;
 });
}
