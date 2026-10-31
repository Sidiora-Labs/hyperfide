import fs from 'node:fs/promises';
import {createPublicKey,verify} from 'node:crypto';
import type {ServiceResources} from './storage/runtime.js';
import type {BootstrapPolicy} from './bootstrap_identity.js';
import {assertBootstrapExternalAuthority,assertFreshAttestation} from './bootstrap_identity.js';
import {assertCurrentAuthority} from './storage/durability.js';
import {writeSemanticDisposition} from './storage/dispositions.js';
import {assertCurrentPrincipal} from './identity/enrollment.js';
import {assertAcceptedBootstrap} from './spec/bootstrap.js';
import {admitOfflineCapabilities} from './spec/revisions.js';
import {canonical,digest} from './spec/import.js';
import {base64,exact,fail,hash,uuid,decimal,frozen} from './transport/protocol.js';
import type {Principal} from './transport/protocol.js';

// An owner-private CLI input and the current operator's signature approve one
// exact accepted-intent transition. This issuer is never a transport capability.
export async function amendBootstrapCapabilities(resources:ServiceResources,value:unknown,policy:BootstrapPolicy,env:Readonly<NodeJS.ProcessEnv>,signal?:AbortSignal,approveSourceTransition=false):Promise<unknown>{
 exact(value,['schema_version','approval','signature_b64']);
 if(value.schema_version!==1)fail('INVALID_REQUEST','Capability approval version required');
 exact(value.approval,[...(approveSourceTransition?['previous_source_digest','approved_source_digest']:[]),'kind','approval_id','organisation_id','run_id','authority_epoch','previous_credential_id','previous_revision_digest','spec_generation','state_version','approved_actions','amendment','revalidate_task_ids','proof_policies','justification','credential']);
 const a=value.approval;
 if(a.kind!==(approveSourceTransition?'BOOTSTRAP_INTENT_APPROVAL_V1':'BOOTSTRAP_CAPABILITY_APPROVAL_V1')||!['approval_id','organisation_id','run_id','authority_epoch','previous_credential_id'].every(key=>uuid(a[key]))||typeof a.previous_revision_digest!=='string'||!/^sha256:[0-9a-f]{64}$/.test(a.previous_revision_digest)||!decimal(a.spec_generation,true)||!decimal(a.state_version,true)||typeof a.justification!=='string'||!a.justification.trim()||a.justification.length>4096)fail('INVALID_REQUEST','Exact accepted base and explicit approval required');
 if(!Array.isArray(a.approved_actions)||!a.approved_actions.length||a.approved_actions.length>256||a.approved_actions.some(v=>typeof v!=='string'||!/^[a-z][a-z0-9._:-]{0,127}$/.test(v))||new Set(a.approved_actions).size!==a.approved_actions.length)fail('INVALID_REQUEST','Finite unique approved action scope required');
 exact(a.credential,['credential_id','actor_id','public_key_b64','expires_at']);const c=a.credential;
 if(!uuid(c.credential_id)||!uuid(c.actor_id)||c.credential_id===a.previous_credential_id||typeof c.expires_at!=='string'||!Number.isFinite(Date.parse(c.expires_at))||new Date(c.expires_at).toISOString()!==c.expires_at)fail('INVALID_REQUEST','New immutable operator credential identity and canonical expiry required');
 base64(c.public_key_b64,32);const signature=base64(value.signature_b64,64),requestDigest=digest(canonical(value)),actions=[...a.approved_actions as string[]].sort();
 if(approveSourceTransition&&(['previous_source_digest','approved_source_digest'].some(key=>typeof a[key]!=='string'||!/^sha256:[0-9a-f]{64}$/.test(String(a[key])))))fail('INVALID_REQUEST','Explicit old and new accepted source digests required');
 const previousRevision=a.previous_revision_digest,justification=a.justification;
 const migration=await fs.readFile(new URL('../migrations/0719-bootstrap-capability-amendment.sql',import.meta.url));
 const {attestation}=await assertBootstrapExternalAuthority(resources,policy,signal);
 return resources.gateway.withPrimaryTransaction({timeoutMs:30000,maxRetries:2,...(signal?{signal}:{})},async tx=>{
  const m=(await tx.query('SELECT name,checksum FROM hyperfide.schema_migrations WHERE version=719')).rows[0];
  if(m?.name!=='0719-bootstrap-capability-amendment'||m.checksum!==hash(migration))fail('BOOTSTRAP_SCHEMA_REQUIRED','Exact trusted capability approval migration required');
  const scope={organisation_id:String(a.organisation_id),run_id:String(a.run_id),authority_epoch:String(a.authority_epoch)};
  const authority={assertCurrent:async(currentTx:Parameters<typeof assertCurrentAuthority>[0],s:{organisation_id:string;run_id:string;authority_epoch:string})=>assertCurrentAuthority(currentTx,{deployment_id:policy.deployment_id,...s})};
  await writeSemanticDisposition(tx,scope);
  await assertCurrentAuthority(tx,{deployment_id:policy.deployment_id,...scope});await assertFreshAttestation(tx,policy.deployment_id,scope.authority_epoch,attestation);
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['bootstrap-operator:'+scope.organisation_id+':'+scope.run_id]);
  const previous=(await tx.query('SELECT * FROM hyperfide.identity_principals WHERE credential_id=$1 FOR UPDATE',[a.previous_credential_id])).rows[0];
  if(!previous||previous.role!=='OPERATOR'||previous.organisation_id!==scope.organisation_id||previous.run_id!==scope.run_id||previous.actor_id!==c.actor_id)fail('AUTH_SCOPE_DENIED','Current operator and unchanged logical actor required');
  const publicKey=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),base64(previous.public_key_b64,32)]),format:'der',type:'spki'});
  if(!verify(null,Buffer.from(canonical(a)),publicKey,signature))fail('AUTH_SIGNATURE_INVALID','Current operator must sign the exact approval');
  const prior=(await tx.query('SELECT request_digest,signed_approval FROM hyperfide.identity_bootstrap_capability_approvals WHERE approval_id=$1',[a.approval_id])).rows[0];
  if(prior){if(prior.request_digest!==requestDigest)fail('BOOTSTRAP_APPROVAL_CONFLICT','Approval identity cannot be reused');const active=(await tx.query('SELECT state,(expires_at>clock_timestamp()) AS live FROM hyperfide.identity_principals WHERE credential_id=$1',[c.credential_id])).rows[0];if(active?.state!=='ACTIVE'||!active.live)fail('AUTH_REVOKED','Approved successor is no longer active');return {schema_version:1,approval_id:a.approval_id,credential_id:c.credential_id,accepted_revision_digest:(await tx.query('SELECT accepted_revision_digest FROM hyperfide.identity_bootstrap_capability_approvals WHERE approval_id=$1',[a.approval_id])).rows[0]!.accepted_revision_digest,replayed:true};}
  const principal:Principal=frozen({credential_id:previous.credential_id,organisation_id:previous.organisation_id,run_id:previous.run_id,actor_id:previous.actor_id,role:previous.role,credential_version:String(previous.credential_version),deployment_epoch:previous.deployment_epoch,sandbox_id:previous.sandbox_id,boot_id:previous.boot_id,boot_generation:previous.boot_generation===null?null:String(previous.boot_generation),attempt_id:previous.attempt_id,attempt_generation:previous.attempt_generation===null?null:String(previous.attempt_generation),allowed_actions:previous.allowed_actions,expires_at:new Date(previous.expires_at).toISOString()});
  await assertCurrentPrincipal(tx,principal,authority);
  const issuance=(await tx.query('SELECT credential_id FROM hyperfide.identity_bootstrap_issuances WHERE organisation_id=$1 AND run_id=$2 FOR SHARE',[scope.organisation_id,scope.run_id])).rows[0];
  const head=(await tx.query('SELECT credential_id,generation::text FROM hyperfide.identity_bootstrap_recoveries WHERE organisation_id=$1 AND run_id=$2 ORDER BY generation DESC LIMIT 1 FOR UPDATE',[scope.organisation_id,scope.run_id])).rows[0];
  if(!issuance||(head?.credential_id??issuance.credential_id)!==a.previous_credential_id)fail('BOOTSTRAP_RECOVERY_CONFLICT','Only current bootstrap operator may approve capabilities');
  const accepted=await assertAcceptedBootstrap(tx,{...scope,accepted_revision_digest:previousRevision});
  if(accepted.spec_generation!==a.spec_generation||accepted.state_version!==a.state_version||accepted.allowed_actions.some(action=>!actions.includes(action)))fail('BOOTSTRAP_ACCEPTANCE_MISMATCH','Exact accepted base and additive approval required');
  exact(a.amendment,['run_id','base_spec_revision_id','base_spec_generation','state_version','purpose','reason','replacement']);
  if(a.amendment.run_id!==scope.run_id||a.amendment.base_spec_revision_id!==accepted.spec_revision_id||a.amendment.base_spec_generation!==a.spec_generation||a.amendment.state_version!==a.state_version||a.amendment.purpose!=='INTENT_CHANGE')fail('BOOTSTRAP_ACCEPTANCE_MISMATCH','Amendment must name the signed accepted base');
  if(!a.amendment.replacement||typeof a.amendment.replacement!=='object'||canonical((a.amendment.replacement as Record<string,unknown>).allowed_actions)!==canonical(actions))fail('AUTH_SCOPE_DENIED','Replacement actions must equal explicit approved ceiling');
  const oldDocument=(await tx.query('SELECT document FROM hyperfide.spec_revisions WHERE organisation_id=$1 AND id=$2',[scope.organisation_id,accepted.spec_revision_id])).rows[0]!.document;
  exact(a.amendment.replacement,['run_id','source','repositories','allowed_actions','closure_policy','provenance']);const replacement=a.amendment.replacement;
  exact(replacement.source,['relative_path','sha256','size_bytes']);
  if(approveSourceTransition&&(a.previous_source_digest!==accepted.source_digest||'sha256:'+replacement.source.sha256!==a.approved_source_digest))fail('AUTH_SCOPE_DENIED','Signed accepted source transition differs from exact previous and next bytes');
  if(!approveSourceTransition&&replacement.source.sha256!==accepted.source_digest.replace(/^sha256:/,''))fail('AUTH_SCOPE_DENIED','Capability-only approval must preserve source bytes');
  if(canonical(replacement.repositories)!==canonical(oldDocument.repositories)||canonical(replacement.closure_policy)!==canonical(oldDocument.closure_policy)||canonical(replacement.provenance)!==canonical(oldDocument.provenance))fail('AUTH_SCOPE_DENIED','Offline approval must preserve repository, closure and provenance pins');
  const root=env.HYPERFIDE_BOOTSTRAP_SOURCE_ROOT;if(!root)fail('BOOTSTRAP_POLICY_REQUIRED','Trusted accepted source root required');
  const decision=await admitOfflineCapabilities(tx,{...scope,project_id:accepted.project_id,root,allowed_actions:actions},principal,{amendment:a.amendment,revalidate_task_ids:a.revalidate_task_ids as string[],proof_policies:a.proof_policies as {task_key:string;policy:unknown}[],justification},env);
  if(decision.decision!=='ACCEPTED')fail('AMENDMENT_REJECTED','Capability amendment did not qualify for acceptance');
  const updated=(await tx.query('SELECT s.revision_digest FROM hyperfide.runs r JOIN hyperfide.spec_revisions s ON s.organisation_id=r.organisation_id AND s.id=r.spec_revision_id WHERE r.organisation_id=$1 AND r.id=$2',[scope.organisation_id,scope.run_id])).rows[0]!;
  await assertAcceptedBootstrap(tx,{...scope,accepted_revision_digest:updated.revision_digest});
  const clock=(await tx.query('SELECT clock_timestamp() AS db_now')).rows[0]!.db_now,ttl=Date.parse(String(c.expires_at))-new Date(clock).getTime();if(ttl<=0||ttl>policy.max_ttl_ms)fail('AUTH_EXPIRED','New operator expiry exceeds trusted policy');
  if((await tx.query('SELECT 1 FROM hyperfide.identity_principals WHERE credential_id=$1',[c.credential_id])).rows.length)fail('BOOTSTRAP_RECOVERY_CONFLICT','Existing credential cannot be adopted');
  await assertCurrentPrincipal(tx,principal,authority);
  await tx.query("UPDATE hyperfide.identity_principals SET state='REVOKED',credential_version=credential_version+1 WHERE credential_id=$1",[a.previous_credential_id]);
  await tx.query("INSERT INTO hyperfide.identity_principals(credential_id,organisation_id,run_id,actor_id,role,public_key_b64,deployment_epoch,allowed_actions,expires_at) VALUES($1,$2,$3,$4,'OPERATOR',$5,$6,$7,$8)",[c.credential_id,scope.organisation_id,scope.run_id,c.actor_id,c.public_key_b64,scope.authority_epoch,actions,c.expires_at]);
  await tx.query("INSERT INTO hyperfide.identity_bootstrap_recoveries(organisation_id,run_id,generation,recovery_id,previous_credential_id,credential_id,accepted_revision_digest,authority_epoch,reason,request_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'CAPABILITIES_AMENDED',$9)",[scope.organisation_id,scope.run_id,String(BigInt(head?.generation??'0')+1n),a.approval_id,a.previous_credential_id,c.credential_id,updated.revision_digest,scope.authority_epoch,requestDigest]);
  await tx.query('INSERT INTO hyperfide.identity_bootstrap_capability_approvals(approval_id,organisation_id,run_id,recovery_id,amendment_id,previous_revision_digest,accepted_revision_digest,request_digest,signed_approval) VALUES($1,$2,$3,$1,$4,$5,$6,$7,$8)',[a.approval_id,scope.organisation_id,scope.run_id,decision.amendment_id,a.previous_revision_digest,updated.revision_digest,requestDigest,JSON.stringify(value)]);
  await assertCurrentPrincipal(tx,frozen({...principal,credential_id:String(c.credential_id),credential_version:'1',allowed_actions:actions,expires_at:String(c.expires_at)}),authority);
  await assertFreshAttestation(tx,policy.deployment_id,scope.authority_epoch,attestation);
  return {schema_version:1,approval_id:a.approval_id,credential_id:c.credential_id,actor_id:c.actor_id,credential_version:'1',deployment_epoch:scope.authority_epoch,accepted_revision_digest:updated.revision_digest,amendment:decision,expires_at:c.expires_at,replayed:false};
 });
}
