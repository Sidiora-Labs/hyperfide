import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';

if(process.platform!=='linux'||process.getuid?.()!==0)throw Error('Linux root is required to exercise the actual UID22001 startup boundary');
const repo=fileURLToPath(new URL('../../../../',import.meta.url));
const root=fs.mkdtempSync('/tmp/hf-bootstrap-chunks-');
try {
 fs.chmodSync(root,0o755);
 const directory=path.join(root,'deploy/hyperfide/fleet-control');
 fs.mkdirSync(directory,{recursive:true,mode:0o755});
 const state=path.join(root,'state');
 fs.mkdirSync(state,{mode:0o700});fs.chownSync(state,22001,22001);
 const node=path.join(root,'node');
 fs.copyFileSync(process.execPath,node);fs.chmodSync(node,0o755);
 const entry=path.join(directory,'start.mjs');
 fs.copyFileSync(path.join(repo,'deploy/hyperfide/fleet-control/start.mjs'),entry);
 const bytes=Buffer.from('{}'),encoded=gzipSync(bytes).toString('base64');
 const digest='sha256:'+createHash('sha256').update(bytes).digest('hex');
 const prefix='HYPERFIDE_FLEET_CONTROL_BOOTSTRAP_B64';
 const base={
  [prefix+'_CHUNK_COUNT']:'2',
  [prefix+'_CHUNK_000']:encoded.slice(0,16),
  [prefix+'_CHUNK_001']:encoded.slice(16),
  HYPERFIDE_FLEET_CONTROL_BOOTSTRAP_SHA256:digest,
 };
 // An integrity-checked transport of {} must reach the existing schema rejection before writing any bootstrap files.
 const cases=[
  ['multi',base,'CONTROL_BOOTSTRAP_SCHEMA'],
  ['legacy',{[prefix]:encoded,HYPERFIDE_FLEET_CONTROL_BOOTSTRAP_SHA256:digest},'CONTROL_BOOTSTRAP_SCHEMA'],
  ['missing',{...base,[prefix+'_CHUNK_001']:''},'CONTROL_BOOTSTRAP_CHUNKS'],
  ['ambiguous',{...base,[prefix]:encoded},'CONTROL_BOOTSTRAP_CHUNKS'],
  ['extra',{...base,[prefix+'_CHUNK_002']:'AAAA'},'CONTROL_BOOTSTRAP_CHUNKS'],
  ['malformed',{...base,[prefix+'_CHUNK_001']:'!'},'CONTROL_BOOTSTRAP_DIGEST'],
  ['count',{...base,[prefix+'_CHUNK_COUNT']:'44'},'CONTROL_BOOTSTRAP_CHUNKS'],
 ];
 for(const[name,env,want]of cases){
  const result=spawnSync(node,[entry],{uid:22001,gid:22001,env:{PATH:'/usr/bin:/bin',...env},encoding:'utf8',timeout:10000});
  if(result.error)throw result.error;
  const events=result.stderr.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  const code=events.at(-1)?.code;
  if(result.status!==78||code!==want)throw Error(name+': '+JSON.stringify({exit:result.status,code}));
 }
 console.log(JSON.stringify({status:'PASS',checks:cases.length,scope:'ACTUAL_START_ENTRY_ENV_TRANSPORT_BEFORE_SCHEMA_OR_AUTHORITY'}));
} finally {
 fs.rmSync(root,{recursive:true});
}
