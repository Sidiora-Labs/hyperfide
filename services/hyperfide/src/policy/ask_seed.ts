import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import type { QueryResult, QueryResultRow } from 'pg';
import { attestationExpiryWarnings } from '../providers/pools.js';
import { loadIsolationPermitVerifier, type VerifiedIsolationPermit } from '../identity/credentials.js';

// Seeds for human.ask.seed (hyperfide-v21 4.7, req 4 ac_4). Every seed carries a stable key; human_interface.ts
// raises it idempotently under the run's seed scope, so a re-seed replays what is already raised.
interface Tx { query<R extends QueryResultRow=QueryResultRow>(text:string,values?:unknown[]):Promise<QueryResult<R>> }
export interface SeedRequest {idempotency_key:string;kind:'decision'|'permission';title:string;body:string;options:string[];recommended:string;deadline_seconds:number|null;chain:string[]}
export interface Seed {source:'decision'|'attestation'|'fence-permit'|'drain';key:string;request:SeedRequest|null;reason?:string}
export type PermitObservation={state:'NOT_CONFIGURED'}|{state:'UNREADABLE';code:string}|{state:'OBSERVED';permit:VerifiedIsolationPermit};

/** The open items of spec/hyperfide/decisions.md section 3 and its run-policy exceptions. The options and the
 * recommended (first) option mirror its "Seeded Ask options" table; 4_7.py fails when the two differ. */
export const openDecisions:readonly {id:string;title:string;gate:string;options:readonly string[]}[]=Object.freeze([
 {id:'O-01',title:'Native authentication mode and model alias resolution',gate:'Decided as configured for the Paxeer X v6.12.0 production release run (task 27.3); each native route is gated before live use.',options:['recorded-27.3-run','api-credential','account-session','mixed']},
 {id:'O-02',title:'Railway and Blaxel account limits, topology and regions',gate:'Decided as configured for the Paxeer X v6.12.0 production release run (task 27.3); gates provider expansion.',options:['recorded-27.3-run','operator-attested-limits']},
 {id:'O-03',title:'PostgreSQL version, pooler, hosting, synchronous standby, fencing and backup',gate:'Pinned versions plus migration, primary-loss, old-primary-isolation and PITR drills gate authority deployment.',options:['hold-authority-deployment','managed-sync-standby','self-hosted-sync-standby']},
 {id:'O-04',title:'Git host and target-ref enforcement across repositories',gate:'Stale worker and old-gateway target writes must fail before accepted publication.',options:['hold-publication','target-ref-acl','server-hook','gateway-enforcement']},
 {id:'O-05',title:'Artifact store, retention, project separation, secret broker and model egress',gate:'Hash, ACL, redaction, rotation, retention and restore tests gate durable evidence and external source transfer.',options:['hold-durable-evidence','select-and-test-services']},
 {id:'O-06',title:'Per-profile resources, slot density and the sustained-concurrency window',gate:'Open, measured from the Paxeer X v6.12.0 production release run (task 27.3); gates the 100/200 capacity claim.',options:['measure-from-27.3-run','freeze-load-manifests-now']},
 {id:'O-07',title:'Source and graph corpus and comparative latency baselines',gate:'Real repositories pinned apart from spec fixtures gate any speedup claim.',options:['hold-speedup-claims','pin-real-corpus-now']},
 {id:'O-08',title:'Model route entitlement, version stability, billing and decision quality',gate:'Route tests, usage reconciliation and calibrated held-out labels gate recommendation-policy promotion.',options:['advice-stays-advisory','promote-recommendation-policy']},
 {id:'O-09',title:'RPO/RTO, minimum HA topology, retention horizons and endurance settings',gate:'Open, measured from the Paxeer X v6.12.0 production release run (task 27.3); settings freeze before campaigns.',options:['measure-from-27.3-run','freeze-proposed-targets-now']},
 {id:'O-10',title:'Public release version, namespaces and legacy compatibility duration',gate:'A recorded release decision and namespace ownership gate distribution.',options:['hold-distribution','release-2.0.0']},
 {id:'O-11',title:'Specialist-sharded review or other coverage reductions',gate:'Default: every configured watcher reviews every relevant commit; an alternative needs explicit policy acceptance.',options:['every-watcher-every-commit','specialist-sharded-review']},
 {id:'O-12',title:'Optional self-host Span and preview provider capabilities',gate:'Excluded from the production baseline unless qualified.',options:['exclude-from-production-baseline','qualify-self-host-span','qualify-preview-capabilities']},
 {id:'E-01',title:'Private-corpus qualification leg of task 2.1 on the supervisory host',gate:'Only that leg runs on the supervisory host; the corpus never leaves ignored storage there.',options:['keep-exception','revoke-exception']}
]);

const MAX_PERMIT_BYTES=131072;
/** The fence permit observer: the off-box signed isolation permit this host holds (bootstrap_fence.ts), read
 * only when HYPERFIDE_ISOLATION_PERMIT_FILE names one. Its signature is checked against the trusted verifier; a
 * permit that no longer verifies (expired or invalid) is reported, not raised. */
