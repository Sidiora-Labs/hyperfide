/** Only this fixed authenticated producer's actual observation receipts join provider inventory. */
export const inventoryJournalOperation='provider.inventory.observe';
export const inventoryJournalPrincipal='PROVISIONER_INVENTORY';
export function validInventoryJournal(result:unknown,requestDigest:unknown,digest:(value:unknown)=>string,expectedRun?:unknown):boolean{
 if(!result||typeof result!=='object'||Array.isArray(result))return false;
 const r=result as Record<string,any>,request=r.request,observation=r.observation;
 if(Object.keys(r).sort().join(',')!=='evidence_digest,observation,request'||!request||!observation||request.schema_version!==1||Object.keys(request).sort().join(',')!=='credential_id,native_sandbox_id,policy_digest,run_id,schema_version,scope')return false;
 if(expectedRun!==undefined&&request.run_id!==expectedRun)return false;
 if(typeof request.run_id!=='string'||!request.run_id||typeof request.credential_id!=='string'||!request.credential_id||observation.kind!=='PROVIDER_INVENTORY_ATTRIBUTION_V1'||request.native_sandbox_id!==observation.native_sandbox_id||request.policy_digest!==observation.policy_digest||!['OWNED','FOREIGN','UNKNOWN'].includes(observation.classification)||!['PRESENT','ABSENT','UNKNOWN'].includes(observation.presence)||typeof observation.observed_at!=='string'||!Number.isFinite(Date.parse(observation.observed_at))||new Date(observation.observed_at).toISOString()!==observation.observed_at)return false;
 try{return digest(request)===requestDigest&&digest(observation)===r.evidence_digest&&digest(request.scope)===digest(observation.scope);}catch{return false;}
}

/** Read full JSON only after indexed latest/presence/foreign selection per native identity. */
export function retainedInventoryEvidenceSQL():string{
 const oldFilter="organisation_id=$1 AND observation->>'kind'='PROVIDER_INVENTORY_ATTRIBUTION_V1' AND observation->'scope'->>'provider'=$2 AND observation->'scope'->>'provider_account_id'=$3";
 const journalFilter="organisation_id=$1 AND principal_scope='PROVISIONER_INVENTORY' AND operation='provider.inventory.observe' AND state='COMPLETED' AND result->'observation'->>'kind'='PROVIDER_INVENTORY_ATTRIBUTION_V1' AND result->'observation'->'scope'->>'provider'=$2 AND result->'observation'->'scope'->>'provider_account_id'=$3";
 const picks=['true',"observation->>'presence' IN('PRESENT','ABSENT')","observation->>'classification'='FOREIGN'"].flatMap(predicate=>[
 `(SELECT id,observation,evidence_digest::text,observed_at,created_at,NULL::jsonb AS journal_result,NULL::text AS journal_request_digest,NULL::text AS journal_run_id FROM hyperfide.provider_observations WHERE ${oldFilter} AND observation->'scope'->>'environment_id'=k.environment_id AND observation->>'native_sandbox_id'=k.native_id AND ${predicate} ORDER BY observed_at DESC,created_at DESC LIMIT 1)`,
 `(SELECT id,result->'observation' AS observation,result->>'evidence_digest' AS evidence_digest,(result->'observation'->>'observed_at')::timestamptz AS observed_at,created_at,result AS journal_result,request_digest::text AS journal_request_digest,run_id::text AS journal_run_id FROM hyperfide.command_inbox WHERE ${journalFilter} AND result->'observation'->'scope'->>'environment_id'=k.environment_id AND result->'observation'->>'native_sandbox_id'=k.native_id AND ${predicate.replaceAll('observation->',"result->'observation'->")} ORDER BY result->'observation'->>'observed_at' DESC,created_at DESC LIMIT 1)`]);
 return `WITH native_keys AS MATERIALIZED (
 SELECT observation->'scope'->>'environment_id' AS environment_id,observation->>'native_sandbox_id' AS native_id FROM hyperfide.provider_observations WHERE ${oldFilter}
 UNION SELECT result->'observation'->'scope'->>'environment_id',result->'observation'->>'native_sandbox_id' FROM hyperfide.command_inbox WHERE ${journalFilter}
 ORDER BY environment_id,native_id LIMIT 10001
 ), selected AS MATERIALIZED (SELECT p.* FROM native_keys k CROSS JOIN LATERAL (${picks.join(' UNION ALL ')}) p),
 latest AS (SELECT DISTINCT ON(observation->'scope'->>'environment_id',observation->>'native_sandbox_id') * FROM selected ORDER BY observation->'scope'->>'environment_id',observation->>'native_sandbox_id',observed_at DESC,created_at DESC),
 presence AS (SELECT DISTINCT ON(observation->'scope'->>'environment_id',observation->>'native_sandbox_id') * FROM selected WHERE observation->>'presence' IN('PRESENT','ABSENT') ORDER BY observation->'scope'->>'environment_id',observation->>'native_sandbox_id',observed_at DESC,created_at DESC),
 foreign_history AS (SELECT DISTINCT ON(observation->'scope'->>'environment_id',observation->>'native_sandbox_id') * FROM selected WHERE observation->>'classification'='FOREIGN' ORDER BY observation->'scope'->>'environment_id',observation->>'native_sandbox_id',observed_at DESC,created_at DESC)
 SELECT *,statement_timestamp() AS now FROM (SELECT * FROM latest UNION SELECT * FROM presence UNION SELECT * FROM foreign_history) evidence ORDER BY observed_at DESC,created_at DESC LIMIT 30001`;
}
