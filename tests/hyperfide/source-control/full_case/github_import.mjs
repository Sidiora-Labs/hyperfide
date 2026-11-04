import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {createNativeAcceptanceFixture} from '../../support/native_source_acceptance_fixture.mjs';
const evidenceFile=process.env.HF_SOURCE_GITHUB_IMPORT_RECEIPT;
assert(evidenceFile,'HF_SOURCE_GITHUB_IMPORT_RECEIPT must identify the owned GitHub canary');
const fd=await fs.open(evidenceFile,constants.O_RDONLY|constants.O_NOFOLLOW);let original;
try{const stat=await fd.stat();assert(stat.isFile()&&stat.size<1048576);original=JSON.parse(await fd.readFile('utf8'));}finally{await fd.close();}
assert.equal(original.status,'PASS');assert.equal(original.provider,'github');assert.equal(original.private,true);
assert.match(original.repository,/^[A-Za-z0-9-]+\/hyperfide-source-canary-[A-Za-z0-9-]+$/);assert.match(original.head,/^git:sha1:[a-f0-9]{40}$/);
assert.equal(original.remote,'https://github.com/'+original.repository+'.git');
function command(program,args,env){const result=spawnSync(program,args,{env,encoding:'utf8',maxBuffer:1048576,timeout:60000});assert.equal(result.status,0,program+' read operation failed');return result.stdout.trim();}
const profile=JSON.parse(command('gh',['api','repos/'+original.repository])),user=command('gh',['api','user','--jq','.login']);
assert.equal(profile.private,true);assert.equal(profile.owner.login.toLowerCase(),user.toLowerCase());
const token=command('gh',['auth','token']);
const environment={PATH:process.env.PATH,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_COUNT:'2',GIT_CONFIG_KEY_0:'http.extraHeader',GIT_CONFIG_VALUE_0:'Authorization: Basic '+Buffer.from('x-access-token:'+token).toString('base64'),GIT_CONFIG_KEY_1:'core.hooksPath',GIT_CONFIG_VALUE_1:'/dev/null'};
const git=args=>command('git',args,environment),checks=[];
assert.equal(git(['ls-remote',original.remote,'refs/heads/main']).split(/\s/)[0],original.head.slice(9));
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'hf-live-import-')),bare=path.join(temporary,'source.git');let f;
try{
 git(['init','--bare',bare]);git(['--git-dir='+bare,'fetch','--no-tags','--no-recurse-submodules',original.remote,original.head.slice(9)+':refs/heads/captured']);
 assert.equal(git(['--git-dir='+bare,'rev-parse','refs/heads/captured']),original.head.slice(9));git(['--git-dir='+bare,'fsck','--full','--strict']);
 checks.push('the current owned private GitHub ref is fetched read-only at the exact retained canary identity');
 const moduleRoot=process.env.SOURCE_CONTROL_MODULE_ROOT,{createLocalGitImportSource}=await import(pathToFileURL(path.join(moduleRoot,'git/import_transport.js')));
 const scope={organisation_id:randomUUID(),repository_id:randomUUID(),security_domain_id:randomUUID()},source=createLocalGitImportSource({id:'live-github',scope,repository_identity:original.remote,path:bare});
 const actions=['source.objects.put','source.objects.read','source.revisions.create','source.revisions.read','source.trees.entries','source.trees.lookup','source.domains.create','source.projections.create','source.projections.read','source.operations.read','source.imports.create','source.imports.read','source.imports.resume','source.imports.mappings'];
 f=await createNativeAcceptanceFixture({scope,actions,serviceOptions:{imports:{sources:[source]}}});
 const policy={schema_version:1,policy_id:randomUUID(),version:1,project_id:'github-canary',repository_identity:original.remote,mappings:[{source_path:'',target_path:'github'}],dependencies:[],no_visible_change:'KEEP',merge_parents:'ORDERED_UNIQUE',public_metadata:'NATIVE_PUBLIC_V1',signature_policy:'PRESERVE_OBSERVATION',tag_signing:'REJECT',object_format:'sha1'};
 const call=(action,input)=>f.client.call(action,input,{operation_id:randomUUID(),idempotency_key:randomUUID()});
 await call('source.projections.create',policy);const id=randomUUID();let state=await call('source.imports.create',{import_id:id,source_id:source.id,tip_oid:original.head,base_revision_id:f.base.revision_id,policy_id:policy.policy_id,policy_version:1,budget:{max_commits:8,max_objects:128,max_bytes:1048576,max_file_bytes:1048576,max_depth:32,max_total_commits:32}});
 for(let n=0;state.state==='IMPORTING'&&n<8;n++)state=await call('source.imports.resume',{import_id:id});assert.equal(state.state,'COMPLETE');
 assert.equal((await call('source.imports.resume',{import_id:id})).revision_id,state.revision_id);
 const mappings=await call('source.imports.mappings',{import_id:id,limit:32});assert(mappings.mappings.some(item=>item.git_oid===original.head));
 checks.push('the live GitHub source imports through bounded native APIs with exact Git mappings and replay identity');
 const revision=await f.client.revision(state.revision_id);
 for(const filename of ['main.txt','binary.dat','run.sh']){const entry=await f.service.trees.lookup(scope,revision.root_tree_id,'github/'+filename);const expected=spawnSync('git',['--git-dir='+bare,'show',original.head.slice(9)+':'+filename],{env:environment,maxBuffer:1048576});assert.equal(expected.status,0);assert.deepEqual(await f.service.objects.readFile(scope,entry.object_id),expected.stdout);if(filename==='run.sh')assert.equal(entry.mode,'100755');}
 const archive=(await f.pool.query('SELECT archive_object_id FROM hyperfide.source_git_import_objects WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND import_id=$4 AND git_oid=$5',[...Object.values(scope),id,original.head])).rows[0];const bytes=await f.service.objects.readFile(scope,archive.archive_object_id);assert.equal('git:sha1:'+createHash('sha1').update(bytes).digest('hex'),original.head);
 assert.equal(git(['ls-remote',original.remote,'refs/heads/main']).split(/\s/)[0],original.head.slice(9));
 checks.push('native imported bytes, executable mode and archived original object match Git while the remote ref remains unchanged');
 const output=process.env.HYPERFIDE_SOURCE_EVIDENCE_DIR;assert(output);await fs.mkdir(output,{recursive:true});
 const receipt={status:'PASS',scope:'read-only live GitHub fetch and native importer on owned PostgreSQL/SigV4 fixture',checks,repository:original.repository,git_head:original.head,native_revision:state.revision_id,imported_commits:state.metrics.imported_commits,remote_mutations:0,cleanup:{complete:true,resources:[]}};
 await fs.writeFile(path.join(output,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));
}finally{await f?.close();await fs.rm(temporary,{recursive:true,force:true});}
