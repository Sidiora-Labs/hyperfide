import {randomUUID} from 'node:crypto';
import type {PrimaryTransaction} from '../storage/transactions.js';
import {assertPrimaryTransaction} from '../storage/transactions.js';
import type {InvocationContext} from '../transport/protocol.js';
import {assertInvocation,DIGEST} from '../transport/protocol.js';
import {canonical,decimal,hash,uuid} from '../hierarchy/packages.js';
import {exactAgentObject} from './sessions.js';
import {fleetError,validateFleetBudget} from './fleet_authority.js';
import type {FleetDecision} from './fleet_authority.js';

/** Additive delegation revisions preserve execution ownership and fence previously observed manager decisions. */
export async function replanFleetDelegationBudget(tx:PrimaryTransaction,i:InvocationContext,d:FleetDecision):Promise<Record<string,unknown>>{
 assertPrimaryTransaction(tx);assertInvocation(i);await i.guard(tx);
 if(d.actor_role!=='PRIMARY'||i.principal.role!=='LEADER'||d.actor_id!==i.principal.actor_id)fleetError('FLEET_PRIMARY_REQUIRED');
 const input=exactAgentObject(d.input,['proposal']),proposal=exactAgentObject(input.proposal,['kind','package_id','manager_session_id','expected_manager_generation','expected_budget_digest','budget','reason']);
 if(proposal.kind!=='UPDATE_DELEGATION_BUDGET'||typeof proposal.expected_budget_digest!=='string'||!DIGEST.test(proposal.expected_budget_digest)||typeof proposal.reason!=='string'||!proposal.reason.trim()||proposal.reason.length>4096)fleetError('FLEET_BUDGET_REPLAN_INPUT');
 const packageId=uuid(proposal.package_id),manager=uuid(proposal.manager_session_id),generation=decimal(proposal.expected_manager_generation),budget=validateFleetBudget(proposal.budget),scope=[i.principal.organisation_id,i.principal.run_id];
 // Manager effects take their plan row before the shared budget lock; use the same order.
 const managerPlan=(await tx.query("SELECT s.plan_generation::text,s.delegation_id,s.manager_generation::text,s.actor_role,a.parent_session_id,a.state FROM hyperfide.fleet_actor_sessions s JOIN hyperfide.agent_sessions a ON a.organisation_id=s.organisation_id AND a.run_id=s.run_id AND a.id=s.session_id WHERE s.organisation_id=$1 AND s.run_id=$2 AND s.session_id=$3 FOR UPDATE OF s",[...scope,manager])).rows[0];
 if(!managerPlan||managerPlan.actor_role!=='WAVE_MANAGER'||managerPlan.delegation_id!==packageId||managerPlan.manager_generation!==generation||managerPlan.parent_session_id!==d.actor_id||!['REGISTERED','RUNNING','DISCONNECTED'].includes(managerPlan.state))fleetError('FLEET_BUDGET_MANAGER_STALE');
 await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['fleet-budget:'+scope[0]+':'+scope[1]+':'+packageId]);
 const previous=(await tx.query(`SELECT d.*,h.owner_generation::text,h.state AS package_state,h.allocation_policy,p.manager_session_id AS current_manager FROM hyperfide.fleet_delegations d JOIN hyperfide.hierarchy_packages h ON h.organisation_id=d.organisation_id AND h.run_id=d.run_id AND h.package_id=d.package_id JOIN hyperfide.feature_packages p ON p.organisation_id=h.organisation_id AND p.run_id=h.run_id AND p.id=h.package_id WHERE d.organisation_id=$1 AND d.run_id=$2 AND d.package_id=$3 FOR UPDATE OF d FOR SHARE OF h,p`,[...scope,packageId])).rows[0];
 if(!previous||previous.manager_session_id!==manager||previous.current_manager!==manager||String(previous.manager_generation)!==generation||previous.owner_generation!==generation||String(previous.leader_generation)!==d.leader_generation||previous.allocation_policy!=='WAVE'||!['ASSIGNED','ACTIVE','BLOCKED'].includes(previous.package_state)||hash(previous.budget)!==proposal.expected_budget_digest)fleetError('FLEET_BUDGET_REPLAN_STALE');
 const old=validateFleetBudget(previous.budget);
 for(const key of ['allowed_actions','provider_ids','task_ids'])if(canonical([...(old[key] as string[])].sort())!==canonical([...(budget[key] as string[])].sort()))fleetError('FLEET_BUDGET_ADDITIVE_ONLY');
 for(const key of ['max_sandboxes','max_concurrent_workers'])if(Number(budget[key])<Number(old[key]))fleetError('FLEET_BUDGET_ADDITIVE_ONLY');
 const oldProfiles=old.profile_ids as string[],newProfiles=budget.profile_ids as string[];for(const id of newProfiles)uuid(id);
 if(oldProfiles.some(id=>!newProfiles.includes(id)))fleetError('FLEET_BUDGET_ADDITIVE_ONLY');
 const added=newProfiles.filter(id=>!oldProfiles.includes(id));
 const limitIncreases=Object.fromEntries(['max_sandboxes','max_concurrent_workers'].filter(key=>Number(budget[key])>Number(old[key])).map(key=>[key,{previous:old[key],next:budget[key]}]));
 if(!added.length&&!Object.keys(limitIncreases).length)fleetError('FLEET_BUDGET_NO_CHANGE');
 const accepted=(await tx.query(`SELECT t.id FROM hyperfide.tasks t JOIN hyperfide.runs r ON r.organisation_id=t.organisation_id AND r.id=t.run_id WHERE t.organisation_id=$1 AND t.run_id=$2 AND t.feature_package_id=$3 AND t.id=ANY($4::uuid[]) AND t.spec_revision_id=r.spec_revision_id AND t.spec_generation=r.spec_generation AND NOT(t.definition ? 'retirement') FOR SHARE OF t,r`,[...scope,packageId,budget.task_ids])).rows;
 if(accepted.length!==(budget.task_ids as string[]).length)fleetError('FLEET_BUDGET_TASK_SCOPE');
 for(const profile of added){
  const approved=(await tx.query(`SELECT p.id,p.provider,e.content_digest,pc.document FROM hyperfide.environment_profiles e JOIN hyperfide.provider_pools p ON p.organisation_id=e.organisation_id AND p.profile_id=e.id JOIN hyperfide.provider_pool_configurations pc ON pc.organisation_id=p.organisation_id AND pc.pool_id=p.id AND pc.active WHERE e.organisation_id=$1 AND e.id=$2 AND p.state='ACTIVE' AND e.provider=p.provider AND pc.document->'pool'->>'profile_id'=e.id::text AND pc.document->'pool'->>'preparation_digest'=e.content_digest AND (e.manifest->'profile'->'policy'->>'expires_at')::timestamptz>clock_timestamp() AND jsonb_typeof(e.manifest->'profile'->'repositories')='array' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(e.manifest->'profile'->'repositories') repo WHERE NOT EXISTS(SELECT 1 FROM hyperfide.run_repositories r JOIN hyperfide.repositories source ON source.organisation_id=r.organisation_id AND source.id=r.repository_id WHERE r.organisation_id=e.organisation_id AND r.run_id=$3 AND source.url=repo->>'url' AND r.source_object_id=repo->>'commit')) FOR SHARE OF e,p,pc`,[scope[0],profile,scope[1]])).rows;
  if(!approved.length||!approved.some(row=>(budget.provider_ids as string[]).includes(row.provider)&&BigInt(String(row.document?.pool?.approved_limits?.SANDBOX??'0'))>0n&&BigInt(String(row.document?.account?.approved_limits?.SANDBOX??'0'))>0n))fleetError('FLEET_BUDGET_PROFILE_UNAPPROVED');
 }
 // Additions cannot supersede old effects: their ownership, claims and accounting remain unchanged.
 const nextPlan=(BigInt(managerPlan.plan_generation)+1n).toString(),oldDigest=hash(old),newDigest=hash(budget);
 await tx.query('UPDATE hyperfide.fleet_delegations SET budget=$4,decision_id=$5 WHERE organisation_id=$1 AND run_id=$2 AND package_id=$3',[...scope,packageId,budget,d.decision_id]);
 await tx.query('UPDATE hyperfide.fleet_actor_sessions SET plan_generation=$4,updated_at=clock_timestamp() WHERE organisation_id=$1 AND run_id=$2 AND session_id=$3',[...scope,manager,nextPlan]);
 const audit={package_id:packageId,manager_session_id:manager,manager_generation:generation,leader_generation:d.leader_generation,previous_manager_plan_generation:managerPlan.plan_generation,manager_plan_generation:nextPlan,old_budget:old,new_budget:budget,old_budget_digest:oldDigest,new_budget_digest:newDigest,added_profile_ids:added,limit_increases:limitIncreases,decision_id:d.decision_id,reason:proposal.reason};
 await tx.query("INSERT INTO hyperfide.hierarchy_ownership_events(organisation_id,run_id,id,kind,actor_session_id,leader_generation,payload) VALUES($1,$2,$3,'DELEGATION_BUDGET_REPLANNED',$4,$5,$6)",[...scope,randomUUID(),d.actor_id,d.leader_generation,audit]);
 return {kind:'REPLAN',proposal_kind:'UPDATE_DELEGATION_BUDGET',...audit,ownership_changed:false,task_definitions_changed:false,new_work_dispatched:false,existing_execution_unchanged:true,capacity_admission_unchanged:true};
}
