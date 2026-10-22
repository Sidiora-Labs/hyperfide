import type {Component,ComponentContext} from '../components/registry.js';
import {FoundationError} from '../policy/programme.js';
import {acceptedResolution,admin,admittedEvidence,canonical,decimal,digest,digestValue,emit,fail,fields,finding,manager,oid,record,revalidateResolution,semanticDisposition,text,uuid,withFindingTransaction} from './registry.js';
import type {FindingScope,FindingTransaction} from './registry.js';
import {createHash,randomUUID} from 'node:crypto';
import {enqueue,resolveOperatorConsumer} from '../events/outbox.js';
import type {PrimaryTransaction} from '../storage/transactions.js';
import {assignFinding,readerLimit} from './routing.js';
import type {FindingReader} from './routing.js';
async function repair(value:FindingTransaction,id:string):Promise<Record<string,any>>{
 const result=await value.tx.query('SELECT * FROM hyperfide.finding_repairs WHERE organisation_id=$1 AND run_id=$2 AND id=$3 FOR UPDATE',[value.scope.organisation_id,value.scope.run_id,id]);
 if(result.rows.length!==1)fail('REPAIR_NOT_FOUND','Repair does not exist in the authenticated run');return result.rows[0]!;
}
function limit(context:ComponentContext):number{
 const raw=context.env.HF_FINDING_REPAIR_MAX_ATTEMPTS;if(!raw||!/^[1-9][0-9]?$|^100$/.test(raw))fail('REPAIR_POLICY_REQUIRED','An explicit bounded repair attempt policy is required');return Number(raw);
}
async function request(value:FindingTransaction,input:unknown):Promise<Record<string,unknown>>{
 const p=record(input);fields(p,['finding_id','request_id','repair_task_id','expected_state_version']);
 const findingId=uuid(p.finding_id),requestId=uuid(p.request_id),taskId=uuid(p.repair_task_id),version=decimal(p.expected_state_version),packet=digest(p),{tx,scope}=value;
 const f=await finding(tx,scope,findingId,true);await manager(value,String(f.owner_package_id));
 const old=await tx.query('SELECT * FROM hyperfide.finding_repairs WHERE organisation_id=$1 AND run_id=$2 AND request_id=$3',[scope.organisation_id,scope.run_id,requestId]);
 if(old.rows.length){if(old.rows[0]!.request_digest!==packet)fail('IDEMPOTENCY_CONFLICT','Repair request was reused with different intent');return {repair:old.rows[0],replayed:true};}
 if(String(f.registry_version)!==version||['RESOLVED','DUPLICATE','ACCEPTED_EXCEPTION'].includes(f.phase))fail('STALE_FINDING','Finding is changed or not eligible for repair');
 const current=await tx.query('SELECT r.id FROM hyperfide.finding_routes r JOIN hyperfide.finding_route_acknowledgements a ON a.organisation_id=r.organisation_id AND a.run_id=r.run_id AND a.route_id=r.id JOIN hyperfide.feature_packages p ON p.organisation_id=r.organisation_id AND p.run_id=r.run_id AND p.id=r.owner_package_id JOIN hyperfide.hierarchy_packages h ON h.organisation_id=p.organisation_id AND h.run_id=p.run_id AND h.package_id=p.id WHERE r.organisation_id=$1 AND r.run_id=$2 AND r.finding_id=$3 AND r.generation=(SELECT max(x.generation) FROM hyperfide.finding_routes x WHERE x.organisation_id=r.organisation_id AND x.run_id=r.run_id AND x.finding_id=r.finding_id) AND r.manager_session_id=p.manager_session_id AND r.owner_generation=h.owner_generation AND EXISTS(SELECT 1 FROM hyperfide.agent_sessions s WHERE s.organisation_id=p.organisation_id AND s.run_id=p.run_id AND s.id=p.manager_session_id AND s.role=\'FEATURE_MANAGER\' AND s.state IN (\'REGISTERED\',\'RUNNING\')) FOR SHARE OF p,h',[scope.organisation_id,scope.run_id,findingId]);
 if(!current.rows.length)fail('ROUTING_REQUIRED','A current acknowledged owner is required before repair dispatch');
 const task=await tx.query('SELECT criteria_digest,feature_package_id FROM hyperfide.tasks WHERE organisation_id=$1 AND run_id=$2 AND id=$3 FOR SHARE',[scope.organisation_id,scope.run_id,taskId]);
 if(task.rows.length!==1||task.rows[0]!.feature_package_id!==f.owner_package_id||task.rows[0]!.criteria_digest!==f.resolution_condition.criteria_digest)fail('REPAIR_TASK_INVALID','Repair must use an ordinary scoped task with the recorded resolution criteria');
 const budget=await tx.query('SELECT COALESCE(sum(attempt_count),0)::text AS used,min(max_attempts) AS prior_limit FROM hyperfide.finding_repairs WHERE organisation_id=$1 AND run_id=$2 AND finding_id=$3',[scope.organisation_id,scope.run_id,findingId]);
 const maximum=limit(value.context);if(budget.rows[0]!.prior_limit!==null&&Number(budget.rows[0]!.prior_limit)!==maximum)fail('REPAIR_POLICY_CHANGED','Retry cannot silently change the recorded attempt policy');
 if(BigInt(budget.rows[0]!.used)>=BigInt(maximum))fail('REPAIR_LIMIT_REACHED','Repair budget is exhausted; leader escalation is required');
 const active=await tx.query('SELECT id FROM hyperfide.finding_repairs WHERE organisation_id=$1 AND run_id=$2 AND finding_id=$3 AND state IN (\'REQUESTED\',\'RUNNING\',\'READY_FOR_RECHECK\')',[scope.organisation_id,scope.run_id,findingId]);if(active.rows.length)fail('REPAIR_ACTIVE','A repair is already active for this canonical finding');
 const created=await tx.query('INSERT INTO hyperfide.finding_repairs(organisation_id,run_id,finding_id,request_id,request_digest,repair_task_id,resolution_digest,baseline_source_object_id,max_attempts) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',[scope.organisation_id,scope.run_id,findingId,requestId,packet,taskId,f.resolution_digest,f.source_object_id,maximum]);
 await tx.query('UPDATE hyperfide.finding_registry_records SET phase=\'REPAIRING\',state_version=state_version+1 WHERE organisation_id=$1 AND run_id=$2 AND finding_id=$3',[scope.organisation_id,scope.run_id,findingId]);
 await emit(tx,scope,findingId,(BigInt(version)+1n).toString(),'finding.repair-requested',{finding_id:findingId,repair_id:created.rows[0]!.id,task_id:taskId});return {repair:created.rows[0],replayed:false};
}
async function attach(value:FindingTransaction,input:unknown):Promise<Record<string,unknown>>{
 const p=record(input);fields(p,['repair_id','attempt_id','attempt_generation','expected_state_version']);const id=uuid(p.repair_id),attemptId=uuid(p.attempt_id),generation=decimal(p.attempt_generation),version=decimal(p.expected_state_version),{tx,scope}=value;
 const r=await repair(value,id),f=await finding(tx,scope,r.finding_id,true);await manager(value,String(f.owner_package_id));
 const current=await tx.query('SELECT a.id,a.sandbox_id,a.slot_id,a.sandbox_boot_generation::text FROM hyperfide.attempts a JOIN hyperfide.tasks t ON t.organisation_id=a.organisation_id AND t.run_id=a.run_id AND t.id=a.task_id JOIN hyperfide.compute_leases l ON l.organisation_id=a.organisation_id AND l.run_id=a.run_id AND l.attempt_id=a.id AND l.attempt_generation=a.generation AND l.authority_epoch=a.authority_epoch WHERE a.organisation_id=$1 AND a.run_id=$2 AND a.id=$3 AND a.task_id=$4 AND a.generation=$5 AND a.authority_epoch=$6 AND a.kind=\'IMPLEMENTATION\' AND a.compute_authority=\'CURRENT\' AND a.execution_state=\'RUNNING\' AND a.lease_expires_at>clock_timestamp() AND l.state=\'ACTIVE\' AND l.expires_at>clock_timestamp() AND t.current_attempt_id=a.id AND t.generation=a.generation FOR SHARE OF a,t,l',[scope.organisation_id,scope.run_id,attemptId,r.repair_task_id,generation,value.principal.deployment_epoch]);
 if(!current.rows.length)fail('STALE_ATTEMPT','Repair must attach to a current ordinary fenced implementation attempt');
 const compute=await actualInspector('../scheduler/leases.js','assertCurrentCompute'),attempt=current.rows[0]!;await compute(tx,{organisation_id:scope.organisation_id,run_id:scope.run_id,task_id:r.repair_task_id,attempt_id:attemptId,attempt_generation:generation,authority_epoch:value.principal.deployment_epoch,sandbox_id:attempt.sandbox_id,slot_id:attempt.slot_id,sandbox_boot_generation:attempt.sandbox_boot_generation},{operation:'ADVANCE'});

 if(r.attempt_id===attemptId&&String(r.attempt_generation)===generation&&r.state==='RUNNING')return {repair_id:id,attempt_id:attemptId,attempt_generation:generation,replayed:true};
 if(String(r.state_version)!==version||!['REQUESTED','FAILED'].includes(r.state))fail('STALE_REPAIR','Repair is no longer eligible for attempt attachment');
 const budget=await tx.query('SELECT COALESCE(sum(attempt_count),0)::text AS used FROM hyperfide.finding_repairs WHERE organisation_id=$1 AND run_id=$2 AND finding_id=$3',[scope.organisation_id,scope.run_id,r.finding_id]);if(BigInt(budget.rows[0]!.used)>=BigInt(r.max_attempts))fail('REPAIR_LIMIT_REACHED','Repair budget is exhausted');
 await tx.query('UPDATE hyperfide.finding_repairs SET state=\'RUNNING\',attempt_id=$4,attempt_generation=$5,attempt_count=attempt_count+1,updated_at=clock_timestamp(),state_version=state_version+1 WHERE organisation_id=$1 AND run_id=$2 AND id=$3',[scope.organisation_id,scope.run_id,id,attemptId,generation]);
 await tx.query('INSERT INTO hyperfide.finding_repair_events(organisation_id,run_id,repair_id,actor_id,event_type,payload,actor_role,credential_id) VALUES($1,$2,$3,$4,\'ATTACHED\',$5::jsonb,$6,$7)',[scope.organisation_id,scope.run_id,id,value.principal.actor_id,JSON.stringify({attempt_id:attemptId,attempt_generation:generation}),value.principal.role,value.principal.credential_id]);return {repair_id:id,attempt_id:attemptId,attempt_generation:generation,replayed:false};
}
async function submit(value:FindingTransaction,input:unknown):Promise<Record<string,unknown>>{
 const p=record(input);fields(p,['repair_id','custody_id','custody_generation','intended_source_object_id','expected_state_version']);const id=uuid(p.repair_id),custodyId=uuid(p.custody_id),generation=decimal(p.custody_generation),source=oid(p.intended_source_object_id),version=decimal(p.expected_state_version),{tx,scope}=value;
 const r=await repair(value,id),f=await finding(tx,scope,r.finding_id,true);await manager(value,String(f.owner_package_id));
 const custody=await tx.query('SELECT id FROM hyperfide.submission_custodies WHERE organisation_id=$1 AND run_id=$2 AND id=$3 AND custody_generation=$4 AND task_id=$5 AND source_attempt_id=$6 AND source_generation=$7 AND repository_id=$8 AND source_object_id=$9 AND criteria_digest=$10 AND authority=\'ACTIVE\' FOR SHARE',[scope.organisation_id,scope.run_id,custodyId,generation,r.repair_task_id,r.attempt_id,r.attempt_generation,f.repository_id,source,f.resolution_condition.criteria_digest]);
 if(!custody.rows.length)fail('SUBMISSION_INVALID','Repair submission must have active custody bound to the repair attempt and intended revision');
 if(r.custody_id===custodyId&&String(r.custody_generation)===generation&&r.intended_source_object_id===source&&r.state==='READY_FOR_RECHECK')return {repair_id:id,state:r.state,replayed:true};
 if(String(r.state_version)!==version||r.state!=='RUNNING')fail('STALE_REPAIR','Repair submission does not match the active repair state');
 await tx.query('UPDATE hyperfide.finding_repairs SET custody_id=$4,custody_generation=$5,intended_source_object_id=$6,state=\'READY_FOR_RECHECK\',updated_at=clock_timestamp(),state_version=state_version+1 WHERE organisation_id=$1 AND run_id=$2 AND id=$3',[scope.organisation_id,scope.run_id,id,custodyId,generation,source]);
 await tx.query('UPDATE hyperfide.finding_registry_records SET phase=\'READY_FOR_RECHECK\',state_version=state_version+1 WHERE organisation_id=$1 AND run_id=$2 AND finding_id=$3',[scope.organisation_id,scope.run_id,r.finding_id]);
 return {repair_id:id,state:'READY_FOR_RECHECK',replayed:false};
}
async function actualInspector(relative:string,name:string):Promise<(...args:any[])=>Promise<any>>{
 let loaded:Record<string,unknown>;try{loaded=await import(new URL(relative,import.meta.url).href) as Record<string,unknown>;}catch{fail('DEPENDENCY_NOT_READY','A required qualification inspector is not installed');}
 if(typeof loaded[name]!=='function')fail('DEPENDENCY_NOT_READY','The installed qualification module does not expose its required inspector');return loaded[name] as (...args:any[])=>Promise<any>;
}
async function qualifiedRepairProof(tx:FindingTransaction['tx'],scope:FindingScope,r:Record<string,any>,f:Record<string,any>,reproductionPlanId:unknown,historical=false):Promise<{proof:Record<string,unknown>;reproducer:unknown}>{
 await revalidateResolution(tx,scope,f);
 const stored=record(f.resolution_condition),conditionInput=Object.fromEntries(['condition_id','criteria_digest','rubric_digest','requires_original_failure','required_contract_ids'].map(key=>[key,stored[key]]));const repairCondition=await acceptedResolution(tx,scope,String(r.repair_task_id),String(f.repository_id),conditionInput);
 if(canonical(repairCondition.required_check_definitions)!==canonical(stored.required_check_definitions)||canonical(repairCondition.required_check_ids)!==canonical(stored.required_check_ids))fail('RESOLUTION_CONDITION_CHANGED','Repair registry executable definitions differ from recorded original obligations');

 const inspect=await actualInspector('../assurance/coverage.js','inspectCoverage');
 const proof=record(await inspect(tx,scope,r.custody_id));
 let admittedCurrent=proof.qualified===true,effectiveSource=String(r.intended_source_object_id),effectivePublication:Record<string,unknown>|null=null;
 if(proof.proof_source_origin==='INTEGRATED_PUBLICATION'){
  const inspectPublication=await actualInspector('../integration/publication.js','inspectIntegratedPublication');const publication=record(await inspectPublication(tx,scope,{task_id:r.repair_task_id,custody_id:r.custody_id,custody_generation:String(r.custody_generation)})),source=record(publication.current_source);
  if(publication.status!=='PUBLISHED'||publication.lineage_status!=='VERIFIED_PUBLISHED_CHAIN'||source.repository_id!==f.repository_id||proof.proof_publication_operation_id!==source.operation_id||proof.proof_source_object_id!==source.source_object_id||!source.source_manifest_digest||proof.proof_source_manifest_digest!==source.source_manifest_digest)fail('RESOLUTION_PUBLICATION_STALE','Effective repair proof must match the authoritative latest published contributor chain');effectiveSource=oid(source.source_object_id);effectivePublication=source;
  if(historical&&proof.authority==='RELEASED'&&r.resolution_proof?.coverage?.qualified===true){const current=await tx.query('SELECT 1 FROM hyperfide.tasks WHERE organisation_id=$1 AND run_id=$2 AND id=$3 AND current_custody_id=$4 AND state=\'INTEGRATED\'',[scope.organisation_id,scope.run_id,r.repair_task_id,r.custody_id]);admittedCurrent=current.rows.length===1;}
 }else if(proof.proof_source_origin!=='SUBMITTED_RESULT'||proof.authority==='RELEASED')fail('RESOLUTION_NOT_QUALIFIED','Current published repair needs explicitly requalified effective source');
 if(!admittedCurrent||proof.proof_complete!==true||proof.proof_registry_current!==true||proof.proof_registry_digest!==repairCondition.proof_registry_digest||!['ACTIVE',...(historical?['RELEASED']:[])].includes(String(proof.authority))||proof.applicability!=='CURRENT'||proof.qualification_outcome!=='PASS'||String(proof.custody_generation)!==String(r.custody_generation)||proof.source_object_id!==r.intended_source_object_id||proof.proof_source_object_id!==effectiveSource||proof.proof_criteria_digest!==repairCondition.criteria_digest||proof.criteria_digest!==f.resolution_condition.criteria_digest||proof.rubric_digest!==f.resolution_condition.rubric_digest)fail('RESOLUTION_NOT_QUALIFIED','Current input-bound qualification does not prove the recorded repair condition');
 const checks=Array.isArray(proof.passed_check_ids)?proof.passed_check_ids:[],clauses=Array.isArray(proof.clauses)?proof.clauses:[];
 if(!checks.includes(f.resolution_condition.condition_id)&&!clauses.some(item=>record(item).id===f.resolution_condition.condition_id&&record(item).satisfied===true))fail('RESOLUTION_CHECK_MISSING','Recorded resolution condition is absent from the accepted registry proof');
 if((f.resolution_condition.required_contract_ids as unknown[]).length){const check=await actualInspector('../review/contracts.js','inspectContractCoverage');const result=record(await check(tx,scope,f.resolution_condition.required_contract_ids,{repository_id:f.repository_id,source_object_id:effectiveSource}));if(result.status!=='COMPLETE')fail('AFFECTED_CONSUMER_UNQUALIFIED','Affected producer and consumer contracts require current independent proof');}
 let reproducer:unknown=null;
 if(f.resolution_condition.requires_original_failure){
  if(!reproductionPlanId)fail('ORIGINAL_REPRODUCTION_REQUIRED','The recorded condition requires original-failure and repaired-success evidence');
  const inspectReproduction=await actualInspector('../review/reproductions.js','inspectReproduction');
  reproducer=record(await inspectReproduction(tx,scope,uuid(reproductionPlanId)));
  const checked=record(reproducer),original=record(checked.original),repaired=record(checked.repaired);
  const definitions=stored.required_check_definitions as {id:string;definition_digest:string}[];
  const selected=definitions.find(item=>item.id===original.template_id&&(stored.counterfactual_check_ids as unknown[]).includes(item.id));
  const currentPlan=checked.plan_kind==='CURRENT_SOURCE';
  const bound=(x:Record<string,unknown>,sourceTask:string,sourceCriteria:string)=>x.task_id===r.repair_task_id&&x.origin_task_id===f.origin_task_id&&x.source_task_id===sourceTask&&x.criteria_digest===repairCondition.criteria_digest&&x.source_criteria_digest===sourceCriteria&&x.origin_registry_digest===stored.proof_registry_digest&&['COMPONENT','CONTRACT','SYSTEM'].includes(String(x.qualification_scope))&&x.template_id===selected?.id&&x.check_definition_digest===selected?.definition_digest;
  const hasSource=(x:Record<string,unknown>,source:string)=>Array.isArray(x.source_set)&&x.source_set.some(entry=>record(entry).repository_id===f.repository_id&&record(entry).source_object_id===source);
  const hasCheck=(x:Record<string,unknown>,status:string)=>Array.isArray(x.checks)&&x.checks.some(entry=>record(entry).id===selected?.id&&record(entry).status===status);
  let originalRegistryBound=original.registry_digest===repairCondition.proof_registry_digest;
  if(currentPlan){
   // A new current-source job cites the immutable causal job; it never changes
   // the old job's registry/source labels to impersonate current execution.
   const causal=uuid(checked.causal_plan_id);digestValue(original.registry_digest);
   originalRegistryBound=original.historical===true&&original.causal_plan_id===causal&&original.causal_job_id===original.job_id&&original.currentness==='HISTORICAL_CAUSAL_PROOF'&&typeof original.registry_current==='boolean'&&original.origin_registry_current===true;
   if(!effectivePublication||repaired.historical!==false||repaired.currentness!=='CURRENT_EXECUTION_PROOF'||repaired.source_origin!=='INTEGRATED_PUBLICATION'||repaired.publication_operation_id!==effectivePublication.operation_id||repaired.qualification_receipt_digest!==proof.receipt_digest||repaired.git_provenance_manifest_digest!==effectivePublication.git_provenance_manifest_digest||repaired.integration_input_manifest_digest!==effectivePublication.integration_input_manifest_digest)fail('REPRODUCTION_NOT_QUALIFIED','Fresh repaired execution must bind exact effective publication and qualification receipts');
  }
  if(checked.status!=='COMPLETE'||repaired.custody_id!==r.custody_id||typeof repaired.custody_generation!=='string'||repaired.custody_generation!==String(r.custody_generation)||!['PAIRED','CURRENT_SOURCE'].includes(String(checked.plan_kind))||!selected||!originalRegistryBound||!bound(original,String(f.origin_task_id),String(stored.criteria_digest))||!bound(repaired,String(r.repair_task_id),String(repairCondition.criteria_digest))||repaired.registry_digest!==repairCondition.proof_registry_digest||!hasSource(original,r.baseline_source_object_id)||!hasSource(repaired,effectiveSource)||original.outcome!=='FAIL'||repaired.outcome!=='PASS'||!hasCheck(original,'FAIL')||!hasCheck(repaired,'PASS')||effectiveSource!==r.intended_source_object_id&&!currentPlan)fail('REPRODUCTION_NOT_QUALIFIED','Exact recorded executable counterfactual with current source and policy bindings was not established');
 }

 return {proof,reproducer};
}
async function resolve(value:FindingTransaction,input:unknown):Promise<Record<string,unknown>>{
 const p=record(input);fields(p,['repair_id','expected_state_version'],['reproduction_plan_id']);const id=uuid(p.repair_id),version=decimal(p.expected_state_version),{tx,scope}=value;
 const r=await repair(value,id),f=await finding(tx,scope,r.finding_id,true);await manager(value,String(f.owner_package_id));
 if(r.state==='RESOLVED'){const current=await inspectFindingResolution(tx,scope,String(r.finding_id));return {repair_id:id,resolved:current.current,historically_resolved:true,replayed:true,current_finding_phase:f.phase};}
 if(String(r.state_version)!==version||r.state!=='READY_FOR_RECHECK'||!r.custody_id||!r.intended_source_object_id)fail('STALE_REPAIR','Resolution requires the current submitted repair candidate');
 if(r.resolution_digest!==f.resolution_digest)fail('RESOLUTION_CONDITION_CHANGED','Recorded resolution obligations changed');
 const {proof,reproducer}=await qualifiedRepairProof(tx,scope,r,f,p.reproduction_plan_id);
 const admitted=await tx.query('SELECT evidence_id FROM hyperfide.submission_evidence WHERE organisation_id=$1 AND run_id=$2 AND custody_id=$3',[scope.organisation_id,scope.run_id,r.custody_id]);const evidenceIds=admitted.rows.map(row=>String(row.evidence_id));await admittedEvidence(tx,scope,evidenceIds,String(f.repository_id),String(r.intended_source_object_id));
 await tx.query('UPDATE hyperfide.finding_repairs SET state=\'RESOLVED\',resolution_evidence_ids=$4::jsonb,resolution_proof=$5::jsonb,updated_at=clock_timestamp(),state_version=state_version+1 WHERE organisation_id=$1 AND run_id=$2 AND id=$3',[scope.organisation_id,scope.run_id,id,JSON.stringify(evidenceIds),JSON.stringify({coverage:proof,reproduction:reproducer,reproduction_plan_id:p.reproduction_plan_id??null})]);
 await tx.query('UPDATE hyperfide.finding_registry_records SET phase=\'RESOLVED\',state_version=state_version+1 WHERE organisation_id=$1 AND run_id=$2 AND finding_id=$3',[scope.organisation_id,scope.run_id,r.finding_id]);
 await tx.query('UPDATE hyperfide.findings SET state=\'RESOLVED\',state_version=state_version+1 WHERE organisation_id=$1 AND run_id=$2 AND id=$3',[scope.organisation_id,scope.run_id,r.finding_id]);
 await emit(tx,scope,String(r.finding_id),(BigInt(f.registry_version)+1n).toString(),'finding.resolved',{finding_id:r.finding_id,repair_id:id,custody_id:r.custody_id,source_object_id:r.intended_source_object_id,receipt_digest:proof.receipt_digest});return {repair_id:id,resolved:true,receipt_digest:proof.receipt_digest,replayed:false};
}
export const ESCALATION_OPTIONS=Object.freeze(['HOLD','RETRY','REASSIGN','ACCEPT_EXCEPTION']);
/** One Ask per escalated repair: its id is derived from the repair, so raising is idempotent across retries and readers. */
export function escalationAskId(scope:FindingScope,repairId:string):string{
 const h=createHash('sha256').update('repair-escalation:'+scope.organisation_id+':'+scope.run_id+':'+repairId).digest('hex');
 return h.slice(0,8)+'-'+h.slice(8,12)+'-8'+h.slice(13,16)+'-'+((parseInt(h[16]!,16)&3)|8).toString(16)+h.slice(17,20)+'-'+h.slice(20,32);
}
/**
 * The decision deadline has no code default (workflow [asks]: a decision proceeds on its recommended option and is flagged
 * when the deadline passes); the operator sets HF_FINDING_ESCALATION_ASK_SECONDS until the 3.6 per-kind policy table owns it.
 */
