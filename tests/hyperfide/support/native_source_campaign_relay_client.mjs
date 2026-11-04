import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {readPrivate} from '../source-control/workloads/deployment.mjs';
import {stableOperation} from '../source-control/workloads/durable.mjs';
import {atomicJSON,canonical,digest,exactScope,jsonGet,privateDirectory,unpackEvidence} from '../source-control/workloads/mailbox.mjs';
const selected=JSON.parse(await readPrivate(process.env.HF_SOURCE_RELAY_CONFIG));assert.equal(selected.schema_version,1);
const manifest=JSON.parse(await readPrivate(selected.manifest_file)),scope=JSON.parse(process.env.HF_SOURCE_CAMPAIGN_SCOPE);assert.deepEqual(manifest.scope,scope);assert(Date.parse(manifest.expires_at)>Date.now());
const output=process.env.HF_SOURCE_CAMPAIGN_RESULT;assert(path.isAbsolute(output));assert(path.isAbsolute(selected.state_file));assert(Number.isSafeInteger(selected.timeout_seconds)&&selected.timeout_seconds>0&&selected.timeout_seconds<=600);
const operation=process.env.HF_SOURCE_CAMPAIGN_OPERATION_ID??stableOperation(manifest.prefix,selected.kind,output);
await privateDirectory(path.dirname(selected.state_file));const stateStat=await fs.lstat(selected.state_file).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});if(stateStat)assert(stateStat.isFile()&&!stateStat.isSymbolicLink()&&stateStat.nlink===1&&stateStat.uid===process.getuid()&&!(stateStat.mode&0o077));const database=new DatabaseSync(selected.state_file);await fs.chmod(selected.state_file,0o600);
database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS jobs(operation_id TEXT PRIMARY KEY,job_id TEXT NOT NULL UNIQUE,request TEXT NOT NULL); CREATE TABLE IF NOT EXISTS binding(identity TEXT PRIMARY KEY)');
const identity=canonical({prefix:manifest.prefix,scope:manifest.scope,deployment_identity:manifest.deployment_identity});const prior=database.prepare('SELECT identity FROM binding').get();if(prior)assert.equal(prior.identity,identity);else database.prepare('INSERT INTO binding VALUES(?)').run(identity);
let binding=database.prepare('SELECT * FROM jobs WHERE operation_id=?').get(operation);
try{
 if(!binding){const slot=manifest.slots.find(item=>item.kind===selected.kind&&!database.prepare('SELECT 1 FROM jobs WHERE job_id=?').get(item.id));assert(slot,'No remaining authorized mailbox slots');const input=selected.input_file?JSON.parse(await readPrivate(selected.input_file)):{};const request={schema_version:1,job_id:slot.id,nonce:slot.nonce,scope,deployment_identity:manifest.deployment_identity,operation_id:operation,submitted_at:new Date().toISOString(),input};const raw=canonical(request);assert(Buffer.byteLength(raw)<=65536);database.prepare('INSERT INTO jobs VALUES(?,?,?)').run(operation,slot.id,raw);binding={job_id:slot.id,request:raw};}
 const slot=manifest.slots.find(item=>item.id===binding.job_id);assert(slot&&slot.kind===selected.kind);const hash=digest(binding.request);
 let response=await jsonGet(slot.response_get_url,25165824);
 if(!response){const sent=await fetch(slot.request_put_url,{method:'PUT',headers:{'if-none-match':'*'},body:binding.request,redirect:'error',signal:AbortSignal.timeout(30000)});assert([200,201,204,412].includes(sent.status),'Mailbox request upload failed');await sent.body?.cancel();}
 const until=Date.now()+selected.timeout_seconds*1000;
 while(!response&&Date.now()<until){await delay(500);response=await jsonGet(slot.response_get_url,25165824);}
 assert(response,'Mailbox controller response timed out; retain the original operation');exactScope(response,manifest);assert.equal(response.job_id,slot.id);assert.equal(response.request_sha256,hash);assert.equal(response.status,'COMPLETE',response.error??'Mailbox job did not complete');assert.equal(response.result.status,'PASS');assert.deepEqual(response.result.scope,scope);
 await privateDirectory(path.dirname(output));await unpackEvidence(path.dirname(output),response.files);await atomicJSON(output,response.result);
}finally{database.close();}
