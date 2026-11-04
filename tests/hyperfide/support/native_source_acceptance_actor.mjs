import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createNativeAcceptanceFixture} from './native_source_acceptance_fixture.mjs';

const f=await createNativeAcceptanceFixture();
const checks=[];
const count=async(table,where='',values=[])=>(await f.pool.query('SELECT count(*)::int AS count FROM hyperfide.'+table+(where?' WHERE '+where:''),values)).rows[0].count;
const candidate=async(text,domain=f.domain)=>f.createCandidate(await f.createRevision({text,parent_revision_ids:[domain.revision_id]}),{domain});
const independent=async text=>{
  const domain=await f.createDomain();
  return {domain,candidate:await candidate(text,domain)};
};
try {
  assert.notEqual(f.roles.author.principal_id,f.roles.checker.principal_id);
  const proposal=await f.createRevision({text:'candidate: first accepted source\n'});
  const first=await f.createCandidate(proposal);
  assert.equal(first.revision_id,proposal.revision_id);
  assert.equal(first.root_tree_id,proposal.root_tree_id);
  assert.equal(await count('source_native_acceptances'),0);
  assert.equal((await f.client.domain(f.domain.domain_id)).revision_id,f.base.revision_id);
  const qualified=await f.qualify(first);
  assert.equal(qualified.execution.observed.exit_code,0);
  assert.equal(qualified.execution.observed.signal,null);
  assert.equal(qualified.execution.stdout,'native check passed\n');
  assert.equal(qualified.evidence.outcome,'PASS');
  assert.equal(qualified.qualification.manifest_digest,first.manifest_digest);
  const proof=qualified.execution.receipt;
  const pinned=(await f.pool.query('SELECT object_id,position FROM hyperfide.source_object_pins WHERE owner_id=$1 ORDER BY position',['native-evidence:'+qualified.evidence.evidence_id])).rows;
  assert.deepEqual(pinned.map(row=>row.object_id),[qualified.execution.receipt_object_id,proof.output.stdout_object_id,proof.output.stderr_object_id,...proof.artifacts.map(item=>item.object_id)]);
  checks.push('an independent authenticated checker executes the registered command on pinned source and publishes retained exact-input evidence');

  const acceptanceOperation=randomUUID();
  const accepted=await f.accept(first,qualified,{operation_id:acceptanceOperation});
  assert.equal(accepted.generation,'2');
  assert.equal(accepted.previous_revision_id,f.base.revision_id);
  assert.equal(accepted.root_tree_id,proposal.root_tree_id);
  assert.equal(accepted.revision_id,proposal.revision_id);
  const replay=await f.accept(first,qualified,{operation_id:acceptanceOperation});
  assert.deepEqual(replay,accepted);
  assert.deepEqual(await f.client.acceptance(accepted.acceptance_id),accepted);
  assert.equal((await f.client.domain(f.domain.domain_id)).revision_id,proposal.revision_id);
  assert.equal(await count('source_native_acceptances','domain_id=$1',[f.domain.domain_id]),1);
  assert.equal(await count('source_events',"aggregate_id=$1 AND event_type='NATIVE_SOURCE_ACCEPTED'",['domain:'+f.domain.domain_id]),1);
  assert((await f.pool.query('SELECT 1 FROM hyperfide.source_object_pins WHERE object_id=$1 AND owner_id=$2',[proposal.root_tree_id,'acceptance:'+accepted.acceptance_id])).rowCount>0);
  assert.equal((await f.pool.query("SELECT to_regclass('hyperfide.tasks') AS tasks")).rows[0].tasks,null);
  checks.push('atomic domain acceptance records one replayable receipt, advances only the selected domain, pins its root and creates no fleet task completion');

  const raceDomain=await f.createDomain();
  const [left,right]=await Promise.all([candidate('candidate: racing left\n',raceDomain),candidate('candidate: racing right\n',raceDomain)]);
  const [leftProof,rightProof]=await Promise.all([f.qualify(left),f.qualify(right)]);
  const race=await Promise.allSettled([f.accept(left,leftProof),f.accept(right,rightProof)]);
  assert.equal(race.filter(row=>row.status==='fulfilled').length,1);
  const rejected=race.find(row=>row.status==='rejected');assert.equal(rejected.reason.code,'DOMAIN_CHANGED');
  const winner=race.find(row=>row.status==='fulfilled').value;
  assert.equal((await f.client.domain(raceDomain.domain_id)).revision_id,winner.revision_id);
  assert.equal(await count('source_native_acceptances','domain_id=$1',[raceDomain.domain_id]),1);
  await assert.rejects(f.accept(left,leftProof,{operation_id:acceptanceOperation}),error=>error.code==='IDEMPOTENCY_CONFLICT');
  checks.push('two qualified candidates racing one expected generation produce exactly one accepted head and operation identities cannot be rebound');

  const changed=await independent('candidate: changed policy generation\n');
  const changedProof=await f.qualify(changed.candidate);
  const configured=await f.mutation('source.domains.configure',{domain_id:changed.domain.domain_id,expected_generation:'1',policy_id:f.policy.policy_id,policy_digest:f.policy.policy_digest});
  assert.equal(configured.generation,'2');
  await assert.rejects(f.accept(changed.candidate,changedProof),error=>error.code==='DOMAIN_CHANGED');
  assert.equal(await count('source_native_acceptances','domain_id=$1',[changed.domain.domain_id]),0);
  assert.equal((await f.client.domain(changed.domain.domain_id)).revision_id,f.base.revision_id);
  checks.push('a changed domain generation invalidates an already qualified candidate without moving source');

  const custodyCase=await independent('candidate: revoked custody\n');
  const custodyProof=await f.qualify(custodyCase.candidate);
  const custody=custodyCase.candidate.contributors[0];
  await f.mutation('source.assurance.revoke',{custody_id:custody.custody_id});
  await assert.rejects(f.accept(custodyCase.candidate,custodyProof),error=>error.code==='CUSTODY_STALE');
  assert.equal(await count('source_native_acceptances','domain_id=$1',[custodyCase.domain.domain_id]),0);
  checks.push('revoking contributor custody fences previously complete evidence at the acceptance transaction');

  const evidenceCase=await independent('candidate: revoked evidence\n');
  const evidenceProof=await f.qualify(evidenceCase.candidate);
  await f.mutation('source.assurance.revoke',{evidence_id:evidenceProof.evidence.evidence_id},{},f.checkerClient);
  await assert.rejects(f.accept(evidenceCase.candidate,evidenceProof),error=>error.code==='EVIDENCE_BINDING_MISMATCH');
  assert.equal(await count('source_native_acceptances','domain_id=$1',[evidenceCase.domain.domain_id]),0);
  checks.push('revoking checker evidence fences a retained qualification and preserves the old domain head');

  const failed=await independent('FAIL real checker failure\n');
  const failedEvidence=await f.publishEvidence(failed.candidate);
  assert.equal(failedEvidence.execution.observed.exit_code,7);
  assert.equal(failedEvidence.evidence.outcome,'FAIL');
  await assert.rejects(f.mutation('source.candidates.qualify',{candidate_id:failed.candidate.candidate_id,evidence_ids:[failedEvidence.evidence.evidence_id]}),error=>error.code==='EVIDENCE_BINDING_MISMATCH');
  assert.equal(await count('source_native_acceptances','domain_id=$1',[failed.domain.domain_id]),0);
  checks.push('a real failed checker command remains failed evidence and cannot qualify or advance source');

  const forged=await independent('candidate: binding checks\n');
  const wrongTree=await f.runCheck(forged.candidate,{mutate:receipt=>({...receipt,root_tree_id:f.base.root_tree_id})});
  await assert.rejects(f.publishEvidence(forged.candidate,{execution:wrongTree}),error=>error.code==='EVIDENCE_BINDING_MISMATCH');
  const validExecution=await f.runCheck(forged.candidate);
  await assert.rejects(f.publishEvidence(forged.candidate,{execution:validExecution,actor:f.client}),error=>error.code==='CHECKER_NOT_AUTHORIZED');
  const wrongGraph=await f.runCheck(forged.candidate,{mutate:receipt=>({...receipt,inputs:{...receipt.inputs,graph:f.sourceDigest('another-graph-generation')}})});
  await assert.rejects(f.publishEvidence(forged.candidate,{execution:wrongGraph}),error=>error.code==='EVIDENCE_BINDING_MISMATCH');
  checks.push('evidence with another graph generation cannot qualify the unchanged candidate or narrow its required checks');
  const wrongInputs=await f.runCheck(forged.candidate,{mutate:receipt=>({...receipt,inputs:{...receipt.inputs,contract:f.sourceDigest('another-contract')}})});
  await assert.rejects(f.publishEvidence(forged.candidate,{execution:wrongInputs}),error=>error.code==='EVIDENCE_BINDING_MISMATCH');
  await f.pool.query(`INSERT INTO hyperfide.source_native_assurance_checkers(organisation_id,repository_id,security_domain_id,policy_id,check_id,principal_id,credential_id,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+interval '30 minutes')`,[...Object.values(f.scope),f.policy.policy_id,f.check.id,f.roles.author.principal_id,f.roles.author.credential_id]);
  await assert.rejects(f.publishEvidence(forged.candidate,{execution:validExecution,actor:f.client}),error=>error.code==='CHECKER_NOT_INDEPENDENT');
  checks.push('altered source and input bindings and self-certification by even a registered author are refused');

  const malformedRevision=await f.createRevision({text:'candidate: malformed proposal\n'});
  const malformedCustody=await f.registerCustody(malformedRevision);
  const beforeMalformed=await count('source_native_candidates');
  const duplicate={revision_id:malformedRevision.revision_id,change_id:malformedRevision.change_id,custody_id:malformedCustody.custody_id,custody_generation:'1'};
  const freshDomain=await f.createDomain();
  await assert.rejects(f.createCandidate(malformedRevision,{domain:freshDomain,input:{contributors:[duplicate,duplicate]}}),error=>error.code==='INVALID_REQUEST');
  await assert.rejects(f.createCandidate(malformedRevision,{domain:freshDomain,input:{inputs:{...first.inputs,source:f.sourceDigest('wrong-source')}}}),error=>error.code==='CANDIDATE_INPUT_MISMATCH');
  const unrelated=await f.createRevision({text:'candidate: unrelated contributor\n',parent_revision_ids:[]});
  const unrelatedCustody=await f.registerCustody(unrelated);
  await assert.rejects(f.createCandidate(malformedRevision,{domain:freshDomain,input:{contributors:[{revision_id:unrelated.revision_id,change_id:unrelated.change_id,custody_id:unrelatedCustody.custody_id,custody_generation:'1'}]}}),error=>error.code==='INVALID_CONTRIBUTOR');
  assert.equal(await count('source_native_candidates'),beforeMalformed);
  await assert.rejects(f.pool.query('UPDATE hyperfide.source_native_candidates SET manifest=$1 WHERE candidate_id=$2',[{},first.candidate_id]),error=>error.code==='23514');
  checks.push('duplicate contributors, mismatched source manifests and edits to immutable candidates cannot enter acceptance');

  const lost=await independent('candidate: lost acknowledgment\n');
  const lostProof=await f.qualify(lost.candidate);
  const sdk=await import(pathToFileURL(path.join(process.env.SOURCE_CONTROL_SDK_MODULE_ROOT,'client.js')));
  let lose=true;
  const interrupted=new sdk.SourceControlClient({endpoint:f.endpoint,scope:f.scope,token:()=>f.tokenFor(),fetch:async(...args)=>{
    const response=await fetch(...args);if(lose){lose=false;await response.arrayBuffer();throw new TypeError('controlled lost acceptance response');}return response;
  }});
  const lostOperation=randomUUID(),lostInput={candidate_id:lost.candidate.candidate_id,qualification_id:lostProof.qualification.qualification_id};
  await assert.rejects(interrupted.acceptCandidate(lostInput,{operation_id:lostOperation,idempotency_key:lostOperation}),error=>error.code==='OUTCOME_UNKNOWN'&&error.details.operation_id===lostOperation);
  const operation=await f.client.operation(lostOperation);assert.equal(operation.state,'SUCCEEDED');
  const recovered=await f.mutation('source.acceptance.accept',lostInput,{operation_id:lostOperation});
  assert.deepEqual(operation.result,recovered);
  assert.equal((await f.client.domain(lost.domain.domain_id)).generation,'2');
  assert.equal(await count('source_native_acceptances','domain_id=$1',[lost.domain.domain_id]),1);
  checks.push('a lost acceptance response resolves through the original operation and never advances the domain twice');

  const revokedPolicy=await f.registerPolicy({policy_id:randomUUID(),policy_digest:f.sourceDigest({case:'revoked-policy',checks:[f.check]}),checks:[f.check]});
  const policyDomain=await f.createDomain(f.base,revokedPolicy);
  const policyCandidate=await candidate('candidate: revoked policy\n',policyDomain);
  const policyProof=await f.qualify(policyCandidate);
  await f.pool.query('UPDATE hyperfide.source_native_assurance_policies SET revoked_at=clock_timestamp() WHERE policy_id=$1',[revokedPolicy.policy_id]);
  await assert.rejects(f.accept(policyCandidate,policyProof),error=>error.code==='EVIDENCE_POLICY_STALE');
  assert.equal(await count('source_native_acceptances','domain_id=$1',[policyDomain.domain_id]),0);
  checks.push('revoking the registered checker policy invalidates existing qualification without mutating accepted history');

  const checkerRevocation=await independent('candidate: checker credential revocation\n');
  const checkerRevocationProof=await f.qualify(checkerRevocation.candidate);
  const expiredCredential=await independent('candidate: durable proof after credential expiry\n');
  const expiredCredentialProof=await f.qualify(expiredCredential.candidate);
  await f.pool.query("UPDATE hyperfide.source_principal_credentials SET expires_at=(SELECT max(created_at)+interval '1 millisecond' FROM hyperfide.source_native_assurance_evidence WHERE checker_credential_id=$1) WHERE credential_id=$1",[f.roles.checker.credential_id]);
  await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal((await f.pool.query('SELECT expires_at<clock_timestamp() AS expired FROM hyperfide.source_principal_credentials WHERE credential_id=$1',[f.roles.checker.credential_id])).rows[0].expired,true);
  const durableAfterExpiry=await f.accept(expiredCredential.candidate,expiredCredentialProof);
  assert.equal(durableAfterExpiry.revision_id,expiredCredential.candidate.revision_id);
  checks.push('credential expiry prevents new assertions while proof issued under valid authority remains usable');
  await f.pool.query('UPDATE hyperfide.source_principal_credentials SET revoked_at=clock_timestamp() WHERE credential_id=$1',[f.roles.checker.credential_id]);
  await assert.rejects(f.accept(checkerRevocation.candidate,checkerRevocationProof),error=>error.code==='CHECKER_NOT_AUTHORIZED');
  assert.equal(await count('source_native_acceptances','domain_id=$1',[checkerRevocation.domain.domain_id]),0);
  checks.push('checker credential revocation is rechecked after qualification and before accepting source');

  const report={schema_version:1,status:'PASS',scope:'real PostgreSQL, independent Ed25519 checker, executed command, source HTTP/SDK and SigV4 storage',checks,
    acceptance_id:accepted.acceptance_id,accepted_revision_id:accepted.revision_id,backend_requests:f.backend.requests.length};
  const output=path.join(f.ROOT,'build/source-control/4.1');await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,'receipt.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
} finally {await f.close();}
