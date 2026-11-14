#!/usr/bin/env python3
from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[4]
PROGRAM = r'''
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import * as sdk from '@hyperfide/source-control';
const root=process.argv[1];
const server=await import(pathToFileURL(root+'/core/control-plane/src/source_control/contracts.ts'));
const {SourceCursorCodec}=await import(pathToFileURL(root+'/core/control-plane/dist/source_control/cursors.js'));
const vectors=JSON.parse(await readFile(root+'/tests/hyperfide/cases/source_control/fixtures/contracts-v1.json','utf8'));
const contractPaths=['sdk/source-control/src/contracts.ts','core/control-plane/src/source_control/contracts.ts'];
const contractDigests=await Promise.all(contractPaths.map(async path=>createHash('sha256').update(await readFile(root+'/'+path)).digest('hex')));
const decisions=await readFile(root+'/spec/hyperfide-source-control/decisions.md','utf8');
const outcomes=[];
function check(id,fn){try{fn();outcomes.push({id,outcome:'PASS'});}catch(e){outcomes.push({id,outcome:'FAIL',message:e.message,code:e.code??e.name});}}
function refused(code,fn){assert.throws(fn,e=>e.code===code);}
const uuid='9466c1d1-8a2a-462d-a861-f35e8a1de11b';
const scope={organisation_id:uuid,repository_id:'84039ca3-26fc-4a01-96d1-393fb2ea20e4',security_domain_id:'3ab840da-ca61-4554-b551-1b417f473cb7'};
check('sdk-server-contract-digests-identical',()=>{
 assert.equal(contractDigests[0],contractDigests[1],'SDK/server contract divergence: regenerate with sync-fleet-contracts.mjs source');
});
check('golden-cross-language-object-envelopes',()=>{
 for(const vector of vectors.vectors){for(const codec of [server,sdk]){
  const encoded=codec.canonicalEnvelope(vector.kind,Buffer.from(vector.payload_hex,'hex'));
  assert.equal(Buffer.from(encoded).toString('hex'),vector.envelope_hex);
  assert.equal('sha256:'+createHash('sha256').update(encoded).digest('hex'),vector.object_id);
  const decoded=codec.decodeCanonicalEnvelope(encoded,vector.kind);assert.equal(Buffer.from(decoded.payload).toString('hex'),vector.payload_hex);
  if(Object.hasOwn(vector,'canonical_value')){
   assert.equal(Buffer.from(codec.canonicalBytes(vector.canonical_value)).toString('hex'),vector.payload_hex);
   const parsed=codec.parseStrictJSON(Buffer.from(vector.payload_hex,'hex'));
   assert.equal(codec.canonicalJSON(parsed),Buffer.from(vector.payload_hex,'hex').toString('utf8'));
   assert.deepEqual(JSON.parse(codec.canonicalJSON(parsed)),vector.canonical_value);
  }
 }}
 assert.notEqual(vectors.vectors.find(v=>v.name==='binary-blob').object_id,vectors.vectors.find(v=>v.name==='type-separated-chunk').object_id);
});
check('integer-and-generation-bound-vectors',()=>{
 for(const codec of [server,sdk]){
  for(const vector of vectors.generation_vectors){
   if(vector.error)refused(vector.error,()=>codec.parseGeneration(vector.value));
   else assert.equal(codec.parseGeneration(vector.value),vector.value);
  }
  for(const value of [-9007199254740991,9007199254740991])assert.equal(codec.parseStrictJSON(codec.canonicalJSON(value)),value);
  for(const value of [-9007199254740992,9007199254740992])refused('INVALID_INTEGER',()=>codec.canonicalJSON(value));
 }
});
const request={protocol_version:1,scope,operation_id:uuid,action:'source.revisions.create',idempotency_key:uuid,input:{tree_id:vectors.vectors.find(v=>v.name==='empty-tree').object_id,parents:[]},authority:{authority_epoch:'1',generation:'18446744073709551615',policy_version:'source-v1'}};
check('real-sdk-server-request-and-response-interoperability',()=>{
 const decoded=server.decodeSourceRequest(sdk.encodeSourceRequest(request));assert.equal(server.canonicalJSON(decoded),sdk.canonicalJSON(request));
 const result={protocol_version:1,operation_id:uuid,result:{state:'CREATED',root_tree_id:request.input.tree_id}};
 assert.equal(sdk.canonicalJSON(sdk.decodeSourceResponse(server.encodeSourceResponse(result))),server.canonicalJSON(result));
 const failure={protocol_version:1,operation_id:uuid,error:{code:'OUTCOME_UNKNOWN',message:'Look up the original operation',retry:'RETRY_SAME_OPERATION',outcome:'UNKNOWN'}};
 assert.equal(sdk.decodeSourceResponse(server.encodeSourceResponse(failure)).error.outcome,'UNKNOWN');
});
check('content-transfer-allowance-is-action-scoped',()=>{
 const payload=Buffer.alloc(4194304,0x61).toString('base64');
 for(const codec of [server,sdk]){
  const transfer={...request,action:'source.objects.put',input:{payload_base64:payload}};
  const decoded=codec.decodeSourceRequest(codec.encodeSourceRequest(transfer));assert.equal(decoded.input.payload_base64,payload);
  refused('LIMIT_EXCEEDED',()=>codec.encodeSourceRequest({...transfer,action:'source.revisions.create'}));
  refused('LIMIT_EXCEEDED',()=>codec.encodeSourceRequest({...transfer,action:'source.fleet.manifest'}));
  const response={protocol_version:1,operation_id:uuid,result:{payload_base64:payload}};
  assert.equal(codec.decodeSourceResponse(codec.encodeSourceResponse(response,{action:'source.objects.read'}),{action:'source.objects.read'}).result.payload_base64,payload);
  refused('LIMIT_EXCEEDED',()=>codec.encodeSourceResponse(response));
  refused('LIMIT_EXCEEDED',()=>codec.decodeSourceRequest(codec.canonicalBytes({...request,input:{values:Array.from({length:40},()=> 'x'.repeat(32768))}},12582912)));
 }
});
check('version-negotiation-and-exact-envelope-fields',()=>{
 for(const codec of [server,sdk]){
  assert.equal(codec.negotiateSourceCapabilities({protocol_versions:[2,1],required_capabilities:['api-only']}).protocol_version,1);
  refused('UNSUPPORTED_VERSION',()=>codec.negotiateSourceCapabilities({protocol_versions:[2],required_capabilities:[]}));
  refused('UNSUPPORTED_CAPABILITY',()=>codec.negotiateSourceCapabilities({protocol_versions:[1],required_capabilities:['offline-authority']}));
  refused('UNSUPPORTED_VERSION',()=>codec.parseSourceRequest({...request,protocol_version:2}));
  refused('UNSUPPORTED_ACTION',()=>codec.parseSourceRequest({...request,action:'source.unknown'}));
  refused('INVALID_REQUEST',()=>codec.parseSourceRequest({...request,git_oid:'a'.repeat(40)}));
  refused('INVALID_REQUEST',()=>codec.parseSourceResponse({protocol_version:1,operation_id:uuid,result:{},error:{}}));
 }
});
check('strict-json-no-duplicate-numeric-or-unicode-aliases',()=>{
 for(const codec of [server,sdk]){
  refused('DUPLICATE_FIELD',()=>codec.parseStrictJSON('{"scope":1,"scope":2}'));
  for(const number of ['1.0','1e0','01','-0','9007199254740992'])assert.throws(()=>codec.parseStrictJSON(number));
  refused('INVALID_UTF8',()=>codec.parseStrictJSON('"\\ud800"'));
  refused('INVALID_UTF8',()=>codec.parseStrictJSON(new Uint8Array([0x22,0xc0,0x80,0x22])));
  refused('INVALID_INTEGER',()=>codec.canonicalJSON({x:1.5}));
  refused('INVALID_REQUEST',()=>codec.canonicalJSON({x:undefined}));
  assert.equal(codec.canonicalJSON({b:1,a:['雪','é','é']}),'{"a":["雪","é","é"],"b":1}');
  assert.equal(codec.canonicalJSON(codec.parseStrictJSON('{"__proto__":1}')),'{"__proto__":1}');
 }
});
check('native-identities-do-not-coerce-git-or-raw-hashes',()=>{
 for(const codec of [server,sdk]){
  refused('INVALID_IDENTITY',()=>codec.parseObjectId('a'.repeat(64)));
  refused('INVALID_IDENTITY',()=>codec.parseObjectId('git:'+'a'.repeat(40)));
  refused('INVALID_IDENTITY',()=>codec.parseGitIdentity({object_format:'sha1',oid:vectors.vectors[0].object_id}));
  assert.equal(codec.parseGitIdentity({object_format:'sha256',oid:'a'.repeat(64)}).object_format,'sha256');
  refused('INVALID_REQUEST',()=>codec.parseSourceScope({...scope,run_id:uuid}));
  refused('INVALID_GENERATION',()=>codec.parseGeneration('01'));
  refused('INVALID_GENERATION',()=>codec.parseGeneration('18446744073709551616'));
 }
});
check('exact-paths-kinds-and-mode-round-trips',()=>{
 for(const codec of [server,sdk]){
  for(const p of ['sdk/雪.ts','é.txt','é.txt'])assert.equal(codec.parseRepositoryPath(p),p);
  assert.notEqual(codec.parseRepositoryPath('é'),codec.parseRepositoryPath('é'));
  for(const p of ['','/root','../secret','sdk/../x','sdk//x','sdk/./x','C:/x','sdk\\x','x\0y'])refused('INVALID_PATH',()=>codec.parseRepositoryPath(p));
  refused('INVALID_UTF8',()=>codec.parseRepositoryPath('\ud800'));
  for(const [kind,mode]of [['file','100644'],['file','100755'],['directory','040000'],['symlink','120000']]){
   const entry={name:'雪',kind,mode,object_id:vectors.vectors[0].object_id};assert.deepEqual(codec.parseTreeEntry(entry),entry);
  }
  refused('INVALID_TREE_ENTRY',()=>codec.parseTreeEntry({name:'x',kind:'symlink',mode:'100755',object_id:vectors.vectors[0].object_id}));
  refused('OBJECT_KIND_MISMATCH',()=>codec.decodeCanonicalEnvelope(Buffer.from(vectors.vectors[0].envelope_hex,'hex'),'revision'));
  refused('INVALID_OBJECT',()=>codec.decodeCanonicalEnvelope(Buffer.from('hyperfide-source-control\0v1\0blob\0'+'00\0')));
 }
});
check('lifecycle-replay-and-public-provenance-boundaries',()=>{
 for(const codec of [server,sdk]){
  refused('INVALID_STATE',()=>codec.parseOperationState('DONE'));refused('INVALID_STATE',()=>codec.parseSourceLifecycle('UPLOADED'));
  codec.assertOperationTransition('ADMITTED','RUNNING');codec.assertOperationTransition('RUNNING','OUTCOME_UNKNOWN');codec.assertOperationTransition('OUTCOME_UNKNOWN','SUCCEEDED');
  refused('INVALID_STATE_TRANSITION',()=>codec.assertOperationTransition('SUCCEEDED','RUNNING'));
  const provenance={author:{name:'Developer',email:'developer@example.test'},message:'Update core',timestamp:'2026-11-02T00:00:00.000Z'};
  assert.deepEqual(codec.parsePublicProvenance(provenance),provenance);
  refused('INVALID_REQUEST',()=>codec.parsePublicProvenance({...provenance,private_context:'not source provenance'}));
  refused('INVALID_REQUEST',()=>codec.parsePublicProvenance({...provenance,timestamp:'2026-11-02T00:00:00Z'}));
 }
});
check('page-parsing-and-sdk-server-round-trips',()=>{
 const snapshot=request.input.tree_id;
 const cursorCodec=new SourceCursorCodec(randomBytes(32));
 const binding={scope,principal_id:uuid,authority_epoch:'1',query:{action:'source.trees.entries'},snapshot};
 const position={after:'page-😀'};
 const cursor=cursorCodec.encode(binding,position);
 const entry={name:'page-😀',kind:'file',mode:'100644',object_id:snapshot};
 for(const [producer,consumer]of [[server,sdk],[sdk,server]]){
  for(const coverage of ['COMPLETE','PARTIAL','REDACTED','INDEX_PENDING']){
   const page={items:[entry],next_cursor:coverage==='PARTIAL'?cursor:null,coverage,snapshot,index_generation:'18446744073709551615',index_complete:coverage!=='INDEX_PENDING'};
   const response=consumer.decodeSourceResponse(producer.encodeSourceResponse({protocol_version:1,operation_id:uuid,result:page}));
   assert.deepEqual(consumer.parseSourcePage(response.result,consumer.parseTreeEntry),page);
   assert.deepEqual(JSON.parse(consumer.canonicalJSON(consumer.parseSourcePage(response.result))),page);
   if(coverage==='PARTIAL')assert.deepEqual(cursorCodec.decode(binding,consumer.parseSourcePage(response.result).next_cursor),position);
  }
  const empty={items:[],next_cursor:null,coverage:'COMPLETE',snapshot};
  assert.deepEqual(consumer.parseSourcePage(empty),empty);
  const full={...empty,items:Array.from({length:256},()=>entry)};
  assert.equal(consumer.parseSourcePage(full,consumer.parseTreeEntry).items.length,256);
  refused('LIMIT_EXCEEDED',()=>consumer.parseSourcePage({...full,items:[...full.items,entry]}));
  refused('INVALID_TREE_ENTRY',()=>consumer.parseSourcePage({...empty,items:[{...entry,mode:'040000'}]},consumer.parseTreeEntry));
 }
});
check('malformed-page-and-cursor-refusals',()=>{
 const page={items:[],next_cursor:null,coverage:'COMPLETE',snapshot:request.input.tree_id};
 for(const codec of [server,sdk]){
  assert.equal(codec.parseSourceCursor('opaque_token.signature'),'opaque_token.signature');
  assert.equal(codec.parseSourceCursor('x'.repeat(65536)).length,65536);
  for(const cursor of ['',null,undefined,0,{},[],true,'x'.repeat(65537),'a b','a\tb','a\nb','a\rb','a\0b','a\x1fb','a\x7fb','雪','😀','\ud800']){
   refused('INVALID_CURSOR',()=>codec.parseSourceCursor(cursor));
   if(cursor!==null)refused('INVALID_CURSOR',()=>codec.parseSourcePage({...page,coverage:'PARTIAL',next_cursor:cursor}));
  }
  refused('INVALID_CURSOR',()=>codec.parseSourcePage({...page,coverage:'PARTIAL'}));
  refused('INVALID_CURSOR',()=>codec.parseSourcePage({...page,next_cursor:'opaque'}));
  for(const value of [null,[],false])refused('INVALID_REQUEST',()=>codec.parseSourcePage(value));
  for(const value of [null,{},'items',1])refused('INVALID_REQUEST',()=>codec.parseSourcePage({...page,items:value}));
  refused('INVALID_REQUEST',()=>codec.parseSourcePage({...page,items:Array(1)}));
  for(const coverage of ['UNKNOWN','complete',null,{},1])refused('INVALID_REQUEST',()=>codec.parseSourcePage({...page,coverage}));
  refused('INVALID_REQUEST',()=>codec.parseSourcePage({...page,unexpected:true}));
  for(const field of ['items','next_cursor','coverage','snapshot']){
   const missing={...page};delete missing[field];assert.throws(()=>codec.parseSourcePage(missing));
  }
  refused('INVALID_IDENTITY',()=>codec.parseSourcePage({...page,snapshot:'a'.repeat(64)}));
  for(const vector of vectors.generation_vectors){
   if(vector.error)refused(vector.error,()=>codec.parseSourcePage({...page,index_generation:vector.value}));
   else assert.equal(codec.parseSourcePage({...page,index_generation:vector.value}).index_generation,vector.value);
  }
  for(const index_complete of ['true',1,null,undefined])refused('INVALID_REQUEST',()=>codec.parseSourcePage({...page,index_complete}));
 }
});
check('operation-replay-digest-conflict-is-a-server-rule',()=>{
 const replay={...request,input:{...request.input,parents:[request.input.tree_id]}};
 for(const [producer,consumer]of [[sdk,server],[server,sdk]]){
  const original=consumer.decodeSourceRequest(producer.encodeSourceRequest(request));
  const changed=consumer.decodeSourceRequest(producer.encodeSourceRequest(replay));
  assert.equal(original.operation_id,changed.operation_id);
  assert.equal(original.idempotency_key,changed.idempotency_key);
  const digest=value=>createHash('sha256').update(consumer.canonicalBytes(value)).digest('hex');
  assert.notEqual(digest(original.input),digest(changed.input));
  const conflict={protocol_version:1,operation_id:uuid,error:{code:'IDEMPOTENCY_CONFLICT',message:'Operation identity is already bound to another request',retry:'NEVER',outcome:'KNOWN'}};
  assert.deepEqual(consumer.decodeSourceResponse(producer.encodeSourceResponse(conflict)),conflict);
 }
 assert.match(decisions,/D28:[\s\S]*same operation_id[\s\S]*different request_digest[\s\S]*IDEMPOTENCY_CONFLICT/);
});
console.log(JSON.stringify({status:outcomes.every(x=>x.outcome==='PASS')?'PASS':'FAIL',task:'0.1',assertions:outcomes,scope:'Native protocol and real SDK/server codec interoperability'}));
if(outcomes.some(x=>x.outcome!=='PASS'))process.exitCode=1;
'''


