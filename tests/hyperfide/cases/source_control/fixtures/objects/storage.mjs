import {createSourceS3Fixture} from './backend.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import pg from '../../../../../../core/control-plane/node_modules/pg/lib/index.js';
const folder=process.argv[2],load=name=>import(pathToFileURL(folder+'/'+name+'.js'));
const [{SourceObjectService,sourceObjectId,encodeTreeNode},{PostgresSourceObjectCatalog,protectSourceRoot},{PersistentTree},{S3SourceObjectBackend,sourceS3Configuration}]=await Promise.all([load('objects'),load('object_catalog'),load('trees'),load('s3')]);
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:8});
const db={transaction:async body=>{const tx=await pool.connect();try{await tx.query('BEGIN');const result=await body(tx);await tx.query('COMMIT');return result;}catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}}};
const scope={organisation_id:randomUUID(),repository_id:randomUUID(),security_domain_id:randomUUID()},checks=[];
const fixture=await createSourceS3Fixture(),{requests}=fixture;
const catalog=new PostgresSourceObjectCatalog(db),s3=new S3SourceObjectBackend(fixture.config),store=new SourceObjectService(catalog,s3),trees=new PersistentTree(store);
try{
 await pool.query('CREATE SCHEMA hyperfide');await pool.query(await fs.readFile('core/control-plane/migrations/0736-source-control-storage.sql','utf8'));
 const file=await store.putFile(scope,Buffer.from('exact executable bytes\n')),symlink=await store.put(scope,'blob',Buffer.from('../core/main.ts'));
 assert.equal((await store.readFile(scope,file.object_id)).toString(),'exact executable bytes\n');assert.notEqual(sourceObjectId('blob',Buffer.from('same')),sourceObjectId('chunk',Buffer.from('same')));checks.push('typed envelopes and file descriptor reconstruct exact independent payload');
 const binary=Buffer.alloc(4194304+17,0xa5);binary.set(Buffer.from('final short chunk'),4194304);const large=await store.putFile(scope,binary);assert.deepEqual(await store.readFile(scope,large.object_id,{offset:4194296,length:25}),binary.subarray(4194296));assert.deepEqual(await store.readFile(scope,large.object_id),binary);checks.push('chunked binary descriptor reconstructs whole payload and cross-chunk range');
 const entry={name:'main.ts',kind:'file',mode:'100755',object_id:file.object_id};let root=await trees.empty(scope);
 root=(await trees.patch(scope,root,[{path:'core/main.ts',operation:'put',...entry},{path:'link',operation:'put',kind:'symlink',mode:'120000',object_id:symlink.object_id}])).root_tree_id;
 assert.equal((await trees.lookup(scope,root,'core/main.ts')).mode,'100755');assert.equal((await trees.lookup(scope,root,'link')).kind,'symlink');assert.equal((await trees.list(scope,root,{limit:1})).entries.length,1);checks.push('nested sparse tree preserves executable and symlink metadata');
 const metrics=[];for(const count of [512,4096]){
 const entries=Array.from({length:count},(_,n)=>({...entry,name:'entry-'+String(n).padStart(6,'0')})),initial=await trees.fromEntries(scope,entries),before=requests.length;
 const updated=await trees.patch(scope,initial.root_tree_id,[{path:'entry-000123',operation:'put',kind:'file',mode:'100644',object_id:file.object_id}]);const calls=requests.length-before;console.log(JSON.stringify({phase:"patch-metrics",count,...updated.metrics,calls}));assert(updated.metrics.nodes_read<=2*Buffer.byteLength("entry-000123")+2&&updated.metrics.nodes_written<=2*Buffer.byteLength("entry-000123")+2&&calls<160,{count,...updated.metrics,calls});assert.equal((await trees.lookup(scope,updated.root_tree_id,'entry-000123')).mode,'100644');assert.equal((await trees.lookup(scope,initial.root_tree_id,'entry-000123')).mode,'100755');metrics.push({entries:count,...updated.metrics,backend_requests:calls});
 let cursor,seen=[];do{const page=await trees.list(scope,updated.root_tree_id,{limit:127,...(cursor?{cursor}:{})});seen.push(...page.entries.map(e=>e.name));cursor=page.next_cursor;}while(cursor);assert.equal(seen.length,count);assert.deepEqual(seen,entries.map(e=>e.name));
 }checks.push('fixed patch touches bounded radix paths across512 and4096 entries; pagination has no duplicates or omissions');
 const lost=Buffer.from('lost response payload'),operation=randomUUID(),id=sourceObjectId('blob',lost);fixture.faults.losePut=true;fixture.faults.unavailableReads=1;
 await assert.rejects(store.put(scope,'blob',lost,operation),e=>e.code==='OBJECT_UNAVAILABLE');const upload=await catalog.begin(scope,{operation_id:operation,object_id:id,kind:'blob',size_bytes:String(Buffer.byteLength('hyperfide-source-control\0v1\0blob\0'+lost.length+'\0')+lost.length)});assert.equal(upload.status,'UNKNOWN');await store.completeUpload(scope,upload.upload_id);assert.equal((await store.read(scope,id)).payload.toString(),lost.toString());assert.equal(requests.filter(r=>r.method==='PUT'&&r.key.endsWith(upload.incarnation_id)).length,1);checks.push('lost PUT acknowledgment remains UNKNOWN until exact readback verifies without another PUT');
 await assert.rejects(store.put(scope,'blob',Buffer.from('changed request'),operation),e=>e.code==='IDEMPOTENCY_CONFLICT');
 fixture.faults.corrupt=true;await assert.rejects(store.read(scope,id),e=>e.code==='OBJECT_INTEGRITY');fixture.faults.corrupt=false;
 const internal=await store.put(scope,'tree-leaf',encodeTreeNode({kind:'tree-leaf',prefix:'6',entries:[entry],count:1}));
 await assert.rejects(db.transaction(tx=>protectSourceRoot(tx,scope,internal.object_id,randomUUID())),e=>e.code==='INVALID_TREE');
 await assert.rejects(trees.patch(scope,internal.object_id,[]),e=>e.code==='INVALID_TREE');
 await assert.rejects(store.put(scope,'tree-leaf',encodeTreeNode({kind:'tree-leaf',prefix:'',entries:[{name:'invalid-dir',kind:'directory',mode:'040000',object_id:internal.object_id}],count:1})),e=>e.code==='INVALID_TREE');checks.push('internal radix node cannot become a revision root, directory root or directory entry');
 const beforeDenied=requests.length;await assert.rejects(store.read({...scope,security_domain_id:randomUUID()},id),e=>e.code==='OBJECT_NOT_READY');assert.equal(requests.length,beforeDenied);checks.push('corruption, changed idempotent request and cross-domain guesses are refused');
 const missing='sha256:'+'a'.repeat(64);await assert.rejects(store.put(scope,'tree-leaf',encodeTreeNode({kind:'tree-leaf',prefix:'',entries:[{...entry,object_id:missing}],count:1})),e=>e.code==='INVALID_TREE');
 const pin=await db.transaction(tx=>protectSourceRoot(tx,scope,root,randomUUID()));assert.equal(pin.object_id,root);const pins=await pool.query("SELECT count(*)::int AS count FROM hyperfide.source_object_pins WHERE owner_kind='OBJECT'");assert(pins.rows[0].count>0);checks.push('verified parents and revision roots acquire real durable exact-incarnation pins');
 const fenced=await trees.empty({...scope,repository_id:randomUUID()});
 const fencedRow=(await pool.query('SELECT * FROM hyperfide.source_native_objects WHERE object_id=$1 AND repository_id<>$2',[fenced,scope.repository_id])).rows[0];const fencedScope={...scope,repository_id:fencedRow.repository_id};
 await pool.query("UPDATE hyperfide.source_object_placements SET state='DELETE_PENDING' WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND object_id=$4",[scope.organisation_id,fencedScope.repository_id,scope.security_domain_id,fenced]);
 await assert.rejects(db.transaction(tx=>protectSourceRoot(tx,fencedScope,fenced,randomUUID())),e=>e.code==='OBJECT_NOT_READY');
 await assert.rejects(pool.query("UPDATE hyperfide.source_native_objects SET kind='blob' WHERE organisation_id=$1 AND repository_id=$2 AND object_id=$3",[scope.organisation_id,scope.repository_id,root]),e=>e.code==='23514');checks.push('physical placement deletion fence prevents new root pins; native identity mutation rejected in PostgreSQL');
 assert(requests.every(r=>['PUT','GET'].includes(r.method)));assert(requests.every(r=>r.key.startsWith('/fixture-bucket/source/v1/')));checks.push('all reconstruction uses identified GET/conditionalPUT without LIST or repository materialization');
 let live={status:'UNRUN',reason:'run with --live-s3 for configured backend'};
 if(process.argv.includes('--live-s3')){
 try{
 const actual=new S3SourceObjectBackend(sourceS3Configuration(process.env)),bytes=Buffer.from('hyperfide source S3 integration '+randomUUID()),object=sourceObjectId('blob',bytes),incarnation=randomUUID(),domain=randomUUID(),key='source/v1/'+domain+'/blob/'+object.slice(7,9)+'/'+object.slice(7)+'/'+incarnation;
 const envelope=Buffer.concat([Buffer.from('hyperfide-source-control\0v1\0blob\0'+bytes.length+'\0'),bytes]);const put=await actual.put(key,envelope),observed=await actual.read(key,envelope.length);assert.equal(observed.state,'PRESENT');assert.deepEqual(observed.bytes,envelope);assert.equal(await actual.put(key,Buffer.from('different bytes')),'EXISTS');const cleanup=await actual.delete(key,object,envelope.length);assert.equal(cleanup,'ABSENT');live={status:'PASS',backend:actual.identity,put_outcome:put,key,object_id:object,cleanup};
 }catch(error){if(error.code!=='SOURCE_STORAGE_CONFIG')throw error;live={status:'UNRUN',reason:'Configured source S3 backend is unavailable'};}
 }
 const receipt={status:live.status==='PASS'?'PASS':'COMPONENT_PASS',checks,metrics,backend:s3.identity,backend_requests:requests.length,live_s3:live};await fs.mkdir('build/source-control/1.1',{recursive:true});await fs.writeFile('build/source-control/1.1/receipt.json',JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));if(process.argv.includes('--live-s3')&&live.status!=='PASS')process.exitCode=77;
}finally{await pool.end();await fixture.close();}
