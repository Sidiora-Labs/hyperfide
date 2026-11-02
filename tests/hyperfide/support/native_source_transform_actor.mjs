import assert from 'node:assert/strict';
import {generateKeyPairSync,randomBytes,randomUUID,sign} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import pg from '../../../core/control-plane/node_modules/pg/lib/index.js';
import {createSourceS3Fixture} from '../cases/source_control/fixtures/objects/backend.mjs';

const ROOT=fileURLToPath(new URL('../../../',import.meta.url));
const moduleRoot=process.env.SOURCE_CONTROL_MODULE_ROOT;
assert(moduleRoot&&process.env.SOURCE_CONTROL_SDK_MODULE_ROOT);
const load=name=>import(pathToFileURL(path.join(moduleRoot,name+'.js')));
const [{createSourceService},{startSourceHttp},{S3SourceObjectBackend},{SourceMergeEngine},{SOURCE_ACTIONS,SOURCE_API_PATH},{SourceControlClient},{verifySourcePrincipalToken},{authorizeSource}]=await Promise.all([
  load('registration'),load('http'),load('s3'),load('merge'),load('contracts'),
  import(pathToFileURL(path.join(process.env.SOURCE_CONTROL_SDK_MODULE_ROOT,'client.js'))),load('authentication'),load('capabilities'),
]);
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:12});
const fixture=await createSourceS3Fixture(),controller=new AbortController();
const scope={organisation_id:randomUUID(),repository_id:randomUUID(),security_domain_id:randomUUID()};
const principal_id=randomUUID(),credential_id=randomUUID(),capability_id=randomUUID(),policy='native-transform-case-v1';
const {privateKey,publicKey}=generateKeyPairSync('ed25519');
const trust={issuer:'owned-transform-test',audience:'native-source-transform',keys:{'owned-transform-key':publicKey},max_ttl_seconds:300};
const checks=[],metrics=[];
let server;
const provenance=message=>({author:{name:'Native transformation integration',email:'source-transform@example.invalid'},message,timestamp:'2026-11-02T00:00:00.000Z'});
function tokenFor(capability=capability_id){
  const now=Math.floor(Date.now()/1000),header=Buffer.from(JSON.stringify({alg:'EdDSA',kid:'owned-transform-key',typ:'HF-SOURCE-1'})).toString('base64url');
  const payload=Buffer.from(JSON.stringify({schema_version:1,iss:trust.issuer,aud:trust.audience,sub:principal_id,credential_id,credential_version:'1',principal_kind:'automation',scope,iat:now,nbf:now,exp:now+290,capability_id:capability})).toString('base64url');
  return header+'.'+payload+'.'+sign(null,Buffer.from(header+'.'+payload),privateKey).toString('base64url');
}
try{
  await pool.query('CREATE SCHEMA hyperfide');
  for(const migration of JSON.parse(process.env.SOURCE_CONTROL_MIGRATIONS))await pool.query(await fs.readFile(path.join(ROOT,'core/control-plane/migrations',migration),'utf8'));
  await pool.query('INSERT INTO hyperfide.source_authority_domains(organisation_id,repository_id,security_domain_id,authority_epoch,policy_version) VALUES($1,$2,$3,1,$4)',[...Object.values(scope),policy]);
  await pool.query(`INSERT INTO hyperfide.source_principal_credentials(organisation_id,repository_id,security_domain_id,credential_id,principal_id,principal_kind,credential_version,issuer,audience,signing_key_id,expires_at)
    VALUES($1,$2,$3,$4,$5,'automation',1,$6,$7,'owned-transform-key',clock_timestamp()+interval '10 minutes')`,[...Object.values(scope),credential_id,principal_id,trust.issuer,trust.audience]);
  await pool.query(`INSERT INTO hyperfide.source_capabilities(organisation_id,repository_id,security_domain_id,id,principal_id,credential_id,principal_kind,authority_epoch,policy_version,actions,path_prefixes,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,'automation',1,$7,$8,ARRAY[''],clock_timestamp()+interval '10 minutes')`,[...Object.values(scope),capability_id,principal_id,credential_id,policy,[...SOURCE_ACTIONS]]);
  const service=createSourceService({pool,backend:new S3SourceObjectBackend(fixture.config),cursorKey:randomBytes(32),workspaceBudgets:{cache_bytes:16777216,max_cache_entries:1024,max_file_bytes:8388608,materialized_bytes:33554432,dirty_bytes:8388608}});
  await service.metadata.registerRepository(scope,{authority_epoch:'1',policy_version:policy,durability_profile:'single-region-verified-s3-v1'});
  server=await startSourceHttp({api:service.api,trust,host:'127.0.0.1',port:0,allowLoopbackHTTP:true,signal:controller.signal});
  const endpoint=server.address+SOURCE_API_PATH,client=new SourceControlClient({endpoint,scope,token:()=>tokenFor(),timeout_ms:120000});
  const call=(action,input,options={})=>{
    if(action==='source.transforms.merge')return client.merge(input,options);
    if(action==='source.transforms.rebase')return client.rebase(input,options);
    if(action==='source.transforms.revert')return client.revert(input,options);
    if(action==='source.transforms.read')return client.transformation(input.operation_id,options);
    if(action==='source.transforms.resume')return client.resumeTransformation(input,options);
    return client.call(action,input,options);
  };
  const file=async text=>(await service.objects.putFile(scope,Buffer.isBuffer(text)?text:Buffer.from(text))).object_id;
  const entry=async(name,text,mode='100644')=>({name,kind:'file',mode,object_id:await file(text)});
  const tree=async entries=>(await service.trees.fromEntries(scope,entries)).root_tree_id;
  const patch=async(root,changes)=>(await service.trees.apply(scope,root,changes)).root_tree_id;
  const replace=async(root,name,text,mode='100644')=>patch(root,[{path:name,entry:await entry(name.split('/').at(-1),text,mode)}]);
  const content=async(root,name)=>{
    const found=await service.trees.lookup(scope,root,name);assert(found,'Expected retained source path '+name);
    return (await service.objects.readFile(scope,found.object_id)).toString('utf8');
  };
  const revision=async(root,parents=[],change_id=randomUUID(),message='native fixture')=>{
    const operation=randomUUID();
    const receipt=await client.createRevision({change_id,root_tree_id:root,parent_revision_ids:parents,predecessor_revision_ids:[],provenance:provenance(message)},{operation_id:operation,idempotency_key:operation});
    return {...receipt,change_id};
  };
  const transform=async(kind,input,options={})=>{
    const operation=options.operation_id??randomUUID();
    return {operation,input,result:await call('source.transforms.'+kind,input,{operation_id:operation,idempotency_key:operation,...options})};
  };
  const engine=new SourceMergeEngine(service.objects,service.trees);
  const baseText='alpha\nbeta\ngamma\ndelta\n',oursText='ALPHA\nbeta\ngamma\ndelta\n',theirsText='alpha\nbeta\ngamma\nDELTA\n',mergedText='ALPHA\nbeta\ngamma\nDELTA\n';
  const baseRoot=await tree([await entry('main.txt',baseText),await entry('untouched.txt','retained\n')]);
  const oursRoot=await replace(baseRoot,'main.txt',oursText),theirsRoot=await replace(baseRoot,'main.txt',theirsText);
  const [base]=await Promise.all([revision(baseRoot,[],randomUUID(),'base')]);
  const ours=await revision(oursRoot,[base.revision_id],randomUUID(),'ours'),theirs=await revision(theirsRoot,[base.revision_id],randomUUID(),'theirs');
  const merged=await transform('merge',{ours_revision_id:ours.revision_id,theirs_revision_id:theirs.revision_id,change_id:randomUUID(),provenance:provenance('merge independent lines')});
  assert.equal(merged.result.status,'COMPLETED');
  assert.equal(await content(merged.result.receipt.root_tree_id,'main.txt'),mergedText);
  assert.equal(await content(merged.result.receipt.root_tree_id,'untouched.txt'),'retained\n');
  assert.deepEqual((await client.revision(merged.result.receipt.revision_id)).parent_revision_ids,[ours.revision_id,theirs.revision_id]);
  assert.deepEqual(await call('source.transforms.merge',merged.input,{operation_id:merged.operation,idempotency_key:merged.operation}),merged.result);
  await assert.rejects(call('source.transforms.merge',{...merged.input,change_id:randomUUID()},{operation_id:merged.operation,idempotency_key:merged.operation}),error=>error.code==='IDEMPOTENCY_CONFLICT');
  checks.push('authenticated API merges independent text edits, preserves untouched source and exact parents, and binds deterministic replay to its original request');

  const conflictCases=[
    {name:'same-line text',base:baseText,ours:oursText,theirs:'alpha-other\nbeta\ngamma\ndelta\n',kind:'TEXT'},
    {name:'binary content',base:Buffer.from([0,1]),ours:Buffer.from([0,2]),theirs:Buffer.from([0,3]),kind:'BINARY'},
    {name:'concurrent add',base:null,ours:'first\n',theirs:'second\n',kind:'ADD_ADD'},
    {name:'delete versus modify',base:'before\n',ours:null,theirs:'after\n',kind:'DELETE_MODIFY'},
  ];
  const conflictProof=[];
  for(const sample of conflictCases){
    const roots=[];
    for(const bytes of [sample.base,sample.ours,sample.theirs])roots.push(await tree(bytes===null?[]:[await entry('entry',bytes)]));
    const input={base_tree_id:roots[0],ours_tree_id:roots[1],theirs_tree_id:roots[2]};
    const result=await engine.merge(scope,input);
    assert.equal(result.root_tree_id,null,sample.name);assert.equal(result.conflicts.length,1,sample.name);
    assert.equal(result.conflicts[0].kind,sample.kind,sample.name);assert.equal(result.conflicts[0].path,'entry');
    assert.deepEqual(await engine.merge(scope,input),result,sample.name+' deterministic result');
    conflictProof.push({name:sample.name,kind:result.conflicts[0].kind});
  }
  const nested=await tree([await entry('child','nested\n')]);
  const typeRoots=[await tree([await entry('entry','original\n')]),await tree([{name:'entry',kind:'directory',mode:'040000',object_id:nested}]),await tree([await entry('entry','modified\n')])];
  const typeResult=await engine.merge(scope,{base_tree_id:typeRoots[0],ours_tree_id:typeRoots[1],theirs_tree_id:typeRoots[2]});
  assert.equal(typeResult.conflicts[0].kind,'DIRECTORY_FILE');assert.equal(typeResult.root_tree_id,null);
  const link=async target=>({name:'entry',kind:'symlink',mode:'120000',object_id:(await service.objects.put(scope,'blob',Buffer.from(target))).object_id});
  const linkRoots=[];for(const target of ['base','ours','theirs'])linkRoots.push(await tree([await link(target)]));
  const linkResult=await engine.merge(scope,{base_tree_id:linkRoots[0],ours_tree_id:linkRoots[1],theirs_tree_id:linkRoots[2]});
  assert.equal(linkResult.conflicts[0].kind,'SYMLINK');assert.equal(linkResult.root_tree_id,null);
  const typeLinkRoot=await tree([await link('new-target')]);
  const entryType=await engine.merge(scope,{base_tree_id:typeRoots[0],ours_tree_id:typeLinkRoot,theirs_tree_id:typeRoots[2]});
  assert.equal(entryType.root_tree_id,null);assert.equal(entryType.conflicts[0].kind,'ENTRY_TYPE');
  const executableRoot=await replace(baseRoot,'main.txt',baseText,'100755');
  const modeMerge=await engine.merge(scope,{base_tree_id:baseRoot,ours_tree_id:executableRoot,theirs_tree_id:theirsRoot});
  assert(modeMerge.root_tree_id);assert.equal((await service.trees.lookup(scope,modeMerge.root_tree_id,'main.txt')).mode,'100755');
  assert.equal(await content(modeMerge.root_tree_id,'main.txt'),theirsText);
  const modeConflictFile=await file('same executable contents\n'),modeConflictBase=await tree([]);
  const modeConflictRoots=await Promise.all(['100644','100755'].map(mode=>tree([{name:'entry',kind:'file',mode,object_id:modeConflictFile}])));
  const modeConflict=await engine.merge(scope,{base_tree_id:modeConflictBase,ours_tree_id:modeConflictRoots[0],theirs_tree_id:modeConflictRoots[1]});
  assert.equal(modeConflict.root_tree_id,null);assert.equal(modeConflict.conflicts[0].kind,'EXECUTABLE_MODE');
  checks.push('typed immutable conflicts distinguish text, binary, add/add, delete/modify, directory/file, symlink and executable mode conflicts; independent mode and content edits compose');

  const shared=await file('unchanged\n');
  for(const size of [512,4096]){
    const entries=Array.from({length:size},(_,index)=>({name:'p'+index.toString(16).padStart(4,'0'),kind:'file',mode:'100644',object_id:shared}));
    const root=await tree(entries),left=await replace(root,'p0001','left\n'),right=await replace(root,'p0002','right\n');
    const result=await engine.merge(scope,{base_tree_id:root,ours_tree_id:left,theirs_tree_id:right});
    assert(result.root_tree_id);assert.equal(await content(result.root_tree_id,'p0001'),'left\n');assert.equal(await content(result.root_tree_id,'p0002'),'right\n');
    assert.equal(await content(result.root_tree_id,'p0003'),'unchanged\n');
    assert.equal(result.rename_detection.status,'NOT_PERFORMED');metrics.push({entries:size,...result.metrics});
  }
  assert(metrics[1].nodes_read<=metrics[0].nodes_read+32,JSON.stringify(metrics));
  assert(metrics[1].entries_compared<=metrics[0].entries_compared+512,JSON.stringify(metrics));
  checks.push('a fixed two-path merge skips identical radix subtrees as an untouched directory grows from 512 to4096 entries');

  const step1=await revision(oursRoot,[base.revision_id],randomUUID(),'stack first');
  const step2Root=await replace(oursRoot,'next.txt','stack second\n'),step2=await revision(step2Root,[step1.revision_id],randomUUID(),'stack second');
  const rebased=await transform('rebase',{revision_ids:[step1.revision_id,step2.revision_id],onto_revision_id:theirs.revision_id,max_steps:1});
  assert.equal(rebased.result.status,'PENDING');assert.equal(rebased.result.mappings.length,1);
  await assert.rejects(call('source.transforms.resume',{operation_id:rebased.operation,expected_generation:'999'}),error=>error.code==='STALE_TRANSFORMATION');
  const resumedTwice=await Promise.all([call('source.transforms.resume',{operation_id:rebased.operation,max_steps:1}),call('source.transforms.resume',{operation_id:rebased.operation,max_steps:1})]);
  assert.deepEqual(resumedTwice[0],resumedTwice[1]);
  const rebasedDone=resumedTwice[0];
  assert.equal(rebasedDone.status,'COMPLETED');assert.equal(rebasedDone.mappings.length,2);
  assert.deepEqual(rebasedDone.mappings.map(item=>[item.original_revision_id,item.change_id]),[[step1.revision_id,step1.change_id],[step2.revision_id,step2.change_id]]);
  const successor=await client.revision(rebasedDone.mappings[1].successor_revision_id);
  assert.deepEqual(successor.parent_revision_ids,[rebasedDone.mappings[0].successor_revision_id]);
  assert.equal(await content(successor.root_tree_id,'main.txt'),mergedText);assert.equal(await content(successor.root_tree_id,'next.txt'),'stack second\n');
  assert.deepEqual((await client.revision(step2.revision_id)).parent_revision_ids,[step1.revision_id]);
  const memberships=await call('source.changes.revisions',{change_id:step1.change_id});
  assert(memberships.revisions.some(item=>item.revision_id===step1.revision_id));
  assert(memberships.revisions.some(item=>item.revision_id===rebasedDone.mappings[0].successor_revision_id&&item.predecessor_revision_ids.includes(step1.revision_id)));
  const noOp=await transform('rebase',{revision_ids:[step1.revision_id],onto_revision_id:base.revision_id});
  assert.equal(noOp.result.status,'COMPLETED');assert.equal(noOp.result.mappings[0].successor_revision_id,step1.revision_id);assert.equal(noOp.result.mappings[0].unchanged,true);
  const repeated=await transform('rebase',{revision_ids:[step1.revision_id,step2.revision_id],onto_revision_id:theirs.revision_id});
  assert.equal(repeated.result.status,'COMPLETED');assert.deepEqual(repeated.result.mappings.map(item=>item.successor_revision_id),rebasedDone.mappings.map(item=>item.successor_revision_id));
  checks.push('concurrent bounded rebase resumes commit one durable stack, preserves change identities and predecessor mappings, reuses no-op revisions and retains original descendants');
  const step3Root=await replace(step2Root,'third.txt','stack third\n'),step3=await revision(step3Root,[step2.revision_id],randomUUID(),'stack third');
  const compareAndSwap=await transform('rebase',{revision_ids:[step1.revision_id,step2.revision_id,step3.revision_id],onto_revision_id:theirs.revision_id,max_steps:1});
  const resumeRace=await Promise.allSettled([1,2].map(()=>call('source.transforms.resume',{operation_id:compareAndSwap.operation,max_steps:1,expected_generation:compareAndSwap.result.generation})));
  assert.equal(resumeRace.filter(item=>item.status==='fulfilled').length,1);
  assert.equal(resumeRace.find(item=>item.status==='rejected').reason.code,'STALE_TRANSFORMATION');
  const afterResumeRace=await call('source.transforms.read',{operation_id:compareAndSwap.operation});
  assert.equal(afterResumeRace.next_step,2);assert.equal(afterResumeRace.generation,String(BigInt(compareAndSwap.result.generation)+1n));
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM hyperfide.source_transformation_steps WHERE operation_id=$1',[compareAndSwap.operation])).rows[0].count,2);
  assert.equal((await call('source.transforms.resume',{operation_id:compareAndSwap.operation})).status,'COMPLETED');
  const malformedOperation=randomUUID();
  await assert.rejects(call('source.transforms.merge',{...merged.input,budget:{max_nodes:0}},{operation_id:malformedOperation,idempotency_key:malformedOperation}),error=>error.code==='INVALID_REQUEST');
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM hyperfide.source_metadata_operations WHERE operation_id=$1',[malformedOperation])).rows[0].count,0);
  const beforeNullResolution=await call('source.transforms.read',{operation_id:compareAndSwap.operation});
  await assert.rejects(call('source.transforms.resume',{operation_id:compareAndSwap.operation,resolution:null}),error=>error.code==='INVALID_REQUEST');
  assert.deepEqual(await call('source.transforms.read',{operation_id:compareAndSwap.operation}),beforeNullResolution);
  checks.push('same-generation concurrent resumes advance exactly one step; malformed merge budgets and null resolutions have no durable effects');

  const conflictingRoot=await replace(baseRoot,'main.txt','different first\nbeta\ngamma\ndelta\n');
  const conflictingOnto=await revision(conflictingRoot,[base.revision_id],randomUUID(),'conflicting onto');
  const cleanRoot=await replace(baseRoot,'added.txt','retained from first stack step\n'),cleanStep=await revision(cleanRoot,[base.revision_id],randomUUID(),'clean stack step');
  const conflictStepRoot=await replace(cleanRoot,'main.txt',oursText),conflictStep=await revision(conflictStepRoot,[cleanStep.revision_id],randomUUID(),'conflicting stack step');
  const partial=await transform('rebase',{revision_ids:[cleanStep.revision_id,conflictStep.revision_id],onto_revision_id:conflictingOnto.revision_id,max_steps:1});
  assert.equal(partial.result.status,'PENDING');
  const stopped=await call('source.transforms.resume',{operation_id:partial.operation,max_steps:1});
  assert.equal(stopped.status,'CONFLICT');assert.equal(stopped.mappings.length,1);assert(stopped.conflict_id);assert.equal(stopped.conflicts[0].kind,'TEXT');
  assert.deepEqual(await call('source.transforms.read',{operation_id:partial.operation}),stopped);
  const retainedSuccessor=await client.revision(stopped.mappings[0].successor_revision_id),resolvedRoot=await replace(retainedSuccessor.root_tree_id,'main.txt','resolved first\nbeta\ngamma\ndelta\n');
  const resolved=await call('source.transforms.resume',{operation_id:partial.operation,resolution:{conflict_id:stopped.conflict_id,resolved_tree_id:resolvedRoot,provenance:provenance('explicit resolution')}});
  assert.equal(resolved.status,'COMPLETED');assert.equal(resolved.mappings.length,2);
  const resolvedRevision=await client.revision(resolved.mappings[1].successor_revision_id);
  assert.equal(await content(resolvedRevision.root_tree_id,'main.txt'),'resolved first\nbeta\ngamma\ndelta\n');
  assert.equal(await content(resolvedRevision.root_tree_id,'added.txt'),'retained from first stack step\n');
  assert.deepEqual(await call('source.transforms.resume',{operation_id:partial.operation,resolution:{conflict_id:stopped.conflict_id,resolved_tree_id:resolvedRoot,provenance:provenance('explicit resolution')}}),resolved);
  await assert.rejects(call('source.transforms.resume',{operation_id:partial.operation,resolution:{conflict_id:stopped.conflict_id,resolved_tree_id:retainedSuccessor.root_tree_id,provenance:provenance('explicit resolution')}}),error=>error.code==='IDEMPOTENCY_CONFLICT');
  checks.push('conflicting rebase exposes its retained partial stack and accepts an explicit conflict-bound resolved tree as a new successor revision');

  const cancelled=await transform('rebase',{revision_ids:[step1.revision_id,step2.revision_id],onto_revision_id:theirs.revision_id,max_steps:1});
  assert.equal(cancelled.result.status,'PENDING');
  const beforeCancel=(await pool.query('SELECT count(*)::int AS count FROM hyperfide.source_revisions')).rows[0].count;
  assert.equal((await call('source.operations.cancel',{operation_id:cancelled.operation})).disposition,'CANCELLED');
  const cancelledResult=await call('source.transforms.resume',{operation_id:cancelled.operation});assert.equal(cancelledResult.status,'CANCELLED');
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM hyperfide.source_revisions')).rows[0].count,beforeCancel);
  checks.push('cancellation fences the remaining durable rebase steps without deleting already committed predecessors');
  const raceOnto=await revision(theirsRoot,[base.revision_id],randomUUID(),'cancel race onto');
  const raced=await transform('rebase',{revision_ids:[step1.revision_id,step2.revision_id],onto_revision_id:raceOnto.revision_id,max_steps:1});
  await Promise.allSettled([call('source.transforms.resume',{operation_id:raced.operation}),call('source.operations.cancel',{operation_id:raced.operation})]);
  const racedFinal=await call('source.transforms.read',{operation_id:raced.operation}),racedOperation=await client.operation(raced.operation);
  assert(['COMPLETED','CANCELLED'].includes(racedFinal.status));
  assert.equal(racedOperation.state,racedFinal.status==='COMPLETED'?'SUCCEEDED':'CANCELLED');
  assert.equal(racedFinal.mappings.length,racedFinal.status==='COMPLETED'?2:1);
  checks.push('a real concurrent cancel-versus-step-commit race has one consistent terminal outcome and retained mapping count');

  const revertInput={revision_id:merged.result.receipt.revision_id,onto_revision_id:merged.result.receipt.revision_id,change_id:randomUUID(),provenance:provenance('revert merge')};
  await assert.rejects(transform('revert',revertInput),error=>error.code==='MAINLINE_REQUIRED');
  const reverted=await transform('revert',{...revertInput,mainline_parent_revision_id:ours.revision_id});
  assert.equal(reverted.result.status,'COMPLETED');assert.equal(reverted.result.receipt.root_tree_id,oursRoot);
  assert.deepEqual((await client.revision(reverted.result.receipt.revision_id)).parent_revision_ids,[merged.result.receipt.revision_id]);
  await assert.rejects(transform('revert',{...revertInput,mainline_parent_revision_id:base.revision_id}),error=>error.code==='INVALID_MAINLINE');
  checks.push('revert of a merge requires one of its exact parents and applies the inverse relative to that explicit mainline');

  const crossLeft=await revision(oursRoot,[ours.revision_id,theirs.revision_id],randomUUID(),'crisscross left');
  const crossRight=await revision(theirsRoot,[theirs.revision_id,ours.revision_id],randomUUID(),'crisscross right');
  const multipleInput={ours_revision_id:crossLeft.revision_id,theirs_revision_id:crossRight.revision_id,change_id:randomUUID(),provenance:provenance('multiple bases')};
  await assert.rejects(transform('merge',multipleInput),error=>error.code==='MULTIPLE_MERGE_BASES');
  await assert.rejects(transform('merge',{...multipleInput,base_revision_id:base.revision_id}),error=>error.code==='INVALID_MERGE_BASE');
  const selectedBase=await transform('merge',{...multipleInput,base_revision_id:ours.revision_id});
  assert.equal(selectedBase.result.status,'COMPLETED');assert.equal(selectedBase.result.receipt.root_tree_id,theirsRoot);
  assert.equal(selectedBase.result.merge_base_ids.length,2);
  const unrelated=await revision(baseRoot,[],randomUUID(),'unrelated root');
  await assert.rejects(transform('merge',{...multipleInput,ours_revision_id:ours.revision_id,theirs_revision_id:unrelated.revision_id}),error=>error.code==='UNRELATED_HISTORIES');
  checks.push('crisscross histories require an explicit maximal merge base and unrelated histories are refused');
  const authenticatedPrincipal=verifySourcePrincipalToken(tokenFor(),trust,scope);
  const seedContext=await service.metadata.transaction(tx=>authorizeSource(tx,{principal:authenticatedPrincipal,scope,action:'source.revisions.create',mutation:true}));
  let trunk=base.revision_id;
  await service.metadata.transaction(async tx=>{
    for(let index=0;index<5000;index++){
      const operation=randomUUID(),receipt=await service.metadata.createRevisionInTransaction(tx,seedContext,{operation_id:operation,idempotency_key:operation,change_id:randomUUID(),root_tree_id:baseRoot,parent_revision_ids:[trunk],predecessor_revision_ids:[],provenance:provenance('long shared trunk '+index)});
      trunk=receipt.revision_id;
    }
  });
  const trunkLeft=await revision(oursRoot,[trunk],randomUUID(),'long trunk left'),trunkRight=await revision(theirsRoot,[trunk],randomUUID(),'long trunk right');
  const boundedAncestry=await transform('merge',{ours_revision_id:trunkLeft.revision_id,theirs_revision_id:trunkRight.revision_id,change_id:randomUUID(),provenance:provenance('bounded merge base')});
  assert.equal(boundedAncestry.result.status,'COMPLETED');assert.deepEqual(boundedAncestry.result.merge_base_ids,[trunk]);
  assert.equal(await content(boundedAncestry.result.receipt.root_tree_id,'main.txt'),mergedText);
  checks.push('merge-base discovery cuts a shared 5000-revision trunk and succeeds within its bounded ancestry traversal');
  const commonMerge=await revision(baseRoot,[trunk,base.revision_id],randomUUID(),'shared trunk merge commit');
  const commonLeft=await revision(oursRoot,[commonMerge.revision_id],randomUUID(),'shared merge left'),commonRight=await revision(theirsRoot,[commonMerge.revision_id],randomUUID(),'shared merge right');
  const mergeFrontier=await transform('merge',{ours_revision_id:commonLeft.revision_id,theirs_revision_id:commonRight.revision_id,change_id:randomUUID(),provenance:provenance('bounded common merge frontier')});
  assert.equal(mergeFrontier.result.status,'COMPLETED');assert.deepEqual(mergeFrontier.result.merge_base_ids,[commonMerge.revision_id]);
  assert.equal(await content(mergeFrontier.result.receipt.root_tree_id,'main.txt'),mergedText);
  checks.push('merge-base discovery also cuts a shared merge-commit frontier before expanding its long retained ancestry');

  let lose=true;
  const interrupted=new SourceControlClient({endpoint,scope,token:()=>tokenFor(),fetch:async(...args)=>{const response=await fetch(...args);if(lose){lose=false;await response.arrayBuffer();throw new TypeError('controlled transformation response loss');}return response;}});
  const lostOperation=randomUUID(),lostInput={ours_revision_id:ours.revision_id,theirs_revision_id:theirs.revision_id,change_id:randomUUID(),provenance:provenance('lost transform reply')};
  await assert.rejects(interrupted.merge(lostInput,{operation_id:lostOperation,idempotency_key:lostOperation}),error=>error.code==='OUTCOME_UNKNOWN'&&error.details.operation_id===lostOperation);
  const retained=await call('source.transforms.read',{operation_id:lostOperation});assert.equal(retained.status,'COMPLETED');
  assert.deepEqual(await call('source.transforms.merge',lostInput,{operation_id:lostOperation,idempotency_key:lostOperation}),retained);
  const lostReceipt=await client.operation(lostOperation);assert.equal(lostReceipt.state,'SUCCEEDED');assert.deepEqual(lostReceipt.result,retained);
  checks.push('lost transformation acknowledgment resolves the same retained operation and retries do not create another result');

  const restrictedCapability=randomUUID();
  await pool.query(`INSERT INTO hyperfide.source_capabilities(organisation_id,repository_id,security_domain_id,id,principal_id,credential_id,principal_kind,authority_epoch,policy_version,actions,path_prefixes,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,'automation',1,$7,$8,ARRAY['allowed'],clock_timestamp()+interval '10 minutes')`,[...Object.values(scope),restrictedCapability,principal_id,credential_id,policy,[...SOURCE_ACTIONS]]);
  const restricted=new SourceControlClient({endpoint,scope,token:()=>tokenFor(restrictedCapability)}),beforeDenied=fixture.requests.length;
  await assert.rejects(restricted.call('source.transforms.merge',merged.input,{operation_id:randomUUID(),idempotency_key:randomUUID()}),error=>error.code==='SCOPE_DENIED');
  assert.equal(fixture.requests.length,beforeDenied);
  checks.push('a path-restricted capability cannot authorize repository-wide transformation or cause a backend existence read');
  const receipt={schema_version:1,status:'PASS',scope:'real PostgreSQL, Ed25519 API and SDK, SigV4 backend, production merge/rebase/revert',checks,conflicts:conflictProof,merge_metrics:metrics,backend_requests:fixture.requests.length};
  const output=path.join(ROOT,'build/source-control/3.1');await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');
  console.log(JSON.stringify(receipt));
}finally{
  if(server)await server.close();controller.abort();await pool.end();await fixture.close();
}
