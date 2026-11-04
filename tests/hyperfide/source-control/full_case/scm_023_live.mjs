import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {loadSourceClient} from '../../../../plugins/hyperfide-source-control/runtime.ts';
import {runSourceProductBrowser} from '../../support/native_source_product_browser.mjs';
import {captureNativeSource} from './native_capture.mjs';
import {verifyLiveFleetFacts} from './scm_023_live_fleet.mjs';

const exec=promisify(execFile),root=path.resolve(import.meta.dirname,'../../../..');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function protectedJSON(filename){
 assert(path.isAbsolute(filename),'Absolute input path required');
 const file=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const stat=await file.stat();assert(stat.isFile()&&stat.nlink===1&&stat.size<262144&&(stat.mode&0o077)===0,'Private bounded regular input required');return JSON.parse(await file.readFile('utf8'));}finally{await file.close();}
}
const input=await protectedJSON(process.env.HF_SOURCE_LIVE_JOURNEY_INPUT);
const config=await protectedJSON(input.source_config);
assert(new URL(config.endpoint).protocol==='https:');
assert(!['127.0.0.1','localhost','::1','[::1]','0.0.0.0'].includes(new URL(config.endpoint).hostname),'Live journey requires deployed endpoint');
assert.equal(input.variant,'api-cli-ui');
const binding=await loadSourceClient(input.source_config),client=binding.client;
const output=path.join(root,'build/source-control/full-case/SCM-023-live');
await fs.mkdir(output,{recursive:true});
const assertions=[];
const prove=(id,value)=>{assert.equal(value,true,id);assertions.push({id:'SCM-023.live.'+id,expected:true,actual:true});};
const candidate=await client.call('source.candidates.read',{candidate_id:input.candidate_id});
const revision=await client.revision(candidate.revision_id);
assert.equal(revision.root_tree_id,candidate.root_tree_id);
assert(candidate.contributors.some(c=>c.run_id===input.run_id&&c.task_id===input.task_id&&c.revision_id===revision.revision_id),'Candidate must retain real native worker custody');
const assignment=await client.call('source.fleet.read',{assignment_id:input.assignment_id});
assert.equal(assignment.assignment_id,input.assignment_id);
assert.equal(assignment.task_id,input.task_id);
assert.equal(assignment.run_id,input.run_id);
assert.equal(assignment.authority.managed.attempt_id,assignment.attempt_id);
assert.equal(assignment.authority.managed.attempt_generation,assignment.attempt_generation);
assert(assignment.workspace_id && assignment.base_revision_id);
prove('native-worker-candidate-custody',true);
const options=()=>{const id=randomUUID();return {operation_id:id,idempotency_key:id};};
const createRevision=async({text,parent_revision_ids})=>{
 const parent=await client.revision(parent_revision_ids[0]);
 const bytes=Buffer.from(text),blob=await client.call('source.objects.put',{kind:'blob',payload_base64:bytes.toString('base64')},options());
 const descriptor=Buffer.from(JSON.stringify([1,String(bytes.length),'sha256:'+hash(bytes),['blob',blob.object_id]]));
 const file=await client.call('source.objects.put',{kind:'file',payload_base64:descriptor.toString('base64')},options());
 const tree=await client.call('source.trees.patch',{tree_id:parent.root_tree_id,patches:[{path:input.conflict_path??'main.txt',operation:'put',kind:'file',mode:'100644',object_id:file.object_id}]},options());
 return client.createRevision({change_id:randomUUID(),root_tree_id:tree.root_tree_id,parent_revision_ids,predecessor_revision_ids:[],provenance:{author:{name:'Source product qualification',email:''},message:'Explicit live product conflict scenario',timestamp:new Date().toISOString()}},options());
};
const cli=async args=>{
 const env={...process.env};delete env.HYPERFIDE_CLI;delete env.HYPERFIDE_CLI_REEXEC;
 const result=await exec(process.execPath,[path.join(root,'apps/cli/dist/index.js'),'source','--config',input.source_config,...args],{cwd:output,env,timeout:60000,maxBuffer:4194304});
 return JSON.parse(result.stdout.trim());
};
await fs.access(path.join(root,'apps/cli/dist/index.js'));
const cliRevision=await cli(['revision',revision.revision_id]);
prove('signed-cli-revision',cliRevision.ok===true&&cliRevision.result.root_tree_id===revision.root_tree_id);
const history=await cli(['history',revision.revision_id]);
prove('signed-cli-history-without-clone',history.ok===true&&history.result.entries.some(row=>row.revision_id===revision.revision_id)&&!(await fs.readdir(output)).includes('.git'));
const progressFile=path.join(output,'browser-progress.json');
let resume;
try { resume=JSON.parse(await fs.readFile(progressFile,'utf8')); }
catch(error) { if(error.code!=='ENOENT')throw error; }
if(resume) {
 assert.equal(resume.candidate_id,input.candidate_id,'Progress belongs to another candidate');
 assert.equal(resume.revision_id,revision.revision_id);
 assert.equal(resume.root_tree_id,revision.root_tree_id);
 for(const file of resume.screenshots??[])assert((await fs.stat(file)).size>0);
}
const browser=await runSourceProductBrowser({client,scope:config.scope,base:revision,createRevision,projectName:'Deployed native fleet source'},binding,{progressFile,resume,candidateId:input.candidate_id,evidenceIds:input.evidence_ids,revisionId:revision.revision_id,rootTreeId:revision.root_tree_id,destinationId:input.destination_id,targetRef:input.target_ref,expectedOldOid:input.expected_old_oid??'git:sha1:'+'0'.repeat(40),outputDirectory:path.relative(root,path.join(output,'browser'))});
prove('ui-native-independent-qualification',browser.qualification?.candidate_id===input.candidate_id&&browser.qualification.evidence.evidence_ids.every(id=>input.evidence_ids.includes(id)));
const accepted=await client.call('source.acceptance.read',{acceptance_id:browser.acceptance_id});
prove('ui-accepts-exact-worker-revision',accepted.revision_id===revision.revision_id&&accepted.root_tree_id===revision.root_tree_id&&accepted.qualification_id===browser.qualification.qualification_id);
prove('ui-real-conflict-and-resolution',browser.conflict.status==='PASS'&&browser.conflict.base_revision_id===revision.revision_id);
prove('ui-three-viewport-journeys',browser.screenshots.length===18&&(await Promise.all(browser.screenshots.map(file=>fs.stat(file)))).every(stat=>stat.size>0));
const publication=await client.call('source.publications.read',{operation_id:browser.publication.operation_id});
prove('ui-configured-publication',publication.status==='PUBLISHED'&&publication.acceptance_id===accepted.acceptance_id&&publication.revision_id===revision.revision_id);
assert(/^[-\w.]+\/[-\w.]+$/.test(input.github_repository),'Explicit GitHub repository required');
assert(/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(input.target_ref));
const gh=async args=>JSON.parse((await exec('gh',['api',...args],{cwd:output,timeout:60000,maxBuffer:16777216})).stdout);
const head=await gh(['repos/'+input.github_repository+'/git/ref/'+input.target_ref.slice(5)]);
prove('independent-github-head',publication.git_oid==='git:sha1:'+head.object.sha);
const comparePath=input.readback_path??input.conflict_path??'main.txt';
const remote=await gh(['repos/'+input.github_repository+'/contents/'+comparePath+'?ref='+head.object.sha]);
assert.equal(remote.encoding,'base64');
const manifest=await client.nativeFleetManifest({revision_id:revision.revision_id,paths:[comparePath],max_files:1,max_bytes:65536,max_nodes:256,metadata_only:false});
const native=manifest.entries.find(entry=>entry.path===comparePath);assert(native);
prove('independent-github-content',Buffer.from(remote.content,'base64').equals(Buffer.from(native.content_base64,'base64')));
const sourceContext={scope:config.scope,authority_epoch:assignment.authority.authority_epoch,policy_version:assignment.authority.policy_version};
assert.equal(sourceContext.authority_epoch, revision.authority_epoch);
const nativeCapture = await captureNativeSource({client,context:sourceContext,revisionId:revision.revision_id,workspaceRoot:root,outputDirectory:path.join(output,'native'),assertionIds:[...assertions.map(row=>row.id),'SCM-023.live.native-source-capture'],toolchain:[process.execPath]});
prove('native-source-capture',nativeCapture.revision_id===revision.revision_id&&nativeCapture.root_tree_id===revision.root_tree_id);
const receipt={schema_version:1,status:'PASS',variant:'api-cli-ui',execution_profile:'deployed-signed-native-fleet-github',endpoint:config.endpoint,scope:config.scope,run_id:input.run_id,task_id:input.task_id,assignment_id:input.assignment_id,candidate_id:input.candidate_id,revision_id:revision.revision_id,root_tree_id:revision.root_tree_id,acceptance:accepted,publication,github:{repository:input.github_repository,head:head.object.sha,content_sha256:hash(Buffer.from(remote.content,'base64'))},browser,native_capture:nativeCapture,assertions};
if(process.env.HF_SOURCE_LIVE_FULL==='1') {
 const fleet=await verifyLiveFleetFacts({input,client,scope:config.scope,protectedJSON,product:receipt});
 const mapping=[
  ['signed-cli-revision-read',['signed-cli-revision']],
  ['signed-cli-history-without-checkout',['signed-cli-history-without-clone']],
  ['ui-shows-exact-fleet-accepted-source',['ui-accepts-exact-worker-revision']],
  ['ui-conflict-resolution-preserves-source',['ui-real-conflict-and-resolution']],
  ['ui-desktop-tablet-mobile',['ui-three-viewport-journeys']],
  ['ui-publication-has-explicit-durable-status',['ui-configured-publication']],
  ['independent-git-readback-matches-native',['independent-github-head','independent-github-content']],
  ['genuine-native-source-capture',['native-source-capture']],
 ];
 const observed=new Set(assertions.map(row=>row.id));
 const fullIds=[...fleet.ids,...mapping.map(([id,requirements])=>{for(const requirement of requirements)assert(observed.has('SCM-023.live.'+requirement));return 'SCM-023.'+id;})];
 assert.equal(fullIds.length,19);
 receipt.product_assertions=assertions.slice();
 receipt.assertions=fullIds.map(id=>({id,expected:true,actual:true}));
 receipt.fleet=fleet.records;
 receipt.native_capture=await captureNativeSource({client,context:sourceContext,revisionId:revision.revision_id,workspaceRoot:root,outputDirectory:path.join(output,'native-full'),assertionIds:fullIds,toolchain:[process.execPath]});
}
await fs.writeFile(path.join(output,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');
for(const assertion of receipt.assertions)console.log(JSON.stringify({type:'assertion',...assertion}));
console.log(JSON.stringify({type:'cleanup',complete:true,resources:[],retained:['native source history','configured GitHub publication']}));
