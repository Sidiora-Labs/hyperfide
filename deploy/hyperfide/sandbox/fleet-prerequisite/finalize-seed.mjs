import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../../..');
const args=process.argv.slice(2);
if(![2,3].includes(args.length)||args[0]!=='--inputs'||args.length===3&&args[2]!=='--push')throw new Error('Use --inputs PATH [--push]');
const input=JSON.parse(await fs.readFile(args[1],'utf8'));
const digest=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
for(const [file,expected] of [[input.claude_binary,'sha256:'+input.claude_sha256],[path.join(input.node_root,'bin/node'),input.node_digest],[input.python_manifest,input.python_manifest_file_digest],[input.source_inputs,input.source_inputs_digest],[input.cli,input.cli_digest]])if(digest(await fs.readFile(file))!==expected)throw new Error('Final build input changed');
const run=(executable,argv)=>{const child=spawnSync(executable,argv,{cwd:root,env:process.env,stdio:'inherit'});if(child.error||child.status!==0)throw new Error('Final seed stage failed');};
const seedRoot=path.join(root,'build/fleet/seed'),oldOperation=path.join(seedRoot,'push-operation.json');
try{
 const previous=JSON.parse(await fs.readFile(oldOperation,'utf8'));
 if(!['PUSH_COMPLETED','CONFIRMED_REJECTED'].includes(previous.status))throw new Error('Reconcile the previous image operation before final staging');
 const archive=path.join(seedRoot,'toolchain-build');await fs.mkdir(archive,{mode:0o700});
 for(const name of ['push-operation.json','push.log','push-status.log','prepared-receipt.json','catalogue-receipt.json','catalogue-readback.json'])try{await fs.rename(path.join(seedRoot,name),path.join(archive,name));}catch(error){if(error.code!=='ENOENT')throw error;}
}catch(error){if(error.code!=='ENOENT')throw error;}
const script=path.join(root,'deploy/hyperfide/sandbox/fleet-prerequisite/prepare-seed.py');
const common=['--node-root',input.node_root,'--base-images',input.base_images,'--resource-plan',input.resource_plan,'--claude',input.claude_binary,'--claude-sha256',input.claude_sha256,'--python-root',input.python_root];
run('python3',[script,...common,'--output',input.runtime_context]);
const preparedFile=path.join(seedRoot,'prepared-receipt.json'),runtimeReceipt=path.join(seedRoot,'runtime-prepared-receipt.json');await fs.copyFile(preparedFile,runtimeReceipt);
run(process.execPath,[path.join(root,'deploy/hyperfide/sandbox/fleet-prerequisite/declare-profile.mjs'),'--source-inputs',input.source_inputs,'--seed-context',input.runtime_context,'--prepared-receipt',runtimeReceipt,'--output',input.declaration_output,'--authority-origin',input.authority_origin]);
run('python3',[script,...common,'--output',input.final_context,'--preparation-candidate',path.join(input.declaration_output,'candidate')]);
const readManifest=async context=>JSON.parse(await fs.readFile(path.join(context,'payload/opt/hyperfide/seed-manifest.json'),'utf8'));
const before=await readManifest(input.runtime_context),after=await readManifest(input.final_context),byPath=new Map(after.files.map(file=>[file.path,file]));
for(const file of before.files)if(JSON.stringify(file)!==JSON.stringify(byPath.get(file.path)))throw new Error('Runtime artifacts changed between staging and final preparation');
if(args.includes('--push'))run(process.execPath,[path.join(root,'deploy/hyperfide/sandbox/fleet-prerequisite/push-seed.mjs'),'--context',input.final_context,'--cli',input.cli]);
process.stdout.write(JSON.stringify({status:args.includes('--push')?'PUSH_FINISHED':'FINAL_CONTEXT_PREPARED',profile_registration:path.join(input.declaration_output,'profile-registration.json'),context:input.final_context})+'\n');
