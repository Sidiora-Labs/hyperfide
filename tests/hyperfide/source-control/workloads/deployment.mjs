import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function readPrivate(filename){
 assert(path.isAbsolute(filename),'Private configuration path must be absolute');
 const stat=await fs.lstat(filename);
 assert(stat.isFile()&&!stat.isSymbolicLink()&&!(stat.mode&0o077),'Campaign configuration and credentials require private regular files');
 return fs.readFile(filename,'utf8');
}
export function deploymentConfig(config,plan){
 assert.equal(config.schema_version,1);assert.equal(config.backend_identity,plan.backend_identity);assert.equal(config.isolated_scope,true);assert.equal(plan.real_backend,true);
 const endpoint=new URL(config.endpoint);assert.equal(endpoint.protocol,'https:');assert(!endpoint.username&&!endpoint.password&&!endpoint.search&&!endpoint.hash);
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
 assert.deepEqual(Object.keys(config.scope).sort(),['organisation_id','repository_id','security_domain_id']);for(const value of Object.values(config.scope))assert(uuid.test(value));
 assert(path.isAbsolute(config.credential_file));assert(path.isAbsolute(config.output_directory));assert(config.observer);
 assert(config.budgets&&Number.isFinite(config.budgets.max_checkpoint_p95_ms)&&config.budgets.max_checkpoint_p95_ms>0&&Number.isFinite(config.budgets.max_growth_ratio)&&config.budgets.max_growth_ratio>=1);
 assert(Array.isArray(config.corpora));assert.equal(config.corpora.length,plan.file_counts.length);
 for(const count of plan.file_counts){const corpus=config.corpora.find(c=>c.logical_files===count);assert(corpus&&/^sha256:[0-9a-f]{64}$/.test(corpus.revision_id));assert(Array.isArray(corpus.edit_paths)&&corpus.edit_paths.length===plan.modified_files&&new Set(corpus.edit_paths).size===plan.modified_files);for(const name of corpus.edit_paths)assert(typeof name==='string'&&name&&!path.isAbsolute(name)&&!name.split('/').some(p=>!p||p==='.'||p==='..'));}
 return config;
}
export async function credential(config){
 const value=JSON.parse(await readPrivate(config.credential_file));assert.equal(value.schema_version,1);assert.equal(value.endpoint,config.endpoint);assert.deepEqual(value.scope,config.scope);
 assert(Date.parse(value.expires_at)>Date.now()+30000,'Credential expires too soon; issuer must atomically renew the file');assert(typeof value.token==='string'&&value.token&&!/[\r\n]/.test(value.token));return value.token;
}
export function observerCounters(value,backend){
 assert.equal(value.backend_identity,backend);assert.equal(value.real_s3,true);
 for(const key of ['persisted_revisions','storage_requests','storage_bytes','hydrated_bytes','cache_hits','cache_misses','queue_depth','lock_wait_ms','connection_count','publication_lag_ms'])assert(Number.isSafeInteger(value[key])&&value[key]>=0,'Missing measured observer counter '+key);
 return value;
}
