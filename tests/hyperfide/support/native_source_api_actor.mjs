import assert from 'node:assert/strict';
import {createHash,createHmac,generateKeyPairSync,randomBytes,randomUUID,sign} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import pg from '../../../core/control-plane/node_modules/pg/lib/index.js';
import {createSourceS3Fixture} from '../cases/source_control/fixtures/objects/backend.mjs';

const ROOT=fileURLToPath(new URL('../../../',import.meta.url));
const moduleRoot=process.env.SOURCE_CONTROL_MODULE_ROOT;
assert(moduleRoot&&process.env.SOURCE_CONTROL_SDK_MODULE_ROOT,'The owned native source fixture must compile the actual service and SDK');
const load=name=>import(pathToFileURL(path.join(moduleRoot,name+'.js')));
const [{createSourceService},{startSourceHttp},{S3SourceObjectBackend},{SOURCE_ACTIONS,SOURCE_API_PATH},{SourceControlClient}]=await Promise.all([
  load('registration'),load('http'),load('s3'),load('contracts'),
  import(pathToFileURL(path.join(process.env.SOURCE_CONTROL_SDK_MODULE_ROOT,'client.js'))),
]);
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:12});
const fixture=await createSourceS3Fixture(),controller=new AbortController(),workingDirectory=await fs.mkdtemp(path.join(os.tmpdir(),'hf-source-api-client-'));
let server;
const checks=[];
const API_ACTIONS=['source.capabilities','source.objects.put','source.objects.read','source.objects.inspect','source.trees.patch','source.trees.lookup','source.trees.entries','source.revisions.create','source.revisions.read','source.changes.revisions','source.operations.read','source.operations.cancel','source.queries.ancestry','source.queries.merge-bases','source.queries.diff','source.queries.line-map','source.queries.blame','source.queries.history','source.workspaces.open','source.workspaces.detail','source.workspaces.widen','source.workspaces.checkpoint'];
assert(API_ACTIONS.every(action=>SOURCE_ACTIONS.includes(action)));
const scope={organisation_id:randomUUID(),repository_id:randomUUID(),security_domain_id:randomUUID()};
const principal_id=randomUUID(),credential_id=randomUUID(),capability_id=randomUUID(),policy='source-api-case-v1';
const {privateKey,publicKey}=generateKeyPairSync('ed25519');
const trust={issuer:'owned-source-test',audience:'native-source-api',keys:{'owned-source-key':publicKey},max_ttl_seconds:300};
const sha=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const canonical=value=>Buffer.from(JSON.stringify(value));
function tokenFor(tokenScope=scope,changes={}) {
  const now=Math.floor(Date.now()/1000),header=Buffer.from(JSON.stringify({alg:'EdDSA',kid:'owned-source-key',typ:'HF-SOURCE-1'})).toString('base64url');
  const payload=Buffer.from(JSON.stringify({schema_version:1,iss:trust.issuer,aud:trust.audience,sub:principal_id,credential_id,credential_version:'1',principal_kind:'automation',scope:tokenScope,iat:now,nbf:now,exp:now+290,capability_id,...changes})).toString('base64url');
  return header+'.'+payload+'.'+sign(null,Buffer.from(header+'.'+payload),privateKey).toString('base64url');
}
try {
  await pool.query('CREATE SCHEMA hyperfide');
  for(const migration of JSON.parse(process.env.SOURCE_CONTROL_MIGRATIONS))await pool.query(await fs.readFile(path.join(ROOT,'core/control-plane/migrations',migration),'utf8'));
  await pool.query('INSERT INTO hyperfide.source_authority_domains(organisation_id,repository_id,security_domain_id,authority_epoch,policy_version) VALUES($1,$2,$3,1,$4)',[...Object.values(scope),policy]);
  await pool.query(`INSERT INTO hyperfide.source_principal_credentials(organisation_id,repository_id,security_domain_id,credential_id,principal_id,principal_kind,credential_version,issuer,audience,signing_key_id,expires_at)
    VALUES($1,$2,$3,$4,$5,'automation',1,$6,$7,'owned-source-key',clock_timestamp()+interval '10 minutes')`,[...Object.values(scope),credential_id,principal_id,trust.issuer,trust.audience]);
  await pool.query(`INSERT INTO hyperfide.source_capabilities(organisation_id,repository_id,security_domain_id,id,principal_id,credential_id,principal_kind,authority_epoch,policy_version,actions,path_prefixes,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,'automation',1,$7,$8,ARRAY[''],clock_timestamp()+interval '10 minutes')`,[...Object.values(scope),capability_id,principal_id,credential_id,policy,API_ACTIONS]);
  const cursorKey=randomBytes(32);
  const service=createSourceService({pool,backend:new S3SourceObjectBackend(fixture.config),cursorKey,workspaceBudgets:{cache_bytes:16*1024*1024,max_cache_entries:1024,max_file_bytes:8*1024*1024,materialized_bytes:32*1024*1024,dirty_bytes:8*1024*1024}});
  await service.metadata.registerRepository(scope,{authority_epoch:'1',policy_version:policy,durability_profile:'single-region-verified-s3-v1'});
  server=await startSourceHttp({api:service.api,trust,host:'127.0.0.1',port:0,allowLoopbackHTTP:true,signal:controller.signal});
  process.chdir(workingDirectory);
  assert.deepEqual(await fs.readdir(workingDirectory),[]);
  const endpoint=server.address+SOURCE_API_PATH,client=new SourceControlClient({endpoint,scope,token:()=>tokenFor(),timeout_ms:30000});
  const call=(action,input,options={})=>client.call(action,input,options);
  const put=async(kind,bytes)=>call('source.objects.put',{kind,payload_base64:Buffer.from(bytes).toString('base64')});
  const file=async bytes=>{const blob=await put('blob',bytes);return put('file',canonical([1,String(bytes.length),sha(bytes),['blob',blob.object_id]]));};
  const revision=async(root,parent=[],change=randomUUID(),predecessors=[])=>{
    const operation=randomUUID(),input={change_id:change,root_tree_id:root,parent_revision_ids:parent,predecessor_revision_ids:predecessors,
      provenance:{author:{name:'Source API integration',email:'source-api@example.invalid'},message:'Native source test commit',timestamp:new Date().toISOString()}};
    return {result:await call('source.revisions.create',input,{operation_id:operation,idempotency_key:operation}),operation,input};
  };
  const discovered=await client.capabilities();
  assert(discovered.actions.includes('source.revisions.create')&&discovered.actions.includes('source.queries.diff'));
  checks.push('authenticated taskless HTTP discovery advertises actual installed source operations');
  const firstBytes=Buffer.from('shared\nold\nlast\n'),secondBytes=Buffer.from('shared\nnew\nlast\n'),privateBytes=Buffer.from('retained outside sparse selection\n');
  const [firstFile,privateFile]=await Promise.all([file(firstBytes),file(privateBytes)]);
  const symlink=await put('blob',Buffer.from('main.ts'));
  const empty=await put('tree-leaf',canonical([1,'',[]]));
  const initial=await call('source.trees.patch',{tree_id:empty.object_id,patches:[
    {path:'src/main.ts',operation:'put',kind:'file',mode:'100755',object_id:firstFile.object_id},
    {path:'src/link',operation:'put',kind:'symlink',mode:'120000',object_id:symlink.object_id},
    {path:'private/kept.txt',operation:'put',kind:'file',mode:'100644',object_id:privateFile.object_id},
  ]});
  const base=await revision(initial.root_tree_id);
  assert.equal((await client.revision(base.result.revision_id)).root_tree_id,initial.root_tree_id);
  const firstLookup=await client.lookup(initial.root_tree_id,'src/main.ts');assert.equal(firstLookup.entry.mode,'100755');
  assert.equal((await client.lookup(initial.root_tree_id,'src/link')).entry.kind,'symlink');
  const descriptor=JSON.parse(Buffer.from((await client.object(firstFile.object_id)).payload_base64,'base64').toString());
  assert.deepEqual(descriptor.slice(0,3),[1,String(firstBytes.length),sha(firstBytes)]);assert.equal(descriptor[3][0],'blob');
  assert.deepEqual(Buffer.from((await client.object(descriptor[3][1])).payload_base64,'base64'),firstBytes);
  checks.push('API-only client uploads typed blobs/files/trees, creates immutable revision, and reconstructs exact executable and symlink metadata');
  const secondFile=await file(secondBytes),patched=await call('source.trees.patch',{tree_id:initial.root_tree_id,patches:[{path:'src/main.ts',operation:'put',kind:'file',mode:'100755',object_id:secondFile.object_id}]});
  const child=await revision(patched.root_tree_id,[base.result.revision_id],base.input.change_id,[base.result.revision_id]);
  const ancestry=await call('source.queries.ancestry',{ancestor_revision_id:base.result.revision_id,descendant_revision_id:child.result.revision_id});assert.equal(ancestry.is_ancestor,true);
  const narrowBudget={max_nodes:1,max_bytes:4194304,max_ms:5000};
  const unfinished=await call('source.queries.ancestry',{ancestor_revision_id:base.result.revision_id,descendant_revision_id:child.result.revision_id,budget:narrowBudget});
  assert.equal(unfinished.is_ancestor,null);assert.equal(unfinished.coverage.state,'PARTIAL');assert(unfinished.next_cursor);
  assert.equal((await call('source.queries.ancestry',{ancestor_revision_id:base.result.revision_id,descendant_revision_id:child.result.revision_id,budget:narrowBudget,cursor:unfinished.next_cursor})).is_ancestor,true);
  await assert.rejects(call('source.queries.ancestry',{ancestor_revision_id:'sha256:'+'a'.repeat(64),descendant_revision_id:'sha256:'+'a'.repeat(64)}),error=>error.code==='NOT_FOUND');
  assert.deepEqual((await call('source.queries.merge-bases',{left_revision_id:child.result.revision_id,right_revision_id:base.result.revision_id})).revision_ids,[base.result.revision_id]);
  const diff=await call('source.queries.diff',{before_revision_id:base.result.revision_id,after_revision_id:child.result.revision_id});
  assert.deepEqual(diff.entries.map(entry=>[entry.path,entry.kind]),[['src/main.ts','MODIFIED']]);assert.equal(diff.coverage.state,'COMPLETE');
  const lineMap=await call('source.queries.line-map',{before_revision_id:base.result.revision_id,after_revision_id:child.result.revision_id,path:'src/main.ts'});
  assert.equal(lineMap.binary,false);assert.deepEqual(lineMap.mappings.map(mapping=>[mapping.before_line,mapping.after_line]),[[1,1],[3,3]]);
  const blame=await call('source.queries.blame',{revision_id:child.result.revision_id,path:'src/main.ts'});
  assert.deepEqual(blame.lines.map(line=>line.origin_revision_id),[base.result.revision_id,child.result.revision_id,base.result.revision_id]);
  checks.push('server ancestry, merge bases, object-level diff, exact line mapping and first-parent blame run without a checkout; bounded ancestry resumes rather than fabricating absence');
  const history=await call('source.queries.history',{revision_id:child.result.revision_id,limit:1});assert.equal(history.entries.length,1);assert(history.next_cursor);
  const following=await call('source.queries.history',{revision_id:child.result.revision_id,limit:1,cursor:history.next_cursor});assert.equal(following.entries[0].revision_id,base.result.revision_id);assert.equal(following.next_cursor,null);
  await assert.rejects(call('source.queries.history',{revision_id:child.result.revision_id,limit:2,cursor:history.next_cursor}),error=>error.code==='RESNAPSHOT_REQUIRED');
  const listing=await client.tree(initial.root_tree_id,{limit:1});assert(listing.next_cursor);
  const nextListing=await client.tree(initial.root_tree_id,{limit:1,cursor:listing.next_cursor});assert.deepEqual([...listing.entries,...nextListing.entries].map(entry=>entry.name),['private','src']);
  await assert.rejects(client.tree(patched.root_tree_id,{limit:1,cursor:listing.next_cursor}),error=>error.code==='RESNAPSHOT_REQUIRED');
  checks.push('authenticated history and directory cursors preserve snapshots and reject altered query or tree');
  const [cursorPayload,cursorSignature]=history.next_cursor.split('.');
  const tamperedSignature=(cursorSignature[0]==='A'?'B':'A')+cursorSignature.slice(1);
  await assert.rejects(call('source.queries.history',{revision_id:child.result.revision_id,limit:1,cursor:cursorPayload+'.'+tamperedSignature}),error=>error.code==='INVALID_CURSOR');
  const expiredBody={...JSON.parse(Buffer.from(cursorPayload,'base64url').toString()),expires_at:Date.now()-1000};
  const expiredPayload=Buffer.from(JSON.stringify(expiredBody)).toString('base64url');
  const expiredCursor=expiredPayload+'.'+createHmac('sha256',cursorKey).update(expiredPayload).digest('base64url');
  await assert.rejects(call('source.queries.history',{revision_id:child.result.revision_id,limit:1,cursor:expiredCursor}),error=>error.code==='RESNAPSHOT_REQUIRED');
  const alternateCapability=randomUUID();
  await pool.query(`INSERT INTO hyperfide.source_capabilities(organisation_id,repository_id,security_domain_id,id,principal_id,credential_id,principal_kind,authority_epoch,policy_version,actions,path_prefixes,expires_at)
    SELECT organisation_id,repository_id,security_domain_id,$2,principal_id,credential_id,principal_kind,authority_epoch,policy_version,actions,path_prefixes,expires_at FROM hyperfide.source_capabilities WHERE id=$1`,[capability_id,alternateCapability]);
  const alternateClient=new SourceControlClient({endpoint,scope,token:()=>tokenFor(scope,{capability_id:alternateCapability})});
  await assert.rejects(alternateClient.call('source.queries.history',{revision_id:child.result.revision_id,limit:1,cursor:history.next_cursor}),error=>error.code==='RESNAPSHOT_REQUIRED');
  checks.push('real HTTP query continuation rejects signature tampering, authenticated expiry and substitution of current capability');

  const blobBytes=Buffer.alloc(4*1024*1024,0x9d),large=await put('blob',blobBytes);
  assert.deepEqual(Buffer.from((await client.object(large.object_id)).payload_base64,'base64'),blobBytes);
  checks.push('4 MiB source object crosses the actual bounded HTTP SDK request and response codecs');
  const workspaceIds=[randomUUID(),randomUUID()];
  const opened=[];
  for(const workspace_id of workspaceIds)opened.push(await call('source.workspaces.open',{workspace_id,base_revision_id:base.result.revision_id,mode:'SPARSE',read_paths:['src'],write_paths:['src']}));
  assert.notEqual(opened[0].workspace.workspace_id,opened[1].workspace.workspace_id);
  const operation=randomUUID(),checkpoint={workspace_id:workspaceIds[0],operation_id:operation,expected_workspace_generation:'1',expected_scope_generation:'1',base_revision_id:base.result.revision_id,overlay_generation:'1',changes:[{path:'src/main.ts',operation:'put',kind:'file',mode:'100755',object_id:secondFile.object_id}]};
  const checkpointState=async()=>{
    const workspace=(await pool.query('SELECT workspace_generation::text AS generation,root_tree_id FROM hyperfide.source_workspaces WHERE workspace_id=$1',[workspaceIds[0]])).rows[0];
    const revisions=(await pool.query('SELECT count(*)::int AS count FROM hyperfide.source_revisions')).rows[0].count;
    return {workspace,revisions};
  };
  const stateBeforeInvalid=await checkpointState(),differentOuter=randomUUID(),differentInner=randomUUID();
  await assert.rejects(call('source.workspaces.checkpoint',{...checkpoint,operation_id:differentInner},{operation_id:differentOuter,idempotency_key:differentOuter}),error=>error.code==='IDEMPOTENCY_CONFLICT');
  assert.deepEqual(await checkpointState(),stateBeforeInvalid);
  await assert.rejects(call('source.workspaces.checkpoint',{...checkpoint,operation_id:base.operation},{operation_id:base.operation,idempotency_key:base.operation}),error=>error.code==='IDEMPOTENCY_CONFLICT');
  assert.deepEqual(await checkpointState(),stateBeforeInvalid);
  assert.deepEqual((await client.operation(base.operation)).result,base.result);
  checks.push('checkpoint transport/body identities must agree and an existing revision operation cannot be reused for a different mutation');
  const checkpointResult=await call('source.workspaces.checkpoint',checkpoint,{operation_id:operation,idempotency_key:operation});
  assert.equal(checkpointResult.workspace.workspace_generation,'2');
  const checkpointRevision=await client.revision(checkpointResult.revision_id);
  assert.equal((await client.lookup(checkpointRevision.root_tree_id,'private/kept.txt')).entry.object_id,privateFile.object_id);
  assert.equal((await call('source.workspaces.detail',{workspace_id:workspaceIds[1]})).workspace.base_revision_id,base.result.revision_id);
  assert.deepEqual(await call('source.workspaces.checkpoint',checkpoint,{operation_id:operation,idempotency_key:operation}),checkpointResult);
  await assert.rejects(call('source.workspaces.checkpoint',{...checkpoint,overlay_generation:'2'},{operation_id:operation,idempotency_key:operation}),error=>error.code==='IDEMPOTENCY_CONFLICT');
  const checkpointLookup=await client.operation(operation);assert(['COMMITTED','SUCCEEDED'].includes(checkpointLookup.state));assert.deepEqual(checkpointLookup.result,checkpointResult);
  checks.push('independent sparse workspaces checkpoint only explicit changes, retain omitted paths and replay one committed operation');
  const staleOperation=randomUUID();
  await assert.rejects(call('source.workspaces.checkpoint',{...checkpoint,operation_id:staleOperation},{operation_id:staleOperation,idempotency_key:staleOperation}),error=>error.code==='WORKSPACE_CHANGED');
  assert.equal((await call('source.workspaces.detail',{workspace_id:workspaceIds[0]})).workspace.workspace_generation,'2');
  const divergent=await Promise.all([revision(initial.root_tree_id,[child.result.revision_id],child.input.change_id,[child.result.revision_id]),revision(patched.root_tree_id,[child.result.revision_id],child.input.change_id,[child.result.revision_id])]);
  assert.notEqual(divergent[0].result.revision_id,divergent[1].result.revision_id);
  const divergencePage=await call('source.changes.revisions',{change_id:child.input.change_id,limit:100});
  for(const value of divergent){const observed=divergencePage.revisions.find(row=>row.revision_id===value.result.revision_id);assert(observed);assert.deepEqual(observed.predecessor_revision_ids,[child.result.revision_id]);}
  assert.equal((await client.revision(base.result.revision_id)).root_tree_id,initial.root_tree_id);
  checks.push('fresh stale-generation mutation is rejected while concurrent API successors preserve explicit predecessor identity and immutable source');

  const lostOperation=randomUUID(),lostInput={...child.input,change_id:randomUUID(),predecessor_revision_ids:[],provenance:{...child.input.provenance,message:'Lost acknowledgment API case'}};
  let lose=true;
  const interrupted=new SourceControlClient({endpoint,scope,token:()=>tokenFor(),fetch:async(...args)=>{const response=await fetch(...args);if(lose){lose=false;await response.arrayBuffer();throw new TypeError('controlled response loss');}return response;}});
  await assert.rejects(interrupted.createRevision(lostInput,{operation_id:lostOperation,idempotency_key:lostOperation}),error=>error.code==='OUTCOME_UNKNOWN'&&error.details.operation_id===lostOperation);
  const committed=await client.operation(lostOperation);assert.equal(committed.state,'SUCCEEDED');
  assert.deepEqual(await call('source.revisions.create',lostInput,{operation_id:lostOperation,idempotency_key:lostOperation}),committed.result);
  const effects=await pool.query('SELECT count(*)::int AS count FROM hyperfide.source_metadata_operations WHERE operation_id=$1',[lostOperation]);assert.equal(effects.rows[0].count,1);
  checks.push('lost HTTP acknowledgment resolves the exact committed operation and retry returns one durable result');
  let host={status:'UNRUN',reason:'Enable HYPERFIDE_SOURCE_RUN_HOST=1 for the actual host workspace journey'};
  if(process.env.HYPERFIDE_SOURCE_RUN_HOST==='1'||process.argv.includes('--host-driver')) {
    const output=path.join(ROOT,'build/source-control/2.1');await fs.mkdir(output,{recursive:true});
    const profile=path.join(output,'host-profile.private.json'),logPath=path.join(output,'host-driver.private.log');
    await fs.writeFile(profile,JSON.stringify({endpoint,token:tokenFor(),scope,authority:{authority_epoch:'1',generation:'1',policy_version:policy}})+'\n',{mode:0o600});
    await fs.chmod(profile,0o600);
    const log=await fs.open(logPath,'w',0o600);let writes=Promise.resolve(),size=0;
    try {
      const exitCode=await new Promise((resolve,reject)=>{
        const childProcess=spawn('python3',[path.join(ROOT,'tests/hyperfide/cases/source_control/2_2.py')],{cwd:ROOT,env:{...process.env,HYPERFIDE_SOURCE_CONTROL_TEST_PROFILE:profile},stdio:['ignore','pipe','pipe']});
        let killTimer;const timer=setTimeout(()=>{childProcess.kill('SIGTERM');killTimer=setTimeout(()=>childProcess.kill('SIGKILL'),5000);},240000);
        const record=chunk=>{size+=chunk.length;if(size>4194304){childProcess.kill('SIGTERM');return;}writes=writes.then(()=>log.write(chunk));};
        childProcess.stdout.on('data',record);childProcess.stderr.on('data',record);childProcess.on('error',reject);
        childProcess.on('close',code=>{clearTimeout(timer);if(killTimer)clearTimeout(killTimer);resolve(code);});
      });
      await writes;await log.sync();assert.equal(exitCode,0,'Actual host workspace driver failed; inspect '+logPath);
      host={status:'PASS',exit_code:exitCode,log:path.relative(ROOT,logPath)};
      checks.push('actual host cache/materializer/journal/checkpoint driver passes against the same authenticated HTTP source service');
    }finally{await writes;await log.close();await fs.rm(profile,{force:true});}
  }
  const beforeDenied=fixture.requests.length;
  await pool.query('UPDATE hyperfide.source_capabilities SET revoked_at=clock_timestamp() WHERE id=$1',[capability_id]);
  await assert.rejects(client.object(firstFile.object_id),error=>error.code==='SCOPE_DENIED');
  await assert.rejects(client.object('sha256:'+'a'.repeat(64)),error=>error.code==='SCOPE_DENIED');
  assert.equal(fixture.requests.length,beforeDenied);
  checks.push('revoked capability denies known and guessed objects before any backend existence read');
  assert(fixture.requests.length>0&&fixture.requests.every(request=>['GET','PUT'].includes(request.method)));
  const receipt={schema_version:1,status:'PASS',scope:'real PostgreSQL, Ed25519 taskless authentication, HTTP listener, published SDK and SigV4 object adapter',checks,
    source_scope:scope,base_revision_id:base.result.revision_id,child_revision_id:child.result.revision_id,checkpoint_revision_id:checkpointResult.revision_id,
    backend:service.objects.backend.identity,backend_requests:fixture.requests.length,working_directory_initially_empty:true,host_workspace:host};
  const output=path.join(ROOT,'build/source-control/2.1');await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');
  console.log(JSON.stringify(receipt));
}finally {
  if(server)await server.close();controller.abort();await pool.end();await fixture.close();process.chdir(ROOT);await fs.rm(workingDirectory,{recursive:true,force:true});
}
