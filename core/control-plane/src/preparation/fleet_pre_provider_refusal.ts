import type {PrimaryTransaction} from '../storage/transactions.js';
import {assertPrimaryTransaction} from '../storage/transactions.js';
import type {InvocationContext} from '../transport/protocol.js';
import {fail,hash} from '../transport/protocol.js';
import {runnerCanonical} from '../runner/bridge.js';
import {readPreProviderRefusal} from '../runner/pre_provider_refusal.js';
import {releaseJobAllocation} from '../scheduler/claim.js';
import {ResourceScheduler} from '../scheduler/resources.js';
type Data=Record<string,any>;
/** A retained pre-provider fence proves no native execution, not a failed native result. */
export async function proveInstallPreProviderRefusal(tx:PrimaryTransaction,i:InvocationContext,binding:Data,install:Data):Promise<{job:Data;proof:Data}>{
 assertPrimaryTransaction(tx);const s=[i.principal.organisation_id,i.principal.run_id];
 const retained=await readPreProviderRefusal(tx,{organisation_id:s[0]!,run_id:s[1]!,operation_id:binding.runner_operation_id});
 const deny=():never=>fail('FLEET_INSTALL_PRE_PROVIDER_UNPROVEN','Exact retained pre-provider refusal and exclusive logical allocation required');
 if(!retained)return deny();const {job,proof}=retained;const plan:Data=job.plan,body:Data=proof.proof;
 if(proof.id!==binding.proof_id||proof.proof_digest!==binding.proof_digest||hash(runnerCanonical(body))!==binding.proof_digest||job.plan_digest!==binding.runner_plan_digest||job.operation_id!==install.operation_id||job.operation_id!==binding.runner_operation_id||job.authority_epoch!==install.authority_epoch||plan.preparation_request?.job_binding?.namespace!=='FLEET_INSTALL'||plan.preparation_request.job_binding.job_id!==install.operation_id||plan.preparation_request.job_binding.input_packet_digest!==install.admission_digest||plan.binding?.sandbox_id!==install.sandbox_id||plan.binding?.boot_id!==install.boot_id||String(plan.binding?.boot_generation)!==String(install.boot_generation))return deny();
 const submitted=(await tx.query('SELECT id FROM hyperfide.provider_remote_operations WHERE organisation_id=$1 AND run_id=$2 AND (id=$3 OR session_id=$4) LIMIT 1',[...s,job.operation_id,job.session_id])).rows;if(submitted.length)return deny();
 const allocation=(await tx.query('SELECT *,generation::text,sandbox_boot_generation::text FROM hyperfide.resource_job_allocations WHERE organisation_id=$1 AND run_id=$2 AND id=$3 FOR UPDATE',[...s,plan.allocation?.allocation_id])).rows[0];
 if(!allocation||allocation.state!=='ACTIVE'||allocation.job_kind!=='PREPARATION'||allocation.reservation_id!==job.reservation_id||allocation.assignee_session_id!==job.session_id||allocation.sandbox_id!==install.sandbox_id||allocation.sandbox_boot_generation!==String(install.boot_generation)||allocation.slot_id!==plan.binding.slot_id||allocation.generation!==String(plan.allocation.generation)||allocation.request_id!==plan.allocation.request_id||body.allocation?.id!==allocation.id||String(body.allocation.generation)!==allocation.generation||body.allocation.request_id!==allocation.request_id||body.allocation.reservation_id!==allocation.reservation_id||body.allocation.session_id!==job.session_id)return deny();
 if((await tx.query('SELECT operation_id FROM hyperfide.runner_remote_jobs WHERE organisation_id=$1 AND run_id=$2 AND reservation_id=$3 AND operation_id<>$4 LIMIT 1',[...s,job.reservation_id,job.operation_id])).rows.length)return deny();
 const reservations=(await tx.query(`SELECT r.id,r.capacity_account_id,r.quantity::text,r.expires_at::text,r.state,c.capacity_class,c.dimension FROM hyperfide.reservations r JOIN hyperfide.capacity_accounts c ON c.organisation_id=r.organisation_id AND c.id=r.capacity_account_id WHERE r.organisation_id=$1 AND r.run_id=$2 AND r.request_id=$3 ORDER BY r.id FOR UPDATE OF r`,[...s,allocation.request_id])).rows;
 if(reservations.length!==4||new Set(reservations.map(r=>r.dimension)).size!==4||['PREPARATION','CPU_MILLIS','MEMORY_BYTES','DISK_BYTES'].some(name=>!reservations.some(r=>r.dimension===name))||reservations.some(r=>r.state!=='ALLOCATED'||r.capacity_class==='PHYSICAL'||r.dimension==='WARM_SPARE')||!Array.isArray(body.reservations)||body.reservations.length!==4||reservations.some(r=>!body.reservations.some((p:Data)=>p.id===r.id&&p.capacity_account_id===r.capacity_account_id&&String(p.quantity)===r.quantity&&p.dimension===r.dimension&&Date.parse(p.expires_at)===Date.parse(r.expires_at))))return deny();
 await releaseJobAllocation(tx,{organisation_id:s[0]!,run_id:s[1]!,allocation_id:allocation.id,allocation_generation:allocation.generation,reservation_id:allocation.reservation_id,assignee_session_id:job.session_id});
 const ids=new Set<string>(reservations.map(r=>r.id)),scheduler=new ResourceScheduler();scheduler.registerProofReader('runner.pre-provider-refusal',async(_t,input)=>ids.has(input.reservation_id)?{id:proof.id,digest:proof.proof_digest,observed_at:new Date(proof.created_at).toISOString()}:null);
 try{await scheduler.release(tx,{organisation_id:s[0]!,run_id:s[1]!,reservation_ids:[...ids]});}finally{scheduler.close();}
 return {job,proof};
}
