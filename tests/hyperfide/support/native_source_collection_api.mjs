import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
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
 await f.pool.query('UPDATE hyperfide.source_capabilities SET revoked_at=clock_timestamp() WHERE id=$1',[f.roles.author.capability_id]);await assert.rejects(f.client.call('source.collection.inspect',{partition,limit:1}),error=>error.code==='SCOPE_DENIED');checks.push('source capability revocation immediately fences collection access');
 const receipt={status:'PASS',checks,backend_requests:f.backend.requests.length};await fs.writeFile('build/source-control/2.3/api-receipt.json',JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));
}finally{await f.close();}
