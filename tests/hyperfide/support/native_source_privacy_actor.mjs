import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createNativeAcceptanceFixture} from './native_source_acceptance_fixture.mjs';
const actions=['source.revisions.create','source.revisions.read','source.domains.create','source.objects.read','source.objects.inspect','source.trees.lookup','source.trees.entries','source.queries.history','source.queries.ancestry','source.queries.merge-bases','source.queries.diff','source.queries.blame','source.queries.line-map','source.subscriptions.create','source.subscriptions.poll','source.publications.create','source.audit.read'];
const f=await createNativeAcceptanceFixture({actions});
const {SourceControlClient}=await import(pathToFileURL(path.join(process.env.SOURCE_CONTROL_SDK_MODULE_ROOT,'client.js')));
const checks=[];
try{
 const publicFile=await f.service.objects.putFile(f.scope,Buffer.from('public source\n'));
 const privateFile=await f.service.objects.putFile(f.scope,Buffer.from('not visible outside private scope\n'));
 const tree=await f.service.trees.patch(f.scope,f.base.root_tree_id,[{path:'public/main.txt',operation:'put',kind:'file',mode:'100644',object_id:publicFile.object_id},{path:'private/secret.txt',operation:'put',kind:'file',mode:'100644',object_id:privateFile.object_id}]);
 const revision=await f.createRevision({root_tree_id:tree.root_tree_id});
 const cap=randomUUID();
 await f.pool.query(`INSERT INTO hyperfide.source_capabilities(organisation_id,repository_id,security_domain_id,id,principal_id,credential_id,principal_kind,authority_epoch,policy_version,actions,path_prefixes,expires_at) VALUES($1,$2,$3,$4,$5,$6,'automation',1,$7,$8,ARRAY['public'],clock_timestamp()+interval '5 minutes')`,[...Object.values(f.scope),cap,f.roles.author.principal_id,f.roles.author.credential_id,f.sourcePolicy,actions]);
 const client=new SourceControlClient({endpoint:f.endpoint,scope:f.scope,token:()=>f.tokenFor('author',cap)});
 const allowed=await client.call('source.trees.lookup',{tree_id:revision.root_tree_id,path:'public/main.txt'});
 assert.equal(allowed.entry.object_id,publicFile.object_id);
 const before=f.backend.requests.length;
 const refusals=[
  ['source.trees.lookup',{tree_id:revision.root_tree_id,path:'private/secret.txt'}],
  ['source.trees.lookup',{tree_id:revision.root_tree_id,path:'private/missing.txt'}],
  ['source.objects.read',{object_id:privateFile.object_id}],
  ['source.objects.read',{object_id:'sha256:'+'f'.repeat(64)}],
  ['source.objects.inspect',{object_id:privateFile.object_id}],
  ['source.trees.entries',{tree_id:revision.root_tree_id}],
  ['source.revisions.read',{revision_id:revision.revision_id}],
  ['source.queries.history',{revision_id:revision.revision_id}],
  ['source.queries.ancestry',{ancestor_revision_id:f.base.revision_id,descendant_revision_id:revision.revision_id}],
  ['source.queries.merge-bases',{left_revision_id:f.base.revision_id,right_revision_id:revision.revision_id}],
  ['source.queries.diff',{before_revision_id:f.base.revision_id,after_revision_id:revision.revision_id}],
  ['source.queries.blame',{revision_id:revision.revision_id,path:'private/secret.txt'}],
  ['source.queries.line-map',{before_revision_id:f.base.revision_id,after_revision_id:revision.revision_id,path:'private/secret.txt'}],
  ['source.subscriptions.create',{consumer_id:randomUUID(),bootstrap_revision_id:revision.revision_id}],
  ['source.subscriptions.poll',{consumer_id:randomUUID(),subscription_epoch:randomUUID()}],
  ['source.publications.create',{acceptance_id:'sha256:'+'a'.repeat(64),destination_id:'private-export',target_ref:'refs/heads/main',expected_old_oid:null}],
  ['source.audit.read',{}],
 ];
 for(const [action,input] of refusals)await assert.rejects(client.call(action,input),error=>error.code==='SCOPE_DENIED',action);
 assert.equal(f.backend.requests.length,before);
 checks.push('an explicitly granted path-limited capability reads its public path and refuses private content, existence, tree listings, revision history, ancestry, diff, blame, line maps, events, audits and export before object I/O');
 const state=(await f.pool.query('SELECT count(*)::int AS n FROM hyperfide.source_git_publications')).rows[0].n;
 assert.equal(state,0);
 await f.pool.query('UPDATE hyperfide.source_capabilities SET revoked_at=clock_timestamp() WHERE id=$1',[cap]);
 await assert.rejects(client.call('source.trees.lookup',{tree_id:revision.root_tree_id,path:'public/main.txt'}),error=>error.code==='SCOPE_DENIED');
 assert.equal(f.backend.requests.length,before);
 checks.push('revocation immediately refuses the previously authorized public path and scoped export leaves no publication intent');
 const foreign={...f.scope,security_domain_id:randomUUID()};
 const other=new SourceControlClient({endpoint:f.endpoint,scope:foreign,token:()=>f.tokenFor('author',cap)});
 for(const object_id of [privateFile.object_id,'sha256:'+'e'.repeat(64)])await assert.rejects(other.call('source.objects.read',{object_id}),error=>['UNAUTHENTICATED','SCOPE_DENIED'].includes(error.code));
 assert.equal(f.backend.requests.length,before);
 checks.push('known and guessed objects in another security domain produce authorization refusals without backend existence reads');
 const receipt={status:'PASS',checks,scope:'actual authenticated HTTP API, explicit action grants, PostgreSQL and SigV4 object fixture',refused_actions:refusals.map(([action])=>action),backend_requests:f.backend.requests.length};
 await fs.mkdir('build/source-control/privacy',{recursive:true});await fs.writeFile('build/source-control/privacy/receipt.json',JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));
}finally{await f.close();}
