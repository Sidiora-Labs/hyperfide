import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import {createNativeAcceptanceFixture} from './native_source_acceptance_fixture.mjs';
const f=await createNativeAcceptanceFixture({actions:['source.objects.put','source.objects.read','source.revisions.create','source.revisions.read','source.domains.create','source.retention.configure','source.retention.acquire','source.retention.release','source.retention.reserve','source.retention.reconcile','source.collection.discover','source.collection.collect','source.collection.inspect']}),checks=[];
try{
 const policy={expected_generation:'0',minimum_age_seconds:0,quarantine_seconds:0,backup_until:'2000-01-01T00:00:00Z',backend_identity:'s3-v1:'+new URL(f.backend.config.endpoint).origin+'/fixture-bucket',independent_expiration:false};
 assert.equal((await f.mutation('source.retention.configure',policy)).generation,'1');assert.equal((await f.mutation('source.retention.configure',policy)).generation,'1');
 const uploaded=await f.mutation('source.objects.put',{kind:'blob',payload_base64:Buffer.from('api retained source').toString('base64')}),id=uploaded.object_id,partition=parseInt(id.slice(7,9),16)%16;
 await f.pool.query("UPDATE hyperfide.source_object_pins SET expires_at=clock_timestamp()-interval '1 second' WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND object_id=$4 AND owner_kind='UPLOAD'",[...Object.values(f.scope),id]);
 const root={root_id:randomUUID(),owner_kind:'EXPORT',owner_id:'exact-export',object_id:id};
 const retained=await f.mutation('source.retention.acquire',root);assert.equal(retained.object_id,id);assert.deepEqual(await f.mutation('source.retention.acquire',root),retained);
 assert.equal((await f.mutation('source.collection.discover',{partition,limit:1})).quarantined.length,0);
 await assert.rejects(f.mutation('source.retention.release',{root_id:root.root_id,owner_kind:'EXPORT',owner_id:'wrong-export'}),error=>error.code==='RETENTION_OWNER_MISMATCH');
 await f.mutation('source.retention.release',{root_id:root.root_id,owner_kind:'EXPORT',owner_id:root.owner_id});
 await f.mutation('source.collection.discover',{partition,limit:1});
 const debt=await f.client.call('source.collection.inspect',{partition,limit:1});assert.equal(debt.work.length,1);assert.equal(debt.work[0].object_id,id);
 const rescued={...root,root_id:randomUUID(),owner_kind:'HOLD',owner_id:'rescue'};await f.mutation('source.retention.acquire',rescued);assert.equal((await f.client.object(id)).payload_base64,Buffer.from('api retained source').toString('base64'));checks.push('registered authenticated retention API acquires, replays, rejects wrong owner, exposes debt and rescues source');
 await f.mutation('source.retention.release',{root_id:rescued.root_id,owner_kind:'HOLD',owner_id:'rescue'});await f.mutation('source.collection.discover',{partition,limit:1});const result=await f.mutation('source.collection.collect',{partition,limit:1});assert.equal(result.results[0].outcome,'ABSENT');assert.equal((await f.client.call('source.collection.inspect',{partition,limit:1})).work.length,0);checks.push('registered collection executes exact conditional deletion and removes resolved debt');
 const classes=['WORKSPACE','CUSTODY','CANDIDATE','EVIDENCE','IMPORT','EXPORT','BACKUP','HOLD'],inventory=[];
 for(const owner_kind of classes){
  const bytes=Buffer.from('retention closure '+owner_kind),blob=await f.mutation('source.objects.put',{kind:'blob',payload_base64:bytes.toString('base64')});
  const descriptor=[1,String(bytes.length),'sha256:'+createHash('sha256').update(bytes).digest('hex'),['blob',blob.object_id]];
  const file=await f.mutation('source.objects.put',{kind:'file',payload_base64:Buffer.from(JSON.stringify(descriptor)).toString('base64')});
  const leaf=await f.mutation('source.objects.put',{kind:'tree-leaf',payload_base64:Buffer.from(JSON.stringify([1,'',[['kept.txt','file','100644',file.object_id]]])).toString('base64')});
  const root={root_id:randomUUID(),owner_kind,owner_id:'case-root-'+owner_kind,object_id:leaf.object_id};await f.mutation('source.retention.acquire',root);
  inventory.push({root,objects:[leaf.object_id,file.object_id,blob.object_id],bytes});
 }
 await f.pool.query("UPDATE hyperfide.source_object_pins SET expires_at=clock_timestamp()-interval '1 second' WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND owner_kind='UPLOAD' AND object_id=ANY($4::text[])",[...Object.values(f.scope),inventory.flatMap(item=>item.objects)]);
 for(let round=0;round<3;round++)for(let part=0;part<16;part++){await f.mutation('source.collection.discover',{partition:part,limit:256});await f.mutation('source.collection.collect',{partition:part,limit:256});}
 for(const item of inventory){for(const object_id of item.objects)assert.equal((await f.client.object(object_id)).object_id,object_id);const blob=await f.client.object(item.objects[2]);assert(Buffer.from(blob.payload_base64,'base64').equals(item.bytes));}
 checks.push('every declared workspace custody candidate evidence import export backup and hold root preserves independently retrieved tree file and blob closure while upload pins expire');
 for(const item of inventory)await f.mutation('source.retention.release',{root_id:item.root.root_id,owner_kind:item.root.owner_kind,owner_id:item.root.owner_id});
 for(let round=0;round<3;round++)for(let part=0;part<16;part++){await f.mutation('source.collection.discover',{partition:part,limit:256});await f.mutation('source.collection.collect',{partition:part,limit:256});}
 for(const item of inventory)for(const object_id of item.objects)await assert.rejects(f.client.object(object_id),error=>error.code==='OBJECT_NOT_READY');
 checks.push('ending each declared root obligation reclaims parent before children without erasing another retained closure');
 await f.pool.query('UPDATE hyperfide.source_capabilities SET revoked_at=clock_timestamp() WHERE id=$1',[f.roles.author.capability_id]);await assert.rejects(f.client.call('source.collection.inspect',{partition,limit:1}),error=>error.code==='SCOPE_DENIED');checks.push('source capability revocation immediately fences collection access');
 await fs.mkdir(process.env.HYPERFIDE_SOURCE_EVIDENCE_DIR??'build/source-control/2.3',{recursive:true});
 const receipt={status:'PASS',checks,backend_requests:f.backend.requests.length};await fs.writeFile((process.env.HYPERFIDE_SOURCE_EVIDENCE_DIR??'build/source-control/2.3')+'/api-receipt.json',JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));
}finally{await f.close();}
