import {abandonBoundNotStartedInstall,readBoundNotStartedInstallProof} from './preinstall_bound_cleanup.js';
import type {InvocationContext} from '../transport/protocol.js';
import {randomUUID} from 'node:crypto';
import type {PrimaryTransaction} from '../storage/transactions.js';
import {assertPrimaryTransaction} from '../storage/transactions.js';
import {lockRun} from '../events/outbox.js';
import {digestDocument} from '../providers/pools.js';
import {releaseJobAllocation} from '../scheduler/claim.js';
import {object} from '../policy/programme.js';
type Data=Record<string,any>;
export interface PreinstallScope{organisation_id:string;run_id:string;sandbox_id:string;boot_generation:string}
/** A mechanical executor registration is not evidence that an installer ran. */
async function inspect(tx:PrimaryTransaction,input:PreinstallScope,closed:boolean):Promise<Data|null>{
 const s=[input.organisation_id,input.run_id,input.sandbox_id,input.boot_generation];
 const boot=(await tx.query(`SELECT n.id AS bootstrap_id,n.manifest_digest,n.manifest,n.receipt,n.receipt_digest,s.native_sandbox_id,s.pool_id,b.boot_id FROM hyperfide.sandboxes s JOIN hyperfide.sandbox_boots b ON b.organisation_id=s.organisation_id AND b.sandbox_id=s.id AND b.boot_generation=s.boot_generation JOIN hyperfide.provider_native_bootstraps n ON n.organisation_id=s.organisation_id AND n.run_id=$2 AND n.sandbox_id=s.id AND n.boot_generation=s.boot_generation AND n.boot_id=b.boot_id WHERE s.organisation_id=$1 AND s.id=$3 AND s.boot_generation=$4 AND s.work_admitted=false AND n.state='READY' FOR SHARE OF s,b,n`,s)).rows;
 if(boot.length!==1)return null;const b=boot[0]!;if(digestDocument(b.manifest)!==b.manifest_digest||digestDocument(b.receipt)!==b.receipt_digest)return null;
 const unsafe=(await tx.query(`SELECT EXISTS(SELECT 1 FROM hyperfide.attempts WHERE organisation_id=$1 AND sandbox_id=$2::uuid)
 OR EXISTS(SELECT 1 FROM hyperfide.workspaces WHERE organisation_id=$1 AND sandbox_id=$2::uuid)
 OR EXISTS(SELECT 1 FROM hyperfide.fleet_environment_installs WHERE organisation_id=$1 AND sandbox_id=$2::uuid)
 OR EXISTS(SELECT 1 FROM hyperfide.provider_remote_operations WHERE organisation_id=$1 AND sandbox_id=$2::uuid)
 OR EXISTS(SELECT 1 FROM hyperfide.identity_principals WHERE organisation_id=$1 AND sandbox_id=$2::uuid AND role<>'RUNNER' AND state='ACTIVE')
 OR EXISTS(SELECT 1 FROM hyperfide.command_inbox WHERE organisation_id=$1 AND operation='provider.bootstrap.daemon-recovery' AND state='PENDING' AND result->'request'->'binding'->>'sandbox_id'=$3)
 OR EXISTS(SELECT 1 FROM hyperfide.runner_remote_jobs j JOIN hyperfide.runner_registry r ON r.organisation_id=j.organisation_id AND r.run_id=j.run_id AND r.session_id=j.session_id WHERE r.organisation_id=$1 AND r.sandbox_id=$2::uuid)
 OR EXISTS(SELECT 1 FROM hyperfide.native_launch_plans n JOIN hyperfide.agent_sessions a ON a.organisation_id=n.organisation_id AND a.run_id=n.run_id AND a.id=n.agent_session_id WHERE a.organisation_id=$1 AND a.sandbox_id=$2::uuid)
 OR EXISTS(SELECT 1 FROM hyperfide.slot_allocations WHERE organisation_id=$1 AND sandbox_id=$2::uuid AND state IN('ACTIVE','RELEASE_PENDING')) AS unsafe`,[input.organisation_id,input.sandbox_id,input.sandbox_id])).rows[0];if(unsafe?.unsafe!==false)return null;
 const allocations=(await tx.query('SELECT *,generation::text,sandbox_boot_generation::text FROM hyperfide.resource_job_allocations WHERE organisation_id=$1 AND sandbox_id=$2 FOR UPDATE',[input.organisation_id,input.sandbox_id])).rows;
 if(allocations.length!==1)return null;const a=allocations[0]!;if(a.run_id!==input.run_id||a.sandbox_boot_generation!==input.boot_generation||a.job_kind!=='PREPARATION'||!(closed?['RELEASE_PENDING','RELEASED']:['ACTIVE']).includes(a.state))return null;
 const sessions=(await tx.query('SELECT *,sandbox_boot_generation::text FROM hyperfide.agent_sessions WHERE organisation_id=$1 AND sandbox_id=$2 FOR UPDATE',[input.organisation_id,input.sandbox_id])).rows;
 if(sessions.length!==1)return null;const session=sessions[0]!;
 const r=(await tx.query('SELECT r.*,w.capacity_kind,w.state AS slot_state FROM hyperfide.runner_registry r JOIN hyperfide.worker_slots w ON w.organisation_id=r.organisation_id AND w.id=r.slot_id AND w.sandbox_id=r.sandbox_id AND w.boot_generation=r.boot_generation WHERE r.organisation_id=$1 AND r.run_id=$2 AND r.session_id=$3 FOR SHARE OF r,w',[input.organisation_id,input.run_id,a.assignee_session_id])).rows[0];
 if(!r||r.capacity_kind!=='PREPARATION'||r.sandbox_id!==input.sandbox_id||String(r.boot_generation)!==input.boot_generation||r.boot_id!==b.boot_id||r.slot_id!==a.slot_id||r.state!=='PREPARING'||!(closed?['DRAINING','RETIRED']:['ALLOCATED','RETIRED']).includes(r.slot_state)||session.id!==r.session_id||session.slot_id!==a.slot_id||session.sandbox_boot_generation!==input.boot_generation||session.run_id!==input.run_id||session.role!=='WORKER'||session.connector!=='hyperfide-native'||session.account_key!==r.credential_id||session.native_session_id!==r.session_id||session.attempt_id!==null||session.state!==(closed?'STOPPED':'REGISTERED'))return null;
 const slots=b.manifest?.template?.slots;if(!Array.isArray(slots)||slots.filter((v:Data)=>v.kind==='PREPARATION'&&v.slot_id===r.slot_id&&v.session_id===r.session_id&&v.uid===r.uid&&v.gid===r.gid&&v.credential_sensitive===false).length!==1)return null;
 const deliveries=(await tx.query('SELECT * FROM hyperfide.fleet_install_deliveries WHERE organisation_id=$1 AND sandbox_id=$2 FOR SHARE',[input.organisation_id,input.sandbox_id])).rows;
 if(deliveries.length!==1)return null;const d=deliveries[0]!;if(d.run_id!==input.run_id||d.boot_id!==b.boot_id||String(d.boot_generation)!==input.boot_generation||d.session_id!==r.session_id||d.target_binding_id!==a.id||d.reservation_id!==a.reservation_id||d.state!=='REGISTERED'||d.operation_id!==null||d.request!==null||d.request_digest!==null)return null;
 const reservations=(await tx.query('SELECT id,state,expires_at::text,expires_at<=clock_timestamp() AS expired FROM hyperfide.reservations WHERE organisation_id=$1 AND run_id=$2 AND request_id=$3 ORDER BY id FOR SHARE',[input.organisation_id,input.run_id,a.request_id])).rows;
 if(!reservations.length||reservations.some(v=>v.expired!==true||!(closed?['RELEASE_PENDING','RELEASED']:['ALLOCATED']).includes(v.state)))return null;
 return {binding:{organisation_id:input.organisation_id,run_id:input.run_id,sandbox_id:input.sandbox_id,boot_generation:input.boot_generation,boot_id:b.boot_id,native_sandbox_id:b.native_sandbox_id,pool_id:b.pool_id,bootstrap_id:b.bootstrap_id,manifest_digest:b.manifest_digest},allocation:{id:a.id,request_id:a.request_id,reservation_id:a.reservation_id,generation:a.generation,session_id:r.session_id,slot_id:r.slot_id},delivery:{id:d.id,registration_digest:d.registration_digest,input_digest:d.input_digest},reservations:reservations.map(v=>({id:v.id,expires_at:v.expires_at}))};
}
export async function abandonExpiredPreinstall(tx:PrimaryTransaction,input:PreinstallScope,invocation?:InvocationContext):Promise<Data|null>{
 assertPrimaryTransaction(tx);await lockRun(tx,input,'exclusive');const retained=await readAbandonedPreinstallProof(tx,input);if(retained)return retained;const proof=await inspect(tx,input,false);if(!proof)return invocation?abandonBoundNotStartedInstall(tx,input,invocation):null;
 const a=proof.allocation;await releaseJobAllocation(tx,{organisation_id:input.organisation_id,run_id:input.run_id,allocation_id:a.id,allocation_generation:a.generation,reservation_id:a.reservation_id,assignee_session_id:a.session_id});
 await tx.query("UPDATE hyperfide.agent_sessions SET state='STOPPED',state_version=state_version+1 WHERE organisation_id=$1 AND run_id=$2 AND id=$3 AND state='REGISTERED' AND attempt_id IS NULL",[input.organisation_id,input.run_id,a.session_id]);
 const result={schema_version:1,kind:'ABANDONED_PREINSTALL_V1',...proof,physical_resources_released:false};
 await tx.query("INSERT INTO hyperfide.command_inbox(organisation_id,run_id,id,principal_scope,operation,idempotency_key,request_digest,state,result) VALUES($1,$2,$3,'preinstall-cleanup','fleet.preinstall.abandon',$4,$5,'COMPLETED',$6)",[input.organisation_id,input.run_id,randomUUID(),input.sandbox_id+':'+input.boot_generation,digestDocument(proof),result]);return result;
}
export async function readAbandonedPreinstallProof(tx:PrimaryTransaction,input:PreinstallScope):Promise<Data|null>{
 assertPrimaryTransaction(tx);const retained=(await tx.query("SELECT result FROM hyperfide.command_inbox WHERE organisation_id=$1 AND run_id=$2 AND principal_scope='preinstall-cleanup' AND operation='fleet.preinstall.abandon' AND idempotency_key=$3 AND state='COMPLETED'",[input.organisation_id,input.run_id,input.sandbox_id+':'+input.boot_generation])).rows[0]?.result;
 if(!object(retained))return null;if(retained.kind==='ABANDONED_NOT_STARTED_INSTALL_V1'||retained.kind==='ABANDONED_PRE_PROVIDER_INSTALL_V1')return readBoundNotStartedInstallProof(tx,input,retained);if(retained.kind!=='ABANDONED_PREINSTALL_V1')return null;const fresh=await inspect(tx,input,true);if(!fresh)return null;
 const {schema_version,kind,physical_resources_released,...pins}=retained;if(digestDocument(pins)!==digestDocument(fresh))return null;return retained;
}
