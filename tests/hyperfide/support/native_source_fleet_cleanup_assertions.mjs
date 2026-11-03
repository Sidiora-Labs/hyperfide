import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export async function assertNativeFleetCleanup({f,resources,controlRoot,scope,assignment,sourceAssignment,submission,invocation,expectedBytes}){
 const [{readNativeFleetCleanup},{nextFleetCompletion},{projectFleetCompletionCommands},{FoundationError}]=await Promise.all([
  import(pathToFileURL(path.join(controlRoot,'source_control/fleet-cleanup.js'))),
  import(pathToFileURL(path.join(controlRoot,'runner/fleet_completion.js'))),
  import(pathToFileURL(path.join(controlRoot,'preparation/fleet_completion.js'))),
  import(pathToFileURL(path.join(controlRoot,'policy/programme.js'))),
 ]);
 const assigned=assignment.tasks.find(task=>task.attempt_id===sourceAssignment.attempt_id);
 assert(assigned,'Actual assigned attempt must exist');
 const attempt=(await f.pool.query(`SELECT sandbox_id,slot_id,sandbox_boot_generation::text,authority_epoch
  FROM hyperfide.attempts WHERE organisation_id=$1 AND run_id=$2 AND id=$3 AND generation=$4`,
  [scope.organisation_id,scope.run_id,sourceAssignment.attempt_id,sourceAssignment.attempt_generation])).rows[0];
 assert(attempt,'Actual source assignment must retain its compute attempt');
 const binding={...scope,attempt_id:sourceAssignment.attempt_id,attempt_generation:sourceAssignment.attempt_generation,
  sandbox_id:attempt.sandbox_id,slot_id:attempt.slot_id,boot_generation:attempt.sandbox_boot_generation,authority_epoch:attempt.authority_epoch};
 const transaction=body=>resources.gateway.withPrimaryTransaction({timeoutMs:15000,maxRetries:2},body);
 const read=next=>transaction(tx=>readNativeFleetCleanup(tx,next));
 const state=await read(binding);
 assert.equal(state.native,true);
 assert.deepEqual(state.custody,{custody_id:submission.custody_id,workspace_id:sourceAssignment.workspace_id,
  revision_id:submission.revision_id,root_tree_id:submission.root_tree_id,result_digest:submission.result_digest});
 for(const changed of [{slot_id:randomUUID()},{sandbox_id:randomUUID()},{boot_generation:String(BigInt(binding.boot_generation)+1n)},{authority_epoch:randomUUID()}])
  await assert.rejects(()=>read({...binding,...changed}),error=>error.code==='NATIVE_CLEANUP_BINDING');
 const rollback=new FoundationError('NATIVE_CLEANUP_TEST_ROLLBACK','Native cleanup retention negative control rollback');
 await assert.rejects(()=>transaction(async tx=>{
  const removed=await tx.query(`DELETE FROM hyperfide.source_object_pins
   WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND owner_kind='REVISION'
   AND owner_id=$4 AND object_id=$5 RETURNING object_id`,[f.scope.organisation_id,f.scope.repository_id,f.scope.security_domain_id,
   'native-custody:'+submission.custody_id+':'+submission.custody_generation,submission.root_tree_id]);
  assert.equal(removed.rowCount,1);
  const unavailable=await readNativeFleetCleanup(tx,binding);
  assert.deepEqual(unavailable,{native:true,custody:null});
  throw rollback;
 }),error=>error.code===rollback.code);
 assert.deepEqual(await read(binding),state);
 const counts=(await f.pool.query(`SELECT count(*)::int AS count FROM hyperfide.fleet_worker_launches f
  JOIN hyperfide.native_launch_plans n USING(organisation_id,run_id,launch_id)
  WHERE n.organisation_id=$1 AND n.run_id=$2 AND n.attempt_id=$3`,[scope.organisation_id,scope.run_id,binding.attempt_id])).rows[0];
 assert.equal(counts.count,0,'This fixture has no signed native launch and cannot claim native control release');
 await transaction(async tx=>{
  const completion=await nextFleetCompletion(tx,invocation.principal);
  assert.notEqual(completion?.binding.attempt_id,binding.attempt_id);
  const projected=await projectFleetCompletionCommands(tx,invocation,{after:null,limit:100});
  assert.equal(projected.commands.some(command=>command.input.attempt_id===binding.attempt_id),false);
 });
 const entry=await f.service.trees.lookup(f.scope,submission.root_tree_id,'main.txt');
 assert(entry,'Retained native submission must still resolve after worker directory cleanup');
 const bytes=await f.service.objects.readFile(f.scope,entry.object_id);
 if(expectedBytes!==undefined)assert.deepEqual(bytes,Buffer.from(expectedBytes));
 return [
  'native cleanup resolves exact submitted custody and permanent root retention after local worker deletion',
  'native cleanup rejects changed slot, sandbox, boot and authority and refuses missing retention pins',
  'source custody without an actual signed native launch produces no native release or legacy archive command',
 ];
}
