import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createNativeAcceptanceFixture} from './native_source_acceptance_fixture.mjs';
const f=await createNativeAcceptanceFixture({actions:['source.revisions.create','source.revisions.read','source.domains.create','source.operations.read','source.queries.batch','source.trees.lookup','source.trees.entries','source.queries.ancestry']});
const {SourceControlClient}=await import(pathToFileURL(path.join(process.env.SOURCE_CONTROL_SDK_MODULE_ROOT,'client.js')));
const checks=[];
const good={id:'revision',action:'source.revisions.read',input:{revision_id:f.base.revision_id}};
const refused=(code,body)=>assert.rejects(body,e=>e.code===code,code);
try {
 const mixed=await f.client.batch({items:[good,{id:'absent',action:'source.revisions.read',input:{revision_id:'sha256:'+'f'.repeat(64)}},{id:'bad',action:'source.revisions.read',input:{revision_id:'invalid'}}]},{causal_token:f.base.causal_token});
 assert.equal(mixed.coverage,'PARTIAL');assert.deepEqual(mixed.items.map(x=>[x.id,x.action]),[['revision','source.revisions.read'],['absent','source.revisions.read'],['bad','source.revisions.read']]);
 assert.equal(mixed.items[0].result.revision_id,f.base.revision_id);assert.equal(mixed.items[1].error.code,'NOT_FOUND');assert.equal(mixed.items[2].error.code,'INVALID_IDENTITY');
 checks.push('one SDK HTTP batch returns independently bound successful, absent and malformed metadata reads');
 const restricted=randomUUID();
 await f.pool.query(`INSERT INTO hyperfide.source_capabilities(organisation_id,repository_id,security_domain_id,id,principal_id,credential_id,principal_kind,authority_epoch,policy_version,actions,path_prefixes,expires_at) VALUES($1,$2,$3,$4,$5,$6,'automation',1,$7,$8,ARRAY['main.txt'],clock_timestamp()+interval '10 minutes')`,[...Object.values(f.scope),restricted,f.roles.author.principal_id,f.roles.author.credential_id,f.sourcePolicy,['source.queries.batch','source.trees.lookup']]);
 const scoped=new SourceControlClient({endpoint:f.endpoint,scope:f.scope,token:()=>f.tokenFor('author',restricted)});
 const paths=await scoped.batch({items:[{id:'allowed',action:'source.trees.lookup',input:{tree_id:f.base.root_tree_id,path:'main.txt'}},{id:'denied',action:'source.trees.lookup',input:{tree_id:f.base.root_tree_id,path:'secrets/key'}}]});
 assert(paths.items[0].result.entry);assert.equal(paths.items[1].error.code,'SCOPE_DENIED');
 checks.push('path-restricted parent batch independently authorizes every member and returns no denied-path data');
 const forbidden=await f.client.batch({items:[{id:'mutation',action:'source.revisions.create',input:{}},{id:'nested',action:'source.queries.batch',input:{items:[good]}},{id:'binary',action:'source.objects.read',input:{object_id:f.base.root_tree_id}},good]});
 assert(forbidden.items.slice(0,3).every(x=>x.error.code==='BATCH_ACTION_DENIED'));assert.equal(forbidden.items[3].result.revision_id,f.base.revision_id);
 await refused('LIMIT_EXCEEDED',()=>f.client.batch({items:Array.from({length:17},(_,i)=>({...good,id:'n'+i}))}));
 await refused('INVALID_REQUEST',()=>f.client.batch({items:[good,good]}));
 await refused('INVALID_REQUEST',()=>f.client.batch({items:[{...good,scope:f.scope}]}));
 await refused('LIMIT_EXCEEDED',()=>f.client.batch({items:[good],budget:{max_bytes:524289}}));
 checks.push('nested batches, mutations, raw bytes, duplicate identities, scope overrides and oversized envelopes are refused');
 const stale=JSON.parse(Buffer.from(f.base.causal_token,'base64url'));stale[2]='2';
 const causal=await f.client.batch({items:[good,{...good,id:'second'}]},{causal_token:Buffer.from(JSON.stringify(stale)).toString('base64url')});
 assert(causal.items.every(x=>x.error.code==='STALE_CAUSAL_TOKEN'));
 checks.push('parent causal dependency reaches every child read and cannot be dropped in a batch');
 const entry=await f.service.trees.lookup(f.scope,f.base.root_tree_id,'main.txt');
 const wide=await f.service.trees.fromEntries(f.scope,Array.from({length:150},(_,i)=>({name:String(i).padStart(3,'0')+'x'.repeat(120),kind:'file',mode:'100644',object_id:entry.object_id})));
 const bounded=await f.client.batch({items:[{id:'wide',action:'source.trees.entries',input:{tree_id:wide.root_tree_id,limit:256}},good],budget:{max_bytes:16384}});
 assert.equal(bounded.items[0].error.code,'BATCH_BYTE_LIMIT');assert.equal(bounded.items[1].error.code,'BATCH_BYTE_LIMIT');assert(Buffer.byteLength(JSON.stringify(bounded))<16384);
 checks.push('large metadata results exhaust a shared byte budget with explicit per-item failure and bounded output');
 const blocker=await f.pool.connect();
 try {
  await blocker.query('BEGIN');await blocker.query('SELECT 1 FROM hyperfide.source_repositories WHERE organisation_id=$1 FOR UPDATE',[f.scope.organisation_id]);
  const started=Date.now();const cancelled=await f.client.batch({items:[{id:'blocked',action:'source.queries.ancestry',input:{ancestor_revision_id:f.base.revision_id,descendant_revision_id:f.base.revision_id,budget:{max_ms:5000}}},good],budget:{max_ms:50}},{causal_token:f.base.causal_token});
  assert(Date.now()-started<2000);assert(cancelled.items.every(x=>x.error.code==='BATCH_CANCELLED'));
 }finally {await blocker.query('ROLLBACK');blocker.release();}
 assert.equal((await f.client.batch({items:[good]})).coverage,'COMPLETE');
 checks.push('a real blocked PostgreSQL read cannot exceed the group deadline or admit later members; the API remains usable');
 const receipt={schema_version:1,status:'PASS',checks,scope:'actual authenticated HTTP, PostgreSQL locks, SigV4 objects and typed SDK',requests:f.backend.requests.length};
 const out=path.resolve('build/source-control/batch');await fs.mkdir(out,{recursive:true});await fs.writeFile(path.join(out,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');for(const check of checks)console.log('batch-source: '+check);console.log(JSON.stringify(receipt,null,2));
}finally {await f.close();}
