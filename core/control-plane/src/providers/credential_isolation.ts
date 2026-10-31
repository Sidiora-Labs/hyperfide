import type {PrimaryTransaction} from '../storage/transactions.js';
import {assertPrimaryTransaction} from '../storage/transactions.js';
import {fleetReadinessDigest} from '../preparation/fleet_readiness_contract.js';
import {object} from '../policy/programme.js';
import {fail} from './pools.js';
type Data=Record<string,any>;
export async function assertRunnerCredentialIsolation(tx:PrimaryTransaction,scope:{organisation_id:string;run_id:string;session_id:string;sandbox_id:string;boot_generation:string},envRefs:unknown):Promise<void>{
 assertPrimaryTransaction(tx);
 if(!object(envRefs))fail('RUNNER_SECRET_REFERENCE_INVALID','Explicit credential reference map required');
 const row=(await tx.query(`SELECT r.slot_id,r.uid,r.gid,st.inventory,a.receipt AS activation_receipt,a.receipt_digest AS activation_receipt_digest,
 EXISTS(SELECT 1 FROM hyperfide.provider_native_bootstraps j WHERE j.organisation_id=r.organisation_id AND j.run_id=r.run_id AND j.sandbox_id=r.sandbox_id AND j.boot_id=r.boot_id AND j.boot_generation=r.boot_generation) AS bootstrap_origin,
 EXISTS(SELECT 1 FROM hyperfide.fleet_runtime_readiness f CROSS JOIN LATERAL jsonb_array_elements(COALESCE(f.publication->'readiness_input'->'configurations','[]'::jsonb)) c WHERE f.organisation_id=r.organisation_id AND f.run_id=r.run_id AND f.sandbox_id=r.sandbox_id AND f.boot_id=r.boot_id AND f.boot_generation=r.boot_generation AND f.slot_id=r.slot_id AND f.slot_generation=r.slot_generation AND c->>'kind'='secret-ref') AS workspace_secrets
 FROM hyperfide.runner_registry r JOIN hyperfide.identity_principals p ON p.credential_id=r.credential_id JOIN hyperfide.identity_runner_status st ON st.credential_id=r.credential_id JOIN hyperfide.sandboxes s ON s.organisation_id=r.organisation_id AND s.id=r.sandbox_id JOIN hyperfide.sandbox_boots b ON b.organisation_id=s.organisation_id AND b.sandbox_id=s.id AND b.boot_generation=s.boot_generation
 LEFT JOIN LATERAL(SELECT x.receipt,x.receipt_digest FROM hyperfide.provider_worker_activations x WHERE x.organisation_id=r.organisation_id AND x.run_id=r.run_id AND x.sandbox_id=r.sandbox_id AND x.boot_id=r.boot_id AND x.boot_generation=r.boot_generation AND x.worker_slot_id=r.slot_id AND x.state='ACTIVE' ORDER BY x.created_at DESC LIMIT 1) a ON true
 WHERE r.organisation_id=$1 AND r.run_id=$2 AND r.session_id=$3 AND r.sandbox_id=$4 AND r.boot_generation=$5 AND b.boot_id=r.boot_id AND s.boot_generation=r.boot_generation AND s.observed_state='RUNNING' AND s.desired_state='RUNNING' AND r.state IN('PREPARING','CURRENT') AND p.role='RUNNER' AND p.state='ACTIVE' AND p.expires_at>clock_timestamp() AND st.heartbeat_at>clock_timestamp()-interval '90 seconds' FOR SHARE OF r,p,st,s,b`,[scope.organisation_id,scope.run_id,scope.session_id,scope.sandbox_id,scope.boot_generation])).rows[0];
 if(!Object.keys(envRefs).length&&!row?.workspace_secrets)return;
 if(!row||!Array.isArray(row.inventory))fail('RUNNER_CREDENTIAL_ISOLATION_REQUIRED','Credential delivery requires current measured dedicated VM isolation');
 const physical=row.inventory.filter((item:unknown):item is Data=>object(item)&&item.state==='READY'&&typeof item.slot_id==='string');
 const matching=physical.filter((item:Data)=>item.slot_id===row.slot_id&&item.uid===Number(row.uid)&&item.gid===Number(row.gid)&&item.isolation_profile==='vm_dedicated'&&item.vm_level_isolation===true&&item.credential_sensitive===true);
 if(physical.length!==1||matching.length!==1)fail('RUNNER_CREDENTIAL_ISOLATION_REQUIRED','Credential delivery requires the sole credential-sensitive slot on a dedicated VM');
 if(row.bootstrap_origin&&(!object(row.activation_receipt)||fleetReadinessDigest(row.activation_receipt)!==row.activation_receipt_digest||row.activation_receipt.state!=='ACTIVATED'||row.activation_receipt.worker_slot_id!==row.slot_id))fail('RUNNER_CREDENTIAL_ACTIVATION_REQUIRED','Bootstrap workers require a verified completed credential-isolation transition');
}
