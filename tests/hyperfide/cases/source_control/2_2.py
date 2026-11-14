#!/usr/bin/env python3
"""Exercise sparse workspaces against an owned PostgreSQL source service and real host files."""
import argparse
import importlib.util
import shutil
import os
from pathlib import Path
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
const {SparseSourceMaterializer, probeHostNames} = await load('sdk/source-control/src/host/materializer.ts');
const {SourceWorkspaceJournal} = await load('core/host-daemon/src/source-control/journal.ts');
const {NativeWorkspaceCheckpoint} = await load('core/host-daemon/src/source-control/checkpoint.ts');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'hf-native-workspace-'));
const scope = options.profile?.scope ?? {organisation_id:randomUUID(),repository_id:randomUUID(),security_domain_id:randomUUID()};
const budgets = {cache_bytes:32*1024*1024,max_cache_entries:256,max_file_bytes:16*1024*1024,materialized_bytes:32*1024*1024,dirty_bytes:32*1024*1024};
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const identity = (kind,payload) => sha(Buffer.concat([Buffer.from('hyperfide-source-control\0v1\0'+kind+'\0'+payload.length+'\0'),payload]));
const results = [], readinessReceipts = [];
let calls = [], deny = false, corrupt = false, cancel = false, lose = false, poisonReceipt = false, raceEdit = null;
assert.ok(options.profile, 'An owned or explicit source service profile is required');
const {SourceControlClient} = await load('sdk/source-control/src/client.ts');
const sdk = new SourceControlClient({...options.profile,scope});
const delegate = {call:(action,input,opts={})=>sdk.call(action,input,{...opts,...(options.profile.authority?{authority:options.profile.authority}:{})})};
const serverControl = action => new Promise((resolve,reject) => {
 if (!process.send) return reject(new SourceWorkspaceError('CAPABILITY_MISSING','Server-side revocation requires the owned native_source_sparse_fixture actor'));
 const request_id=randomUUID();
 const listener=message=>{if(message.request_id!==request_id)return;process.off('message',listener);clearTimeout(timer);message.error?reject(Error(message.error)):resolve(message);};
 const timer=setTimeout(()=>{process.off('message',listener);reject(Error('Owned source control deadline expired'));},30000);
 process.on('message',listener);process.send({action,request_id});
});
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
let tree,revision;
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
  const receipt=ready.receipt;readinessReceipts.push(receipt);
  assert.equal(receipt.kind,'WORKSPACE_READINESS');assert.deepEqual(receipt.scope,scope);
  for(const key of ['workspace_id','workspace_generation','scope_generation','base_revision_id','authority_epoch'])assert.equal(receipt[key],first[key]);
  assert.deepEqual(receipt.selected_paths,['src']);assert.equal(receipt.closure_state,'INCOMPLETE');
  const closure=(await client.detail(first.workspace_id)).dependency_closure_manifest;
  assert.equal(closure.state,'INCOMPLETE');assert.equal(closure.reason,'DEPENDENCY_ANALYSIS_UNAVAILABLE');assert.deepEqual(closure.dependencies,[]);
  assert.equal(receipt.closure_manifest_digest,sha(Buffer.from(JSON.stringify([closure.schema_version,closure.state,closure.dependencies,closure.reason]))));
  const installed=(await journalA.snapshot()).installed.sort((a,b)=>Buffer.compare(Buffer.from(a.path),Buffer.from(b.path)));
  assert.equal(receipt.installed_entry_digest,sha(Buffer.from(JSON.stringify(installed.map(e=>[e.path,e.kind,e.mode,e.object_id,e.payload_digest,e.size_bytes])))));
  const {receipt_digest,...bound}=receipt;assert.equal(receipt_digest,sha(Buffer.from(JSON.stringify(bound))));
  assert.equal(ready.receipt.admission,undefined);assert.deepEqual(first.admission,{state:'OPEN'});
  const reads=calls.filter(c=>c.action==='source.objects.read').length;await b.materialize(second,['src']);assert.equal(calls.filter(c=>c.action==='source.objects.read').length,reads);
  assert.deepEqual(await fs.readFile(path.join(rootA,'src/large.bin')),payloads['src/large.bin']);
  assert.equal((await fs.stat(path.join(rootA,'src/run.sh'))).mode&0o111,0o111);assert.equal(await fs.readlink(path.join(rootA,'src/link')),'run.sh');
  await assert.rejects(fs.stat(path.join(rootA,'omitted')),e=>e.code==='ENOENT');
  await fs.writeFile(path.join(rootA,'src/.atomic-save'),'first private edit\n');await fs.rename(path.join(rootA,'src/.atomic-save'),path.join(rootA,'src/a.txt'));assert.deepEqual(await fs.readFile(path.join(rootB,'src/a.txt')),payloads['src/a.txt']);
  const sa=await fs.stat(path.join(rootA,'src/a.txt')),sb=await fs.stat(path.join(rootB,'src/a.txt'));assert.notEqual(sa.ino,sb.ino);
 });
 await check('bounded-traversal-ignores-one-thousand-unrelated-directories',async()=>{
  const measure=async(base,label)=>{
   const descriptor=await client.open({base_revision_id:base,mode:'SPARSE',read_paths:['src'],write_paths:['src']});
   const localCache=new NativeObjectCache(path.join(temp,label+'-cache'),{max_bytes:budgets.cache_bytes,max_entries:budgets.max_cache_entries,max_object_bytes:5*1024*1024});
   const host=new SparseSourceMaterializer(client,localCache,new SourceWorkspaceJournal(path.join(temp,label+'-state')),path.join(temp,label));
   const before=calls.length;const ready=await host.materialize(descriptor,['src']);assert.equal(ready.files,4);
   return Object.fromEntries(['source.trees.lookup','source.trees.entries','source.objects.read'].map(action=>[action,calls.slice(before).filter(c=>c.action===action).length]));
  };
  const baseline=await measure(revision,'bounded-before');
  assert.ok(baseline['source.trees.lookup']>0);assert.ok(baseline['source.trees.entries']>0);assert.ok(baseline['source.objects.read']>0);
  const empty=await delegate.call('source.objects.put',{kind:'tree-leaf',payload_base64:Buffer.from('[1,"",[]]').toString('base64')},{operation_id:randomUUID()});
  let expanded=tree;
  for(let start=0;start<1000;start+=128){
   const patches=Array.from({length:Math.min(128,1000-start)},(_,index)=>({path:'unrelated-'+String(start+index).padStart(4,'0'),operation:'put',kind:'directory',mode:'040000',object_id:empty.object_id}));
   expanded=(await delegate.call('source.trees.patch',{tree_id:expanded,patches},{operation_id:randomUUID()})).root_tree_id;
  }
  let cursor,unrelated=0;
  do{const page=await delegate.call('source.trees.entries',{tree_id:expanded,limit:128,...(cursor?{cursor}:{})});unrelated+=page.entries.filter(e=>e.kind==='directory'&&e.name.startsWith('unrelated-')).length;cursor=page.next_cursor;}while(cursor);
  assert.equal(unrelated,1000);
  const operation_id=randomUUID();
  const large=await delegate.call('source.revisions.create',{change_id:randomUUID(),root_tree_id:expanded,parent_revision_ids:[revision],predecessor_revision_ids:[],provenance:{author:{name:'Sparse traversal qualification',email:''},message:'Add unrelated directories',timestamp:new Date().toISOString()}},{operation_id,idempotency_key:operation_id});
  const after=await measure(large.revision_id,'bounded-after');assert.deepEqual(after,baseline);
 });
 await check('host-name-probe-and-case-folding-and-normalization-collisions',async()=>{
  const probeRoot=path.join(temp,'name-probe');await fs.mkdir(probeRoot);
  const semantics=await probeHostNames(probeRoot);assert.equal(typeof semantics.case_folding,'boolean');assert.equal(typeof semantics.unicode_normalization,'boolean');assert.deepEqual(await fs.readdir(probeRoot),[]);
  const reference=await file(Buffer.from('colliding names\n'));
  for(const [label,names,requirements]of [['case',['Name.txt','name.txt'],{case_folding:true,unicode_normalization:false}],['unicode',['\u00e9.txt','e\u0301.txt'],{case_folding:false,unicode_normalization:true}]]){
   const patched=await delegate.call('source.trees.patch',{tree_id:tree,patches:names.map(name=>({path:'collisions/'+name,operation:'put',kind:'file',mode:'100644',object_id:reference}))},{operation_id:randomUUID()});
   const operation_id=randomUUID();const created=await delegate.call('source.revisions.create',{change_id:randomUUID(),root_tree_id:patched.root_tree_id,parent_revision_ids:[revision],predecessor_revision_ids:[],provenance:{author:{name:'Host name qualification',email:''},message:'Host incompatible source names',timestamp:new Date().toISOString()}},{operation_id,idempotency_key:operation_id});
   const descriptor=await client.open({base_revision_id:created.revision_id,mode:'SPARSE',read_paths:['collisions'],write_paths:[]});
   const hostRoot=path.join(temp,'collisions-'+label),journal=new SourceWorkspaceJournal(path.join(temp,'collisions-'+label+'-state'));
   const host=new SparseSourceMaterializer(client,cache,journal,hostRoot),before=calls.filter(c=>c.action==='source.objects.read').length;
   await assert.rejects(host.materialize(descriptor,['collisions'],undefined,requirements),e=>e.code==='HOST_NAME_INCOMPATIBLE');
   assert.equal(calls.filter(c=>c.action==='source.objects.read').length,before);assert.deepEqual(await fs.readdir(hostRoot),[]);assert.deepEqual((await journal.snapshot()).installed,[]);
  }
 });
 await check('server-side-capability-revocation-during-materialization',async()=>{
  assert.ok(options.profile.revocation_token,'Owned service must supply a separate revocable capability');
  const revokedSdk=new SourceControlClient({...options.profile,scope,token:options.profile.revocation_token});
  let revoked=false,objectReads=0;
  const revokedClient=new NativeWorkspaceClient({call:async(action,input,opts)=>{
   const value=await revokedSdk.call(action,input,opts);
   if(action==='source.objects.read'){objectReads++;if(!revoked){await serverControl('revoke-checker');revoked=true;}}
   return value;
  }},scope);
  const descriptor=await revokedClient.open({base_revision_id:revision,mode:'SPARSE',read_paths:['src'],write_paths:[]});
  const localCache=new NativeObjectCache(path.join(temp,'revoked-cache'),{max_bytes:budgets.cache_bytes,max_entries:budgets.max_cache_entries,max_object_bytes:5*1024*1024});
  const journal=new SourceWorkspaceJournal(path.join(temp,'revoked-state')),hostRoot=path.join(temp,'revoked');
  const host=new SparseSourceMaterializer(revokedClient,localCache,journal,hostRoot);
  await assert.rejects(host.materialize(descriptor,['src']),e=>e.code==='SCOPE_DENIED');
  assert.equal(revoked,true);assert.equal(objectReads,1);assert.deepEqual((await journal.snapshot()).installed,[]);
  assert.deepEqual(await fs.readdir(path.join(hostRoot,'src')),[]);
  await assert.rejects(revokedClient.detail(descriptor.workspace_id),e=>e.code==='SCOPE_DENIED');
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
  await fs.chmod(path.join(rootA,'src/large.bin'),0o755);await journalA.overflow();await a.reconcile(first);const state=await journalA.snapshot();assert.equal(state.overflow,false);assert.deepEqual(new Set(state.entries.map(e=>e.path)),new Set(['src/a.txt','src/new.txt','src/new-link','src/run.sh','src/link','src/large.bin']));
  const checkpoint=new NativeWorkspaceCheckpoint(client,journalA,rootA,a),beforeUploads=calls.length;const result=await checkpoint.checkpoint(first);assert.equal((await journalA.snapshot()).entries.length,0);
  const uploadCalls=calls.slice(beforeUploads);assert.ok(result.skipped_uploads>=3);assert.ok(result.uploaded_objects>0);
  assert.equal(result.uploaded_objects,uploadCalls.filter(c=>c.action==='source.objects.put').length);
  assert.equal(result.skipped_uploads+result.uploaded_objects,uploadCalls.filter(c=>c.action==='source.objects.inspect').length);
  const largeId=fixtureEntries.get('src/large.bin').object_id;
  assert.ok(uploadCalls.some(c=>c.action==='source.objects.inspect'&&c.input.object_id===largeId));
  assert.ok(!uploadCalls.some(c=>c.action==='source.objects.put'&&c.input.kind==='file'&&identity('file',Buffer.from(c.input.payload_base64,'base64'))===largeId));
  const request=calls.filter(c=>c.action==='source.workspaces.checkpoint').at(-1).input;assert.ok(request.changes.every(c=>!c.path.startsWith('omitted/')));assert.equal(request.changes.find(c=>c.path==='src/run.sh').mode,'100644');assert.equal(request.changes.find(c=>c.path==='src/large.bin').mode,'100755');assert.equal(request.changes.find(c=>c.path==='src/link').kind,'file');assert.equal(request.changes.find(c=>c.path==='src/new-link').kind,'symlink');
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
 console.log(JSON.stringify({status:'PASS',readiness_receipts:readinessReceipts,qualification_level:options.profile?'REAL_SOURCE_SERVICE_AND_HOST_FILESYSTEM':'HOST_FILESYSTEM_COMPONENT',full_case_qualified:!!options.profile,assertions:results}));
} finally {await fs.rm(temp,{recursive:true,force:true});if(process.connected)process.disconnect();}
'''

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--component', action='store_true', help='Use the owned source service and component object backend')
    args = parser.parse_args()
    if os.environ.get('HYPERFIDE_SOURCE_CONTROL_TEST_PROFILE'):
        raise RuntimeError('CAPABILITY_MISSING: unset HYPERFIDE_SOURCE_CONTROL_TEST_PROFILE and use the owned native_source_sparse_fixture.mjs fixture through this launcher; explicit profiles lack the required IPC revocation control channel')
    node = shutil.which(os.environ.get('HYPERFIDE_NODE_BINARY') or 'node')
    if not node:
        raise RuntimeError('CAPABILITY_MISSING: set HYPERFIDE_NODE_BINARY to an executable Node binary or install node on PATH')
    spec = importlib.util.spec_from_file_location('native_source_fixture', ROOT / 'tests/hyperfide/support/native_source_fixture.py')
    fixture = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fixture)
    return fixture.run_source_actor(ROOT / 'tests/hyperfide/support/native_source_sparse_fixture.mjs', timeout=360,
                                    actor_env={'SOURCE_CONTROL_WORKSPACE_PROGRAM': PROGRAM, 'SOURCE_CONTROL_SPARSE_OWNED': '1'})

if __name__ == '__main__':
    sys.exit(main())
