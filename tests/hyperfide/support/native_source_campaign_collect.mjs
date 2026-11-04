/** Read-only deployment observer: exact scoped SQL counts and raw storage/client instrumentation. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {storageObservations} from '../source-control/workloads/storage_observer.mjs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {readPrivate,observerCounters} from '../source-control/workloads/deployment.mjs';
const config=JSON.parse(await readPrivate(process.env.HF_SOURCE_COLLECTOR_CONFIG));
const scope=JSON.parse(process.env.HF_SOURCE_CAMPAIGN_SCOPE);assert.deepEqual(scope,config.scope);
const pg=await import(pathToFileURL(config.pg_module)),Client=pg.Client??pg.default?.Client;assert.equal(typeof Client,'function');
const providerRaw=await readPrivate(config.provider_snapshot_file),provider=JSON.parse(providerRaw);
assert.equal(provider.schema_version,1);assert.deepEqual(provider.scope,scope);
assert(Math.abs(Date.now()-Date.parse(provider.sampled_at))<120000,'Stale deployment provider snapshot');
assert(provider.deployment_identity&&['provider','service_id','deployment_id','image_digest','resource_profile_digest'].every(key=>typeof provider.deployment_identity[key]==='string'&&provider.deployment_identity[key]));

const storage=await storageObservations(config,scope),{storage_requests,storage_bytes}=storage,storageEvidence=storage.evidence;
const httpSnapshots=[],httpSources=[];const snapshotPaths=config.http_snapshots??[];
assert(Number.isSafeInteger(config.http_expected_processes)&&config.http_expected_processes>0,'Explicit expected source process count required');
for(const filename of snapshotPaths){const raw=await readPrivate(filename),sample=JSON.parse(raw);assert.deepEqual(sample.scope,scope);assert.equal(sample.service_id,provider.deployment_identity.service_id);assert.equal(sample.deployment_id,provider.deployment_identity.deployment_id);assert.equal(sample.coverage,'COMPLETE');assert.equal(sample.state,'RUNNING');assert(Math.abs(Date.now()-Date.parse(sample.sampled_at))<120000,'Stale native HTTP counter snapshot');assert(sample.listeners.length>0);httpSnapshots.push(sample);httpSources.push({kind:'native-http-counters',identity:filename,sha256:'sha256:'+createHash('sha256').update(raw).digest('hex')});}
assert.equal(httpSnapshots.length,config.http_expected_processes);assert.equal(new Set(httpSnapshots.map(value=>value.boot_id)).size,httpSnapshots.length,'Duplicate source process snapshot');
const clientRaw=await readPrivate(config.client_metrics_file),clientMetrics=JSON.parse(clientRaw);
assert.deepEqual(clientMetrics.scope,scope);
assert.equal(clientMetrics.schema_version,1);
assert(Math.abs(Date.now()-Date.parse(clientMetrics.sampled_at))<120000,'Stale client instrumentation');
assert(typeof clientMetrics.measurement==='string'&&clientMetrics.measurement.length>0);
const databaseUrl=config.database_config_file?JSON.parse(await readPrivate(config.database_config_file)).database_url:process.env.DATABASE_URL;
const db=new Client({connectionString:databaseUrl,application_name:'source-independent-observer'});await db.connect();
let counts,activity;
try{
 await db.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
 const args=[scope.organisation_id,scope.repository_id,scope.security_domain_id];
 const where='organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3';
 counts=(await db.query(`SELECT (SELECT count(*) FROM hyperfide.source_revisions WHERE ${where})::text AS revisions,(SELECT count(*) FROM hyperfide.source_workspaces WHERE ${where})::text AS workspaces,(SELECT count(*) FROM hyperfide.source_metadata_operations WHERE ${where} AND state='PENDING')::text AS queue,(SELECT coalesce(max(greatest(0,extract(epoch FROM (clock_timestamp()-created_at))*1000)),0) FROM hyperfide.source_git_publications WHERE ${where} AND status IN ('QUEUED','READY','DISPATCHED','OUTCOME_UNKNOWN'))::text AS publication_ms,pg_database_size(current_database())::text AS database_bytes,pg_total_relation_size('hyperfide.source_workspaces')::text AS workspace_total_bytes,pg_relation_size('hyperfide.source_workspaces')::text AS workspace_table_bytes,pg_indexes_size('hyperfide.source_workspaces')::text AS workspace_index_bytes,pg_total_relation_size('hyperfide.source_metadata_operations')::text AS operation_total_bytes`,args)).rows[0];
 activity=(await db.query("SELECT count(*)::text AS connections,coalesce(max(CASE WHEN wait_event_type='Lock' THEN greatest(0,extract(epoch FROM (clock_timestamp()-query_start))*1000) ELSE 0 END),0)::text AS lock_ms FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()")).rows[0];
 await db.query('COMMIT');
}finally{await db.end();}
const observations={deployment_identity:provider.deployment_identity,backend_identity:config.backend_identity,real_s3:true,persisted_revisions:Number(counts.revisions),persisted_workspaces:Number(counts.workspaces),database_bytes:Number(counts.database_bytes),workspace_total_bytes:Number(counts.workspace_total_bytes),workspace_table_bytes:Number(counts.workspace_table_bytes),workspace_index_bytes:Number(counts.workspace_index_bytes),operation_total_bytes:Number(counts.operation_total_bytes),storage_requests,storage_bytes,storage_read_bytes:storage.storage_read_bytes,storage_offered_write_bytes:storage.storage_offered_write_bytes,storage_acknowledged_write_bytes:storage.storage_acknowledged_write_bytes,storage_unknown_write_lengths:storage.storage_unknown_write_lengths,storage_failed_write_requests:storage.storage_failed_write_requests,storage_unknown_write_outcomes:storage.storage_unknown_write_outcomes,http_requests:httpSnapshots.reduce((sum,value)=>sum+value.requests,0),http_processes:httpSnapshots,hydrated_bytes:clientMetrics.hydrated_bytes,cache_hits:clientMetrics.cache_hits,cache_misses:clientMetrics.cache_misses,queue_depth:Number(counts.queue),lock_wait_ms:Math.ceil(Number(activity.lock_ms)),connection_count:Number(activity.connections),publication_lag_ms:Math.ceil(Number(counts.publication_ms))};
observerCounters(observations,config.backend_identity);
process.stdout.write(JSON.stringify({schema_version:1,scope,sampled_at:new Date().toISOString(),observations,sources:[{kind:'provider-deployment-readback',identity:config.provider_snapshot_file,sha256:'sha256:'+createHash('sha256').update(providerRaw).digest('hex')},{kind:'postgresql-repeatable-read',identity:config.database_identity},...storageEvidence,...httpSources,{kind:'client-instrumentation',identity:config.client_metrics_file,sha256:'sha256:'+createHash('sha256').update(clientRaw).digest('hex')}],samples:{postgres:{...counts,...activity},client:clientMetrics},measurement_notes:{lock_wait_ms:'maximum current lock wait age in dedicated database',storage_bytes:'response bytes consumed by source service; same as storage_read_bytes',storage_offered_write_bytes:'known PUT request payload bytes offered to fetch, including failed requests',storage_acknowledged_write_bytes:'known PUT payload bytes with observed successful S3 response, including replay attempts; not unique object size or TCP/TLS bytes',storage_unknown_write_lengths:'PUT attempts with unmeasured streaming request size',storage_unknown_write_outcomes:'PUT fetch failures without a conclusive HTTP response',queue_depth:'pending native metadata operations'}})+'\n');
