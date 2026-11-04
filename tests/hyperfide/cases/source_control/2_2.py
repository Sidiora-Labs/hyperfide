#!/usr/bin/env python3
"""Exercise the native host workspace against a source service or bounded host fixture."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[4]
PROGRAM = r'''
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
const root = process.argv[1], options = JSON.parse(process.argv[2]);
if(options.profile_path)options.profile=JSON.parse(await fs.readFile(options.profile_path,'utf8'));
const load = relative => import(pathToFileURL(path.join(root, relative)).href);
const {NativeWorkspaceClient, SourceWorkspaceError} = await load('core/host-daemon/src/source-control/client.ts');
const {NativeObjectCache} = await load('core/host-daemon/src/source-control/cache.ts');
const {SparseSourceMaterializer} = await load('core/host-daemon/src/source-control/materializer.ts');
const {SourceWorkspaceJournal} = await load('core/host-daemon/src/source-control/journal.ts');
const {NativeWorkspaceCheckpoint} = await load('core/host-daemon/src/source-control/checkpoint.ts');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'hf-native-workspace-'));
const scope = options.profile?.scope ?? {organisation_id:randomUUID(),repository_id:randomUUID(),security_domain_id:randomUUID()};
const budgets = {cache_bytes:32*1024*1024,max_cache_entries:256,max_file_bytes:16*1024*1024,materialized_bytes:32*1024*1024,dirty_bytes:32*1024*1024};
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const identity = (kind,payload) => sha(Buffer.concat([Buffer.from('hyperfide-source-control\0v1\0'+kind+'\0'+payload.length+'\0'),payload]));
const results = [], blobs = new Map(), workspaces = new Map(), operations = new Map();
let calls = [], deny = false, corrupt = false, cancel = false, lose = false, poisonReceipt = false, raceEdit = null;
let delegate;
const seed = async(kind,payload) => { const object_id=identity(kind,payload); blobs.set(object_id,{object_id,kind,payload}); return object_id; };
if(options.profile) {
 const {SourceControlClient} = await load('sdk/source-control/src/client.ts');
 const sdk = new SourceControlClient({...options.profile,scope});
 delegate = {call:(action,input,opts={})=>sdk.call(action,input,{...opts,...(options.profile.authority?{authority:options.profile.authority}:{})})};
} else {
 delegate = {call:async(action,input,opts={})=>{
  if(action==='source.objects.put') return {object_id:await seed(input.kind,Buffer.from(input.payload_base64,'base64'))};
  if(action==='source.objects.read') { const item=blobs.get(input.object_id); assert.ok(item); return {object_id:item.object_id,kind:item.kind,payload_base64:item.payload.toString('base64'),byte_length:String(item.payload.length)}; }
  if(action==='source.workspaces.open') { const descriptor={schema_version:1,scope,workspace_id:input.workspace_id,workspace_generation:'1',scope_generation:'1',authority_epoch:'1',base_revision_id:input.base_revision_id,root_tree_id:tree,mode:input.mode,read_paths:input.read_paths,write_paths:input.write_paths,checkpoint_revision_id:null,budgets};workspaces.set(descriptor.workspace_id,descriptor);return {workspace:structuredClone(descriptor),admission:{state:'OPEN'}}; }
  if(action==='source.workspaces.detail') return {workspace:structuredClone(workspaces.get(input.workspace_id))};
  if(action==='source.trees.lookup') return {entry:fixtureEntries.get(input.path)??null};
  if(action==='source.trees.entries') return {entries:[...fixtureEntries].filter(([name])=>path.posix.dirname(name)===(input.tree_id===srcTree?'src':input.tree_id===omittedTree?'omitted':'.')).map(([,entry])=>entry),next_cursor:null};
  if(action==='source.workspaces.checkpoint') {
   const descriptor=workspaces.get(input.workspace_id);assert.equal(input.expected_workspace_generation,descriptor.workspace_generation);
   const revision_id=sha(Buffer.from(JSON.stringify(input)));const next={...descriptor,workspace_generation:String(BigInt(descriptor.workspace_generation)+1n),base_revision_id:revision_id,checkpoint_revision_id:revision_id};workspaces.set(next.workspace_id,next);
   const result={workspace:structuredClone(next),revision_id,receipt:{schema_version:1,scope,operation_id:input.operation_id,overlay_generation:input.overlay_generation,workspace_generation:next.workspace_generation}};operations.set(input.operation_id,{state:'SUCCEEDED',result});return result;
  }
  if(action==='source.operations.read') {const found=operations.get(input.operation_id);if(!found)throw new SourceWorkspaceError('NOT_FOUND','Absent operation');return found;}
  throw Error('Unexpected host fixture operation '+action);
 }};
}
const transport={call:async(action,input,opts={})=>{
 calls.push({action,input:structuredClone(input)});
 if(deny&&action==='source.workspaces.detail')throw new SourceWorkspaceError('SOURCE_ACCESS_DENIED','Revoked read');
 if(cancel&&action==='source.objects.read')throw new DOMException('Cancelled','AbortError');
 const value=await delegate.call(action,input,opts);
 if(raceEdit&&action==='source.objects.put'&&input.kind==='blob'){const edit=raceEdit;raceEdit=null;await edit();}
 if(corrupt&&action==='source.objects.read')return {...value,payload_base64:Buffer.from('corrupt').toString('base64')};
 if(poisonReceipt&&action==='source.workspaces.checkpoint'){poisonReceipt=false;return {...value,receipt:{...value.receipt,operation_id:randomUUID()}};}
 if(lose&&action==='source.workspaces.checkpoint'){lose=false;throw new SourceWorkspaceError('OUTCOME_UNKNOWN','Lost checkpoint acknowledgment');}
 return value;
}};
const client=new NativeWorkspaceClient(transport,scope);
let tree,srcTree,omittedTree,revision;
const fixtureEntries=new Map();
async function file(bytes){return client.putFile(bytes);}
const payloads={ 'src/a.txt':Buffer.from('original\n'),'src/run.sh':Buffer.from('#!/bin/sh\necho source\n'),'src/link':Buffer.from('run.sh'),'src/large.bin':Buffer.alloc(4*1024*1024+17,0xa7),'omitted/hidden.txt':Buffer.from('must survive sparse checkpoint\n') };
async function setup(){
 const entries=[];
 for(const [name,bytes]of Object.entries(payloads)){
  const symlink=name==='src/link',object_id=symlink?await client.putObject('blob',bytes):await file(bytes);
  const entry={name:path.posix.basename(name),kind:symlink?'symlink':'file',mode:symlink?'120000':name.endsWith('.sh')?'100755':'100644',object_id};fixtureEntries.set(name,entry);entries.push({path:name,operation:'put',...entry});
 }
 if(options.profile){
  const empty=await client.putObject('blob',Buffer.alloc(0));void empty;
  const emptyTree=await delegate.call('source.objects.put',{kind:'tree-leaf',payload_base64:Buffer.from('[1,"",[]]').toString('base64')},{operation_id:randomUUID()});
  const patched=await delegate.call('source.trees.patch',{tree_id:emptyTree.object_id,patches:entries},{operation_id:randomUUID()});tree=patched.root_tree_id;
  const operation_id=randomUUID();const created=await delegate.call('source.revisions.create',{change_id:randomUUID(),root_tree_id:tree,parent_revision_ids:[],predecessor_revision_ids:[],provenance:{author:{name:'Source workspace qualification',email:'workspace@example.invalid'},message:'Native workspace fixture',timestamp:new Date().toISOString()}},{operation_id,idempotency_key:operation_id});revision=created.revision_id;
 }else{
  srcTree=await seed('tree-leaf',Buffer.from(JSON.stringify([1,'',[...fixtureEntries].filter(([name])=>name.startsWith('src/')).map(([,e])=>[e.name,e.kind,e.mode,e.object_id])])));
  omittedTree=await seed('tree-leaf',Buffer.from('[1,"",[]]'));
  fixtureEntries.set('src',{name:'src',kind:'directory',mode:'040000',object_id:srcTree});fixtureEntries.set('omitted',{name:'omitted',kind:'directory',mode:'040000',object_id:omittedTree});
  tree=await seed('tree-leaf',Buffer.from('[1,"",[]]'));revision=sha(Buffer.from('host-fixture-revision'));
 }
}
async function check(id,body){try{await body();results.push({id,outcome:'PASS'});}catch(error){results.push({id,outcome:'FAIL',code:error.code??error.name,message:error.message});throw error;}}
try {
 await setup();
 const first=await client.open({base_revision_id:revision,mode:'SPARSE',read_paths:['src'],write_paths:['src'],...(options.profile?{}:{budgets})});
 const second=await client.open({base_revision_id:revision,mode:'SPARSE',read_paths:['src'],write_paths:['src'],...(options.profile?{}:{budgets})});
 const cache=new NativeObjectCache(path.join(temp,'cache'),{max_bytes:Math.min(first.budgets.cache_bytes,second.budgets.cache_bytes),max_entries:Math.min(first.budgets.max_cache_entries,second.budgets.max_cache_entries),max_object_bytes:5*1024*1024});
 const rootA=path.join(temp,'a'),rootB=path.join(temp,'b');
 const journalA=new SourceWorkspaceJournal(path.join(temp,'state-a')),journalB=new SourceWorkspaceJournal(path.join(temp,'state-b'));
 const a=new SparseSourceMaterializer(client,cache,journalA,rootA),b=new SparseSourceMaterializer(client,cache,journalB,rootB);
 await check('sparse-private-copies-and-exact-file-kinds',async()=>{
  const ready=await a.materialize(first,['src']);assert.equal(ready.state,'READY');assert.equal(ready.files,4);
  const reads=calls.filter(c=>c.action==='source.objects.read').length;await b.materialize(second,['src']);assert.equal(calls.filter(c=>c.action==='source.objects.read').length,reads);
  assert.deepEqual(await fs.readFile(path.join(rootA,'src/large.bin')),payloads['src/large.bin']);
  assert.equal((await fs.stat(path.join(rootA,'src/run.sh'))).mode&0o111,0o111);assert.equal(await fs.readlink(path.join(rootA,'src/link')),'run.sh');
  await assert.rejects(fs.stat(path.join(rootA,'omitted')),e=>e.code==='ENOENT');
  await fs.writeFile(path.join(rootA,'src/.atomic-save'),'first private edit\n');await fs.rename(path.join(rootA,'src/.atomic-save'),path.join(rootA,'src/a.txt'));assert.deepEqual(await fs.readFile(path.join(rootB,'src/a.txt')),payloads['src/a.txt']);
  const sa=await fs.stat(path.join(rootA,'src/a.txt')),sb=await fs.stat(path.join(rootB,'src/a.txt'));assert.notEqual(sa.ino,sb.ino);
 });
 await check('warm-cache-requires-current-read-authority',async()=>{
  deny=true;try{await assert.rejects(b.materialize(second,['src']),e=>e.code==='SOURCE_ACCESS_DENIED');}finally{deny=false;}
 });
 await check('omitted-inputs-and-cross-scope-descriptors-refuse-before-cache-read',async()=>{
  await assert.rejects(a.materialize(first,['omitted']),e=>['SOURCE_ACCESS_DENIED','SCOPE_DENIED'].includes(e.code));
  const reads=calls.filter(c=>c.action==='source.objects.read').length;
  await assert.rejects(b.materialize({...second,scope:{...second.scope,repository_id:randomUUID()}},['src']),e=>e.code==='WORKSPACE_STALE');
  assert.equal(calls.filter(c=>c.action==='source.objects.read').length,reads);
 });
 await check('unsafe-paths-and-symlink-parents-do-not-escape',async()=>{
  await assert.rejects(a.materialize(first,['../outside']),e=>e.code==='INVALID_PATH');
  const outside=path.join(temp,'outside'),hostile=path.join(temp,'hostile');await fs.mkdir(outside);await fs.mkdir(hostile);await fs.symlink(outside,path.join(hostile,'src'));
  const materializer=new SparseSourceMaterializer(client,cache,new SourceWorkspaceJournal(path.join(temp,'hostile-state')),hostile);
  await assert.rejects(materializer.materialize(first,['src']));assert.deepEqual(await fs.readdir(outside),[]);
 });
 await check('corrupt-and-cancelled-downloads-never-become-cache-hits',async()=>{
  const reference=await client.putObject('blob',Buffer.from('uncached-integrity-fixture'));
  const fresh=new NativeObjectCache(path.join(temp,'fresh-cache'),{max_bytes:1024,max_entries:4,max_object_bytes:1024});
  corrupt=true;try{await assert.rejects(fresh.acquire(scope,reference,()=>client.readObject(reference),async()=>{}),e=>e.code==='OBJECT_INTEGRITY');}finally{corrupt=false;}
  cancel=true;try{await assert.rejects(fresh.acquire(scope,reference,()=>client.readObject(reference),async()=>{}),e=>e.name==='AbortError');}finally{cancel=false;}
  const acquired=await fresh.acquire(scope,reference,()=>client.readObject(reference),async()=>{});assert.equal(acquired.object.payload.toString(),'uncached-integrity-fixture');await acquired.release();
 });
 await check('edit-racing-checkpoint-retains-dirty-bytes-without-revision',async()=>{
  await journalA.mark('src/a.txt');const count=calls.filter(c=>c.action==='source.workspaces.checkpoint').length;
  raceEdit=()=>fs.writeFile(path.join(rootA,'src/a.txt'),'racing edit retained\n');
  await assert.rejects(new NativeWorkspaceCheckpoint(client,journalA,rootA,a).checkpoint(first),e=>e.code==='UNSTABLE_FILE');
  assert.equal(calls.filter(c=>c.action==='source.workspaces.checkpoint').length,count);assert.equal((await journalA.snapshot()).pending,null);assert.equal(await fs.readFile(path.join(rootA,'src/a.txt'),'utf8'),'racing edit retained\n');
 });
 await check('watcher-overflow-scans-only-installed-scope-and-preserves-omitted-paths',async()=>{
  await fs.writeFile(path.join(rootA,'src/new.txt'),'new local source\n');await fs.symlink('a.txt',path.join(rootA,'src/new-link'));await fs.chmod(path.join(rootA,'src/run.sh'),0o644);await fs.unlink(path.join(rootA,'src/link'));await fs.writeFile(path.join(rootA,'src/link'),'type transition\n');
  await journalA.overflow();await a.reconcile(first);const state=await journalA.snapshot();assert.equal(state.overflow,false);assert.deepEqual(new Set(state.entries.map(e=>e.path)),new Set(['src/a.txt','src/new.txt','src/new-link','src/run.sh','src/link']));
  const checkpoint=new NativeWorkspaceCheckpoint(client,journalA,rootA,a);const result=await checkpoint.checkpoint(first);assert.equal((await journalA.snapshot()).entries.length,0);
  const request=calls.filter(c=>c.action==='source.workspaces.checkpoint').at(-1).input;assert.ok(request.changes.every(c=>!c.path.startsWith('omitted/')));assert.equal(request.changes.find(c=>c.path==='src/run.sh').mode,'100644');assert.equal(request.changes.find(c=>c.path==='src/link').kind,'file');assert.equal(request.changes.find(c=>c.path==='src/new-link').kind,'symlink');
  if(options.profile){const registered=await delegate.call('source.revisions.read',{revision_id:result.revision_id});const preserved=await delegate.call('source.trees.lookup',{tree_id:registered.root_tree_id,path:'omitted/hidden.txt'});assert.equal(preserved.entry.object_id,fixtureEntries.get('omitted/hidden.txt').object_id);}
  Object.assign(first,result.workspace);
 });
 await check('wrong-checkpoint-receipt-retains-journal-until-original-operation-is-resolved',async()=>{
  await fs.writeFile(path.join(rootA,'src/a.txt'),'receipt binding check\n');await journalA.mark('src/a.txt');
  const checkpoint=new NativeWorkspaceCheckpoint(client,journalA,rootA,a);poisonReceipt=true;
  await assert.rejects(checkpoint.checkpoint(first),e=>e.code==='CHECKPOINT_RECEIPT');assert.ok((await journalA.snapshot()).pending);
  const count=calls.filter(c=>c.action==='source.workspaces.checkpoint').length;const recovered=await checkpoint.checkpoint(first);assert.equal(calls.filter(c=>c.action==='source.workspaces.checkpoint').length,count);assert.equal((await journalA.snapshot()).pending,null);Object.assign(first,recovered.workspace);
 });
 await check('lost-checkpoint-response-resolves-original-operation-and-retains-later-edits',async()=>{
  await fs.writeFile(path.join(rootA,'src/a.txt'),'captured checkpoint\n');await journalA.mark('src/a.txt');await fs.unlink(path.join(rootA,'src/new.txt'));await journalA.mark('src/new.txt','remove');
  const checkpoint=new NativeWorkspaceCheckpoint(client,journalA,rootA,a);lose=true;await assert.rejects(checkpoint.checkpoint(first),e=>e.code==='OUTCOME_UNKNOWN');
  const original=(await journalA.snapshot()).pending.request;await fs.writeFile(path.join(rootA,'src/a.txt'),'later edit survives\n');await journalA.mark('src/a.txt');
  const count=calls.filter(c=>c.action==='source.workspaces.checkpoint').length;const recovered=await checkpoint.checkpoint(first);assert.equal(calls.filter(c=>c.action==='source.workspaces.checkpoint').length,count);assert.equal((await journalA.snapshot()).pending,null);assert.ok((await journalA.snapshot()).entries.some(e=>e.path==='src/a.txt'));assert.equal(await fs.readFile(path.join(rootA,'src/a.txt'),'utf8'),'later edit survives\n');assert.equal(recovered.receipt.operation_id??original.operation_id,original.operation_id);
 });
 if(options.profile)await check('server-scope-widening-preserves-base-root-and-dirty-host-bytes',async()=>{
  const before=await client.detail(first.workspace_id),dirty=await journalA.snapshot(),bytes=await fs.readFile(path.join(rootA,'src/a.txt'));
  assert.ok(dirty.entries.some(e=>e.path==='src/a.txt'));
  const operation_id=randomUUID(),input={workspace_id:before.workspace_id,expected_workspace_generation:before.workspace_generation,expected_scope_generation:before.scope_generation,read_paths:['src','omitted'],write_paths:['src','omitted']};
  const widened=await delegate.call('source.workspaces.widen',input,{operation_id,idempotency_key:operation_id});
  assert.equal(widened.scope_changed,true);
  for(const key of ['base_revision_id','root_tree_id','checkpoint_revision_id'])assert.equal(widened.workspace[key],before[key]);
  assert.equal(BigInt(widened.workspace.scope_generation),BigInt(before.scope_generation)+1n);
  await assert.rejects(a.materialize(before,['omitted']),e=>e.code==='WORKSPACE_STALE');
  const current=await client.detail(first.workspace_id);assert.equal(current.scope_generation,widened.workspace.scope_generation);
  await a.materialize(current,['omitted']);
  assert.deepEqual(await fs.readFile(path.join(rootA,'src/a.txt')),bytes);
  assert.deepEqual((await journalA.snapshot()).entries,dirty.entries);
  assert.deepEqual(await fs.readFile(path.join(rootA,'omitted/hidden.txt')),payloads['omitted/hidden.txt']);
  assert.deepEqual(await delegate.call('source.workspaces.widen',input,{operation_id,idempotency_key:operation_id}),widened);
  Object.assign(first,current);
 });
 await check('pinned-cache-pressure-retains-dirty-working-bytes',async()=>{
  const tiny=new NativeObjectCache(path.join(temp,'tiny-cache'),{max_bytes:5,max_entries:1,max_object_bytes:5});const one=await client.putObject('blob',Buffer.from('12345')),two=await client.putObject('blob',Buffer.from('other'));
  const held=await tiny.acquire(scope,one,()=>client.readObject(one),async()=>{});try{await assert.rejects(tiny.acquire(scope,two,()=>client.readObject(two),async()=>{}),e=>e.code==='CACHE_PRESSURE');}finally{await held.release();}
  assert.equal(await fs.readFile(path.join(rootA,'src/a.txt'),'utf8'),'later edit survives\n');const next=await tiny.acquire(scope,two,()=>client.readObject(two),async()=>{});await next.release();
 });
 console.log(JSON.stringify({status:'PASS',qualification_level:options.profile?'REAL_SOURCE_SERVICE_AND_HOST_FILESYSTEM':'HOST_FILESYSTEM_COMPONENT',full_case_qualified:!!options.profile,assertions:results}));
} finally {await fs.rm(temp,{recursive:true,force:true});}
'''

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--component', action='store_true')
    args = parser.parse_args()
    profile_path = os.environ.get('HYPERFIDE_SOURCE_CONTROL_TEST_PROFILE')
    if not args.component and not profile_path:
        print(json.dumps({'status': 'UNRUN', 'missing_environment': ['HYPERFIDE_SOURCE_CONTROL_TEST_PROFILE'], 'full_case_qualified': False}))
        return 2
    options = {'profile_path': str(Path(profile_path).resolve()) if profile_path else None}
    node = os.environ.get('HYPERFIDE_NODE_BINARY', '/root/.nvm/versions/node/v24.22.0/bin/node')
    result = subprocess.run([node, '--import', 'tsx', '--input-type=module', '-e', PROGRAM, str(ROOT), json.dumps(options)], cwd=ROOT, text=True, capture_output=True, timeout=240)
    sys.stdout.write(result.stdout)
    sys.stderr.write(result.stderr)
    return result.returncode

if __name__ == '__main__':
    sys.exit(main())
