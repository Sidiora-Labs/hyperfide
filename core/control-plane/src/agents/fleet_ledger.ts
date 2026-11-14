import type {PrimaryTransaction} from '../storage/transactions.js';
import type {InvocationContext} from '../transport/protocol.js';
import {assertPrimaryTransaction} from '../storage/transactions.js';
import {assertInvocation} from '../transport/protocol.js';
import {hash} from '../hierarchy/packages.js';

/**
 * The dispatch UI consumes this bounded, read-only projection. It is built
 * from the durable decision/effect tables on the primary transaction, never
 * from a local dispatcher journal. Unknown effects remain visible so an
 * operator can reconcile the original operation.
 */
export async function readFleetLedgerProjection(tx:PrimaryTransaction,i:InvocationContext):Promise<Record<string,unknown>> {
 assertPrimaryTransaction(tx); assertInvocation(i); await i.guard(tx);
 const scope=[i.principal.organisation_id,i.principal.run_id];
 const run=(await tx.query('SELECT authority_epoch::text, state, state_version::text FROM hyperfide.runs WHERE organisation_id=$1 AND id=$2 FOR SHARE',scope)).rows[0];
 if(!run) throw new Error('FLEET_LEDGER_SCOPE_INVALID');
 const leader=(await tx.query('SELECT generation::text FROM hyperfide.hierarchy_leaders WHERE organisation_id=$1 AND run_id=$2 FOR SHARE',scope)).rows[0];
 const actor=(await tx.query('SELECT delegation_id::text,manager_generation::text FROM hyperfide.fleet_actor_sessions WHERE organisation_id=$1 AND run_id=$2 AND session_id=$3 FOR SHARE',[...scope,i.principal.actor_id])).rows[0];
 const rows=(await tx.query(`SELECT d.id::text AS decision_id,d.operation_id::text,d.actor_id::text,
   d.body->>'actor_role' AS actor_role,d.action,
   COALESCE(d.body->>'authority_epoch',r.result->>'authority_epoch') AS authority_epoch,
   COALESCE(d.body->>'leader_generation',r.result->>'leader_generation') AS leader_generation,
   COALESCE(d.body->>'delegation_id',r.result->>'delegation_id') AS delegation_id,
   COALESCE(d.body->>'manager_generation',r.result->>'manager_generation') AS manager_generation,
   COALESCE(r.result->>'state',r.result->>'status',r.result->>'outcome',CASE WHEN r.operation_id IS NULL THEN NULL ELSE 'RECORDED' END) AS receipt_state, r.result AS receipt_result,
   COALESCE(r.created_at,d.created_at)::text AS created_at
   FROM hyperfide.fleet_decisions d
   LEFT JOIN hyperfide.fleet_effect_receipts r ON r.organisation_id=d.organisation_id AND r.run_id=d.run_id AND r.decision_id=d.id
   WHERE d.organisation_id=$1 AND d.run_id=$2
   ORDER BY COALESCE(r.created_at,d.created_at) DESC,d.id DESC LIMIT 501`,scope)).rows;
 const history=rows.slice(0,500).map(row=>({
  decisionId:String(row.decision_id),operationId:String(row.operation_id),actorId:String(row.actor_id),
  actorRole:row.actor_role===null?'UNKNOWN':String(row.actor_role),action:String(row.action),
  authorityEpoch:row.authority_epoch===null?null:String(row.authority_epoch),leaderGeneration:row.leader_generation===null?null:String(row.leader_generation),
  delegationId:row.delegation_id===null?null:String(row.delegation_id),managerGeneration:row.manager_generation===null?null:String(row.manager_generation),
  receiptState:row.receipt_state===null?null:String(row.receipt_state),receiptDigest:row.receipt_result===null?null:hash(row.receipt_result),createdAt:new Date(String(row.created_at)).toISOString(),
 }));
 return {schemaVersion:1,authority:{mode:'manager',state:String(run.state),actorRole:i.principal.role==='LEADER'?'PRIMARY':i.principal.role==='FEATURE_MANAGER'?'FEATURE_MANAGER':'UNKNOWN',capabilities:['read','manager-decision'],authorityEpoch:String(run.authority_epoch),leaderGeneration:leader?.generation===null||leader?.generation===undefined?null:String(leader.generation),delegationId:actor?.delegation_id===null||actor?.delegation_id===undefined?null:String(actor.delegation_id),managerGeneration:actor?.manager_generation===null||actor?.manager_generation===undefined?null:String(actor.manager_generation),asOf:new Date().toISOString()},history,projection:{source:'hyperfide.fleet_decisions+fleet_effect_receipts',route:'PRIMARY',truncated:rows.length>500,stateVersion:String(run.state_version)}};
}
