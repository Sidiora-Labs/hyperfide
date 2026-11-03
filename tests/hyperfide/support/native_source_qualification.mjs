import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createSignedSourceClient} from '../../../core/authority-client/src/source.ts';
import {SourceMetadata} from '../../../core/control-plane/dist/source_control/metadata.js';
import {createQualificationAdapter} from '../../../plugins/hyperfide-qualify/adapter.ts';
import {LaneService} from '../../../plugins/hyperfide-qualify/lanes.ts';
import {materializeQualification} from '../../../plugins/hyperfide-qualify/native-adapter.ts';
import {writeReceipt} from '../../../plugins/hyperfide-qualify/receipts.ts';
import pg from '../../../core/control-plane/node_modules/pg/lib/index.js';

const {config}=JSON.parse(await fs.readFile(process.env.SOURCE_SIGNED_TRANSPORT_INPUT,'utf8'));
const root=path.dirname(process.env.SOURCE_SIGNED_TRANSPORT_INPUT),pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
const sdk=await createSignedSourceClient(config),oldConfig=process.env.HYPERFIDE_QUALIFY_SOURCE_CONFIG,oldPath=process.env.PATH;
const checks=[];let lanes;
const hash=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
try{
 await new SourceMetadata(pool).registerRepository(config.scope,{authority_epoch:'1',policy_version:'signed-transport-v1',durability_profile:'single-region-verified-s3-v1'});
 const empty=await sdk.call('source.objects.put',{kind:'tree-leaf',payload_base64:Buffer.from('[1,"",[]]').toString('base64')});
 const contents={'spec/fixture/spec.kvx':'[task.1.1]\nverify_cmd = '+JSON.stringify('node -e '+JSON.stringify('console.log("native-qualification")'))+'\n','main.txt':'qualification source\n'};
 const patches=[];
 for(const [name,text]of Object.entries(contents)){
  const bytes=Buffer.from(text),blob=await sdk.call('source.objects.put',{kind:'blob',payload_base64:bytes.toString('base64')});
  const file=await sdk.call('source.objects.put',{kind:'file',payload_base64:Buffer.from(JSON.stringify([1,String(bytes.length),hash(bytes),['blob',blob.object_id]])).toString('base64')});
  patches.push({path:name,operation:'put',kind:'file',mode:'100644',object_id:file.object_id});
 }
 const tree=await sdk.call('source.trees.patch',{tree_id:empty.object_id,patches});
 const revision=await sdk.createRevision({change_id:randomUUID(),root_tree_id:tree.root_tree_id,parent_revision_ids:[],predecessor_revision_ids:[],provenance:{author:{name:'Native qualification',email:''},message:'Native qualification source',timestamp:new Date().toISOString()}},{operation_id:randomUUID(),idempotency_key:randomUUID()});
 const native={schema_version:1,transport:config,revision_id:revision.revision_id,read_paths:['spec/fixture','main.txt'],budgets:{cache_bytes:8388608,max_cache_entries:128,max_file_bytes:8388608,materialized_bytes:8388608,dirty_bytes:8388608}};
 const filename=path.join(root,'qualification-source.json');await fs.writeFile(filename,JSON.stringify(native),{mode:0o600});process.env.HYPERFIDE_QUALIFY_SOURCE_CONFIG=filename;
 const noGit=path.join(root,'no-git');await fs.mkdir(noGit);const marker=path.join(root,'git-was-called');await fs.writeFile(path.join(noGit,'git'),'#!/bin/sh\necho forbidden >> '+JSON.stringify(marker)+'\nexit 97\n',{mode:0o755});process.env.PATH=noGit+':'+oldPath;
 const artifactRoot=path.join(root,'qualification-artifacts');await fs.mkdir(artifactRoot);
 lanes=new LaneService(createQualificationAdapter(path.resolve('hyperfide')));
 const result=await lanes.wait((await lanes.start({repository:artifactRoot,feature:'fixture',task:'1.1'})).id);
 assert.equal(result.state,'passed',result.error);assert.equal(result.commit,null);assert.equal(result.source.revision_id,revision.revision_id);assert.equal(result.source.root_tree_id,tree.root_tree_id);
 const receipt=JSON.parse(await fs.readFile(path.join(artifactRoot,result.receipt),'utf8'));
 assert.equal(receipt.commit,undefined);assert.equal(receipt.source.revision_id,revision.revision_id);assert.deepEqual(receipt.inputs.map(row=>row.original_path).sort(),Object.keys(contents).sort());
 await assert.rejects(fs.stat(marker),error=>error.code==='ENOENT');
 await assert.rejects(()=>sdk.call('source.workspaces.detail',{workspace_id:receipt.source.workspace_id}),error=>error.code==='WORKSPACE_NOT_FOUND');
 checks.push('native qualification executes pinned sparse source and retains native evidence without a Git command');
 const view=await materializeQualification(native,native.read_paths,'mutated');
 try{
  await fs.writeFile(path.join(view.path,'main.txt'),'altered after materialization\n');
  await assert.rejects(()=>writeReceipt({task:'1.1',cwd:artifactRoot,sourceRoot:view.path,source:view.source,sourceFiles:view.sourceFiles,verify_cmd:'true',exit:0,duration:1,toolchain:{node:process.version},log:'',sources:['main.txt']}),/modified its pinned source/);
 }finally{await view.release();}
 checks.push('qualification refuses source bytes changed after materialization');
 const opened=await sdk.call('source.workspaces.open',{workspace_id:randomUUID(),base_revision_id:revision.revision_id,mode:'SPARSE',read_paths:['main.txt'],write_paths:[]});
 await assert.rejects(()=>sdk.call('source.workspaces.close',{workspace_id:opened.workspace.workspace_id,expected_workspace_generation:'2'}),error=>error.code==='WORKSPACE_CHANGED');
 const operation=randomUUID(),input={workspace_id:opened.workspace.workspace_id,expected_workspace_generation:'1'};
 const closed=await sdk.call('source.workspaces.close',input,{operation_id:operation});assert.deepEqual(await sdk.call('source.workspaces.close',input,{operation_id:operation}),closed);assert.equal(closed.state,'CLOSED');
 checks.push('workspace release rejects stale generations and replays its original close');
 await fs.mkdir('build/source-control/native-qualification',{recursive:true});await fs.writeFile('build/source-control/native-qualification/receipt.json',JSON.stringify({status:'PASS',scope:'actual native qualification adapter, signed TLS, immutable source and executed verification',checks},null,2)+'\n');
 console.error('native source qualification: '+checks.length+' groups passed');
}finally{
 await lanes?.close();await pool.end();
 if(oldConfig===undefined)delete process.env.HYPERFIDE_QUALIFY_SOURCE_CONFIG;else process.env.HYPERFIDE_QUALIFY_SOURCE_CONFIG=oldConfig;
 if(oldPath===undefined)delete process.env.PATH;else process.env.PATH=oldPath;
}
