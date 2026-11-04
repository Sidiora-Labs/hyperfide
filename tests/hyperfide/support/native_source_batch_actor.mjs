import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createNativeAcceptanceFixture} from './native_source_acceptance_fixture.mjs';

const actions=['source.capabilities','source.objects.put','source.objects.read','source.objects.inspect','source.revisions.create','source.revisions.read','source.operations.read','source.domains.create','source.domains.read','source.domains.configure','source.candidates.create','source.candidates.read','source.candidates.qualify','source.acceptance.accept','source.acceptance.read','source.assurance.custody.create','source.assurance.publish','source.assurance.revoke','source.queue.enqueue','source.queue.claim','source.queue.bind','source.queue.complete','source.queue.fail','source.queue.isolate','source.queue.read'];
const checkScript="const fs=require('node:fs'),crypto=require('node:crypto');const bytes=fs.readFileSync('main.txt'),text=bytes.toString('utf8');const ok=!(text.includes('A=1')&&text.includes('B=1'));fs.writeFileSync('proof.json',JSON.stringify({sha256:crypto.createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length}));process.stdout.write(ok?'independent check passed\\n':'combined dependency conflict\\n');process.exitCode=ok?0:7;";
const f=await createNativeAcceptanceFixture({actions,checkScript}),fixtures=[f],checks=[];
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const call=(fixture,action,input,options={})=>fixture.mutation('source.queue.'+action,input,options);
const enqueue=(fixture,candidates,options={})=>call(fixture,'enqueue',{candidate_ids:candidates.map(candidate=>candidate.candidate_id),expires_at:new Date(Date.now()+60000).toISOString(),...options});
const claim=async fixture=>(await call(fixture,'claim',{lease_ms:30000})).batch;
const lease=batch=>({batch_id:batch.batch_id,lease_id:batch.lease_id});
async function proposal(fixture,text,domain=fixture.domain){return fixture.createCandidate(await fixture.createRevision({text,parent_revision_ids:[domain.revision_id]}),{domain});}
async function prepared(fixture,batch,text){
 const revision=await fixture.createRevision({text,parent_revision_ids:batch.manifest.candidate_ids.length===1?[batch.manifest.expected_revision_id]:await Promise.all(batch.manifest.candidate_ids.map(async id=>(await fixture.client.call('source.candidates.read',{candidate_id:id})).revision_id))});
 return fixture.createCandidate(revision,{domain:{...fixture.domain,domain_id:batch.manifest.domain_id,generation:batch.manifest.expected_generation,revision_id:batch.manifest.expected_revision_id},dependencies:batch.manifest.dependencies,input:{contributors:batch.manifest.contributors}});
}
async function fresh(options={}) {const next=await createNativeAcceptanceFixture({pool:f.pool,migrate:false,actions,checkScript,...options});fixtures.push(next);return next;}
try {
 const left=await proposal(f,'candidate:\nA=1\n'),right=await proposal(f,'candidate:\nB=1\n');
 const leftProof=await f.qualify(left),rightProof=await f.qualify(right);
 assert.equal(leftProof.execution.observed.exit_code,0);assert.equal(rightProof.execution.observed.exit_code,0);
 const enqueueOperation=randomUUID(),expires_at=new Date(Date.now()+60000).toISOString();
 const queued=await call(f,'enqueue',{candidate_ids:[left.candidate_id,right.candidate_id],expires_at},{operation_id:enqueueOperation});
 assert.equal(queued.manifest.cost.proposals,2);assert.equal(queued.manifest.cost.contributors,2);
 assert.equal(queued.manifest.cost.manifest_bytes,f.canonicalBytes(left).byteLength+f.canonicalBytes(right).byteLength);
 assert.deepEqual(await call(f,'enqueue',{candidate_ids:[left.candidate_id,right.candidate_id],expires_at},{operation_id:enqueueOperation}),queued);
 assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM hyperfide.source_object_pins WHERE owner_kind='HOLD' AND owner_id=$1",['candidate-queue:'+queued.work_id])).rows[0].n,2);
 const mainBatch=await claim(f);assert.deepEqual(mainBatch.manifest.proposal_ids,queued.manifest.proposal_ids);
 await assert.rejects(call(f,'bind',{...lease(mainBatch),candidate_id:left.candidate_id}),error=>error.code==='BATCH_INPUT_MISMATCH');
 const combined=await prepared(f,mainBatch,'candidate:\nA=1\nB=1\n');
 const bound=await call(f,'bind',{...lease(mainBatch),candidate_id:combined.candidate_id});assert.equal(bound.state,'BOUND');
 await assert.rejects(call(f,'complete',{...lease(mainBatch),qualification_id:leftProof.qualification.qualification_id}),error=>error.code==='QUALIFICATION_REQUIRED');
 const failed=await f.publishEvidence(combined);assert.equal(failed.execution.observed.exit_code,7);
 await assert.rejects(call(f,'fail',{...lease(mainBatch),evidence_ids:[leftProof.evidence.evidence_id]}),error=>error.code==='EVIDENCE_BINDING_MISMATCH');
 const failedBatch=await call(f,'fail',{...lease(mainBatch),evidence_ids:[failed.evidence.evidence_id]});assert.equal(failedBatch.state,'FAILED');
 checks.push('two independently passing proposals form an exact measured batch whose combined source fails a real checker; original evidence cannot qualify or fail the different batch candidate');

 const ids=mainBatch.manifest.proposal_ids;
 await assert.rejects(call(f,'isolate',{...lease(mainBatch),partitions:[[ids[0]],[ids[0]]]}),error=>error.code==='BATCH_INPUT_MISMATCH');
 const isolated=await call(f,'isolate',{...lease(mainBatch),partitions:[[ids[0]],[ids[1]]]});assert.equal(isolated.state,'ISOLATED');
 assert.equal(isolated.result.children.length,2);
 const children=[];
 for(let i=0;i<2;i++){
  const child=await claim(f);assert(child);assert.equal(child.manifest.proposal_ids.length,1);assert.equal(child.attempt,2);
  const original=child.manifest.candidate_ids[0]===left.candidate_id?left:right;
  await assert.rejects(call(f,'bind',{...lease(child),candidate_id:original.candidate_id}),error=>error.code==='BATCH_INPUT_MISMATCH');
  const revision={revision_id:original.revision_id,root_tree_id:original.root_tree_id,change_id:original.contributors[0].change_id};
  const childCandidate=await f.createCandidate(revision,{input:{contributors:child.manifest.contributors}});
  await call(f,'bind',{...lease(child),candidate_id:childCandidate.candidate_id});
  const old=original.candidate_id===left.candidate_id?leftProof:rightProof;
  await assert.rejects(call(f,'complete',{...lease(child),qualification_id:old.qualification.qualification_id}),error=>error.code==='QUALIFICATION_REQUIRED');
  const proof=await f.qualify(childCandidate),passed=await call(f,'complete',{...lease(child),qualification_id:proof.qualification.qualification_id});
  assert.equal(passed.state,'PASSED');assert.notEqual(proof.qualification.qualification_id,old.qualification.qualification_id);assert.notEqual(proof.execution.receipt.execution.execution_id,old.execution.receipt.execution.execution_id);children.push(passed);
 }
 assert.equal((await f.pool.query('SELECT outcome FROM hyperfide.source_native_assurance_evidence WHERE evidence_id=$1',[failed.evidence.evidence_id])).rows[0].outcome,'FAIL');
 assert.deepEqual(await f.client.call('source.candidates.read',{candidate_id:left.candidate_id}),left);
 assert.deepEqual(await f.client.call('source.candidates.read',{candidate_id:right.candidate_id}),right);
 assert.equal((await f.client.domain(f.domain.domain_id)).generation,'1');
 checks.push('failure isolation partitions every original proposal once, preserves failed/original receipts, and requires freshly qualified child candidates without advancing accepted source');

 const fair=await fresh(),coldDomain=await fair.createDomain();
 const hot=[];for(let i=0;i<3;i++){const candidate=await proposal(fair,'candidate: hot '+i+'\n');hot.push(await enqueue(fair,[candidate]));}
 const coldCandidate=await proposal(fair,'candidate: cold\n',coldDomain),cold=await enqueue(fair,[coldCandidate]);
 const first=await claim(fair),second=await claim(fair);assert(first&&second);
 assert(new Set([first.work_id,second.work_id]).has(cold.work_id));
 assert.notEqual(first.manifest.domain_id,second.manifest.domain_id);
 checks.push('persistent per-domain proposer service debt gives a cold domain admission within two claims despite an older hot backlog');

 const reentry=await fresh(),reentryDomains=[reentry.domain,await reentry.createDomain()].sort((a,b)=>a.domain_id.localeCompare(b.domain_id)),hotDomain=reentryDomains[0],waitingDomain=reentryDomains[1];
 await enqueue(reentry,[await proposal(reentry,'candidate: hot first\n',hotDomain)],{max_attempts:1});
 const waiting=await enqueue(reentry,[await proposal(reentry,'candidate: already waiting\n',waitingDomain)]);
 const hotFirst=(await call(reentry,'claim',{lease_ms:1000})).batch;assert.equal(hotFirst.manifest.domain_id,hotDomain.domain_id);
 await delay(1100);
 await enqueue(reentry,[await proposal(reentry,'candidate: hot reentry\n',hotDomain)]);
 const afterReentry=await claim(reentry);assert.equal(afterReentry.work_id,waiting.work_id,'A hot proposer reentering the queue must not reset its debt ahead of waiting work');
 checks.push('a hot proposer cannot reset service debt by draining and reentering while cold work waits');

 const perOwner=await fresh(),authorCandidate=await proposal(perOwner,'candidate: author\n');
 await enqueue(perOwner,[authorCandidate]);
 const raw=await proposal(perOwner,'candidate: second proposer\n');
 const secondOwner=await perOwner.mutation('source.candidates.create',{candidate_id:randomUUID(),domain_id:perOwner.domain.domain_id,expected_generation:'1',expected_revision_id:perOwner.base.revision_id,revision_id:raw.revision_id,contributors:raw.contributors,dependencies:raw.dependencies,inputs:raw.inputs,transformation_version:raw.transformation_version},{},perOwner.checkerClient);
 const secondWork=await enqueue(perOwner,[secondOwner]);
 await enqueue(perOwner,[await proposal(perOwner,'candidate: author extra\n')]);
 const ownerClaims=[await claim(perOwner),await claim(perOwner)];assert(ownerClaims.some(batch=>batch.work_id===secondWork.work_id));
 const served=(await perOwner.pool.query('SELECT principal_id,service_round::text FROM hyperfide.source_candidate_queue_owners WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3',[...Object.values(perOwner.scope)])).rows;
 assert.equal(served.length,2);assert.deepEqual(served.map(row=>Number(row.service_round)).sort((a,b)=>a-b),[1,2]);
 checks.push('within one domain persistent debt gives each immutable proposer a turn without relying on timestamps');

 const concurrent=await fresh(),pending=await enqueue(concurrent,[await proposal(concurrent,'candidate: concurrent\n')]);
 const claims=await Promise.all([claim(concurrent),claim(concurrent)]);assert.equal(claims.filter(Boolean).length,1);assert.equal(claims.find(Boolean).work_id,pending.work_id);
 checks.push('two concurrent claim transactions lease one work item once');

 const retry=await fresh(),retryWork=await enqueue(retry,[await proposal(retry,'candidate: bounded retry\n')],{max_attempts:2});
 const initial=(await call(retry,'claim',{lease_ms:1000})).batch;await delay(1100);
 await assert.rejects(call(retry,'bind',{...lease(initial),candidate_id:left.candidate_id}),error=>error.code==='QUEUE_LEASE_STALE');
 const retried=(await call(retry,'claim',{lease_ms:1000})).batch;assert.equal(retried.work_id,retryWork.work_id);assert.equal(retried.attempt,2);assert.notEqual(retried.lease_id,initial.lease_id);
 assert.equal((await retry.client.call('source.queue.read',{batch_id:initial.batch_id})).attempt,1,'Historical batch attempt must remain pinned after a retry');
 await delay(1100);assert.equal((await call(retry,'claim',{lease_ms:1000})).batch,null);
 assert.equal((await retry.pool.query('SELECT state FROM hyperfide.source_candidate_queue_work WHERE work_id=$1',[retryWork.work_id])).rows[0].state,'EXHAUSTED');
 assert.equal((await retry.pool.query('SELECT count(*)::int AS n FROM hyperfide.source_object_pins WHERE owner_id=$1',['candidate-queue:'+retryWork.work_id])).rows[0].n,0);
 checks.push('expired leases receive new identities for bounded attempts and exhausted work releases only coordinator queue pins');

 const expiring=await fresh(),expiryCandidate=await proposal(expiring,'candidate: expiry\n');
 const expiry=await enqueue(expiring,[expiryCandidate],{expires_at:new Date(Date.now()+1200).toISOString()});await delay(1300);
 assert.equal((await call(expiring,'claim',{lease_ms:1000})).batch,null);
 assert.equal((await expiring.pool.query('SELECT state FROM hyperfide.source_candidate_queue_work WHERE work_id=$1',[expiry.work_id])).rows[0].state,'EXPIRED');
 assert(await expiring.service.objects.read(expiring.scope,expiryCandidate.root_tree_id));
 await assert.rejects(enqueue(expiring,Array.from({length:17},()=>({candidate_id:randomUUID()}))),error=>error.code==='QUEUE_LIMIT');
 await assert.rejects(call(expiring,'enqueue',{candidate_ids:[expiryCandidate.candidate_id],expires_at:new Date(Date.now()+60000).toISOString(),manifest_bytes:0}),error=>error.code==='INVALID_REQUEST');
 await assert.rejects(enqueue(expiring,[expiryCandidate],{max_attempts:4}),error=>error.code==='QUEUE_LIMIT');
 checks.push('expired work is not scheduled, original source remains retained, and callers cannot raise count/retry budgets or forge byte estimates');

 const lost=await fresh(),lostWork=await enqueue(lost,[await proposal(lost,'candidate: lost claim\n')]);
 const {SourceControlClient}=await import(pathToFileURL(path.join(process.env.SOURCE_CONTROL_SDK_MODULE_ROOT,'client.js')));let drop=true;
 const interrupted=new SourceControlClient({endpoint:lost.endpoint,scope:lost.scope,token:()=>lost.tokenFor(),fetch:async(...args)=>{const response=await fetch(...args);if(drop){drop=false;await response.arrayBuffer();throw new TypeError('lost queue claim acknowledgment');}return response;}});
 const operation=randomUUID();await assert.rejects(interrupted.call('source.queue.claim',{lease_ms:30000},{operation_id:operation,idempotency_key:operation}),error=>error.code==='OUTCOME_UNKNOWN');
 const recovered=await lost.client.operation(operation);assert.equal(recovered.state,'SUCCEEDED');assert.equal(recovered.result.batch.work_id,lostWork.work_id);
 assert.deepEqual(await call(lost,'claim',{lease_ms:30000},{operation_id:operation}),recovered.result);
 assert.equal((await lost.pool.query('SELECT attempts FROM hyperfide.source_candidate_queue_work WHERE work_id=$1',[lostWork.work_id])).rows[0].attempts,1);
 checks.push('a lost claim acknowledgment resolves the original leased batch without consuming another attempt');

 const budgets=await fresh(),chain=[];
 await budgets.service.metadata.transaction(async tx=>{
  let parent=budgets.base.revision_id;
  for(let index=0;index<257;index++){
   const operation=randomUUID(),change_id=randomUUID();
   const revision=await budgets.service.metadata.createRevisionInTransaction(tx,budgets.context,{operation_id:operation,idempotency_key:operation,change_id,root_tree_id:budgets.base.root_tree_id,parent_revision_ids:[parent],predecessor_revision_ids:[],provenance:{author:{name:'Queue budget qualification',email:'queue-budget@example.invalid'},message:'retained dependency '+index,timestamp:'2026-11-04T00:00:00.000Z'}});
   chain.push({...revision,change_id});parent=revision.revision_id;
  }
 });
 const contributorRecords=[];
 for(const revision of chain.slice(0,65)){const custody=await budgets.registerCustody(revision);contributorRecords.push({revision_id:revision.revision_id,change_id:revision.change_id,custody_id:custody.custody_id,custody_generation:custody.custody_generation});}
 const manyLeft=await budgets.createCandidate(chain[32],{input:{contributors:contributorRecords.slice(0,33)}}),manyRight=await budgets.createCandidate(chain[64],{input:{contributors:contributorRecords.slice(33)}});
 await assert.rejects(enqueue(budgets,[manyLeft,manyRight]),error=>error.code==='QUEUE_LIMIT');
 const dependencyLeft=await budgets.createCandidate(await budgets.createRevision({text:'candidate: dependencies left\n'}),{dependencies:chain.slice(0,129).map(revision=>({revision_id:revision.revision_id}))});
 const dependencyRight=await budgets.createCandidate(await budgets.createRevision({text:'candidate: dependencies right\n'}),{dependencies:chain.slice(129).map(revision=>({revision_id:revision.revision_id}))});
 await assert.rejects(enqueue(budgets,[dependencyLeft,dependencyRight]),error=>error.code==='QUEUE_LIMIT');
 const byteCandidates=[],sharedDependencies=chain.slice(0,256).map(revision=>({revision_id:revision.revision_id}));
 for(let index=0;index<16;index++)byteCandidates.push(await budgets.createCandidate(await budgets.createRevision({text:'candidate: byte budget '+index+'\n'}),{dependencies:sharedDependencies}));
 const measuredManifestBytes=byteCandidates.reduce((sum,candidate)=>sum+Buffer.byteLength(JSON.stringify(candidate)),0);assert(measuredManifestBytes>262144);
 await assert.rejects(enqueue(budgets,byteCandidates),error=>error.code==='QUEUE_LIMIT');
 assert.equal((await budgets.pool.query('SELECT count(*)::int AS n FROM hyperfide.source_candidate_queue_proposals WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3',[...Object.values(budgets.scope)])).rows[0].n,0);
 checks.push('actual 65-contributor, 257-dependency and oversized 16-candidate manifests exceed independent server budgets and leave no queue proposals');

 const receipt={schema_version:1,status:'PASS',scope:'real PostgreSQL, authenticated source API, actual independent checker, speculative batching',checks,original_candidates:[left.candidate_id,right.candidate_id],failed_batch:mainBatch.batch_id,child_batches:children.map(child=>child.batch_id),measured_cost:queued.manifest.cost};
 const output=path.join(f.ROOT,'build/source-control/4.1-batches');await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');process.stdout.write(JSON.stringify(receipt)+'\n');
}finally{for(const fixture of fixtures.reverse())await fixture.close();}
