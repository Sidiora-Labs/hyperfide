#!/usr/bin/env node
/* Release fence driver for the first authority epoch. It builds the live
 * provider topology from protected configuration (or, when the isolation
 * configuration has scope GREENFIELD, the greenfield topology of an empty
 * deployment), verifies an operator-signed isolation permit, and never reads a
 * signing key. Every mode follows the configured scope. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {constants} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
const ownRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function refuse(code){throw Object.assign(new Error(code),{code});}
async function driver(){
 let module=path.join(ownRoot,'services/dist/recovery/bootstrap_fence.js');
 try{await fs.access(module);}catch{module=path.join(ownRoot,'services/hyperfide/dist/recovery/bootstrap_fence.js');}
 return import(pathToFileURL(module).href);
}
/** Called by migrate.mjs --activate-authority with the control resources and the activation request. */
export async function createBootstrapFenceArguments(resources,request){
 if(!request||typeof request!=='object'||!uuid.test(request.operation_id??'')||!uuid.test(request.deployment_id??''))refuse('BOOTSTRAP_FENCE_CONFIG');
 return (await driver()).createBootstrapFenceArguments(process.env,{resources,request:{deployment_id:request.deployment_id,operation_id:request.operation_id}});
}
async function privateDirectory(name){
 if(!name||!path.isAbsolute(name)||path.resolve(name)!==name)refuse('BOOTSTRAP_FENCE_ARGUMENTS');
 const st=await fs.lstat(name);if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==process.getuid?.()||(st.mode&0o077)!==0||await fs.realpath(name)!==name)refuse('BOOTSTRAP_FENCE_OUTPUT_UNSAFE');
 return name;
}
async function readBounded(name,limit){
 if(!name||!path.isAbsolute(name))refuse('BOOTSTRAP_FENCE_ARGUMENTS');
 const h=await fs.open(name,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const st=await h.stat();if(!st.isFile()||st.size<1||st.size>limit)refuse('BOOTSTRAP_FENCE_ARGUMENTS');return await h.readFile();}finally{await h.close();}
}
async function writePrivate(name,bytes){
 const h=await fs.open(name,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try{await h.writeFile(bytes);await h.sync();}finally{await h.close();}
}
async function main(argv){
 const modes=['--topology','--permit-payload','--seal-permit','--verify-permit'],values=['--operation-id','--key-id','--ttl-seconds','--output-dir','--payload','--signature','--output'];
 let mode;const o={};
 for(let i=0;i<argv.length;i++){
  if(modes.includes(argv[i])){if(mode)refuse('BOOTSTRAP_FENCE_ARGUMENTS');mode=argv[i];continue;}
  if(!values.includes(argv[i])||o[argv[i]]!==undefined||!argv[i+1])refuse('BOOTSTRAP_FENCE_ARGUMENTS');o[argv[i]]=argv[++i];
 }
 const allowed={'--topology':[],'--permit-payload':['--operation-id','--key-id','--ttl-seconds','--output-dir'],'--seal-permit':['--operation-id','--key-id','--payload','--signature','--output'],'--verify-permit':['--operation-id']}[mode];
 if(!allowed||Object.keys(o).some(k=>!allowed.includes(k))||allowed.some(k=>k!=='--ttl-seconds'&&o[k]===undefined)||o['--operation-id']!==undefined&&!uuid.test(o['--operation-id']))refuse('BOOTSTRAP_FENCE_ARGUMENTS');
 const d=await driver(),env=process.env;
 if(mode==='--topology'){const t=await d.bootstrapFenceTopology(env);return {topology_digest:t.topology_digest,consistent:t.consistent,topology:t.topology};}
 if(mode==='--permit-payload'){
  const ttl=o['--ttl-seconds']===undefined?900:/^[0-9]{1,5}$/.test(o['--ttl-seconds'])?Number(o['--ttl-seconds']):refuse('BOOTSTRAP_FENCE_ARGUMENTS');
  const dir=await privateDirectory(o['--output-dir']),p=await d.isolationPermitPayload(env,{operation_id:o['--operation-id'],key_id:o['--key-id'],ttl_seconds:ttl});
  await writePrivate(path.join(dir,'permit.payload'),p.payload);await writePrivate(path.join(dir,'permit.signing-input'),p.signing_input);
  return {payload_file:path.join(dir,'permit.payload'),signing_input_file:path.join(dir,'permit.signing-input'),key_id:o['--key-id'],topology_digest:p.topology_digest,claims:p.claims};
 }
 const derived=await d.bootstrapFenceTopology(env),expected=d.bootstrapPermitExpectation(derived,o['--operation-id']);
 if(mode==='--seal-permit'){
  const envelope=Buffer.from(d.sealIsolationPermit(o['--key-id'],await readBounded(o['--payload'],65536),await readBounded(o['--signature'],64)),'utf8');
  const permit=await d.verifyBootstrapPermit(env,expected,envelope);
  if(!path.isAbsolute(o['--output']))refuse('BOOTSTRAP_FENCE_ARGUMENTS');await privateDirectory(path.dirname(o['--output']));await writePrivate(o['--output'],envelope);
  return {permit_file:o['--output'],permit_digest:permit.permit_digest,expires_at:permit.expires_at};
 }
 const permit=await d.verifyBootstrapPermit(env,expected);
 return {permit_digest:permit.permit_digest,issuer_key_id:permit.issuer_key_id,topology_digest:permit.topology_digest,expires_at:permit.expires_at};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{process.stdout.write(JSON.stringify({ok:true,...await main(process.argv.slice(2))})+'\n');}
 catch(error){const code=typeof error?.code==='string'&&/^[A-Z0-9_]{1,128}$/.test(error.code)?error.code:'BOOTSTRAP_FENCE_FAILED';process.stdout.write(JSON.stringify({ok:false,error:{code}})+'\n');process.exitCode=1;}
}
