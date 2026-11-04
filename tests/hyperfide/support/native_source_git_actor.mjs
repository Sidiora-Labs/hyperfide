import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createNativeAcceptanceFixture} from './native_source_acceptance_fixture.mjs';

const moduleRoot=process.env.SOURCE_CONTROL_MODULE_ROOT;
assert(moduleRoot&&process.env.SOURCE_CONTROL_SDK_MODULE_ROOT);
const load=name=>import(pathToFileURL(path.join(moduleRoot,name+'.js')));
const [{SourceGitProjector},{createLocalGitDestination},{gitObjectId,gitCommitPayload},{sourcePublicationDestinations}]=await Promise.all([load('git/projection'),load('git/transport'),load('git/objects'),load('publication_config')]);
const scope={organisation_id:randomUUID(),repository_id:randomUUID(),security_domain_id:randomUUID()};
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'hf-native-git-'));
const checks=[],metrics=[];
const gitEnvironment={PATH:process.env.PATH??'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',LANG:'C',
  GIT_AUTHOR_NAME:'External contributor',GIT_AUTHOR_EMAIL:'external@example.invalid',GIT_COMMITTER_NAME:'External contributor',GIT_COMMITTER_EMAIL:'external@example.invalid'};
function git(directory,args,input){
  const result=spawnSync('git',['--git-dir='+directory,...args],{input,encoding:null,maxBuffer:32*1024*1024,env:gitEnvironment});
  assert.equal(result.status,0,`git ${args.join(' ')}: ${result.stderr?.toString()}`);
  return result.stdout;
}
const raw=oid=>{assert.match(oid,/^git:sha1:[0-9a-f]{40}$/);return oid.slice(9);};
const gate=()=>{let release;const promise=new Promise(resolve=>{release=resolve;});return {promise,release};};
let fixture;
try{
  const paths=Object.fromEntries(['verify','primary','mirror','cancel','failure'].map(name=>[name,path.join(temporary,name+'.git')]));
  for(const directory of Object.values(paths))git(directory,['init','--bare']);
  const configuration=path.join(temporary,'publication.json');
  await fs.writeFile(configuration,JSON.stringify({destinations:[{scope,id:'primary',provider:'local',repository_identity:'owned-primary',path:paths.primary,allowed_refs:['refs/heads/main']}]}),{mode:0o600});
  await fs.chmod(configuration,0o644);
  assert.throws(()=>sourcePublicationDestinations({HF_SOURCE_PUBLICATION_CONFIG:configuration}),error=>error.code==='CONFIGURATION_INVALID');
  await fs.chmod(configuration,0o600);
  const [primary]=sourcePublicationDestinations({HF_SOURCE_PUBLICATION_CONFIG:configuration});
  checks.push('the administrative destination configuration loads a real local remote and refuses a world-readable configuration');
  const mirror=createLocalGitDestination({scope,id:'mirror',repository_identity:'owned-mirror',path:paths.mirror,allowed_refs:['refs/heads/main']});
  const cancel=createLocalGitDestination({scope,id:'cancel',repository_identity:'owned-cancel',path:paths.cancel,allowed_refs:['refs/heads/main']});
  const failure=createLocalGitDestination({scope,id:'failure',repository_identity:'owned-failure',path:paths.failure,allowed_refs:['refs/heads/main']});
  const originalFailure=failure.transport;
  failure.transport={...originalFailure,async push(input){fixture.backend.faults.corrupt=true;try{return await originalFailure.push(input);}finally{fixture.backend.faults.corrupt=false;}}};
  const foreign=createLocalGitDestination({scope:{...scope,repository_id:randomUUID()},id:'foreign',repository_identity:'owned-foreign',path:paths.mirror,allowed_refs:['refs/heads/main']});
  const faults={loseReply:false,hiddenReads:0,barrier:null,pushes:0};
  const originalPrimary=primary.transport;
  primary.transport={
    ...originalPrimary,
    async observe(...args){if(faults.hiddenReads){faults.hiddenReads--;throw new Error('owned readback interruption');}return originalPrimary.observe(...args);},
    async push(input){faults.pushes++;const result=await originalPrimary.push(input);if(faults.loseReply){faults.loseReply=false;faults.hiddenReads++;throw new Error('owned push response interruption');}return result;},
  };
  const originalCancel=cancel.transport;
  cancel.transport={...originalCancel,async push(input){if(faults.barrier){const current=faults.barrier;current.entered.release();await current.released.promise;}return originalCancel.push(input);}};
  fixture=await createNativeAcceptanceFixture({moduleRoot,sdkRoot:process.env.SOURCE_CONTROL_SDK_MODULE_ROOT,scope,serviceOptions:{publication:{destinations:[primary,mirror,cancel,failure,foreign]}}});
  const {service,client,context,pool}=fixture;
  const projector=new SourceGitProjector(service.objects,service.trees,service.metadata);
  const project=(revision,options={})=>projector.project(context,revision,{authorize_revision:async record=>{
    await service.metadata.readRevision(context,record.revision_id);
  },...options});
  const file=async(name,bytes,mode='100644')=>({name,kind:'file',mode,object_id:(await service.objects.putFile(scope,Buffer.from(bytes))).object_id});
  const tree=async entries=>(await service.trees.fromEntries(scope,entries)).root_tree_id;
  const changes=async(root,entries)=>(await service.trees.apply(scope,root,entries.map(entry=>({path:entry.name,entry})))).root_tree_id;
  const repeated=await file('shared.txt','shared directory bytes\n');
  const largeDirectory=await tree(Array.from({length:512},(_,index)=>({...repeated,name:'file-'+String(index).padStart(4,'0')})));
  const nested=await tree([await file('inside.txt','nested bytes\n')]);
  const empty=await service.trees.empty(scope);
  const link={name:'link',kind:'symlink',mode:'120000',object_id:(await service.objects.put(scope,'blob',Buffer.from('main.txt'))).object_id};
  const binary=Buffer.from([0,255,13,10,128,65]);
  const large=Buffer.alloc(4*1024*1024+17);for(let index=0;index<large.length;index++)large[index]=index%251;
  const root=await tree([await file('main.txt','candidate: native Git publication\n'),await file('run.sh','#!/bin/sh\nprintf native\n','100755'),
    await file('binary.dat',binary),await file('chunked.dat',large),await file('foo.bar','ordered before the directory\n'),await file('unicodé.txt','exact UTF-8\n'),link,
    {name:'foo',kind:'directory',mode:'040000',object_id:nested},{name:'empty',kind:'directory',mode:'040000',object_id:empty},
    {name:'huge',kind:'directory',mode:'040000',object_id:largeDirectory}]);
  const original=await fixture.createRevision({root_tree_id:root,parent_revision_ids:[],message:'public initial commit'});
  await fixture.accept(await fixture.createCandidate(original,{domain:await fixture.createDomain(original)}));
  const leftRoot=await changes(root,[await file('left.txt','left parent\n')]),rightRoot=await changes(root,[await file('right.txt','right parent\n')]);
  const left=await fixture.createRevision({root_tree_id:leftRoot,parent_revision_ids:[original.revision_id],message:'public left commit'});
  const right=await fixture.createRevision({root_tree_id:rightRoot,parent_revision_ids:[original.revision_id],message:'public right commit'});
  for(const revision of [left,right])await fixture.accept(await fixture.createCandidate(revision,{domain:await fixture.createDomain(original)}));
  const mergeRoot=await changes(leftRoot,[await file('right.txt','right parent\n')]);
  const merged=await fixture.createRevision({root_tree_id:mergeRoot,parent_revision_ids:[right.revision_id,left.revision_id],message:'public ordered merge'});
  const cold=await project(merged.revision_id);
  assert.equal(gitObjectId('tree',Buffer.alloc(0)),'git:sha1:4b825dc642cb6eb9a060e54bf8d69288fbee4904');
  let maxChunk=0;
  for(const object of cold.objects){
    const parts=[];let size=0;for await(const chunk of object.content()){parts.push(Buffer.from(chunk));size+=chunk.byteLength;maxChunk=Math.max(maxChunk,chunk.byteLength);}
    assert.equal(size,object.size_bytes);const actual=git(paths.verify,['hash-object','-w','-t',object.kind,'--stdin'],Buffer.concat(parts)).toString().trim();assert.equal(actual,raw(object.oid));
  }
  const head=raw(cold.head_oid);
  git(paths.verify,['update-ref','refs/heads/main',head]);git(paths.verify,['fsck','--full','--strict']);
  assert.deepEqual(git(paths.verify,['cat-file','blob',head+':binary.dat']),binary);
  assert.deepEqual(git(paths.verify,['cat-file','blob',head+':chunked.dat']),large);
  assert.equal(git(paths.verify,['cat-file','blob',head+':link']).toString(),'main.txt');
  const listing=git(paths.verify,['ls-tree','-z',head]).toString().split('\0').filter(Boolean);
  assert(listing.find(line=>line.endsWith('\trun.sh')).startsWith('100755 blob '));
  assert(listing.find(line=>line.endsWith('\tlink')).startsWith('120000 blob '));
  assert(listing.findIndex(line=>line.endsWith('\tfoo.bar'))<listing.findIndex(line=>line.endsWith('\tfoo')));
  assert(!listing.some(line=>line.endsWith('\tempty')));
  const commit=git(paths.verify,['cat-file','commit',head]).toString();
  const parentIds=[right,left].map(revision=>raw(cold.mappings.find(mapping=>mapping.native_kind==='revision'&&mapping.native_id===revision.revision_id).git_oid));
  assert.deepEqual(commit.split('\n').filter(line=>line.startsWith('parent ')),parentIds.map(id=>'parent '+id));
  assert(commit.endsWith('public ordered merge'));
  for(const forbidden of [scope.organisation_id,scope.repository_id,scope.security_domain_id,fixture.roles.author.credential_id])assert(!commit.includes(forbidden));
  assert(maxChunk<=4*1024*1024);
  checks.push('actual Git hashing, fsck, cat-file and ls-tree validate deterministic commits, ordered parents, exact binary/chunked content, UTF-8 names, executable and symlink modes, and directory ordering');
  const checkpointWorkspace=randomUUID(),checkpointOperation=randomUUID();
  await client.call('source.workspaces.open',{workspace_id:checkpointWorkspace,base_revision_id:original.revision_id,mode:'API_ONLY',read_paths:['main.txt'],write_paths:['main.txt']});
  const checkpoint=await client.call('source.workspaces.checkpoint',{workspace_id:checkpointWorkspace,operation_id:checkpointOperation,expected_workspace_generation:'1',expected_scope_generation:'1',base_revision_id:original.revision_id,overlay_generation:'1',changes:[]},{operation_id:checkpointOperation,idempotency_key:checkpointOperation});
  const checkpointRevision=await client.revision(checkpoint.revision_id);
  assert.equal(checkpointRevision.descriptor.provenance.author.name,'Hyperfide');
  assert.equal(checkpointRevision.descriptor.provenance.author.email,'');
  const checkpointProjection=await project(checkpoint.revision_id);
  for(const object of checkpointProjection.objects){const parts=[];for await(const chunk of object.content())parts.push(Buffer.from(chunk));assert.equal(git(paths.verify,['hash-object','-w','-t',object.kind,'--stdin'],Buffer.concat(parts)).toString().trim(),raw(object.oid));}
  git(paths.verify,['update-ref','refs/heads/workspace-checkpoint',raw(checkpointProjection.head_oid)]);
  git(paths.verify,['fsck','--full','--strict']);
  const checkpointGit=git(paths.verify,['cat-file','commit',raw(checkpointProjection.head_oid)]).toString();
  assert.match(checkpointGit,/^author Hyperfide <> [0-9]+ \+0000$/m);
  assert.match(checkpointGit,/^committer Hyperfide <> [0-9]+ \+0000$/m);
  for(const author of [{name:'Injected\nName',email:''},{name:'Hyperfide',email:'injected> <address'},{name:' Hyperfide',email:''},{name:'Hyperfide',email:' address@example.invalid'}])
    assert.throws(()=>gitCommitPayload(checkpointProjection.root_tree_oid,[],{...checkpointRevision.descriptor.provenance,author}),error=>error.code==='UNSUPPORTED_GIT_METADATA');
  checks.push('an actual workspace checkpoint preserves Hyperfide with an empty email in Git author and committer fields, passes strict Git fsck, and retains identity injection checks');

  const repeatedProjection=await project(merged.revision_id);
  assert.equal(repeatedProjection.head_oid,cold.head_oid);assert.equal(repeatedProjection.root_tree_oid,cold.root_tree_oid);
  const noChange=await fixture.createRevision({root_tree_id:mergeRoot,parent_revision_ids:[merged.revision_id],message:'public no-content change'});
  const noChangeProjection=await project(noChange.revision_id);assert.notEqual(noChangeProjection.head_oid,cold.head_oid);
  assert.equal(noChangeProjection.root_tree_oid,cold.root_tree_oid);
  await assert.rejects(project(merged.revision_id,{budget:{max_objects:1}}),error=>error.code==='LIMIT_EXCEEDED');
  const readsBeforeDenial=fixture.backend.requests.length;
  await assert.rejects(project(merged.revision_id,{authorize_revision:async()=>{throw new Error('owned source denial');}}),/owned source denial/);
  assert.equal(fixture.backend.requests.length,readsBeforeDenial);
  checks.push('projection preserves content-empty commits and deterministic retry identities, enforces budgets, and denies source before object reads');

  const candidate=await fixture.createCandidate(merged,{domain:await fixture.createDomain(original)});
  const firstQualified=await fixture.qualify(candidate),accepted=await fixture.accept(candidate,firstQualified);
  const publication=async(acceptance,destination='primary',old=null)=>{
    const operation=randomUUID(),input={acceptance_id:acceptance.acceptance_id,destination_id:destination,target_ref:'refs/heads/main',expected_old_oid:old};
    const result=await client.createPublication(input,{operation_id:operation,idempotency_key:operation});return {operation,input,result};
  };
  const rejectedOperation=randomUUID();
  await assert.rejects(client.createPublication({acceptance_id:merged.revision_id,destination_id:'primary',target_ref:'refs/heads/main',expected_old_oid:null},{operation_id:rejectedOperation,idempotency_key:rejectedOperation}),error=>error.code==='NOT_FOUND');
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM hyperfide.source_git_publications WHERE operation_id=$1',[rejectedOperation])).rows[0].count,0);
  const beforeScopeRefusal=fixture.backend.requests.length;
  await assert.rejects(publication(accepted,'foreign'),error=>error.code==='DESTINATION_DENIED');
  assert.equal(fixture.backend.requests.length,beforeScopeRefusal);
  await assert.rejects(publication(accepted,'primary','0'.repeat(40)),error=>error.code==='UNSUPPORTED_GIT_FORMAT');
  const initial=await publication(accepted);assert.equal(initial.result.status,'QUEUED');assert.equal(await originalPrimary.observe('refs/heads/main'),null);
  await assert.rejects(client.call('source.operations.cancel',{operation_id:initial.operation}),error=>error.code==='PUBLICATION_CANCELLATION_REQUIRED');
  await assert.rejects(publication(accepted),error=>error.code==='PUBLICATION_BUSY');
  const first=await client.resumePublication(initial.operation);assert.equal(first.status,'PUBLISHED');assert.equal(first.git_oid,cold.head_oid);
  assert.equal(git(paths.primary,['rev-parse','refs/heads/main']).toString().trim(),head);
  git(paths.primary,['fsck','--full','--strict']);
  assert.deepEqual(await client.publication(initial.operation),first);
  assert.deepEqual(await client.createPublication(initial.input,{operation_id:initial.operation,idempotency_key:initial.operation}),first);
  assert.equal(faults.pushes,1);
  assert.equal((await client.call('source.acceptance.read',{acceptance_id:accepted.acceptance_id})).result_digest,accepted.result_digest);
  checks.push('authenticated publication requires actual native acceptance, admits one unresolved ref mutation, and publishes through real receive-pack with retained operation replay');

  const mirrored=await publication(accepted,'mirror');assert.equal((await client.resumePublication(mirrored.operation)).status,'PUBLISHED');
  assert.equal(git(paths.mirror,['rev-parse','refs/heads/main']).toString().trim(),head);
  assert.deepEqual(git(paths.mirror,['cat-file','blob',head+':chunked.dat']),large);git(paths.mirror,['fsck','--full','--strict']);
  checks.push('a second fresh destination receives the complete object closure despite mappings retained from the first destination');

  const nextRoot=await changes(mergeRoot,[await file('main.txt','candidate: next publication\n'),await file('new.txt','new source bytes\n')]);
  const next=await fixture.createRevision({root_tree_id:nextRoot,parent_revision_ids:[merged.revision_id],message:'public next commit'});
  const confirmed=new Map(cold.mappings.map(mapping=>[mapping.native_kind+':'+mapping.native_id,mapping]));
  const warm=await project(next.revision_id,{lookup_confirmed_mapping:async(kind,id)=>confirmed.get(kind+':'+id)});
  assert(warm.metrics.mappings_reused>0);assert(warm.metrics.entries_visited<32);assert.equal(warm.metrics.directories_read,1);assert(warm.objects.length<8);
  metrics.push({cold:cold.metrics,warm:warm.metrics});
  const nextDomain=await fixture.createDomain(merged),nextCandidate=await fixture.createCandidate(next,{domain:nextDomain}),nextAccepted=await fixture.accept(nextCandidate);
  const ancestorRevokeOperation=randomUUID();await fixture.checkerClient.revokeSourceEvidence(firstQualified.evidence.evidence_id,{operation_id:ancestorRevokeOperation,idempotency_key:ancestorRevokeOperation});
  const second=await publication(nextAccepted,'primary',first.git_oid);
  faults.loseReply=true;
  const uncertain=await client.resumePublication(second.operation);assert.equal(uncertain.status,'OUTCOME_UNKNOWN');
  await assert.rejects(publication(nextAccepted,'primary',warm.head_oid),error=>error.code==='PUBLICATION_BUSY');
  assert.equal(git(paths.primary,['rev-parse','refs/heads/main']).toString().trim(),raw(warm.head_oid));
  const pushed=faults.pushes,recovered=await client.resumePublication(second.operation);
  assert.equal(recovered.status,'PUBLISHED');assert.equal(recovered.git_oid,warm.head_oid);assert.equal(faults.pushes,pushed);
  assert.deepEqual(git(paths.primary,['cat-file','blob',raw(recovered.git_oid)+':new.txt']),Buffer.from('new source bytes\n'));
  checks.push('confirmed mappings skip already published history after its prior evidence is revoked, and an accepted push with a lost response reconciles by exact remote readback without another push');

  const cancelRevision=await fixture.createRevision({root_tree_id:mergeRoot,parent_revision_ids:[],message:'independent cancellation source'});
  const cancelCandidate=await fixture.createCandidate(cancelRevision,{domain:await fixture.createDomain(cancelRevision)});
  const cancelQualified=await fixture.qualify(cancelCandidate),cancelAccepted=await fixture.accept(cancelCandidate,cancelQualified);
  const cancelled=await publication(cancelAccepted,'cancel');const cancelledResult=await client.cancelPublication(cancelled.operation);assert.equal(cancelledResult.status,'CANCELLED');
  assert.equal(await originalCancel.observe('refs/heads/main'),null);
  const inflight=await publication(cancelAccepted,'cancel');faults.barrier={entered:gate(),released:gate()};
  const pending=client.resumePublication(inflight.operation);await faults.barrier.entered.promise;
  const during=await client.publication(inflight.operation);assert.equal(during.status,'DISPATCHED');
  const revokeOperation=randomUUID();await fixture.checkerClient.revokeSourceEvidence(cancelQualified.evidence.evidence_id,{operation_id:revokeOperation,idempotency_key:revokeOperation});
  const cancelDuring=await client.cancelPublication(inflight.operation);assert.equal(cancelDuring.status,'OUTCOME_UNKNOWN');
  faults.barrier.released.release();faults.barrier=null;
  const afterPush=await pending;assert.equal(afterPush.status,'PUBLISHED');
  assert.equal((await client.resumePublication(inflight.operation)).status,'PUBLISHED');
  checks.push('queued cancellation prevents publication while post-dispatch evidence revocation and cancellation preserve reconciliation of actual remote execution');

  const divergence=await publication(nextAccepted,'mirror',first.git_oid);
  const external=git(paths.mirror,['commit-tree',raw(cold.root_tree_oid),'-p',head],Buffer.from('external concurrent update\n')).toString().trim();
  git(paths.mirror,['update-ref','refs/heads/main',external,head]);
  const refused=await client.resumePublication(divergence.operation);assert.equal(refused.status,'REMOTE_DIVERGED');assert.equal(refused.observed_oid,'git:sha1:'+external);
  assert.equal(git(paths.mirror,['rev-parse','refs/heads/main']).toString().trim(),external);
  await assert.rejects(client.createPublication({acceptance_id:accepted.acceptance_id,destination_id:'primary',target_ref:'refs/heads/unconfigured',expected_old_oid:null},{operation_id:randomUUID(),idempotency_key:randomUUID()}),error=>error.code==='DESTINATION_DENIED');
  checks.push('expected-old comparison detects a real external ref advance and configured destination/ref authorization refuses unintended writes');
  const failureRevision=await fixture.createRevision({root_tree_id:root,parent_revision_ids:[],message:'independent transfer failure source'});
  const failureAccepted=await fixture.accept(await fixture.createCandidate(failureRevision,{domain:await fixture.createDomain(failureRevision)}));
  const failedTransfer=await publication(failureAccepted,'failure');
  const unknownTransfer=await client.resumePublication(failedTransfer.operation);assert.equal(unknownTransfer.status,'OUTCOME_UNKNOWN');
  assert.equal((await client.publication(failedTransfer.operation)).status,'OUTCOME_UNKNOWN');
  assert.equal(await originalFailure.observe('refs/heads/main'),null);
  await assert.rejects(publication(failureAccepted,'failure'),error=>error.code==='PUBLICATION_BUSY');
  checks.push('a real source read failure during pack streaming leaves the API alive and retains the unresolved publication and ref reservation');
  const receipt={schema_version:1,status:'PASS',scope:'actual Git object parser and receive-pack, PostgreSQL, native acceptance, authenticated SDK API and SigV4 objects',checks,metrics,git_version:git(paths.verify,['--version']).toString().trim(),hosted_github:'UNRUN',hosted_gitlab:'UNRUN',primary_pushes:faults.pushes,backend_requests:fixture.backend.requests.length};
  const output=path.join(fixture.ROOT,'build/source-control/5.1');await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');process.stdout.write(JSON.stringify(receipt)+'\n');
}finally{if(fixture)await fixture.close();await fs.rm(temporary,{recursive:true,force:true});}
