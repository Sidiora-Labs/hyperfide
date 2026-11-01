import type {PrimaryTransaction} from '../storage/transactions.js';
import {assertPrimaryTransaction} from '../storage/transactions.js';
import {fail} from '../transport/protocol.js';
export interface FleetSandboxOccupancy{occupied:number;samples:Array<{sandbox_id:string;pool_id:string;observed_state:string}>;samples_omitted:boolean}
/** Logical delegation slots and physical reservation debt have independent lifetimes. */
export async function readFleetSandboxOccupancy(tx:PrimaryTransaction,scope:{organisation_id:string;run_id:string},packages:readonly string[]):Promise<Map<string,FleetSandboxOccupancy>>{
 assertPrimaryTransaction(tx);
 const result=new Map<string,FleetSandboxOccupancy>(packages.map(id=>[id,{occupied:0,samples:[],samples_omitted:false}]));if(!packages.length)return result;
 const rows=(await tx.query(`WITH owned AS (
 SELECT DISTINCT e.result->>'delegation_id' AS delegation_id,s.id,s.pool_id,s.observed_state
 FROM hyperfide.sandboxes s JOIN hyperfide.fleet_effect_receipts e ON e.organisation_id=s.organisation_id AND e.result->>'sandbox_id'=s.id::text
 WHERE e.organisation_id=$1 AND e.run_id=$2 AND e.result->>'delegation_id'=ANY($3::text[]) AND s.observed_state<>'DESTROYED'
 ),ranked AS(SELECT *,count(*) OVER(PARTITION BY delegation_id) AS occupied,row_number() OVER(PARTITION BY delegation_id ORDER BY id) AS position FROM owned)
 SELECT delegation_id,occupied,id::text AS sandbox_id,pool_id::text,observed_state FROM ranked WHERE position<=8 ORDER BY delegation_id,position`,[scope.organisation_id,scope.run_id,[...packages]])).rows;
 for(const row of rows){const entry=result.get(row.delegation_id),count=Number(row.occupied);if(!entry||!Number.isSafeInteger(count)||count<1)fail('FLEET_SANDBOX_BUDGET','Invalid authoritative delegation occupancy');entry.occupied=count;entry.samples.push({sandbox_id:row.sandbox_id,pool_id:row.pool_id,observed_state:row.observed_state});entry.samples_omitted=count>entry.samples.length;}
 return result;
}
