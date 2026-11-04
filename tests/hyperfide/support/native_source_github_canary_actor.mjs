import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import {runHostedSourceCanary} from './native_source_hosted_canary.mjs';
const inventory=process.env.HF_CANARY_INVENTORY?JSON.parse(await fs.readFile(process.env.HF_CANARY_INVENTORY,'utf8')):null;
const repository=inventory?.resource.repository??process.env.HF_CANARY_GITHUB_REPOSITORY;
assert.match(repository,/^[A-Za-z0-9-]+\/hyperfide-source-canary-[A-Za-z0-9-]+$/);
const command=args=>{const result=spawnSync('gh',args,{encoding:'utf8',maxBuffer:1048576});assert.equal(result.status,0,'GitHub command failed');return result.stdout.trim();};
const profile=JSON.parse(command(['api','repos/'+repository]));assert.equal(profile.private,true);assert.equal(profile.owner.login.toLowerCase(),command(['api','user','--jq','.login']).toLowerCase());
if(inventory){assert.equal(inventory.schema_version,1);assert.equal(inventory.resource.id,'github-canary');assert.equal(inventory.resource.provider,'github');assert.equal(inventory.resource.repository_id,profile.id);assert.equal(inventory.resource.owner,profile.owner.login);assert.equal(inventory.private,true);assert.equal(inventory.expected_initial_head,null);assert.equal(inventory.remote,profile.clone_url);}
const expiry=inventory?.resource.expiry??process.env.HF_CANARY_RESOURCE_EXPIRY;
if(expiry!==undefined)assert(Number.isFinite(Date.parse(expiry))&&Date.parse(expiry)>Date.now(),'Canary retention expiry must be in the future');
await fs.mkdir('build/source-control/github-canary',{recursive:true});await fs.writeFile('build/source-control/github-canary/inventory.json',JSON.stringify({repository,private:true,owner:profile.owner.login,retained:true,...(expiry?{expiry}:{})},null,2)+'\n');
const token=command(['auth','token']);
await runHostedSourceCanary({provider:'github',repository,remote:'https://github.com/'+repository+'.git',authorization:'Basic '+Buffer.from('x-access-token:'+token).toString('base64'),...(expiry?{resource:{...(inventory?.resource??{id:'github-canary',owner:profile.owner.login,expiry,repository}),status:'retained'}}:{})});
