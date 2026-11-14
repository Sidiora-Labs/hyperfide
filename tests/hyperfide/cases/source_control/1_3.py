#!/usr/bin/env python3
"""Source authorization, taskless authentication and pinned transfer grants on owned PostgreSQL."""
from pathlib import Path
import importlib.util
import os
import shutil
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[4]
PROGRAM = r'''
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=process.cwd(),out=path.join(root,'build/source-control/1.3');
const moduleRoot=process.env.SOURCE_CONTROL_MODULE_ROOT,sdkRoot=process.env.SOURCE_CONTROL_SDK_MODULE_ROOT;
assert.ok(moduleRoot&&sdkRoot,'The source service and SDK must be compiled from current sources');
const dsn=new URL(process.env.DATABASE_URL);assert.ok(dsn.searchParams.get('host')?.startsWith('/tmp/hyperfide/hf-withpg-'),'owned PostgreSQL required');
const require=createRequire(path.join(root,'core/control-plane/package.json')),pg=require('pg');
const load=name=>import(pathToFileURL(path.join(moduleRoot,name+'.js')));
const auth=await load('authentication'),caps=await load('capabilities'),transfers=await load('transfer_grants'),audit=await load('audit'),storage=await load('object_catalog'),contracts=await load('contracts');
const [{createSourceService},{startSourceHttp},{S3SourceObjectBackend},{SourceControlClient},{createSourceS3Fixture}]=await Promise.all([
 load('registration'),load('http'),load('s3'),import(pathToFileURL(path.join(sdkRoot,'client.js'))),
 import(pathToFileURL(path.join(root,'tests/hyperfide/cases/source_control/fixtures/objects/backend.mjs'))),
]);
await mkdir(out,{recursive:true});
const fixture=await createSourceS3Fixture(),controller=new AbortController();
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:6});
let server,mutationRevocation;
async function digestTrees(trees){
 const hash=createHash('sha256');
 for(const [label,directory] of trees){
  const files=(await readdir(directory,{recursive:true,withFileTypes:true})).filter(file=>file.isFile()).map(file=>path.relative(directory,path.join(file.parentPath,file.name))).sort();
  for(const name of files){hash.update(label+'/'+name+'\0');hash.update(await readFile(path.join(directory,name)));hash.update('\0');}
 }
 return 'sha256:'+hash.digest('hex');
}
const client=new pg.Client({connectionString:process.env.DATABASE_URL});await client.connect();
const checks=[];async function check(name,body){await body();checks.push(name);}
async function tx(body){await client.query('BEGIN');try{const value=await body(client);await client.query('COMMIT');return value;}catch(error){await client.query('ROLLBACK');throw error;}}
async function refused(code,body){await assert.rejects(body,e=>e.code===code);}
function rejected(code,body){assert.throws(body,e=>e.code===code);}
const scope={organisation_id:randomUUID(),repository_id:randomUUID(),security_domain_id:randomUUID()},other={...scope,security_domain_id:randomUUID()};
const principalId=randomUUID(),credentialId=randomUUID(),capabilityId=randomUUID(),objectId='sha256:'+createHash('sha256').update('independent protected object fixture').digest('hex'),incarnation=randomUUID();
const pair=generateKeyPairSync('ed25519'),trust={issuer:'https://source-issuer.invalid',audience:'hyperfide-source',keys:{test:pair.publicKey},max_ttl_seconds:300};
const second=Math.floor(Date.now()/1000),claims={schema_version:1,iss:trust.issuer,aud:trust.audience,sub:principalId,credential_id:credentialId,credential_version:'1',principal_kind:'automation',scope,iat:second,nbf:second,exp:second+300,capability_id:capabilityId};
function token(payload=claims,header={alg:'EdDSA',kid:'test',typ:'HF-SOURCE-1'}){const a=Buffer.from(JSON.stringify(header)).toString('base64url'),b=Buffer.from(JSON.stringify(payload)).toString('base64url');return a+'.'+b+'.'+sign(null,Buffer.from(a+'.'+b),pair.privateKey).toString('base64url');}
const principal=auth.verifySourcePrincipalToken(token(),trust,scope);
const expiration=new Date(Date.now()+240000).toISOString();
const config={key_id:'transfer-1',signing_key:Buffer.alloc(32,0x42),endpoint:'https://source.invalid/transfers',allowed_endpoints:['https://source.invalid'],maximum_lifetime_seconds:120};
let authorized,issued;
try{
 await client.query('CREATE SCHEMA hyperfide');
 for(const file of JSON.parse(process.env.SOURCE_CONTROL_MIGRATIONS))await client.query(await readFile(path.join(root,'core/control-plane/migrations',file),'utf8'));
 await client.query('INSERT INTO hyperfide.source_authority_domains(organisation_id,repository_id,security_domain_id,authority_epoch,policy_version) VALUES($1,$2,$3,1,\'source-v1\')',[scope.organisation_id,scope.repository_id,scope.security_domain_id]);
 await client.query('INSERT INTO hyperfide.source_principal_credentials(organisation_id,repository_id,security_domain_id,credential_id,principal_id,principal_kind,credential_version,issuer,audience,signing_key_id,expires_at) VALUES($1,$2,$3,$4,$5,\'automation\',1,$6,$7,\'test\',$8)',[scope.organisation_id,scope.repository_id,scope.security_domain_id,credentialId,principalId,trust.issuer,trust.audience,expiration]);
 await client.query('INSERT INTO hyperfide.source_capabilities(organisation_id,repository_id,security_domain_id,id,principal_id,credential_id,principal_kind,authority_epoch,policy_version,actions,path_prefixes,expires_at) VALUES($1,$2,$3,$4,$5,$6,\'automation\',1,\'source-v1\',$7,$8,$9)',[scope.organisation_id,scope.repository_id,scope.security_domain_id,capabilityId,principalId,credentialId,['source.capabilities','source.objects.read','source.objects.put','source.trees.patch','source.trees.lookup','source.revisions.create','source.revisions.read','source.operations.read','source.queries.diff','source.audit.read'],[''],expiration]);
 await client.query('INSERT INTO hyperfide.source_native_objects(organisation_id,repository_id,security_domain_id,object_id,kind,size_bytes,state,current_incarnation) VALUES($1,$2,$3,$4,\'blob\',0,\'VERIFIED\',$5)',[scope.organisation_id,scope.repository_id,scope.security_domain_id,objectId,incarnation]);
 await client.query('INSERT INTO hyperfide.source_object_placements(organisation_id,repository_id,security_domain_id,object_id,incarnation_id,generation,storage_key,state) VALUES($1,$2,$3,$4,$5,1,\'owned-fixture/source-object\',\'VERIFIED\')',[scope.organisation_id,scope.repository_id,scope.security_domain_id,objectId,incarnation]);
 await check('signed-taskless-principal-uses-current-server-credential-without-run',async()=>{authorized=await tx(db=>caps.authorizeSource(db,{principal,scope,action:'source.objects.read',object_id:objectId,mutation:false}));assert.equal(authorized.principal_id,principalId);assert.equal(authorized.authority_epoch,'1');assert.equal(authorized.workspace,undefined);});
 await check('signature-algorithm-issuer-audience-scope-and-expiry-boundaries',async()=>{
  for(const payload of [{...claims,iss:'https://other.invalid'},{...claims,aud:'other'},{...claims,exp:second},{...claims,exp:second+901},{...claims,nbf:second+60},{...claims,credential_version:'9999999999999999999'}])rejected('UNAUTHENTICATED',()=>auth.verifySourcePrincipalToken(token(payload),trust,scope));
  rejected('UNAUTHENTICATED',()=>auth.verifySourcePrincipalToken(token(claims,{alg:'HS256',kid:'test',typ:'HF-SOURCE-1'}),trust,scope));
  rejected('UNAUTHENTICATED',()=>auth.verifySourcePrincipalToken(token(),trust,other));
  const wire=token(),parts=wire.split('.');parts[1]=Buffer.from(JSON.stringify({...claims,sub:randomUUID()})).toString('base64url');rejected('UNAUTHENTICATED',()=>auth.verifySourcePrincipalToken(parts.join('.'),trust,scope));
 });
 await check('cross-domain-object-guesses-produce-the-same-authorization-refusal',async()=>{for(const object_id of [objectId,'sha256:'+'0'.repeat(64)])await refused('SCOPE_DENIED',()=>tx(db=>caps.authorizeSource(db,{principal,scope:other,action:'source.objects.read',object_id,mutation:false})));});
 await check('read-transfer-retains-exact-incarnation-through-grant-expiry',async()=>{
  issued=await tx(db=>transfers.issueSourceTransferGrant(db,authorized,{object_id:objectId,incarnation_id:incarnation,method:'GET',expires_at:new Date(Date.now()+60000).toISOString()},config));
  const pins=(await client.query('SELECT object_id,incarnation_id,expires_at FROM hyperfide.source_object_pins WHERE owner_kind=\'READ\' AND owner_id=$1',[issued.grant.grant_id])).rows;
  assert.equal(pins.length,1);assert.equal(pins[0].object_id,objectId);assert.equal(pins[0].incarnation_id,incarnation);assert.ok(new Date(pins[0].expires_at).getTime()>=Date.parse(issued.grant.expires_at));await tx(db=>transfers.assertSourceTransferRetained(db,issued.grant));
 });
 const request={scope,method:'GET',object_id:objectId,incarnation_id:incarnation,storage_key:'owned-fixture/source-object',url:issued.url};
 await check('transfer-signature-binds-method-key-object-domain-incarnation-and-endpoint',async()=>{
  assert.equal(transfers.verifySourceTransferGrant(issued.token,config,request).grant_id,issued.grant.grant_id);
  for(const changed of [{method:'PUT'},{storage_key:'other/key'},{object_id:'sha256:'+'1'.repeat(64)},{incarnation_id:randomUUID()},{scope:other},{url:'https://evil.invalid/transfers/'+issued.grant.grant_id}])rejected('INVALID_TRANSFER_GRANT',()=>transfers.verifySourceTransferGrant(issued.token,config,{...request,...changed}));
  rejected('INVALID_TRANSFER_GRANT',()=>transfers.verifySourceTransferGrant(issued.token,config,request,Date.parse(issued.grant.expires_at)));
  rejected('CONFIGURATION_INVALID',()=>transfers.verifySourceTransferGrant(issued.token,{...config,endpoint:'http://source.invalid/transfers'},request));
 });
 await check('put-transfers-require-authenticated-upload-owner-and-open-placement',async()=>{
  const catalog=new storage.PostgresSourceObjectCatalog({transaction:tx}),uploadObject='sha256:'+createHash('sha256').update('upload ownership fixture').digest('hex');
  const owned=await catalog.begin(scope,{operation_id:randomUUID(),object_id:uploadObject,kind:'blob',size_bytes:'0',owner_principal_id:principalId});
  const foreign=await catalog.begin(scope,{operation_id:randomUUID(),object_id:uploadObject,kind:'blob',size_bytes:'0',owner_principal_id:randomUUID()});
  const input={object_id:uploadObject,incarnation_id:owned.incarnation_id,method:'PUT',expires_at:new Date(Date.now()+60000).toISOString()};
  await refused('INVALID_TRANSFER_GRANT',()=>tx(db=>transfers.issueSourceTransferGrant(db,authorized,{...input,upload_id:foreign.upload_id},config)));
  const put=await tx(db=>transfers.issueSourceTransferGrant(db,authorized,{...input,upload_id:owned.upload_id},config));await tx(db=>transfers.assertSourceTransferRetained(db,put.grant));
  await client.query('UPDATE hyperfide.source_object_uploads SET status=\'VERIFIED\' WHERE upload_id=$1',[owned.upload_id]);
  await refused('INVALID_TRANSFER_GRANT',()=>tx(db=>transfers.assertSourceTransferRetained(db,put.grant)));
 });
 await check('revocation-rejects-warm-cache-and-new-grants-with-bounded-issued-grant-residual',async()=>{
  const cache=new Map([[objectId,Buffer.from('known bytes')]]);assert.ok(cache.has(objectId));await client.query('UPDATE hyperfide.source_capabilities SET revoked_at=clock_timestamp() WHERE id=$1',[capabilityId]);
  await refused('SCOPE_DENIED',()=>tx(db=>authorized.assertCurrent(db)));
  await refused('SCOPE_DENIED',()=>tx(db=>transfers.issueSourceTransferGrant(db,authorized,{object_id:objectId,incarnation_id:incarnation,method:'GET',expires_at:new Date(Date.now()+30000).toISOString()},config)));
  assert.equal(transfers.verifySourceTransferGrant(issued.token,config,request).grant_id,issued.grant.grant_id);await tx(db=>transfers.assertSourceTransferRetained(db,issued.grant));
  await client.query('UPDATE hyperfide.source_capabilities SET revoked_at=NULL WHERE id=$1',[capabilityId]);
 });
 await check('scoped-prefixes-cannot-authorize-guessed-objects-with-client-path-claims',async()=>{
  await client.query('UPDATE hyperfide.source_capabilities SET path_prefixes=$2 WHERE id=$1',[capabilityId,['src']]);
  await refused('SCOPE_DENIED',()=>tx(db=>caps.authorizeSource(db,{principal,scope,action:'source.objects.read',object_id:objectId,paths:['src/a.ts'],mutation:false})));
  await refused('SCOPE_DENIED',()=>tx(db=>caps.authorizeSource(db,{principal,scope,action:'source.queries.diff',paths:['private/a.ts'],mutation:false})));
  const allowed=await tx(db=>caps.authorizeSource(db,{principal,scope,action:'source.queries.diff',paths:['src/a.ts'],mutation:false}));assert.deepEqual(allowed.path_prefixes,['src']);
  await client.query('UPDATE hyperfide.source_capabilities SET path_prefixes=$2 WHERE id=$1',[capabilityId,['']]);
 });
 await check('signed-capability-selection-cannot-be-changed-by-request',async()=>{await refused('SCOPE_DENIED',()=>tx(db=>caps.authorizeSource(db,{principal,scope,action:'source.objects.read',object_id:objectId,mutation:false,capability_id:randomUUID()})));});
 await check('worker-mutation-flag-cannot-bypass-managed-generation-fences',async()=>{
  const workerCapability=randomUUID(),binding={workspace_id:randomUUID(),generation:'4',task_id:randomUUID(),attempt_id:randomUUID(),attempt_generation:'7'};
  await client.query('UPDATE hyperfide.source_principal_credentials SET principal_kind=\'worker\' WHERE credential_id=$1',[credentialId]);
  await client.query('INSERT INTO hyperfide.source_capabilities(organisation_id,repository_id,security_domain_id,id,principal_id,credential_id,principal_kind,authority_epoch,policy_version,actions,path_prefixes,managed_binding,expires_at) VALUES($1,$2,$3,$4,$5,$6,\'worker\',1,\'source-v1\',$7,$8,$9,$10)',[scope.organisation_id,scope.repository_id,scope.security_domain_id,workerCapability,principalId,credentialId,['source.objects.put'],[''],binding,expiration]);
  const worker=auth.verifySourcePrincipalToken(token({...claims,principal_kind:'worker',capability_id:workerCapability}),trust,scope);
  const authority={authority_epoch:'1',policy_version:'source-v1',generation:'4',workspace:{workspace_id:binding.workspace_id,workspace_generation:'4'},managed:{task_id:binding.task_id,attempt_id:binding.attempt_id,attempt_generation:'7'}};
  for(const input of [{},{authority:{...authority,managed:{...authority.managed,attempt_generation:'6'}}},{authority}])await refused('SCOPE_DENIED',()=>tx(db=>caps.authorizeSource(db,{principal:worker,scope,action:'source.objects.put',mutation:false,...input})));
  await client.query('UPDATE hyperfide.source_principal_credentials SET principal_kind=\'automation\' WHERE credential_id=$1',[credentialId]);
 });
 await check('server-policy-epoch-change-fences-previous-capability',async()=>{await client.query('UPDATE hyperfide.source_authority_domains SET authority_epoch=2');await refused('SCOPE_DENIED',()=>tx(db=>authorized.assertCurrent(db)));await client.query('UPDATE hyperfide.source_authority_domains SET authority_epoch=1');});
 await check('credential-revocation-is-checked-after-cryptographic-authentication',async()=>{await client.query('UPDATE hyperfide.source_principal_credentials SET revoked_at=clock_timestamp()');const authenticated=auth.verifySourcePrincipalToken(token(),trust,scope);await refused('UNAUTHENTICATED',()=>tx(db=>caps.authorizeSource(db,{principal:authenticated,scope,action:'source.objects.read',mutation:false})));await client.query('UPDATE hyperfide.source_principal_credentials SET revoked_at=NULL');});
 await check('audit-records-allowlist-fields-and-remain-immutable',async()=>{
  const record=audit.sourceAuditRecord(authorized,{action:'source.objects.read',operation_id:randomUUID(),request_digest:'sha256:'+'2'.repeat(64),result:'SUCCEEDED',source_ids:[objectId],secret:'must-not-enter-audit'});
  assert.ok(!JSON.stringify(record).includes('must-not-enter-audit'));await tx(db=>audit.appendSourceAudit(db,record));const rows=await tx(db=>audit.readSourceAudit(db,authorized));assert.equal(rows.length,1);assert.equal(rows[0].id,record.id);
  await refused('INVALID_AUDIT_RECORD',()=>tx(db=>audit.appendSourceAudit(db,{...record,id:randomUUID(),transfer_token:'private'})));
  await assert.rejects(()=>client.query('UPDATE hyperfide.source_audit SET record=\'{}\''),e=>e.code==='23514');
 });
 await check('missing-retention-pin-refuses-transfer-despite-valid-signature',async()=>{await client.query('DELETE FROM hyperfide.source_object_pins WHERE owner_id=$1',[issued.grant.grant_id]);await refused('INVALID_TRANSFER_GRANT',()=>tx(db=>transfers.assertSourceTransferRetained(db,issued.grant)));});
 const service=createSourceService({pool,backend:new S3SourceObjectBackend(fixture.config),cursorKey:Buffer.alloc(32,0x31),workspaceBudgets:{cache_bytes:16777216,max_cache_entries:1024,max_file_bytes:8388608,materialized_bytes:33554432,dirty_bytes:8388608}});
 await service.metadata.registerRepository(scope,{authority_epoch:'1',policy_version:'source-v1',durability_profile:'single-region-verified-s3-v1'});
 server=await startSourceHttp({api:service.api,trust,host:'127.0.0.1',port:0,allowLoopbackHTTP:true,signal:controller.signal});
 const endpoint=server.address+contracts.SOURCE_API_PATH;
 const sdk=new SourceControlClient({endpoint,scope,token:()=>token(),timeout_ms:30000});
 const call=(action,input,options={})=>sdk.call(action,input,options);
 const put=(kind,bytes)=>call('source.objects.put',{kind,payload_base64:Buffer.from(bytes).toString('base64')});
 async function deniedWithoutBackend(code,body){const before=fixture.requests.length;await refused(code,body);assert.equal(fixture.requests.length,before,'Denial must precede every object backend request');}
 const rowCounts=async()=> (await client.query('SELECT (SELECT count(*)::int FROM hyperfide.source_revisions) AS revisions,(SELECT count(*)::int FROM hyperfide.source_audit) AS audits,(SELECT count(*)::int FROM hyperfide.source_metadata_operations) AS operations,(SELECT count(*)::int FROM hyperfide.source_events) AS events')).rows[0];
 const empty=await put('tree-leaf',Buffer.from(JSON.stringify([1,'',[]])));
 let base,revisionInput,revisionOperation;
 await check('registered-http-service-and-sdk-create-and-read-real-source',async()=>{
  const discovered=await sdk.capabilities();assert.ok(discovered.actions.includes('source.revisions.create'));
  revisionInput={change_id:randomUUID(),root_tree_id:empty.object_id,parent_revision_ids:[],predecessor_revision_ids:[],provenance:{author:{name:'Source capability qualification',email:'source-capability@example.invalid'},message:'Registered service capability qualification',timestamp:new Date().toISOString()}};
  revisionOperation=randomUUID();base=await call('source.revisions.create',revisionInput,{operation_id:revisionOperation,idempotency_key:revisionOperation});
  assert.equal((await sdk.revision(base.revision_id)).root_tree_id,empty.object_id);
  assert.equal((await sdk.object(empty.object_id)).kind,'tree-leaf');assert.ok(fixture.requests.length>0);
 });
 await check('http-changed-request-digest-refuses-replay-without-new-revision-audit-operation-or-event',async()=>{
  const before=await rowCounts();assert.equal(before.revisions,1);assert.equal(before.audits,1);
  assert.deepEqual(await call('source.revisions.create',revisionInput,{operation_id:revisionOperation,idempotency_key:revisionOperation}),base);
  assert.deepEqual(await rowCounts(),before);
  await deniedWithoutBackend('IDEMPOTENCY_CONFLICT',()=>call('source.revisions.create',{...revisionInput,provenance:{...revisionInput.provenance,message:'Changed request body'}},{operation_id:revisionOperation,idempotency_key:revisionOperation}));
  assert.deepEqual(await rowCounts(),before);assert.deepEqual((await sdk.operation(revisionOperation)).result,base);
 });
 await check('http-malicious-paths-refused-before-object-backend',async()=>{
  const paths=['.','..','src/./a','src/../private/a','src//a','src/','/etc/passwd','C:/outside','src/\0name','src\\outside','a'.repeat(256),'é'.repeat(128),'src/'+Array(20).fill('a'.repeat(220)).join('/')];
  for(const malicious of paths){
   rejected('INVALID_PATH',()=>contracts.parseRepositoryPath(malicious));
   await deniedWithoutBackend('INVALID_PATH',()=>sdk.lookup(empty.object_id,malicious));
   await deniedWithoutBackend('INVALID_PATH',()=>call('source.trees.patch',{tree_id:empty.object_id,patches:[{path:malicious,operation:'remove'}]}));
   rejected('INVALID_PATH',()=>caps.sourcePathWithin('src/a',[malicious]));
  }
 });
 let symlinkTree;
 await check('http-outside-tree-symlink-entries-cannot-cross-capability-prefixes',async()=>{
  const relative=await put('blob',Buffer.from('../../outside/secret')),absolute=await put('blob',Buffer.from('/etc/passwd'));
  symlinkTree=await call('source.trees.patch',{tree_id:empty.object_id,patches:[{path:'escape-relative',operation:'put',kind:'symlink',mode:'120000',object_id:relative.object_id},{path:'escape-absolute',operation:'put',kind:'symlink',mode:'120000',object_id:absolute.object_id}]});
  for(const [name,object] of [['escape-relative',relative],['escape-absolute',absolute]]){
   const entry=(await sdk.lookup(symlinkTree.root_tree_id,name)).entry;assert.equal(entry.kind,'symlink');assert.equal(entry.object_id,object.object_id);
  }
  await client.query('UPDATE hyperfide.source_capabilities SET path_prefixes=$2 WHERE id=$1',[capabilityId,['src']]);
  for(const name of ['escape-relative','escape-absolute']){
   await deniedWithoutBackend('SCOPE_DENIED',()=>sdk.lookup(symlinkTree.root_tree_id,name));
   await deniedWithoutBackend('SCOPE_DENIED',()=>sdk.lookup(symlinkTree.root_tree_id,name+'/secret'));
   await deniedWithoutBackend('INVALID_PATH',()=>sdk.lookup(symlinkTree.root_tree_id,'src/../'+name));
  }
  for(const object of [relative,absolute])await deniedWithoutBackend('SCOPE_DENIED',()=>sdk.object(object.object_id));
  await client.query('UPDATE hyperfide.source_capabilities SET path_prefixes=$2 WHERE id=$1',[capabilityId,['']]);
 });
 await check('http-prefix-boundaries-refuse-private-paths-and-guessed-objects',async()=>{
  await client.query('UPDATE hyperfide.source_capabilities SET path_prefixes=$2 WHERE id=$1',[capabilityId,['src']]);
  for(const pathname of ['private/a','src-other/a','src2/a'])await deniedWithoutBackend('SCOPE_DENIED',()=>sdk.lookup(empty.object_id,pathname));
  for(const id of [empty.object_id,'sha256:'+'0'.repeat(64)])await deniedWithoutBackend('SCOPE_DENIED',()=>sdk.object(id));
  await client.query('UPDATE hyperfide.source_capabilities SET path_prefixes=$2 WHERE id=$1',[capabilityId,['']]);
 });
 await check('http-cross-domain-known-and-unknown-guesses-have-identical-refusals',async()=>{
  const foreign=new SourceControlClient({endpoint,scope:other,token:()=>token({...claims,scope:other})});
  await client.query('INSERT INTO hyperfide.source_authority_domains SELECT organisation_id,repository_id,$1,authority_epoch,policy_version,enabled FROM hyperfide.source_authority_domains WHERE security_domain_id=$2',[other.security_domain_id,scope.security_domain_id]);
  await client.query('INSERT INTO hyperfide.source_principal_credentials SELECT organisation_id,repository_id,$1,credential_id,principal_id,principal_kind,credential_version,issuer,audience,signing_key_id,expires_at,revoked_at FROM hyperfide.source_principal_credentials WHERE security_domain_id=$3 AND credential_id=$2',[other.security_domain_id,credentialId,scope.security_domain_id]);
  for(const id of [empty.object_id,'sha256:'+'0'.repeat(64)])await deniedWithoutBackend('SCOPE_DENIED',()=>foreign.object(id));
 });
 await check('private-agent-group-context-is-bounded-and-rejected-from-public-revisions-and-audit',async()=>{
  const context={schema_version:1,agent_group_id:randomUUID(),agent_id:randomUUID(),run_id:randomUUID(),task_id:randomUUID(),attempt_id:randomUUID(),attempt_generation:'1',context:{prompt:'Private instruction',transcript:['Private reasoning']}};
  assert.deepEqual(contracts.parsePrivateAgentGroupContext(context),context);
  assert.deepEqual(Object.keys(context).sort(),[...contracts.PRIVATE_AGENT_GROUP_CONTEXT_FIELDS].sort());
  rejected('INVALID_REQUEST',()=>contracts.parsePrivateAgentGroupContext({...context,unknown:'private'}));
  rejected('INVALID_REQUEST',()=>contracts.parsePrivateAgentGroupContext({...context,context:[]}));
  rejected('INVALID_IDENTITY',()=>contracts.parsePrivateAgentGroupContext({...context,agent_group_id:'invalid'}));
  rejected('INVALID_GENERATION',()=>contracts.parsePrivateAgentGroupContext({...context,attempt_generation:'-1'}));
  rejected('LIMIT_EXCEEDED',()=>contracts.parsePrivateAgentGroupContext({...context,context:{text:'x'.repeat(65537)}}));
  const record=audit.sourceAuditRecord(authorized,{action:'source.revisions.create',operation_id:randomUUID(),request_digest:'sha256:'+'3'.repeat(64),result:'SUCCEEDED',source_ids:[base.revision_id]});
  const before=await rowCounts();
  for(const field of contracts.PRIVATE_AGENT_GROUP_CONTEXT_FIELDS){
   await deniedWithoutBackend('INVALID_REQUEST',()=>call('source.revisions.create',{...revisionInput,provenance:{...revisionInput.provenance,[field]:context[field]}},{idempotency_key:randomUUID()}));
   if(field!=='schema_version'){
    await refused('INVALID_AUDIT_RECORD',()=>tx(db=>audit.appendSourceAudit(db,{...record,[field]:context[field]})));
    rejected('INVALID_AUDIT_RECORD',()=>audit.sourceAuditRecord(authorized,{...record,[field]:context[field]}));
    rejected('INVALID_AUDIT_RECORD',()=>audit.sourceAuditRecord({...authorized,[field]:context[field]},record));
   }
  }
  assert.deepEqual(await rowCounts(),before);
  const persisted=(await client.query('SELECT descriptor FROM hyperfide.source_revisions WHERE revision_id=$1',[base.revision_id])).rows[0].descriptor;
  assert.deepEqual(persisted.provenance,revisionInput.provenance);
  assert.ok(!JSON.stringify(persisted).includes('Private instruction'));
 });
 await check('http-revocation-fences-warm-client-reads-new-mutations-and-credentials',async()=>{
  const warm=await sdk.object(empty.object_id);assert.ok(warm.payload_base64);
  await client.query('UPDATE hyperfide.source_capabilities SET revoked_at=clock_timestamp() WHERE id=$1',[capabilityId]);
  const before=await rowCounts();
  for(const id of [empty.object_id,'sha256:'+'0'.repeat(64)])await deniedWithoutBackend('SCOPE_DENIED',()=>sdk.object(id));
  const operation=randomUUID();await deniedWithoutBackend('SCOPE_DENIED',()=>call('source.revisions.create',{...revisionInput,change_id:randomUUID()},{operation_id:operation,idempotency_key:operation}));
  assert.deepEqual(await rowCounts(),before);
  mutationRevocation={result:'SCOPE_DENIED',immediate:true,new_revision_rows:0,new_audit_rows:0,new_backend_requests:0};
  await client.query('UPDATE hyperfide.source_capabilities SET revoked_at=NULL WHERE id=$1',[capabilityId]);
  await client.query('UPDATE hyperfide.source_principal_credentials SET revoked_at=clock_timestamp() WHERE credential_id=$1',[credentialId]);
  await deniedWithoutBackend('UNAUTHENTICATED',()=>sdk.object(empty.object_id));
  await client.query('UPDATE hyperfide.source_principal_credentials SET revoked_at=NULL WHERE credential_id=$1',[credentialId]);
 });
 assert.ok(issued.residual_validity_ms>0&&issued.residual_validity_ms<=config.maximum_lifetime_seconds*1000);
 assert.equal(issued.residual_validity_ms,Date.parse(issued.grant.expires_at)-Date.parse(issued.grant.issued_at));
 const source_digest=await digestTrees([['control',path.join(root,'core/control-plane/src')],['sdk',path.join(root,'sdk/source-control/src')]]);
 const dist_digest=await digestTrees([['control',path.dirname(moduleRoot)],['sdk',sdkRoot]]);
 const receipt={schema_version:1,task:'1.3',repair_task:'22.37.11',status:'PASS',command:'python3 tests/hyperfide/cases/source_control/1_3.py',exit_code:0,revision:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),source_digest,dist_digest,backend:'owned-postgresql-and-sigv4-http',backend_requests:fixture.requests.length,assertions:checks,revoked_get_grant:{residual_validity_ms:issued.residual_validity_ms},immediate_mutation_revocation:mutationRevocation,scope:'Compiled registered source service api.invoke through actual loopback HTTP and SDK; component authentication and retained grant checks',build_evidence:'/out/run/gates.jsonl#kind=build',verify_evidence:'/out/run/gates.jsonl#kind=verify'};
 const bytes=JSON.stringify(receipt,null,2)+'\n',receiptDigest=createHash('sha256').update(bytes).digest('hex');
 await writeFile(path.join(out,'receipt.json'),bytes,{mode:0o600});
 await writeFile(path.join(out,'receipt.sha256'),receiptDigest+'\n',{mode:0o600});
 console.log(JSON.stringify({...receipt,receipt_sha256:receiptDigest}));
}finally{if(server)await server.close();controller.abort();await client.end();await pool.end();await fixture.close();}
'''


def main():
    node = shutil.which(os.environ.get('HYPERFIDE_NODE_BINARY') or 'node')
    if node is None:
        raise RuntimeError('CAPABILITY_MISSING: set HYPERFIDE_NODE_BINARY or provide node on PATH')
    specification = importlib.util.spec_from_file_location(
        'native_source_fixture', ROOT / 'tests/hyperfide/support/native_source_fixture.py')
    fixture = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(fixture)
    actor = ROOT / 'build/source-control/1.3/capability_actor.mjs'
    actor.parent.mkdir(parents=True, exist_ok=True)
    actor.write_text(PROGRAM)
    with tempfile.TemporaryDirectory(prefix='node-', dir=actor.parent) as node_directory:
        (Path(node_directory) / 'node').symlink_to(Path(node).resolve())
        os.environ['PATH'] = node_directory + os.pathsep + os.environ.get('PATH', '')
        return fixture.run_source_actor(actor, timeout=180)


if __name__ == '__main__':
    sys.exit(main())
