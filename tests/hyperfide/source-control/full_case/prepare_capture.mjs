import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createNativeAcceptanceFixture} from '../../support/native_source_acceptance_fixture.mjs';
import {captureNativeSource} from './native_capture.mjs';
const f=await createNativeAcceptanceFixture();
try{
 const workspaceRoot=path.resolve(f.ROOT),plan=JSON.parse(await fs.readFile(process.env.HF_SOURCE_CAPTURE_REGISTRATION,'utf8'));
 assert(plan.feature==='hyperfide-source-control'&&plan.scope==='full-case');
 assert(plan.source_files.length>0&&plan.source_files.length<=50000);
 const root={directories:new Map(),files:[]};let total=0;
 for(const relative of plan.source_files){
  const filename=path.resolve(workspaceRoot,relative);assert(filename.startsWith(workspaceRoot+'/')&&relative&&!relative.split('/').includes('..'));
  assert.equal(await fs.realpath(filename),filename,'Source capture cannot traverse a symlinked path');
  const before=await fs.lstat(filename);assert(before.isFile()&&!before.isSymbolicLink()&&before.size<=128*1024*1024);
  const bytes=await fs.readFile(filename),after=await fs.stat(filename);assert.equal(after.mtimeMs,before.mtimeMs);assert.equal(after.size,before.size);total+=bytes.length;assert(total<=512*1024*1024);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),plan.source_hashes[relative]);
  const file=await f.service.objects.putFile(f.scope,bytes),parts=relative.split('/'),name=parts.pop();let directory=root;
  for(const part of parts){if(!directory.directories.has(part))directory.directories.set(part,{directories:new Map(),files:[]});directory=directory.directories.get(part);}
  directory.files.push({name,kind:'file',mode:(before.mode&0o111)?'100755':'100644',object_id:file.object_id});
 }
 async function store(directory){const entries=[...directory.files];for(const [name,child]of directory.directories)entries.push({name,kind:'directory',mode:'040000',object_id:await store(child)});return (await f.service.trees.fromEntries(f.scope,entries)).root_tree_id;}
 const tree=await store(root),revision=await f.createRevision({root_tree_id:tree,parent_revision_ids:[]});
 const output=path.join(workspaceRoot,'build/source-control/full-case/implementation-input',randomUUID());
 const native=await captureNativeSource({client:f.client,context:f.context,revisionId:revision.revision_id,workspaceRoot,outputDirectory:output,assertionIds:plan.assertion_ids,toolchain:[process.execPath,...JSON.parse(process.env.HF_SOURCE_CAPTURE_TOOLCHAIN)],maxObjects:200000,maxBytes:1024*1024*1024});
 const note={native_source_path:path.join(output,'native.json'),revision_id:native.revision_id,root_tree_id:native.root_tree_id,source_files:plan.source_files.length,source_bytes:total};
 await fs.writeFile(process.env.HF_SOURCE_CAPTURE_RESULT,JSON.stringify(note)+'\n',{mode:0o600});console.log(JSON.stringify(note));
}finally{await f.close();}
