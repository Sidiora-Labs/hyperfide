import {createPublicKey,verify} from 'node:crypto';
import type {PrimaryTransaction} from '../storage/transactions.js';
import {assertPrimaryTransaction} from '../storage/transactions.js';
import type {InvocationContext} from '../transport/protocol.js';
import {fail,hash} from '../transport/protocol.js';
import {object} from '../policy/programme.js';
import {runnerCanonical} from '../runner/bridge.js';
import {ResourceScheduler} from '../scheduler/resources.js';
import {sourceDigest} from './metadata.js';

export interface NativeFleetCleanupBinding {
 organisation_id:string;run_id:string;attempt_id:string;attempt_generation:string;
 sandbox_id:string;slot_id:string;boot_generation:string;authority_epoch:string;
}
interface NativeFleetCustody {custody_id:string;workspace_id:string;revision_id:string;root_tree_id:string;result_digest:string}
export type NativeFleetCleanupState={native:false}|{native:true;custody:NativeFleetCustody|null};

/** Cleanup relies on retained submission bytes, independently of their later qualification outcome. */
export async function readNativeFleetCleanup(tx:PrimaryTransaction,b:NativeFleetCleanupBinding):Promise<NativeFleetCleanupState>{
 assertPrimaryTransaction(tx);
 const schema=(await tx.query("SELECT to_regclass('hyperfide.source_fleet_assignments') IS NOT NULL AND to_regclass('hyperfide.source_fleet_submissions') IS NOT NULL AS present")).rows[0];
 if(schema?.present!==true)return {native:false};
 const assignments=(await tx.query(`SELECT * FROM hyperfide.source_fleet_assignments
  WHERE organisation_id=$1 AND run_id=$2 AND attempt_id=$3 AND attempt_generation=$4 FOR SHARE`,
  [b.organisation_id,b.run_id,b.attempt_id,b.attempt_generation])).rows;
 if(!assignments.length){
  const native=(await tx.query(`SELECT 1 FROM hyperfide.runner_registry r JOIN hyperfide.fleet_runtime_readiness q
   ON q.organisation_id=r.organisation_id AND q.run_id=r.run_id AND q.runner_session_id=r.session_id AND q.readiness_digest=r.readiness_digest
   WHERE r.organisation_id=$1 AND r.run_id=$2 AND r.sandbox_id=$3 AND r.slot_id=$4 AND r.boot_generation=$5
   AND q.publication->>'source_backend'='native' LIMIT 1`,[b.organisation_id,b.run_id,b.sandbox_id,b.slot_id,b.boot_generation])).rows;
  return native.length?{native:true,custody:null}:{native:false};
 }
 if(assignments.length!==1)fail('NATIVE_CLEANUP_BINDING','One exact native assignment is required');
 const a=assignments[0]!;
 if(a.sandbox_id!==b.sandbox_id||a.slot_id!==b.slot_id||String(a.sandbox_boot_generation)!==b.boot_generation||a.run_authority_epoch!==b.authority_epoch)
  fail('NATIVE_CLEANUP_BINDING','Native cleanup differs from its assignment slot, boot or authority');
 if(!a.submission_id)return {native:true,custody:null};
 const rows=(await tx.query(`SELECT s.*,c.owner_principal_id,c.custody_generation::text AS retained_generation,
  c.revision_id AS retained_revision,c.root_tree_id AS retained_root,c.run_id AS retained_run,c.task_id AS retained_task,
  r.root_tree_id AS revision_root
  FROM hyperfide.source_fleet_submissions s
  JOIN hyperfide.source_native_custodies c USING(organisation_id,repository_id,security_domain_id,custody_id)
  JOIN hyperfide.source_revisions r ON r.organisation_id=s.organisation_id AND r.repository_id=s.repository_id
   AND r.security_domain_id=s.security_domain_id AND r.revision_id=s.revision_id
  JOIN hyperfide.source_workspaces w ON w.organisation_id=s.organisation_id AND w.repository_id=s.repository_id
   AND w.security_domain_id=s.security_domain_id AND w.workspace_id=$6 AND w.principal_id=$7
   AND w.checkpoint_revision_id=s.revision_id AND w.root_tree_id=s.root_tree_id
  JOIN hyperfide.source_object_pins p ON p.organisation_id=s.organisation_id AND p.repository_id=s.repository_id
   AND p.security_domain_id=s.security_domain_id AND p.object_id=s.root_tree_id AND p.owner_kind='REVISION'
   AND p.owner_id='native-custody:'||s.custody_id::text||':'||s.custody_generation::text AND p.position=0 AND p.expires_at IS NULL
  JOIN hyperfide.source_native_objects o ON o.organisation_id=p.organisation_id AND o.repository_id=p.repository_id
   AND o.security_domain_id=p.security_domain_id AND o.object_id=p.object_id AND o.current_incarnation=p.incarnation_id
   AND o.state='VERIFIED' AND o.kind IN('tree-leaf','tree-index') AND o.tree_prefix=''
  JOIN hyperfide.source_object_placements placement ON placement.organisation_id=p.organisation_id
   AND placement.repository_id=p.repository_id AND placement.security_domain_id=p.security_domain_id
   AND placement.object_id=p.object_id AND placement.incarnation_id=p.incarnation_id AND placement.state='VERIFIED'
  WHERE s.organisation_id=$1 AND s.repository_id=$2 AND s.security_domain_id=$3 AND s.assignment_id=$4 AND s.custody_id=$5
  FOR SHARE OF s,c,r,w,p,o,placement`,
  [a.organisation_id,a.repository_id,a.security_domain_id,a.assignment_id,a.submission_id,a.workspace_id,a.worker_principal_id])).rows;
 if(rows.length!==1)return {native:true,custody:null};
 const s=rows[0]!,result=s.result;
 if(s.run_id!==b.run_id||s.task_id!==a.task_id||s.attempt_id!==b.attempt_id||String(s.attempt_generation)!==b.attempt_generation
  ||s.retained_run!==b.run_id||s.retained_task!==a.task_id||s.owner_principal_id!==a.manager_principal_id
  ||String(s.custody_generation)!==s.retained_generation||s.revision_id!==s.retained_revision||s.root_tree_id!==s.retained_root
  ||s.root_tree_id!==s.revision_root||s.run_authority_epoch!==b.authority_epoch||!object(result))
  fail('NATIVE_CLEANUP_CUSTODY','Native submission custody no longer matches the exact assignment');
 const {result_digest,...body}=result;
 if(sourceDigest(body)!==result_digest||result.custody_id!==s.custody_id||result.assignment_id!==a.assignment_id||!object(result.scope)
  ||result.revision_id!==s.revision_id||result.root_tree_id!==s.root_tree_id||result.attempt_id!==b.attempt_id
  ||result.attempt_generation!==b.attempt_generation||result.scope?.organisation_id!==a.organisation_id
  ||result.scope?.repository_id!==a.repository_id||result.scope?.security_domain_id!==a.security_domain_id)
  fail('NATIVE_CLEANUP_CUSTODY','Native submission receipt differs from its retained source');
 return {native:true,custody:{custody_id:s.custody_id,workspace_id:a.workspace_id,revision_id:s.revision_id,root_tree_id:s.root_tree_id,result_digest}};
}

