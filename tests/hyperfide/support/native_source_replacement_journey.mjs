import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {installNativeFleetFixture} from './native_source_fleet_install.mjs';
import {runLocalFleetWorker} from './native_source_fleet_cleanup.mjs';
export async function runReplacementJourney({f,root,controlRoot,ids,baseline,worker,checkpoint,options,sourceCall,task,registerStage,executable}){
 const installed=await installNativeFleetFixture(f,{root:path.join(root,'replacement'),controlRoot,revision:baseline,fleet:ids});registerStage(installed.stage);
 for(let directory=installed.first;directory.startsWith(root);directory=path.dirname(directory))await fs.chmod(directory,0o755);
 await fs.chown(installed.first,62542,62542);await fs.chmod(installed.first,0o700);await fs.chown(path.join(installed.first,'main.txt'),62542,62542);await fs.chmod(path.join(installed.first,'main.txt'),0o600);
 const execution=await runLocalFleetWorker({root:installed.first,text:'candidate: replacement durable output\n',uid:62542,gid:62542,executable});
 const saved=await checkpoint(worker,execution.bytes);
 const submission=await worker.client.submitFleetSource({assignment_id:worker.bound.assignment_id,expected_assignment_generation:'1',expected_workspace_generation:worker.workspace.workspace_generation,revision_id:saved.revision_id},{...options(worker),idempotency_key:randomUUID()});
 assert(Array.isArray(submission.dependencies)&&submission.dependencies.length>0,'Dependent submission must expose its exact typed source dependencies');
 const policy=await f.registerPolicy({policy_id:randomUUID(),policy_digest:task.registry.registry_digest,checks:[f.check]});
 const domain=await f.createDomain(baseline,policy);
 const candidateInput={candidate_id:randomUUID(),domain_id:domain.domain_id,expected_generation:domain.generation,expected_revision_id:domain.revision_id,revision_id:submission.revision_id,contributors:[{revision_id:submission.revision_id,change_id:worker.bound.workspace_id,custody_id:submission.custody_id,custody_generation:submission.custody_generation,run_id:ids.run,task_id:task.task}],dependencies:submission.dependencies,inputs:submission.input_manifest,transformation_version:'native-full-replacement-v1'};
 const forged=structuredClone(candidateInput);forged.candidate_id=randomUUID();forged.dependencies[0].execution_dependency.qualification_id='sha256:'+'0'.repeat(64);forged.inputs.dependency=f.sourceDigest(forged.dependencies.map(value=>value.execution_dependency));
 await assert.rejects(()=>f.client.createCandidate(forged,{operation_id:randomUUID(),idempotency_key:randomUUID()}),error=>error.code==='CANDIDATE_DEPENDENCY_STALE');
 assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM hyperfide.source_native_candidates WHERE candidate_id=$1',[forged.candidate_id])).rows[0].n,0);
 const candidate=await f.client.createCandidate(candidateInput,{operation_id:randomUUID(),idempotency_key:randomUUID()});
 const qualified=await f.qualify(candidate),accepted=await f.accept(candidate,qualified);
 const before=(await f.pool.query('SELECT state,state_version::text FROM hyperfide.tasks WHERE organisation_id=$1 AND run_id=$2 AND id=$3',[ids.organisation,ids.run,task.task])).rows[0];assert.equal(before.state,'SUBMITTED');
 const taskQualification=await sourceCall('operator','source.fleet.qualify',{run_id:ids.run,task_id:task.task,custody_id:submission.custody_id,custody_generation:submission.custody_generation,candidate_id:candidate.candidate_id,qualification_id:qualified.qualification.qualification_id,expected_state_version:before.state_version},randomUUID());
 assert.equal(taskQualification.state,'QUALIFIED');assert.equal(accepted.revision_id,saved.revision_id);
 const {readNativeTaskQualification}=await import(pathToFileURL(path.join(controlRoot,'assurance/fleet_native.js')));
 const snapshot=await f.pool.connect();
 try{await snapshot.query('BEGIN ISOLATION LEVEL REPEATABLE READ');const observed=await readNativeTaskQualification(snapshot,{organisation_id:ids.organisation,run_id:ids.run},task.task,f.scope.repository_id);const retained=(await snapshot.query('SELECT receipt FROM hyperfide.source_fleet_qualifications WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND qualification_id=$4',[...Object.values(f.scope),taskQualification.qualification_id])).rows[0].receipt;assert.deepEqual(observed,retained);await snapshot.query('COMMIT');}finally{await snapshot.query('ROLLBACK').catch(()=>{});snapshot.release();}

 const currentDomain=await f.client.domain(domain.domain_id),variants=[];
 for(let n=0;n<2;n++){const revision=await f.createRevision({text:'candidate: queued variant '+n+'\n',parent_revision_ids:[accepted.revision_id]});variants.push(await f.createCandidate(revision,{domain:currentDomain,dependencies:submission.dependencies}));}
 const queueCapability=randomUUID(),author=f.roles.author;
 await f.pool.query(`INSERT INTO hyperfide.source_capabilities(organisation_id,repository_id,security_domain_id,id,principal_id,credential_id,principal_kind,authority_epoch,policy_version,actions,path_prefixes,expires_at) VALUES($1,$2,$3,$4,$5,$6,'automation',$7,$8,$9,ARRAY[''],clock_timestamp()+interval '10 minutes')`,[...Object.values(f.scope),queueCapability,author.principal_id,author.credential_id,f.context.authority_epoch,f.context.policy_version,['source.queue.enqueue','source.queue.claim','source.queue.read']]);
 const queueClient=new f.client.constructor({endpoint:f.endpoint,scope:f.scope,token:()=>f.tokenFor('author',queueCapability)});
 await queueClient.call('source.queue.enqueue',{candidate_ids:variants.map(value=>value.candidate_id),expires_at:new Date(Date.now()+60000).toISOString(),max_attempts:1},{operation_id:randomUUID(),idempotency_key:randomUUID()});
 const queued=(await queueClient.call('source.queue.claim',{lease_ms:5000},{operation_id:randomUUID(),idempotency_key:randomUUID()})).batch;assert(queued,'Actual proposal batch must be claimable');
 assert.equal(queued.manifest.candidate_ids.length,2);assert.deepEqual(queued.manifest.dependencies,submission.dependencies);
 const retained=await queueClient.call('source.queue.read',{batch_id:queued.batch_id});assert.deepEqual(retained.manifest.dependencies,submission.dependencies);

 return {plain_sql_qualification_read:true,queue_preserved_dependencies:true,queue_manifest_dependencies:queued.manifest.dependencies,forged_dependency_refused:true,submission,qualified,accepted,taskQualification,checkpoint:saved,process:execution.observation,workspace_id:worker.bound.workspace_id};
}
