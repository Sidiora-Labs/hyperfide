import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';

export async function verifyManagedWorkerGraphScope({f,root,controlRoot,baseline,workspace_id,principal_id,invokeWorker}){
 const load=name=>import(pathToFileURL(path.join(controlRoot,name+'.js')));
 const [{NativeSourceGraph},{authorizeSource},{verifySourcePrincipalToken}]=await Promise.all([load('source_control/graph-adapter'),load('source_control/capabilities'),load('source_control/authentication')]);
 const filename='private-graph.ts',body='export function privateWorkerScopeSecret() { return 73; }\n';
 const file=await f.service.objects.putFile(f.scope,Buffer.from(body));
 const allowed=[];
 for(const name of ['one','two','three']){const value=await f.service.objects.putFile(f.scope,Buffer.from('export const '+name+' = 1;\n'));allowed.push({name:name+'.ts',kind:'file',mode:'100644',object_id:value.object_id});}
 const allowedTree=await f.service.trees.fromEntries(f.scope,allowed);
 const patched=await f.service.trees.patch(f.scope,baseline.root_tree_id,[{path:filename,operation:'put',kind:'file',mode:'100644',object_id:file.object_id},{path:'main.txt',operation:'put',kind:'directory',mode:'040000',object_id:allowedTree.root_tree_id}]);
 const revision=await f.createRevision({root_tree_id:patched.root_tree_id,parent_revision_ids:[baseline.revision_id]});
 const capability=randomUUID(),author=f.roles.author;
 await f.pool.query("INSERT INTO hyperfide.source_capabilities(organisation_id,repository_id,security_domain_id,id,principal_id,credential_id,principal_kind,authority_epoch,policy_version,actions,path_prefixes,expires_at) VALUES($1,$2,$3,$4,$5,$6,'automation',1,$7,$8,$9,clock_timestamp()+interval '10 minutes')",[...Object.values(f.scope),capability,author.principal_id,author.credential_id,f.sourcePolicy,['source.graph.build','source.graph.publish','source.graph.query','source.revisions.read','source.objects.read','source.trees.lookup','source.trees.entries'],['']]);
 const context=await f.service.metadata.transaction(tx=>authorizeSource(tx,{principal:verifySourcePrincipalToken(f.tokenFor('author',capability),f.trust,f.scope),scope:f.scope,action:'source.graph.build',mutation:true,paths:[filename,'main.txt']}));
 const binary=path.resolve('hyperfide'),binary_digest='sha256:'+createHash('sha256').update(await fs.readFile(binary)).digest('hex');
 const graph=new NativeSourceGraph(f.service.metadata,f.service.trees,f.service.objects,{binary,binary_digest,scratch:path.join(root,'worker-graph')},Buffer.alloc(32,19));
 const build=await graph.build(context,{build_id:randomUUID(),revision_id:revision.revision_id,root_tree_id:revision.root_tree_id,paths:[filename,'main.txt/**'],configuration:{resolver_digest:'sha256:'+'1'.repeat(64),generated_digest:'sha256:'+'2'.repeat(64),build_flags:[]}});
 assert.equal(build.coverage.complete,true);
 await graph.publish(context,{operation_id:randomUUID(),build_id:build.build_id,channel:'worker-scope',expected_generation:'0'});
 const input={build_id:build.build_id,revision_id:revision.revision_id,root_tree_id:revision.root_tree_id,limit:128};
 const visible=await graph.query(context,{...input,mode:'context'});assert.equal(visible.rows.find(row=>row.path===filename).body,body);assert.equal(visible.rows.length,4,'Author graph must include all four fixture files: '+JSON.stringify(visible.rows.map(row=>row.path)));
 const actualWorkspace=(await f.pool.query('SELECT read_paths FROM hyperfide.source_workspaces WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND workspace_id=$4 AND principal_id=$5',[...Object.values(f.scope),workspace_id,principal_id])).rows[0];assert.deepEqual(actualWorkspace.read_paths,['main.txt'],'Managed workspace has the expected read prefix');
 for(const mode of ['status','symbols','context','dependencies']){
  const result=await invokeWorker('source.graph.query',{...input,mode});
  assert.equal(result.rows.length,3);assert(result.rows.every(row=>row.path.startsWith('main.txt/')));assert.equal(result.coverage.scope,'AUTHORIZED_FILES_ONLY');assert(!JSON.stringify(result).includes(filename));assert(!JSON.stringify(result).includes('privateWorkerScopeSecret'));
 }
 await assert.rejects(()=>invokeWorker('source.graph.query',{...input,mode:'context',path:filename}),error=>error.code==='SCOPE_DENIED');
 await assert.rejects(()=>invokeWorker('source.objects.read',{object_id:file.object_id}),error=>error.code==='AUTH_SCOPE_DENIED');
 const values=[...Object.values(f.scope),workspace_id,principal_id];
 const original=(await f.pool.query('SELECT read_paths,write_paths FROM hyperfide.source_workspaces WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND workspace_id=$4 AND principal_id=$5',values)).rows[0];
 try{
  await f.pool.query("UPDATE hyperfide.source_workspaces SET read_paths=$6,write_paths='[]'::jsonb WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND workspace_id=$4 AND principal_id=$5",[...values,JSON.stringify(['main.txt/one.ts','main.txt/two.ts'])]);
  const first=await invokeWorker('source.graph.query',{...input,mode:'status',limit:1});assert(first.next_cursor);
  await f.pool.query('UPDATE hyperfide.source_workspaces SET read_paths=$6,write_paths=$7 WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND workspace_id=$4 AND principal_id=$5',[...values,JSON.stringify(original.read_paths),JSON.stringify(original.write_paths)]);
  await assert.rejects(()=>invokeWorker('source.graph.query',{...input,mode:'status',limit:1,cursor:first.next_cursor}),error=>['RESNAPSHOT_REQUIRED','INVALID_CURSOR'].includes(error.code));
  assert.equal((await invokeWorker('source.graph.query',{...input,mode:'status'})).rows.length,3);
 }finally{await f.pool.query('UPDATE hyperfide.source_workspaces SET read_paths=$6,write_paths=$7 WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND workspace_id=$4 AND principal_id=$5',[...values,JSON.stringify(original.read_paths),JSON.stringify(original.write_paths)]);}
 return ['managed worker graph reads intersect the exact live workspace read scope across every graph query mode','explicit private graph paths and ungranted raw object reads are refused under signed worker authority','graph cursors cannot cross a change in the authoritative managed workspace read scope'];
}
