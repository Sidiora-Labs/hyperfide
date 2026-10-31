import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import type {ComponentContext} from '../components/registry.js';
import type {ProviderDatabase} from './pools.js';
import {digestDocument,fail,providerInvocation,transaction} from './pools.js';
import {hash,strictJSON} from '../transport/protocol.js';
import {readProtectedFile} from '../preparation/fleet_client.js';
import {object} from '../policy/programme.js';
import {bootstrapIdentityRpc,BootstrapRpcRejection} from './bootstrap_rpc.js';
type Data=Record<string,any>;
function operationId(seed:string):string{const b=createHash('sha256').update(seed).digest();b[6]=(b[6]!&15)|64;b[8]=(b[8]!&63)|128;const h=b.subarray(0,16).toString('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;}
export async function bootstrapGrantCorrection(context:ComponentContext,database:ProviderDatabase,descriptor:Data,recipe:Data):Promise<Data|null>{
 const i=providerInvocation(database),p=i.principal;
 const previous=(await database.query('SELECT * FROM hyperfide.provider_native_bootstraps WHERE organisation_id=$1 AND run_id=$2 AND pool_id=$3 AND intent_id=$4',[p.organisation_id,p.run_id,recipe.pool_id,recipe.intent_id])).rows[0];
 if(!previous){if(recipe.amends_descriptor_digest!==undefined)fail('BOOTSTRAP_TTL_CORRECTION_SCOPE','An amendment requires its original bootstrap');return null;}
 const candidate:Data={...recipe};delete candidate.intent_id;
 const combined:Data={...candidate,origin:descriptor.origin,ca_file:descriptor.ca_file},candidateDigest=digestDocument(combined);
 if(previous.descriptor_digest===candidateDigest)return null;
 if(previous.secret_ref!==path.join(descriptor.state_root,previous.intent_id+'.enrollment.json'))fail('BOOTSTRAP_TTL_CORRECTION_SCOPE','Persistent secret reference cannot change');
 if(candidate.amends_descriptor_digest!==previous.descriptor_digest)fail('PROVIDER_BOOTSTRAP_CONFLICT','Explicit original descriptor amendment pin required');
 const normalized:Data={...combined,grant_ttl_seconds:previous.descriptor.grant_ttl_seconds};delete normalized.amends_descriptor_digest;
 if(digestDocument(normalized)!==previous.descriptor_digest||!Number.isInteger(candidate.grant_ttl_seconds)||candidate.grant_ttl_seconds<1||candidate.grant_ttl_seconds>=previous.descriptor.grant_ttl_seconds)fail('BOOTSTRAP_TTL_CORRECTION_SCOPE','Only an explicitly lower enrollment TTL may change');
 const existing=(await database.query('SELECT * FROM hyperfide.provider_bootstrap_grant_corrections WHERE organisation_id=$1 AND run_id=$2 AND intent_id=$3',[p.organisation_id,p.run_id,previous.intent_id])).rows[0];
 if(existing){if(existing.descriptor_digest!==candidateDigest||digestDocument(existing.descriptor)!==candidateDigest||digestDocument(existing.request)!==existing.request_digest)fail('BOOTSTRAP_TTL_CORRECTION_CONFLICT','Correction is immutable');return existing;}
 const remotePolicy=context.env.HF_PROVIDER_BOOTSTRAP_AUTHORITY_POLICY_FILE,policyBytes=await readProtectedFile(String(remotePolicy??context.env.HF_IDENTITY_CONFIG_FILE),1048576),policy=strictJSON(policyBytes);
 if(remotePolicy&&hash(policyBytes)!==context.env.HF_PROVIDER_BOOTSTRAP_AUTHORITY_POLICY_DIGEST)fail('BOOTSTRAP_TTL_CORRECTION_POLICY','Explicit remote authority policy digest must match protected bytes');
 if(!object(policy)||policy.origin!==descriptor.origin||!Number.isInteger(policy.grant_ttl_seconds)||Number(policy.grant_ttl_seconds)<1||Number(policy.grant_ttl_seconds)>900||candidate.grant_ttl_seconds>Number(policy.grant_ttl_seconds)||previous.descriptor.grant_ttl_seconds<=900)fail('BOOTSTRAP_TTL_CORRECTION_POLICY','Original request must exceed the hard server limit and corrected TTL must fit trusted policy');
 const original=previous.grant_input;
 if(!object(original)||previous.state!=='BOUND'||previous.manifest!==null||previous.manifest_digest!==null||previous.receipt!==null||original.ttl_seconds!==previous.descriptor.grant_ttl_seconds||original.grant_id!==previous.grant_id||original.provisioning_intent_id!==previous.intent_id||original.verifier!==previous.verifier||digestDocument(original.allowed_actions)!==digestDocument(previous.descriptor.allowed_actions))fail('BOOTSTRAP_TTL_CORRECTION_EFFECTS','Correction requires a retained pre-grant request without native effects');
 const request={grant_id:original.grant_id,provisioning_intent_id:original.provisioning_intent_id,verifier:original.verifier,allowed_actions:original.allowed_actions,ttl_seconds:original.ttl_seconds};
 const inputDigest=hash(Buffer.from(JSON.stringify(request)));
 const absence=async()=>{const row=(await database.query('SELECT 1 FROM hyperfide.identity_enrollment_grants WHERE organisation_id=$1 AND (id=$2 OR provisioning_intent_id=$3 OR (sandbox_id=$4 AND boot_id=$5)) LIMIT 1',[p.organisation_id,previous.grant_id,previous.intent_id,previous.sandbox_id,previous.boot_id])).rows[0];if(row)fail('BOOTSTRAP_TTL_CORRECTION_EFFECTS','An existing grant cannot be amended');};
 await absence();
 let rejection=(await database.query('SELECT * FROM hyperfide.provider_bootstrap_grant_rejections WHERE organisation_id=$1 AND run_id=$2 AND intent_id=$3 AND operation_id=$4',[p.organisation_id,p.run_id,previous.intent_id,previous.grant_operation_id])).rows[0];
 if(!rejection){
  try{await bootstrapIdentityRpc(context.env,i,{origin:descriptor.origin,ca_file:descriptor.ca_file},{organisation_id:p.organisation_id,run_id:p.run_id,credential_id:p.credential_id,operation_id:previous.grant_operation_id,idempotency_key:previous.grant_operation_id,action:'identity.grant.issue',input:request},i.signal);fail('BOOTSTRAP_TTL_CORRECTION_EFFECTS','Original grant was not definitively rejected');}
  catch(error){if(!(error instanceof BootstrapRpcRejection))throw error;const evidence=error.evidence;if(evidence.operation_id!==previous.grant_operation_id||evidence.input_digest!==inputDigest||![200,400].includes(evidence.http_status)||evidence.code!=='INVALID_REQUEST'||evidence.origin!==descriptor.origin)fail('BOOTSTRAP_TTL_CORRECTION_REJECTION','Exact authenticated rejection required');
   await transaction(database,async tx=>{await i.guard(tx);await tx.query('INSERT INTO hyperfide.provider_bootstrap_grant_rejections(organisation_id,run_id,intent_id,id,operation_id,input_digest,payload_digest,evidence,evidence_digest,observed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING',[p.organisation_id,p.run_id,previous.intent_id,randomUUID(),evidence.operation_id,evidence.input_digest,evidence.payload_digest,evidence,digestDocument(evidence),evidence.observed_at]);});
  }
  rejection=(await database.query('SELECT * FROM hyperfide.provider_bootstrap_grant_rejections WHERE organisation_id=$1 AND run_id=$2 AND intent_id=$3 AND operation_id=$4',[p.organisation_id,p.run_id,previous.intent_id,previous.grant_operation_id])).rows[0];
 }
 if(!rejection||rejection.input_digest!==inputDigest||digestDocument(rejection.evidence)!==rejection.evidence_digest||![200,400].includes(rejection.evidence.http_status)||rejection.evidence.code!=='INVALID_REQUEST'||rejection.evidence.origin!==descriptor.origin)fail('BOOTSTRAP_TTL_CORRECTION_REJECTION','Durable exact original rejection required');
 return transaction(database,async tx=>{
  await i.guard(tx);await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[p.organisation_id+':bootstrap:'+previous.intent_id]);
  const retained=(await tx.query('SELECT * FROM hyperfide.provider_bootstrap_grant_corrections WHERE organisation_id=$1 AND run_id=$2 AND intent_id=$3 FOR UPDATE',[p.organisation_id,p.run_id,previous.intent_id])).rows[0];if(retained){if(retained.descriptor_digest!==candidateDigest)fail('BOOTSTRAP_TTL_CORRECTION_CONFLICT','Another correction is retained');return retained;}
  const current=(await tx.query('SELECT * FROM hyperfide.provider_native_bootstraps WHERE organisation_id=$1 AND run_id=$2 AND intent_id=$3 FOR UPDATE',[p.organisation_id,p.run_id,previous.intent_id])).rows[0];
  if(!current||current.state!=='BOUND'||current.descriptor_digest!==previous.descriptor_digest||current.grant_operation_id!==previous.grant_operation_id||digestDocument(current.grant_input)!==digestDocument(request)||current.manifest_digest!==null||current.manifest!==null||current.receipt!==null)fail('BOOTSTRAP_TTL_CORRECTION_EFFECTS','Bootstrap crossed the correction boundary');
  const grant=(await tx.query('SELECT id FROM hyperfide.identity_enrollment_grants WHERE organisation_id=$1 AND (id=$2 OR provisioning_intent_id=$3 OR (sandbox_id=$4 AND boot_id=$5)) FOR SHARE',[p.organisation_id,current.grant_id,current.intent_id,current.sandbox_id,current.boot_id])).rows[0];if(grant)fail('BOOTSTRAP_TTL_CORRECTION_EFFECTS','Existing grant forbids correction');
  const corrected={...request,ttl_seconds:candidate.grant_ttl_seconds},operation=operationId('grant-ttl-correction:'+current.intent_id+':'+candidateDigest);
  return(await tx.query('INSERT INTO hyperfide.provider_bootstrap_grant_corrections(organisation_id,run_id,intent_id,id,prior_descriptor_digest,descriptor_digest,descriptor,original_operation_id,rejection_id,rejection_digest,operation_id,request,request_digest,trusted_policy_digest,trusted_ceiling) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *',[p.organisation_id,p.run_id,current.intent_id,randomUUID(),current.descriptor_digest,candidateDigest,combined,current.grant_operation_id,rejection.id,rejection.evidence_digest,operation,corrected,digestDocument(corrected),hash(policyBytes),policy.grant_ttl_seconds])).rows[0]!;
 });
}