/** Called only after the bound runner reports fresh empty-process and empty-credential residue. */
export async function releaseNativeFleetCompute(tx:PrimaryTransaction,i:InvocationContext,b:NativeFleetCleanupBinding,
 command:Record<string,any>,residue:{process_residue:unknown;credential_residue:unknown;evidence_digest:unknown}):Promise<void>{
 const retained=await readNativeFleetCleanup(tx,b);if(!retained.native)return;
 if(!retained.custody)fail('NATIVE_CLEANUP_CUSTODY','Native source must be in coordinator custody before slot release');
 if(i.principal.role!=='RUNNER'||i.principal.sandbox_id!==b.sandbox_id||i.principal.boot_generation!==b.boot_generation
  ||i.principal.deployment_epoch!==b.authority_epoch||residue.process_residue!=='ABSENT'||residue.credential_residue!=='ABSENT')
  fail('NATIVE_CLEANUP_RESIDUE','Current bound runner must observe process and credential absence');
 await i.guard(tx);
 const current=(await tx.query(`SELECT a.compute_authority,r.authority_epoch,b.boot_id FROM hyperfide.attempts a
  JOIN hyperfide.runs r ON r.organisation_id=a.organisation_id AND r.id=a.run_id
  JOIN hyperfide.sandboxes s ON s.organisation_id=a.organisation_id AND s.id=a.sandbox_id AND s.boot_generation=a.sandbox_boot_generation
  JOIN hyperfide.sandbox_boots b ON b.organisation_id=s.organisation_id AND b.sandbox_id=s.id AND b.boot_generation=s.boot_generation
  WHERE a.organisation_id=$1 AND a.run_id=$2 AND a.id=$3 AND a.generation=$4 AND a.sandbox_id=$5 AND a.slot_id=$6 AND a.sandbox_boot_generation=$7
  FOR SHARE OF a,r,s,b`,[b.organisation_id,b.run_id,b.attempt_id,b.attempt_generation,b.sandbox_id,b.slot_id,b.boot_generation])).rows[0];
 if(!current||current.compute_authority!=='RELEASED'||current.authority_epoch!==b.authority_epoch||current.boot_id!==i.principal.boot_id
  ||command.boot_id!==current.boot_id||command.authority_epoch!==b.authority_epoch||command.state!=='REPORTED'
  ||command.action!=='runner.stop'||command.outcome!=='STOPPED'||command.termination!=='CONFIRMED'||command.cleanup_complete!==true
  ||!object(command.report)||command.report.remaining_descendants!==0||command.report.cleanup_complete!==true
  ||!Array.isArray(command.report.cleanup_debt)||command.report.cleanup_debt.length
  ||!Array.isArray(command.report.credential_revocation)||command.report.credential_revocation.some((entry:any)=>entry.state==='UNRESOLVED')
  ||hash(runnerCanonical(command.report))!==command.report_digest)
  fail('NATIVE_CLEANUP_QUIESCENCE','Native release requires exact current STOP and retained source custody');
 const newer=(await tx.query('SELECT 1 FROM hyperfide.runner_control_commands WHERE organisation_id=$1 AND run_id=$2 AND launch_id=$3 AND fence_sequence>$4 LIMIT 1',[b.organisation_id,b.run_id,command.launch_id,String(command.fence_sequence)])).rows;
 const live=(await tx.query(`SELECT 1 FROM hyperfide.compute_leases WHERE organisation_id=$1 AND run_id=$2 AND attempt_id=$3 AND state='ACTIVE'
  UNION ALL SELECT 1 FROM hyperfide.identity_principals WHERE organisation_id=$1 AND run_id=$2 AND attempt_id=$3 AND state='ACTIVE' LIMIT 1`,[b.organisation_id,b.run_id,b.attempt_id])).rows;
 if(newer.length||live.length)fail('NATIVE_CLEANUP_QUIESCENCE','Newer controls or active attempt credentials prevent release');
 const launch=(await tx.query(`SELECT f.*,p.public_key_b64 FROM hyperfide.fleet_worker_launches f
  JOIN hyperfide.native_launch_plans n ON n.organisation_id=f.organisation_id AND n.run_id=f.run_id AND n.launch_id=f.launch_id
  JOIN hyperfide.identity_principals p ON p.credential_id=f.executor_credential_id AND p.organisation_id=f.organisation_id AND p.run_id=f.run_id AND p.role='PROVISIONER'
  WHERE f.organisation_id=$1 AND f.run_id=$2 AND f.launch_id=$3 AND n.attempt_id=$4 AND n.attempt_generation=$5
   AND n.slot_id=$6 AND f.authority_epoch=$7 FOR SHARE OF f,n,p`,[b.organisation_id,b.run_id,command.launch_id,b.attempt_id,b.attempt_generation,b.slot_id,b.authority_epoch])).rows[0];
 if(!launch||launch.state!=='COMPLETED'||!object(launch.result)||launch.result.launch_id!==command.launch_id
  ||launch.result.command_id!==launch.command_id||launch.result.request_digest!==launch.request_digest
  ||!object(launch.result.native)||launch.result.native.terminal_observed!==true||launch.result.native.foreground_owner!==true
  ||hash(runnerCanonical(launch.result))!==launch.result_digest||typeof launch.result_signature!=='string'||typeof launch.public_key_b64!=='string')
  fail('NATIVE_CLEANUP_QUIESCENCE','Signed terminal native execution is required');
 const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(launch.public_key_b64,'base64url')]),format:'der',type:'spki'});
 if(!verify(null,Buffer.from(runnerCanonical(launch.result)),key,Buffer.from(launch.result_signature,'base64url')))
  fail('NATIVE_CLEANUP_QUIESCENCE','Native execution signature differs');
 const reservations=(await tx.query(`SELECT r.id FROM hyperfide.reservations r JOIN hyperfide.capacity_accounts c
  ON c.organisation_id=r.organisation_id AND c.id=r.capacity_account_id
  WHERE r.organisation_id=$1 AND r.run_id=$2 AND r.attempt_id=$3 AND c.capacity_class<>'PHYSICAL' AND c.dimension<>'WARM_SPARE'
  ORDER BY r.id FOR UPDATE OF r`,[b.organisation_id,b.run_id,b.attempt_id])).rows;
 if(!reservations.length)fail('NATIVE_CLEANUP_RESERVATION','Exact attempt reservations are required');
 const ids=new Set<string>(reservations.map(row=>row.id)),scheduler=new ResourceScheduler();
 const proof={id:command.command_id,digest:sourceDigest({submission:retained.custody.result_digest,stop:command.report_digest,residue:residue.evidence_digest}),observed_at:new Date(command.reported_at).toISOString()};
 scheduler.registerProofReader('runner.quiescence',async(_tx,input)=>ids.has(input.reservation_id)?proof:null);
 try{await scheduler.release(tx,{organisation_id:b.organisation_id,run_id:b.run_id,reservation_ids:[...ids]});}finally{scheduler.close();}
}
