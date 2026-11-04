import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {createNativeAcceptanceFixture} from './native_source_acceptance_fixture.mjs';
try {process.loadEnvFile(path.resolve('.env'));}catch(error){if(error.code!=='ENOENT')throw error;}
const {S3SourceObjectBackend,sourceS3Configuration}=await import(pathToFileURL(path.join(process.env.SOURCE_CONTROL_MODULE_ROOT,'s3.js')));
const f=await createNativeAcceptanceFixture({serviceOptions:{backend:new S3SourceObjectBackend(sourceS3Configuration(process.env))}});
const output=path.resolve('build/source-control/sparse-live');await fs.mkdir(output,{recursive:true});
const profile=path.join(process.env.SOURCE_CONTROL_MODULE_ROOT,'sparse-profile.json');
try {
 await fs.writeFile(profile,JSON.stringify({endpoint:f.endpoint,scope:f.scope,token:f.tokenFor()}),{mode:0o600});
 const child=spawn('python3',[path.resolve('tests/hyperfide/cases/source_control/2_2.py')],{env:{...process.env,HYPERFIDE_SOURCE_CONTROL_TEST_PROFILE:profile},stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
 await fs.writeFile(path.join(output,'host.log'),stdout+stderr);
 assert.equal(code,0,stdout+stderr);
 const report=JSON.parse(stdout.trim().split('\n').at(-1));assert.equal(report.qualification_level,'REAL_SOURCE_SERVICE_AND_HOST_FILESYSTEM');
 const rows=(await f.pool.query('SELECT checkpoint_revision_id FROM hyperfide.source_workspaces WHERE checkpoint_revision_id IS NOT NULL')).rows;assert.equal(rows.length,1);
 const revision=await f.client.revision(rows[0].checkpoint_revision_id);
 const hidden=await f.service.trees.lookup(f.scope,revision.root_tree_id,'omitted/hidden.txt');assert(hidden);
 assert.equal((await f.service.objects.readFile(f.scope,hidden.object_id)).toString(),'must survive sparse checkpoint\n');
 const edited=await f.service.trees.lookup(f.scope,revision.root_tree_id,'src/a.txt');assert(edited);
 assert.equal((await f.service.objects.readFile(f.scope,edited.object_id)).toString(),'captured checkpoint\n');
 const removed=await f.service.trees.lookup(f.scope,revision.root_tree_id,'src/new.txt');assert.equal(removed,null);
 const checks=['independent native revision and object readback preserve omitted bytes, committed edits and explicit deletion'];
 const receipt={...report,checks,backend:'REAL_S3',scope:f.scope,checkpoint_revision_id:revision.revision_id,host_platform:process.platform};
 await fs.writeFile(path.join(output,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt,null,2));
}finally {
 const placements=(await f.pool.query('SELECT object_id,incarnation_id,storage_key,state FROM hyperfide.source_object_placements WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3',Object.values(f.scope))).rows;
 await fs.writeFile(path.join(output,'retained-placements.json'),JSON.stringify({scope:f.scope,placements},null,2)+'\n');
 await f.close();
}
