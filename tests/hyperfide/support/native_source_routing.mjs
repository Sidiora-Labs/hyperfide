import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createNativeAcceptanceFixture} from './native_source_acceptance_fixture.mjs';
const f=await createNativeAcceptanceFixture({actions:['source.objects.put','source.objects.read','source.revisions.create','source.revisions.read','source.domains.create','source.routing.move','source.routing.read']}),checks=[];
try{
 const load=name=>import(pathToFileURL(path.join(process.env.SOURCE_CONTROL_MODULE_ROOT,name+'.js')));
 const [{createSourceService},{S3SourceObjectBackend},{SourceRoutedObjectCatalog},{sourceObjectId},{canonicalEnvelope}]=await Promise.all([load('registration'),load('s3'),load('routing'),load('objects'),load('contracts')]);
 const bytes=Buffer.from('source routing owner admission');
 const initial=await f.service.objects.put(f.scope,'blob',bytes),partition=parseInt(initial.object_id.slice(7,9),16)%16;
 const options={pool:f.pool,backend:new S3SourceObjectBackend(f.backend.config),cursorKey:Buffer.alloc(32,7),workspaceBudgets:{cache_bytes:16777216,max_cache_entries:1024,max_file_bytes:8388608,materialized_bytes:33554432,dirty_bytes:8388608}};
 await f.mutation('source.routing.move',{partition,expected_generation:'0',owner_id:'source-a'});
 await assert.rejects(f.service.objects.put(f.scope,'blob',bytes),error=>error.code==='STALE_ROUTE');
 const a=createSourceService({...options,routing_owner_id:'source-a'});
 assert.equal((await a.objects.put(f.scope,'blob',bytes)).object_id,initial.object_id);
 checks.push('an existing unconfigured service cannot bypass a newly configured partition owner');
 await f.mutation('source.routing.move',{partition,expected_generation:'1',owner_id:'source-b'});
 await assert.rejects(a.objects.put(f.scope,'blob',bytes),error=>error.code==='STALE_ROUTE');
 await assert.rejects(f.service.objects.put(f.scope,'blob',bytes),error=>error.code==='STALE_ROUTE');
 const b=createSourceService({...options,routing_owner_id:'source-b'});
 assert.equal((await b.objects.put(f.scope,'blob',bytes)).object_id,initial.object_id);
 assert.equal((await f.service.objects.read(f.scope,initial.object_id)).payload.toString(),bytes.toString());
 checks.push('moving the partition fences both the previous and unspecified owner while immutable reads continue');
 let freshBytes,freshId,freshPartition;for(let index=0;index<100;index++){freshBytes=Buffer.from('unowned route race '+index);freshId=sourceObjectId('blob',freshBytes);freshPartition=parseInt(freshId.slice(7,9),16)%16;if(freshPartition!==partition)break;}
 const tx=await f.pool.connect();let moving;
 try{
  await tx.query('BEGIN');const legacy=new SourceRoutedObjectCatalog({transaction:body=>body(tx)});
  await legacy.begin(f.scope,{operation_id:randomUUID(),object_id:freshId,kind:'blob',size_bytes:String(canonicalEnvelope('blob',freshBytes).length)});
  let moved=false;moving=f.mutation('source.routing.move',{partition:freshPartition,expected_generation:'0',owner_id:'new-owner'}).then(value=>{moved=true;return value;});
  let blocked=false;for(let step=0;step<200&&!moved;step++){blocked=(await f.pool.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())) AS blocked")).rows[0].blocked;if(blocked)break;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(blocked,true,'Initial route ownership must wait for an admitted unconfigured writer');await tx.query('COMMIT');await moving;
  await assert.rejects(f.service.objects.put(f.scope,'blob',freshBytes),error=>error.code==='STALE_ROUTE');
 }finally{await tx.query('ROLLBACK');tx.release();if(moving)await moving;}
 checks.push('initial route creation waits for an admitted unconfigured transaction and fences its later writes');
 const receipt={status:'PASS',checks};await fs.mkdir('build/source-control/routing',{recursive:true});await fs.writeFile('build/source-control/routing/receipt.json',JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));
}finally{await f.close();}
