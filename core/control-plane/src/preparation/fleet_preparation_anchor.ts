import type {PrimaryTransaction} from '../storage/transactions.js';
import {assertPrimaryTransaction} from '../storage/transactions.js';
import type {InvocationContext} from '../transport/protocol.js';
import {assertInvocation,fail,uuid} from '../transport/protocol.js';
import {loadPreparationIntents} from '../hierarchy/packets.js';
export async function resolveFleetPreparationAccountingTask(tx:PrimaryTransaction,i:InvocationContext,input:{package_id:string;task_ids:unknown;preparation_task_id?:unknown}):Promise<{task_id:string;selection_source:string}>{
 assertPrimaryTransaction(tx);assertInvocation(i);await i.guard(tx);const scope=[i.principal.organisation_id,i.principal.run_id];
 const ids=input.task_ids;if(!Array.isArray(ids)||!ids.length||ids.some(id=>!uuid(id))||new Set(ids).size!==ids.length)fail('BOOTSTRAP_INSTALL_OWNER','Explicit delegated task budget required');
 const tasks=(await tx.query('SELECT id FROM hyperfide.tasks WHERE organisation_id=$1 AND run_id=$2 AND feature_package_id=$3 AND id=ANY($4::uuid[]) ORDER BY id FOR SHARE',[...scope,input.package_id,ids])).rows;if(tasks.length!==ids.length)fail('BOOTSTRAP_INSTALL_OWNER','Current delegated accepted tasks differ');
 const explicit=input.preparation_task_id;let task_id:string,selection_source:string;
 if(explicit!==undefined){if(!uuid(explicit)||!ids.includes(explicit))fail('BOOTSTRAP_INSTALL_TASK_SCOPE','Preparation accounting anchor is outside the current delegated task budget');task_id=explicit;selection_source='EXPLICIT_PREPARATION_TASK';}
 else{if(tasks.length!==1)fail('BOOTSTRAP_INSTALL_TASK_SELECTION_REQUIRED','Multiple delegated tasks require an explicit model-selected preparation_task_id');task_id=String(tasks[0]!.id);selection_source='SOLE_CURRENT_DELEGATED_TASK';}
 const accepted=(await loadPreparationIntents(tx,{organisation_id:String(scope[0]),run_id:String(scope[1]),task_ids:[task_id]}))[0];if(!accepted||accepted.error_code)fail('BOOTSTRAP_INSTALL_TASK_UNACCEPTED','Preparation accounting anchor requires current accepted task authority');
 return {task_id,selection_source};
}
