import type {PrimaryTransaction} from '../storage/transactions.js';
import {assertPrimaryTransaction} from '../storage/transactions.js';
import {fail} from '../transport/protocol.js';
import {object} from '../policy/programme.js';

export async function readFleetManagerHandoff(tx:PrimaryTransaction,scope:{organisation_id:string;run_id:string},handoffId:string){
 assertPrimaryTransaction(tx);
 const row=(await tx.query(`SELECT h.*,a.successor_id AS acknowledged_by,r.resolution,d.actor_id AS primary_id,
 p.manager_session_id AS current_manager,g.owner_generation::text,g.state AS package_state
 FROM hyperfide.hierarchy_handoffs h
 JOIN hyperfide.fleet_effect_receipts e ON e.organisation_id=h.organisation_id AND e.run_id=h.run_id AND e.result->>'handoff_id'=h.id::text
 JOIN hyperfide.fleet_decisions d ON d.organisation_id=e.organisation_id AND d.run_id=e.run_id AND d.id=e.decision_id AND d.action='REPLACE_MANAGER'
 JOIN hyperfide.feature_packages p ON p.organisation_id=h.organisation_id AND p.run_id=h.run_id AND p.id=(h.package_snapshot->0->>'package_id')::uuid
 JOIN hyperfide.hierarchy_packages g ON g.organisation_id=p.organisation_id AND g.run_id=p.run_id AND g.package_id=p.id
 LEFT JOIN hyperfide.hierarchy_handoff_acknowledgements a ON a.organisation_id=h.organisation_id AND a.run_id=h.run_id AND a.handoff_id=h.id
 LEFT JOIN hyperfide.hierarchy_handoff_resolutions r ON r.organisation_id=h.organisation_id AND r.run_id=h.run_id AND r.handoff_id=h.id
 WHERE h.organisation_id=$1 AND h.run_id=$2 AND h.id=$3 FOR SHARE OF h,p,g`,[scope.organisation_id,scope.run_id,handoffId])).rows[0];
 if(!row||row.resolution||!Array.isArray(row.package_snapshot)||row.package_snapshot.length!==1||!object(row.package_snapshot[0]))fail('FLEET_HANDOFF_STALE','Exact admitted single-package replacement required');
 const occupied=await tx.query("SELECT p.id FROM hyperfide.feature_packages p JOIN hyperfide.hierarchy_packages h ON h.organisation_id=p.organisation_id AND h.run_id=p.run_id AND h.package_id=p.id WHERE p.organisation_id=$1 AND p.run_id=$2 AND p.manager_session_id=$3 AND p.id<>(($4::jsonb)->0->>'package_id')::uuid AND h.state NOT IN ('CLOSED','CANCELLED') ORDER BY p.id FOR SHARE OF p,h",[scope.organisation_id,scope.run_id,row.successor_id,JSON.stringify(row.package_snapshot)]);
 if(occupied.rowCount)fail('FLEET_MANAGER_ALREADY_ASSIGNED','Replacement successor already owns another nonterminal package');
 const snapshot=row.package_snapshot[0],packageId=String(snapshot.package_id),prior=String(snapshot.owner_generation),future=(BigInt(prior)+1n).toString();
 const acknowledged=row.acknowledged_by===row.successor_id;
 if(acknowledged?row.current_manager!==row.successor_id||row.owner_generation!==future:row.current_manager!==row.predecessor_id||row.owner_generation!==prior||row.package_state!=='HANDOFF_PENDING')fail('FLEET_HANDOFF_STALE','Replacement ownership changed');
 return {handoff_id:handoffId,package_id:packageId,predecessor_id:String(row.predecessor_id),successor_id:String(row.successor_id),manager_generation:future,leader_generation:String(row.leader_generation),authority_epoch:String(row.authority_epoch),primary_id:String(row.primary_id),acknowledged};
}