function escalationDeadlineSeconds(context:ComponentContext):number{
 const raw=context.env.HF_FINDING_ESCALATION_ASK_SECONDS;if(!raw||!/^[1-9][0-9]{1,6}$/.test(raw)||Number(raw)<60||Number(raw)>2592000)fail('ASK_POLICY_REQUIRED','HF_FINDING_ESCALATION_ASK_SECONDS (60 to 2592000) must be set before a repair can escalate');return Number(raw);
}
async function asksInstalled(value:FindingTransaction):Promise<void>{
 const installed=await value.tx.query("SELECT to_regclass('hyperfide.asks')::text AS installed");if(!installed.rows[0]?.installed)fail('DEPENDENCY_NOT_READY','The asks migration (0709) must be applied');
}
async function raiseEscalationAsk(value:FindingTransaction,r:Record<string,any>,reason:string):Promise<{ask_id:string;raised:boolean}>{
 await asksInstalled(value);const {tx,scope}=value,askId=escalationAskId(scope,String(r.id)),seconds=escalationDeadlineSeconds(value.context);
 const title='Repair of finding '+String(r.finding_id)+' escalated after '+String(r.attempt_count)+' of '+String(r.max_attempts)+' attempts';
 const body='The repair budget is exhausted. HOLD keeps the finding assigned with no new repair; RETRY requests another repair under a raised budget; REASSIGN routes the finding to another package; ACCEPT_EXCEPTION records an accepted exception.\nRepair: '+String(r.id)+'\nLast failure: '+reason;
 const inserted=await tx.query("INSERT INTO hyperfide.asks(organisation_id,id,run_id,kind,title,body,options,recommended,deadline,default_policy,chain,task,attempt,raised_by) VALUES($1,$2,$3,'decision',$4,$5,$6::jsonb,'HOLD',clock_timestamp()+make_interval(secs=>$7),'proceed-and-flag','[\"leader\",\"operator\"]'::jsonb,$8,$9,$10) ON CONFLICT(organisation_id,id) DO NOTHING RETURNING *",
  [scope.organisation_id,askId,scope.run_id,title.slice(0,512),body.slice(0,65536),JSON.stringify(ESCALATION_OPTIONS),seconds,r.repair_task_id,r.attempt_id??null,value.principal.credential_id]);
 if(inserted.rows.length===1){
  // Same channel and event shape as human.ask.raise (3.2): without the operator Ask channel the escalation is refused, never parked unseen.
  const ptx=tx as unknown as PrimaryTransaction,consumer=await resolveOperatorConsumer(ptx,{organisation_id:scope.organisation_id,run_id:scope.run_id,namespace:'asks'});
  if(!consumer)fail('ASK_OPERATOR_CONSUMER_REQUIRED','No operator Ask consumer (operator:asks) is registered for this run');
  const row=inserted.rows[0]!,iso=(v:unknown)=>v instanceof Date?v.toISOString():v??null;
  const view={ask_id:row.id,organisation_id:row.organisation_id,run_id:row.run_id,kind:row.kind,title:row.title,body:row.body,options:row.options,recommended:row.recommended,deadline:iso(row.deadline),default_policy:row.default_policy,chain:row.chain,task:row.task,attempt:row.attempt,session:row.session,sandbox:row.sandbox,raised_by:row.raised_by,raised_at:iso(row.raised_at),state:row.state,answered_by:row.answered_by,answer:row.answer,decided_by_default:row.decided_by_default,answered_at:iso(row.answered_at),expired_at:iso(row.expired_at),state_version:String(row.state_version)};
  await enqueue(ptx,{organisation_id:scope.organisation_id,run_id:scope.run_id,id:randomUUID(),aggregate_type:'ask',aggregate_id:askId,aggregate_version:String(row.state_version),event_type:'ask.raised',payload:{schema_version:1,ask:view,actor_id:value.principal.actor_id,actor_role:value.principal.role,target:'OPERATOR',source:{repair_id:String(r.id),finding_id:String(r.finding_id)}}},{consumer_ids:[consumer]});
 }
 return {ask_id:askId,raised:inserted.rows.length===1};
}
async function escalated(value:FindingTransaction,repairId:string):Promise<Record<string,any>>{
 const r=await repair(value,repairId);if(r.state!=='ESCALATED')fail('REPAIR_NOT_ESCALATED','Only an escalated repair is read, acknowledged or routed here');return r;
}
async function repairEvent(value:FindingTransaction,repairId:string,event:string,payload:Record<string,unknown>):Promise<void>{
 await value.tx.query('INSERT INTO hyperfide.finding_repair_events(organisation_id,run_id,repair_id,actor_id,event_type,payload,actor_role,credential_id) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)',[value.scope.organisation_id,value.scope.run_id,repairId,value.principal.actor_id,event,JSON.stringify(payload),value.principal.role,value.principal.credential_id]);
}
async function escalationList(value:FindingTransaction,input:unknown):Promise<Record<string,unknown>>{
 const p=record(input??{});fields(p,[],['limit']);await admin(value);await asksInstalled(value);const limit=readerLimit(p.limit),{tx,scope}=value;
 const rows=await tx.query("SELECT r.id AS repair_id,r.finding_id,r.repair_task_id,r.attempt_count,r.max_attempts,r.state_version::text,r.updated_at,g.phase,g.state_version::text AS registry_version,(SELECT e.payload->>'reason' FROM hyperfide.finding_repair_events e WHERE e.organisation_id=r.organisation_id AND e.run_id=r.run_id AND e.repair_id=r.id AND e.event_type='ESCALATED' ORDER BY e.created_at DESC LIMIT 1) AS reason,EXISTS(SELECT 1 FROM hyperfide.finding_repair_events e WHERE e.organisation_id=r.organisation_id AND e.run_id=r.run_id AND e.repair_id=r.id AND e.event_type='ESCALATION_ACKNOWLEDGED') AS acknowledged,(SELECT e.payload->>'route_id' FROM hyperfide.finding_repair_events e WHERE e.organisation_id=r.organisation_id AND e.run_id=r.run_id AND e.repair_id=r.id AND e.event_type='ESCALATION_ROUTED' ORDER BY e.created_at DESC LIMIT 1) AS route_id FROM hyperfide.finding_repairs r JOIN hyperfide.finding_registry_records g ON g.organisation_id=r.organisation_id AND g.run_id=r.run_id AND g.finding_id=r.finding_id WHERE r.organisation_id=$1 AND r.run_id=$2 AND r.state='ESCALATED' ORDER BY r.updated_at,r.id LIMIT $3",[scope.organisation_id,scope.run_id,limit+1]);
 const items=rows.rows.slice(0,limit).map(row=>({...row,ask_id:escalationAskId(scope,String(row.repair_id))}));
 const asks=items.length?await tx.query('SELECT id,state,answer,decided_by_default,deadline FROM hyperfide.asks WHERE organisation_id=$1 AND id=ANY($2::uuid[])',[scope.organisation_id,items.map(item=>item.ask_id)]):{rows:[]};
 const byId=new Map(asks.rows.map(row=>[String(row.id),row]));
 return {items:items.map(item=>{const a=byId.get(item.ask_id);return {...item,ask:a?{state:a.state,answer:a.answer,decided_by_default:a.decided_by_default,deadline:a.deadline}:null};}),truncated:rows.rows.length>limit};
}
/** Acknowledging records who has seen the escalation and makes sure its decision Ask exists (escalations older than the Ask are backfilled). */
async function escalationAcknowledge(value:FindingTransaction,input:unknown):Promise<Record<string,unknown>>{
 const p=record(input);fields(p,['repair_id','expected_state_version']);await admin(value);const id=uuid(p.repair_id),version=decimal(p.expected_state_version);
 const r=await escalated(value,id);if(String(r.state_version)!==version)fail('STALE_REPAIR','Repair changed since the escalation was read');
 const last=await value.tx.query("SELECT payload->>'reason' AS reason FROM hyperfide.finding_repair_events WHERE organisation_id=$1 AND run_id=$2 AND repair_id=$3 AND event_type='ESCALATED' ORDER BY created_at DESC LIMIT 1",[value.scope.organisation_id,value.scope.run_id,id]);
 const ask=await raiseEscalationAsk(value,r,String(last.rows[0]?.reason??'repair budget exhausted'));
 const prior=await value.tx.query("SELECT actor_id FROM hyperfide.finding_repair_events WHERE organisation_id=$1 AND run_id=$2 AND repair_id=$3 AND event_type='ESCALATION_ACKNOWLEDGED' LIMIT 1",[value.scope.organisation_id,value.scope.run_id,id]);
 if(prior.rows.length)return {repair_id:id,acknowledged:true,acknowledged_by:prior.rows[0]!.actor_id,ask_id:ask.ask_id,replayed:true};
 await repairEvent(value,id,'ESCALATION_ACKNOWLEDGED',{ask_id:ask.ask_id});
 return {repair_id:id,acknowledged:true,acknowledged_by:value.principal.actor_id,ask_id:ask.ask_id,replayed:false};
}
/** Routes the escalated finding to an accountable package with a rationale, through the same explicit assignment as the leader queue. */
async function escalationRoute(value:FindingTransaction,input:unknown):Promise<Record<string,unknown>>{
 const p=record(input);fields(p,['repair_id','request_id','expected_state_version','package_id','reason']);await admin(value);const id=uuid(p.repair_id);
 const r=await escalated(value,id);
 const routed=await assignFinding(value,{finding_id:String(r.finding_id),request_id:p.request_id,expected_state_version:p.expected_state_version,package_id:p.package_id,reason:p.reason});
 const routeId=String((routed.route as Record<string,unknown>).id);
 if(!routed.replayed)await repairEvent(value,id,'ESCALATION_ROUTED',{route_id:routeId,package_id:p.package_id});
 return {repair_id:id,route_id:routeId,leader_queue:(routed.route as Record<string,unknown>).leader_queue,replayed:routed.replayed};
}
export const escalatedRepairReader:FindingReader=Object.freeze({list:escalationList,acknowledge:escalationAcknowledge,route:escalationRoute});
export async function failRepair(value:FindingTransaction,input:unknown):Promise<Record<string,unknown>>{return failure(value,input);}
async function failure(value:FindingTransaction,input:unknown):Promise<Record<string,unknown>>{
 const p=record(input);fields(p,['repair_id','expected_state_version','evidence_ids','reason']);const id=uuid(p.repair_id),version=decimal(p.expected_state_version),reason=text(p.reason,'repair failure rationale'),{tx,scope}=value;
 const r=await repair(value,id),f=await finding(tx,scope,r.finding_id,true);await manager(value,String(f.owner_package_id));if(String(r.state_version)!==version||!['RUNNING','READY_FOR_RECHECK'].includes(r.state))fail('STALE_REPAIR','Repair failure does not match the current repair');
 if(!Array.isArray(p.evidence_ids)||!p.evidence_ids.length)fail('EVIDENCE_REQUIRED','A failed repair needs retained evidence');const evidenceIds=p.evidence_ids.map(uuid);await admittedEvidence(tx,scope,evidenceIds);
 const total=await tx.query('SELECT sum(attempt_count)::text AS used FROM hyperfide.finding_repairs WHERE organisation_id=$1 AND run_id=$2 AND finding_id=$3',[scope.organisation_id,scope.run_id,r.finding_id]);const escalated=BigInt(total.rows[0]!.used)>=BigInt(r.max_attempts),state=escalated?'ESCALATED':'FAILED';
 await tx.query('UPDATE hyperfide.finding_repairs SET state=$4,updated_at=clock_timestamp(),state_version=state_version+1 WHERE organisation_id=$1 AND run_id=$2 AND id=$3',[scope.organisation_id,scope.run_id,id,state]);
 await tx.query('INSERT INTO hyperfide.finding_repair_events(organisation_id,run_id,repair_id,actor_id,event_type,payload,actor_role,credential_id) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)',[scope.organisation_id,scope.run_id,id,value.principal.actor_id,state,JSON.stringify({reason,evidence_ids:evidenceIds}),value.principal.role,value.principal.credential_id]);
 await tx.query('UPDATE hyperfide.finding_registry_records SET phase=\'ASSIGNED\',state_version=state_version+1 WHERE organisation_id=$1 AND run_id=$2 AND finding_id=$3',[scope.organisation_id,scope.run_id,r.finding_id]);
 await emit(tx,scope,String(r.finding_id),(BigInt(f.registry_version)+1n).toString(),escalated?'finding.repair-escalated':'finding.repair-failed',{finding_id:r.finding_id,repair_id:id,reason});
 const ask=escalated?await raiseEscalationAsk(value,{...r,state},reason):null;
 return {repair_id:id,state,escalated,...(ask?{ask_id:ask.ask_id}:{})};
}
export async function inspectFindingResolution(tx:FindingTransaction['tx'],scope:FindingScope,findingId:string):Promise<{current:boolean;reason?:string}>{
 try{await semanticDisposition(tx,scope);const f=await finding(tx,scope,uuid(findingId));if(f.phase!=='RESOLVED'){return {current:false,reason:'FINDING_NOT_RESOLVED'};}const rows=await tx.query('SELECT * FROM hyperfide.finding_repairs WHERE organisation_id=$1 AND run_id=$2 AND finding_id=$3 AND state=\'RESOLVED\' ORDER BY updated_at DESC,id DESC LIMIT 1',[scope.organisation_id,scope.run_id,findingId]);const r=rows.rows[0];if(!r||r.resolution_digest!==f.resolution_digest){return {current:false,reason:'RESOLUTION_PROOF_MISSING'};}await qualifiedRepairProof(tx,scope,r,f,r.resolution_proof?.reproduction_plan_id,true);return {current:true};}catch(error){if(error instanceof FoundationError)return {current:false,reason:'RESOLUTION_PROOF_STALE_OR_UNAVAILABLE'};throw error;}
}
async function repairHistory(value:FindingTransaction,findingId:string):Promise<Record<string,unknown>>{
 const {tx,scope}=value,parameters=[scope.organisation_id,scope.run_id,findingId];
 const repairs=await tx.query('SELECT id AS repair_id,request_id,repair_task_id,state,max_attempts,attempt_count,attempt_id,attempt_generation::text,custody_id,custody_generation::text,intended_source_object_id,resolution_digest,resolution_evidence_ids,state_version::text,updated_at FROM hyperfide.finding_repairs WHERE organisation_id=$1 AND run_id=$2 AND finding_id=$3 ORDER BY updated_at,id',parameters);
 const events=await tx.query('SELECT e.repair_id,e.event_type,e.payload,e.actor_role FROM hyperfide.finding_repair_events e JOIN hyperfide.finding_repairs r ON r.organisation_id=e.organisation_id AND r.run_id=e.run_id AND r.id=e.repair_id WHERE r.organisation_id=$1 AND r.run_id=$2 AND r.finding_id=$3 ORDER BY e.created_at,e.id',parameters);
 const used=repairs.rows.reduce((total,row)=>total+BigInt(row.attempt_count),0n),limits=[...new Set(repairs.rows.map(row=>String(row.max_attempts)))];
 return {repairs:repairs.rows,repair_events:events.rows,attempt_budget:{used:used.toString(),max_attempts:limits.length===1?limits[0]:null,exhausted:limits.length===1&&used>=BigInt(limits[0]!)}};
}
async function externalIssue(value:FindingTransaction,findingId:string):Promise<Record<string,unknown>|null>{
 // GitHub state is descriptive projection only; it is reported, never used as assurance.
 const installed=await value.tx.query("SELECT to_regclass('hyperfide.finding_github_mappings')::text AS installed");if(!installed.rows[0]?.installed)return null;
 const rows=await value.tx.query('SELECT issue_number::text,external_state,external_updated_at FROM hyperfide.finding_github_mappings WHERE organisation_id=$1 AND run_id=$2 AND finding_id=$3',[value.scope.organisation_id,value.scope.run_id,findingId]);return rows.rows[0]??null;
}
async function inspect(value:FindingTransaction,input:unknown):Promise<Record<string,unknown>>{
 const p=record(input);fields(p,['finding_id']);const findingId=uuid(p.finding_id),{tx,scope}=value;
 const f=await finding(tx,scope,findingId);
 return {finding_id:findingId,phase:f.phase,registry_version:String(f.registry_version),resolution:await inspectFindingResolution(tx,scope,findingId),external_issue:await externalIssue(value,findingId),...await repairHistory(value,findingId)};
}
async function recheck(value:FindingTransaction,input:unknown):Promise<Record<string,unknown>>{
 const p=record(input);fields(p,['finding_id','expected_state_version']);const findingId=uuid(p.finding_id),version=decimal(p.expected_state_version),{tx,scope}=value;
 const f=await finding(tx,scope,findingId,true);await manager(value,String(f.owner_package_id));
 if(f.phase!=='RESOLVED')fail('FINDING_NOT_RESOLVED','Only a resolved finding can be rechecked against current evidence');
 if(String(f.registry_version)!==version)fail('STALE_FINDING','Finding changed since the recheck was requested');
 const current=await inspectFindingResolution(tx,scope,findingId);if(current.current)return {finding_id:findingId,current:true,reopened:false};
 // A relevant input change (or unavailable proof) withdraws restored assurance. The
 // resolved repair row and its resolution_evidence_ids remain as immutable history.
 const prior=await tx.query('SELECT id,resolution_evidence_ids FROM hyperfide.finding_repairs WHERE organisation_id=$1 AND run_id=$2 AND finding_id=$3 AND state=\'RESOLVED\' ORDER BY updated_at DESC,id DESC LIMIT 1',[scope.organisation_id,scope.run_id,findingId]);
 await tx.query('UPDATE hyperfide.finding_registry_records SET phase=\'REOPENED\',state_version=state_version+1 WHERE organisation_id=$1 AND run_id=$2 AND finding_id=$3',[scope.organisation_id,scope.run_id,findingId]);
 await tx.query('UPDATE hyperfide.findings SET state=\'OPEN\',state_version=state_version+1 WHERE organisation_id=$1 AND run_id=$2 AND id=$3',[scope.organisation_id,scope.run_id,findingId]);
 await emit(tx,scope,findingId,(BigInt(version)+1n).toString(),'finding.reopened',{finding_id:findingId,reason:current.reason??'RESOLUTION_PROOF_STALE_OR_UNAVAILABLE',prior_repair_id:prior.rows[0]?.id??null,resolution_evidence_ids:prior.rows[0]?.resolution_evidence_ids??[]});
 return {finding_id:findingId,current:false,reopened:true,reason:current.reason,prior_repair_id:prior.rows[0]?.id??null,resolution_evidence_ids:prior.rows[0]?.resolution_evidence_ids??[]};
}
export function createComponent(_context:ComponentContext):Component{return {apiVersion:1,actions:{
 'finding.repair.request':(input,context)=>withFindingTransaction(context,'finding.repair.request',value=>request(value,input)),
 'finding.repair.attach':(input,context)=>withFindingTransaction(context,'finding.repair.attach',value=>attach(value,input)),
 'finding.repair.submit':(input,context)=>withFindingTransaction(context,'finding.repair.submit',value=>submit(value,input)),
 'finding.repair.resolve':(input,context)=>withFindingTransaction(context,'finding.repair.resolve',value=>resolve(value,input)),
 'finding.repair.fail':(input,context)=>withFindingTransaction(context,'finding.repair.fail',value=>failure(value,input)),
 'finding.repair.inspect':(input,context)=>withFindingTransaction(context,'finding.repair.inspect',value=>inspect(value,input)),
 'finding.repair.recheck':(input,context)=>withFindingTransaction(context,'finding.repair.recheck',value=>recheck(value,input))
}};}