export async function observeFencePermit(env:Readonly<NodeJS.ProcessEnv>):Promise<PermitObservation>{
 const file=env.HYPERFIDE_ISOLATION_PERMIT_FILE;
 if(!file)return {state:'NOT_CONFIGURED'};
 try{
  if(!env.HYPERFIDE_ISOLATION_PERMIT_VERIFIER_FILE||!path.isAbsolute(file))return {state:'UNREADABLE',code:'ISOLATION_PERMIT_CONFIG'};
  const verifier=await loadIsolationPermitVerifier(env.HYPERFIDE_ISOLATION_PERMIT_VERIFIER_FILE);
  const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);let bytes:Buffer;
  try{const info=await handle.stat();if(!info.isFile()||info.size<1||info.size>MAX_PERMIT_BYTES)return {state:'UNREADABLE',code:'ISOLATION_PERMIT_INVALID'};bytes=await handle.readFile();}
  finally{await handle.close();}
  return {state:'OBSERVED',permit:verifier.verifySigned(bytes)};
 }catch(error){
  const code=error&&typeof error==='object'&&typeof (error as {code?:unknown}).code==='string'?String((error as {code:string}).code):'ISOLATION_PERMIT_INVALID';
  return {state:'UNREADABLE',code};
 }
}

export async function askSeeds(tx:Tx,input:{organisation_id:string;run_id:string;decision_deadline_seconds:number;permit:PermitObservation}):Promise<Seed[]>{
 const seeds:Seed[]=[];
 // Open decisions: proceed-and-flag on the recommended option at the operator's deadline (D11).
 for(const d of openDecisions)seeds.push({source:'decision',key:d.id,request:{idempotency_key:'seed.decision.'+d.id,kind:'decision',
  title:'Decision '+d.id+': '+d.title,body:d.gate+' Register: spec/hyperfide/decisions.md '+d.id+'.',options:[...d.options],recommended:d.options[0]!,
  deadline_seconds:input.decision_deadline_seconds,chain:['operator']}});
 // Capacity attestations inside the warning window or recently lapsed (providers/pools.ts observer). Renewal is the
 // operator's to grant, so a permission Ask that blocks; its deadline is the attestation's own expiry.
 const pools=(await tx.query<{pool_id:string}>('SELECT DISTINCT pool_id FROM hyperfide.provider_pool_configurations WHERE organisation_id=$1 AND active ORDER BY pool_id',[input.organisation_id])).rows.map(r=>r.pool_id);
 for(const w of pools.length?await attestationExpiryWarnings(tx,input.organisation_id,pools):[])seeds.push({source:'attestation',key:w.attestation_id,request:{
  idempotency_key:'seed.attestation.'+w.attestation_id,kind:'permission',title:'Renew capacity attestation '+w.attestation_id,
  body:'Pool '+w.pool_id+' '+w.scope_kind+':'+w.scope_key+' '+w.dimension+' limit '+w.limit+' attested until '+w.expires_at+'; once lapsed the pool is QUOTA_UNQUALIFIED for this dimension.',
  options:['renew','let-lapse'],recommended:'renew',deadline_seconds:w.seconds_remaining>=1?Math.min(w.seconds_remaining,30*86400):null,chain:['operator']}});
 // The fence permit this host holds, for this organisation and run only.
 const p=input.permit;
 if(p.state==='UNREADABLE')seeds.push({source:'fence-permit',key:'configured',request:null,reason:p.code});
 else if(p.state==='OBSERVED'){
  const permit=p.permit,remaining=Math.floor((Date.parse(permit.expires_at)-Date.now())/1000);
  if(permit.organisation_id!==input.organisation_id||permit.run_id!==input.run_id)seeds.push({source:'fence-permit',key:permit.permit_digest,request:null,reason:'ISOLATION_PERMIT_SCOPE'});
  else if(remaining<1)seeds.push({source:'fence-permit',key:permit.permit_digest,request:null,reason:'ISOLATION_PERMIT_EXPIRED'});
  else seeds.push({source:'fence-permit',key:permit.permit_digest,request:{idempotency_key:'seed.fence-permit.'+permit.permit_digest,kind:'permission',
   title:'Fence permit for operation '+permit.operation_id+' expires '+permit.expires_at,
   body:'The off-box isolation permit (deployment '+permit.deployment_id+', issuer '+permit.issuer_key_id+') stops verifying at '+permit.expires_at+'; the fence operation needs a freshly signed permit after that.',
   options:['re-sign','let-expire'],recommended:'re-sign',deadline_seconds:remaining,chain:['operator']}});
 }
 // Drain controls with a future deadline (scheduler/claim.ts applies the fallback once it passes). Unanswered,
 // the fallback is what happens, so it is the recommended option of a proceed-and-flag decision.
 const drains=await tx.query<{id:string;scope_kind:string;scope_id:string;generation:string;deadline_at:Date;fallback_mode:string;remaining:string}>(
  "SELECT id,scope_kind,scope_id,generation::text,deadline_at,fallback_mode,floor(extract(epoch FROM deadline_at-clock_timestamp()))::bigint::text AS remaining FROM hyperfide.execution_controls WHERE organisation_id=$1 AND run_id=$2 AND mode='DRAIN' AND deadline_at>clock_timestamp()+interval '1 second' ORDER BY deadline_at,id",
  [input.organisation_id,input.run_id]);
 for(const d of drains.rows){
  const fallback='apply-'+d.fallback_mode.toLowerCase();
  seeds.push({source:'drain',key:d.id+'.'+d.generation,request:{idempotency_key:'seed.drain.'+d.id+'.'+d.generation,kind:'decision',
   title:'Drain of '+d.scope_kind+' '+d.scope_id+' reaches its deadline '+new Date(d.deadline_at).toISOString(),
   body:'Execution control '+d.id+' generation '+d.generation+' drains until '+new Date(d.deadline_at).toISOString()+' and then applies '+d.fallback_mode+'. Extending needs a new drain control.',
   options:[fallback,'extend-drain'],recommended:fallback,deadline_seconds:Math.min(Number(d.remaining),30*86400),chain:['operator']}});
 }
 return seeds;
}
