import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import http from 'node:http';
import {spawn,spawnSync} from 'node:child_process';
import {createNativeAcceptanceFixture} from './native_source_acceptance_fixture.mjs';
const f=await createNativeAcceptanceFixture({actions:['source.capabilities','source.domains.create','source.objects.put','source.objects.read','source.trees.patch','source.trees.entries','source.trees.lookup','source.revisions.create','source.revisions.read']});
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'source-corpus-'));
let server;
try{
 const key=path.join(directory,'key.pem'),cert=path.join(directory,'cert.pem');
 assert.equal(spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],{stdio:'ignore'}).status,0);
 server=https.createServer({key:await fs.readFile(key),cert:await fs.readFile(cert)},(req,res)=>{
  const upstream=http.request(f.endpoint,{method:req.method,headers:req.headers},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);});upstream.on('error',error=>res.destroy(error));req.pipe(upstream);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const endpoint='https://localhost:'+server.address().port;
 const credential_file=path.join(directory,'credential.json'),config=path.join(directory,'config.json');
 await fs.writeFile(credential_file,JSON.stringify({schema_version:1,endpoint,scope:f.scope,token:f.tokenFor(),expires_at:new Date(Date.now()+3600000).toISOString()}),{mode:0o600});
 await fs.writeFile(config,JSON.stringify({schema_version:1,isolated_scope:true,endpoint,scope:f.scope,credential_file,output_directory:directory,backend_identity:'owned-component-s3',file_counts:[110,1010],unique_contents:3,history_depth:2}),{mode:0o600});
 const run=()=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[path.resolve('tests/hyperfide/support/native_source_campaign_prepare.mjs')],{env:{...process.env,NODE_EXTRA_CA_CERTS:cert,HF_SOURCE_PREPARE_CONFIG:config},stdio:['ignore','pipe','pipe']});let output='';child.stderr.on('data',b=>output+=b);child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error(output)));});
 await run();
 const first=JSON.parse(await fs.readFile(path.join(directory,'prepared-corpora.json'),'utf8'));
 assert.deepEqual(first.corpora.map(c=>c.logical_files),[110,1010]);assert.deepEqual(first.corpora[0].edit_paths,first.corpora[1].edit_paths);assert.equal(first.measurements.unique_content_objects,3);assert(first.corpora.every(c=>c.history_revision_ids.length===2));
 const before=(await f.pool.query('SELECT count(*)::int AS n FROM hyperfide.source_revisions')).rows[0].n;
 await run();
 assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM hyperfide.source_revisions')).rows[0].n,before,'Resuming preparation must not append duplicate revisions');
 console.log(JSON.stringify({status:'PASS',checks:['real HTTPS source API corpus creation and paginated cardinality','common edit paths and distinct content/history','resumed preparation preserves acknowledged revisions']}));
}finally{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await f.close();await fs.rm(directory,{recursive:true,force:true});}
