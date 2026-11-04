/** Pinned observer hook: captures actual deployment instrumentation, preserves raw evidence. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {readPrivate,observerCounters} from '../source-control/workloads/deployment.mjs';
const hash=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
const config=JSON.parse(await readPrivate(process.env.HF_SOURCE_OBSERVER_CONFIG));
const scope=JSON.parse(process.env.HF_SOURCE_CAMPAIGN_SCOPE);
assert.deepEqual(scope,config.scope);assert.equal(config.schema_version,1);
assert(Array.isArray(config.collector_argv)&&config.collector_argv.length>0);
const executable=config.collector_argv[0];assert(path.isAbsolute(executable));
const stat=await fs.lstat(executable);assert(stat.isFile()&&!stat.isSymbolicLink()&&!(stat.mode&0o022));
assert.equal(hash(await fs.readFile(executable)),config.collector_digest);
const env={PATH:process.env.PATH,LANG:'C',HF_SOURCE_CAMPAIGN_SCOPE:JSON.stringify(scope)};
for(const key of config.env_keys??[]){assert(typeof process.env[key]==='string');env[key]=process.env[key];}
const chunks=[],errors=[];let size=0;
await new Promise((resolve,reject)=>{
 const child=spawn(executable,config.collector_argv.slice(1),{env,stdio:['ignore','pipe','pipe']});
 const timer=setTimeout(()=>child.kill('SIGKILL'),(config.timeout_seconds??60)*1000);
 child.stdout.on('data',b=>{size+=b.length;if(size>16*1024*1024){child.kill('SIGKILL');return;}chunks.push(b);});
 child.stderr.on('data',b=>{if(Buffer.concat(errors).length<65536)errors.push(b);});
 child.on('error',reject);child.on('close',code=>{clearTimeout(timer);code===0&&size<=16*1024*1024?resolve():reject(new Error('Instrumentation collector failed with code '+code));});
});
const raw=Buffer.concat(chunks),measurement=JSON.parse(raw.toString('utf8'));
assert.deepEqual(measurement.scope,scope);
assert.equal(measurement.schema_version,1);
assert(typeof measurement.sampled_at==='string'&&Math.abs(Date.now()-Date.parse(measurement.sampled_at))<120000,'Stale instrumentation snapshot');
assert(Array.isArray(measurement.sources)&&measurement.sources.length>0,'Missing instrumentation provenance');
for(const source of measurement.sources){assert(typeof source.identity==='string'&&source.identity);assert(typeof source.kind==='string'&&source.kind);}
observerCounters(measurement.observations,config.backend_identity);
const sources=[...measurement.sources];
if(config.topology_file){const raw=await readPrivate(config.topology_file),topology=JSON.parse(raw);assert.deepEqual(topology.scope,scope);assert.deepEqual(topology.deployment_identity,measurement.observations.deployment_identity);sources.push({kind:'measured-topology',identity:config.topology_file,sha256:hash(raw)});}

const result=process.env.HF_SOURCE_CAMPAIGN_RESULT;assert(path.isAbsolute(result));
const evidencePath=path.basename(result)+'.instrumentation.json';
await fs.writeFile(path.join(path.dirname(result),evidencePath),raw,{mode:0o600,flag:'wx'});
await fs.writeFile(result,JSON.stringify({schema_version:1,status:'PASS',scope,observations:measurement.observations,sources,sampled_at:measurement.sampled_at,evidence:[{path:evidencePath,size:raw.length,sha256:hash(raw)}]})+'\n',{mode:0o600,flag:'wx'});
