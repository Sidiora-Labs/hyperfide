import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {readPrivate,deploymentIdentity} from '../source-control/workloads/deployment.mjs';
import {atomicJSON,digest,mailboxStorage,s3Configuration} from '../source-control/workloads/mailbox.mjs';
const config=JSON.parse(await readPrivate(process.argv[2]));
assert.equal(config.schema_version,1);deploymentIdentity(config.deployment_identity);assert(path.isAbsolute(config.directory));
assert(Number.isSafeInteger(config.lifetime_seconds)&&config.lifetime_seconds>=3600&&config.lifetime_seconds<=604800);
const storage=mailboxStorage(s3Configuration(process.env)),prefix='campaign-mailbox/v1/'+config.scope.repository_id+'/'+randomUUID(),slots=[];
for(const [kind,action]of Object.entries(config.actions)){
 assert(['observer','worker-canary','throttle','credential-rotation','collection','recovery'].includes(kind));assert(Number.isSafeInteger(action.slots)&&action.slots>0&&action.slots<=10000);assert(Array.isArray(action.argv)&&path.isAbsolute(action.argv[0]));assert(Number.isSafeInteger(action.timeout_seconds)&&action.timeout_seconds>0&&action.timeout_seconds<=600);
 action.code_pins={};for(const filename of new Set([action.argv[0],...(action.code_files??[])])){assert(path.isAbsolute(filename));const stat=await fs.lstat(filename);assert(stat.isFile()&&!stat.isSymbolicLink()&&!(stat.mode&0o022));action.code_pins[filename]=digest(await fs.readFile(filename));}
 for(let index=0;index<action.slots;index++){const id=randomUUID(),nonce=randomBytes(32).toString('base64url');slots.push({id,kind,nonce,request_put_url:storage.presign('PUT',prefix+'/requests/'+id,config.lifetime_seconds,true),response_get_url:storage.presign('GET',prefix+'/responses/'+id,config.lifetime_seconds)});}
}
assert(slots.length<=12000);await fs.mkdir(config.directory,{recursive:true,mode:0o700});
const common={schema_version:1,scope:config.scope,deployment_identity:config.deployment_identity,expires_at:new Date(Date.now()+config.lifetime_seconds*1000).toISOString(),prefix};
await atomicJSON(path.join(config.directory,'client.json'),{...common,slots});
await atomicJSON(path.join(config.directory,'controller.json'),{...common,directory:config.directory,actions:config.actions,jobs:slots.map(({id,kind,nonce})=>({id,kind,nonce})),poll_ms:config.poll_ms??1000,max_parallel:config.max_parallel??4});
console.log(JSON.stringify({status:'READY',directory:config.directory,slots:slots.length,expires_at:common.expires_at,prefix}));
