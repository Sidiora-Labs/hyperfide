import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export async function assertNativeFleetSelection({f,ids,sourceCall,accepted,baseline,taskId,resources,controlRoot,activeAttemptId}) {
  const load=name=>import(pathToFileURL(path.join(controlRoot,name+'.js')));
  const [{readNativeFleetRunSource,readAdmittedNativeFleetSource},{assertNativeTaskQualified},{validateExecutionInputs}]=await Promise.all([
    load('source_control/fleet-run-source'),load('assurance/fleet_native'),load('hierarchy/packets'),
  ]);
  const operation=randomUUID(),input={selection_id:randomUUID(),run_id:ids.run,acceptance_id:accepted.acceptance_id,expected_generation:'0',leader_generation:'1'};
  const selected=await sourceCall('leader','source.fleet.select',input,operation);
  assert.equal(selected.previous_revision_id,baseline.revision_id);
  assert.equal(selected.revision_id,accepted.revision_id);
  assert.equal(selected.generation,'1');
  assert.deepEqual(await sourceCall('leader','source.fleet.select',input,operation),selected);
  assert.deepEqual(await sourceCall('leader','source.fleet.selection',{run_id:ids.run,selection_id:input.selection_id}),selected);
  await assert.rejects(()=>sourceCall('leader','source.fleet.select',{...input,selection_id:randomUUID()}),error=>error.code==='FLEET_SOURCE_CHANGED');
  const rebound=await sourceCall('leader','source.fleet.bind-run',{run_id:ids.run,revision_id:baseline.revision_id,leader_generation:'1'});
  assert.equal(rebound.revision_id,baseline.revision_id);
  const scope={organisation_id:ids.organisation,run_id:ids.run};
  await resources.gateway.withPrimaryTransaction({timeoutMs:15000},async tx=>{
    const current=await readNativeFleetRunSource(tx,scope,ids.repository);
    const historical=await readAdmittedNativeFleetSource(tx,scope,ids.repository,baseline.revision_id);
    assert.equal(current.revision_id,accepted.revision_id);
    assert.equal(current.selection_id,input.selection_id);
    assert.equal(historical.revision_id,baseline.revision_id);
    const qualified=await assertNativeTaskQualified(tx,scope,taskId,ids.repository);
    assert.equal(qualified.revision_id,accepted.revision_id);
    if(activeAttemptId){
      const attempt=(await tx.query('SELECT input_packet_digest FROM hyperfide.attempts WHERE organisation_id=$1 AND run_id=$2 AND id=$3',[ids.organisation,ids.run,activeAttemptId])).rows[0];
      assert(attempt,'An existing admitted attempt is required');
      await validateExecutionInputs(tx,{...scope,digest:attempt.input_packet_digest});
    }
  });
  const count=(await f.pool.query('SELECT count(*)::int AS n FROM hyperfide.source_fleet_selections WHERE organisation_id=$1 AND run_id=$2',[ids.organisation,ids.run])).rows[0].n;
  assert.equal(count,1);
  return selected;
}
