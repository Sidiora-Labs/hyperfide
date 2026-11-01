import type {PrimaryTransaction} from '../storage/transactions.js';
import {assertPrimaryTransaction} from '../storage/transactions.js';
import {fail} from '../transport/protocol.js';
export async function readBootstrapInstallAllocationEpoch(tx:PrimaryTransaction,input:{organisation_id:string;run_id:string;operation_id:string}):Promise<{logical_operation_id:string;allocation_epoch_operation_id:string|null}>{
 assertPrimaryTransaction(tx);
 const lineage=(await tx.query(`WITH RECURSIVE chain(operation_id,depth,path) AS (
 SELECT $3::uuid,0,ARRAY[$3::uuid] UNION ALL
 SELECT edge.predecessor,c.depth+1,c.path||edge.predecessor FROM chain c
 JOIN LATERAL(SELECT predecessor_install_operation_id AS predecessor FROM hyperfide.fleet_install_not_started_recoveries WHERE organisation_id=$1 AND run_id=$2 AND operation_id=c.operation_id UNION ALL SELECT predecessor_install_operation_id FROM hyperfide.fleet_install_recoveries WHERE organisation_id=$1 AND run_id=$2 AND operation_id=c.operation_id) edge ON true
 WHERE c.depth<64 AND NOT edge.predecessor=ANY(c.path))
 SELECT c.operation_id,c.depth,c.path,n.operation_id AS allocation_epoch,(SELECT count(*) FROM (SELECT predecessor_install_operation_id FROM hyperfide.fleet_install_not_started_recoveries WHERE organisation_id=$1 AND run_id=$2 AND operation_id=c.operation_id UNION ALL SELECT predecessor_install_operation_id FROM hyperfide.fleet_install_recoveries WHERE organisation_id=$1 AND run_id=$2 AND operation_id=c.operation_id) edges) AS edge_count FROM chain c LEFT JOIN hyperfide.fleet_install_not_started_recoveries n ON n.organisation_id=$1 AND n.run_id=$2 AND n.operation_id=c.operation_id ORDER BY c.depth`,[input.organisation_id,input.run_id,input.operation_id])).rows;
 if(lineage.some(row=>Number(row.depth)===64))fail('BOOTSTRAP_INSTALL_RECONCILE','Bounded recovery lineage must be reconciled');
 const head=(await tx.query('SELECT logical_operation_id FROM hyperfide.fleet_install_heads WHERE organisation_id=$1 AND run_id=$2 AND current_operation_id=$3',[input.organisation_id,input.run_id,input.operation_id])).rows[0];
 if(!head)fail('BOOTSTRAP_INSTALL_RECONCILE','Current install head required for recovery lineage');
 if(!lineage.length||lineage.some((row,index)=>Number(row.depth)!==index||Number(row.edge_count)!==(index===lineage.length-1?0:1))||lineage.at(-1)!.operation_id!==head.logical_operation_id)fail('BOOTSTRAP_INSTALL_RECONCILE','Recovery lineage must be a complete unbranched acyclic chain ending at its logical root');
 return {logical_operation_id:String(head.logical_operation_id),allocation_epoch_operation_id:lineage.find(row=>row.allocation_epoch)?.allocation_epoch??null};
}