def main():
    override = os.environ.get('HYPERFIDE_NODE')
    node = shutil.which(override or 'node')
    if not node:
        raise RuntimeError('CAPABILITY_MISSING: set HYPERFIDE_NODE or provide node on PATH')
    sdk = ROOT / 'sdk/source-control'
    build = subprocess.run([node, str(ROOT / 'tools/workspace/build-package.mjs')], cwd=sdk, text=True, capture_output=True)
    if build.returncode:
        sys.stderr.write(build.stdout + build.stderr)
        return build.returncode
    result = subprocess.run([node, '--input-type=module', '-e', PROGRAM, str(ROOT)], cwd=sdk, text=True, capture_output=True)
    sys.stdout.write(result.stdout)
    sys.stderr.write(result.stderr)
    if result.returncode:
        return result.returncode
    receipt = json.loads(result.stdout.strip())
    receipt['node_resolution'] = {'source': 'HYPERFIDE_NODE' if override else 'PATH', 'executable': node}
    paths = ['sdk/source-control/package.json', 'sdk/source-control/src/contracts.ts', 'sdk/source-control/src/index.ts', 'core/control-plane/src/source_control/contracts.ts', 'core/control-plane/scripts/sync-fleet-contracts.mjs', 'tests/hyperfide/cases/source_control/fixtures/contracts-v1.json', 'spec/hyperfide-source-control/decisions.md']
    receipt['inputs'] = {p: hashlib.sha256((ROOT / p).read_bytes()).hexdigest() for p in paths}
    out = ROOT / 'build/source-control/0.1'
    out.mkdir(parents=True, exist_ok=True)
    (out / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
