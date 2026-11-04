import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import {readPrivate,deploymentConfig,credential,observerCounters} from '../source-control/workloads/deployment.mjs';
import {campaignManifest,machineIdentity,runCampaignHook} from '../source-control/workloads/campaign.mjs';
import {verifyArtifacts,artifact} from '../source-control/workloads/artifacts.mjs';
import {reloadingSignedClient} from '../source-control/workloads/signed_client.mjs';
const plan=campaignManifest(JSON.parse(await readPrivate(process.env.HF_SOURCE_WORKLOAD_MANIFEST))),config=deploymentConfig(JSON.parse(await readPrivate(process.env.HF_SOURCE_WORKLOAD_CONFIG)),plan),directory=config.output_directory;
const receipt=JSON.parse(await readPrivate(path.join(directory,'receipt.json'))),cleanup=JSON.parse(await readPrivate(path.join(directory,'cleanup.json')));
assert.equal(receipt.status,'PASS');assert.equal(cleanup.status,'PASS');assert.equal(cleanup.open_intents.length,0);assert.equal(cleanup.open_workspaces.length,0);assert.deepEqual(receipt.manifest,plan);assert.deepEqual(receipt.source_scope,config.scope);assert.equal(receipt.machine.digest,plan.hardware_digest);assert.equal(machineIdentity().digest,plan.hardware_digest);
await verifyArtifacts(directory,receipt.artifacts);
const state=new DatabaseSync(path.join(directory,'campaign-state.sqlite'),{readOnly:true});try{assert.equal(JSON.parse(state.prepare("SELECT value FROM meta WHERE key='status'").get().value),'PASS');const binding=JSON.parse(state.prepare("SELECT value FROM meta WHERE key='binding'").get().value);assert.deepEqual(binding,{plan,scope:config.scope,endpoint:config.endpoint,deployment_identity:config.deployment_identity,corpora:config.corpora});assert.equal(state.prepare('SELECT count(*) AS n FROM workspaces WHERE closed=0').get().n,0);}finally{state.close();}
const {SourceControlClient}=await import(pathToFileURL(path.join(process.env.SOURCE_CONTROL_SDK_MODULE_ROOT,'client.js')));
const client=config.signed_config_file?await reloadingSignedClient(config,{sdkRoot:process.env.SOURCE_CONTROL_SDK_MODULE_ROOT,signal:()=>new AbortController().signal,observe:async()=>{},credentialVersion:()=>{}}):new SourceControlClient({endpoint:config.endpoint,scope:config.scope,token:()=>credential(config)});
await client.capabilities();let verifiedRevisions=0;
for(const result of receipt.results){
 const database=new DatabaseSync(result.ledger+'.sqlite',{readOnly:true});try{
  assert.equal(database.prepare('SELECT count(*) AS n FROM operations').get().n,plan.operations);assert.equal(database.prepare('SELECT count(*) AS n FROM revisions').get().n,result.measurements.new_revisions);assert.equal(database.prepare('SELECT count(*) AS n FROM ledger_events WHERE acknowledged=0 AND interrupted=0').get().n,0);
  observerCounters(result.server_before.value,plan.backend_identity,config.deployment_identity);observerCounters(result.server_after.value,plan.backend_identity,config.deployment_identity);
  const rows=database.prepare('SELECT day,sum(new_revision) AS n FROM ledger_events GROUP BY day').all(),days=[0,0,0,0];for(const row of rows)if(row.day>=0&&row.day<4)days[row.day]=row.n;assert.deepEqual(days,result.measurements.daily_new_revisions);
  if(plan.kind==='endurance'){assert(days.slice(0,3).every(value=>value>=100000));assert(result.measurements.elapsed_ms>=259200000);}
  if(plan.kind==='admission'){assert.equal(result.measurements.logical_opens,20000000);assert(result.measurements.elapsed_ms<=86400000);}
  if(result.measurements.checkpoint_rpc_ms){const n=database.prepare('SELECT count(*) AS n FROM ledger_events WHERE checkpoint_ms IS NOT NULL').get().n;const exact=database.prepare('SELECT checkpoint_ms AS ms FROM ledger_events WHERE checkpoint_ms IS NOT NULL ORDER BY checkpoint_ms LIMIT 1 OFFSET ?').get(Math.ceil(n*.95)-1).ms;assert(exact<=result.measurements.checkpoint_rpc_ms.p95+1e-6);assert(result.measurements.checkpoint_rpc_ms.p95<=config.budgets.max_checkpoint_p95_ms);}
  assert.equal(database.prepare("SELECT value FROM ledger_meta WHERE key='journal_sequence'").get().value,database.prepare('SELECT max(sequence) AS n FROM ledger_events').get().n);
  let batch=[];for(const row of database.prepare('SELECT id FROM revisions ORDER BY id').iterate()){batch.push(row.id);if(batch.length===8){await Promise.all(batch.map(async id=>assert.equal((await client.revision(id)).revision_id,id)));verifiedRevisions+=batch.length;batch=[];}}if(batch.length){await Promise.all(batch.map(async id=>assert.equal((await client.revision(id)).revision_id,id)));verifiedRevisions+=batch.length;}
 }finally{database.close();}
 if(['mixed','endurance'].includes(plan.kind)){
  assert.equal(result.query_ledger,path.join(directory,'queries-'+result.logical_files+'.jsonl'));
  const queries=new DatabaseSync(result.query_ledger+'.sqlite',{readOnly:true});try{
   assert.equal(queries.prepare('SELECT count(*) AS n FROM operations').get().n,plan.operations*2);
   assert.equal(queries.prepare('SELECT count(*) AS n FROM ledger_events WHERE acknowledged=0 AND interrupted=0').get().n,0);
   assert.equal(queries.prepare('SELECT count(*) AS n FROM revisions').get().n,0);
   const counts=new Map();let bytes=0;
   for(const row of queries.prepare('SELECT body FROM ledger_events ORDER BY sequence').iterate()){
    const event=JSON.parse(row.body);if(['INTERRUPTED','OUTCOME_UNKNOWN'].includes(event.status))continue;assert(['source.queries.history','source.queries.diff'].includes(event.action));assert(Number.isSafeInteger(event.result_bytes)&&event.result_bytes>=0);bytes+=event.result_bytes;counts.set(event.action,(counts.get(event.action)??0)+1);
   }
   assert.equal(counts.get('source.queries.history'),plan.operations);assert.equal(counts.get('source.queries.diff'),plan.operations);
   assert.equal(result.query_measurements.acknowledged,plan.operations*2);assert(result.query_measurements.submitted>=plan.operations*2);assert.equal(result.query_measurements.rejected,0);
   assert.equal(queries.prepare("SELECT value FROM ledger_meta WHERE key='journal_sequence'").get().value,queries.prepare('SELECT max(sequence) AS n FROM ledger_events').get().n);
   assert(bytes>0,'Mixed metadata queries returned no measured result bytes');
  }finally{queries.close();}
 }
}
if(plan.kind==='growth'){const times=receipt.results.map(row=>row.measurements.checkpoint_rpc_ms.p95);assert(Math.max(...times)/Math.min(...times)<=config.budgets.max_growth_ratio);}
if(plan.kind==='mixed')assert(receipt.results.every(row=>row.measurements.observed_submission_rate>=plan.rate_per_second*.95));
for(const hook of receipt.hook_receipts){const bytes=await fs.readFile(hook.receipt_file);const actual=await artifact(hook.receipt_file,directory);assert.equal(actual.sha256,hook.receipt_sha256);const value=JSON.parse(bytes);assert.equal(value.status,'PASS');assert.deepEqual(value.scope,config.scope);await verifyArtifacts(directory,value.evidence);for(const id of value.worker_revision_ids??[])assert.equal((await client.revision(id)).revision_id,id);}
const observation=await runCampaignHook(config.observer,{scope:config.scope,outputDirectory:directory,ordinal:'completion-verification-'+Date.now()});const current=JSON.parse(await fs.readFile(observation.receipt_file,'utf8')).observations;observerCounters(current,plan.backend_identity,config.deployment_identity);assert(current.persisted_revisions>=receipt.observer_after.value.persisted_revisions);
const proof={schema_version:1,status:'PASS',kind:plan.kind,scope:config.scope,verified_at:new Date().toISOString(),verified_client_revisions:verifiedRevisions,receipt:await artifact(path.join(directory,'receipt.json'),directory),observer:observation};await fs.writeFile(path.join(directory,'verification.json'),JSON.stringify(proof,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(proof));
