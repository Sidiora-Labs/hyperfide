import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../../..');
const args=process.argv.slice(2);
if(args.length!==4||args[0]!=='--context'||args[2]!=='--cli')throw new Error('Use --context PATH --cli PATH');
const context=path.resolve(args[1]),cli=path.resolve(args[3]),seedRoot=path.join(root,'build/fleet/seed');
if(!context.startsWith(seedRoot+path.sep)||!cli.startsWith(seedRoot+path.sep))throw new Error('Seed inputs must be inside the isolated build root');
const digest=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const receipt=JSON.parse(await fs.readFile(path.join(seedRoot,'prepared-receipt.json'),'utf8'));
if(receipt.context!==context||!/^hf-fleet-prereq-seed-[a-f0-9]{12}$/.test(receipt.resource_name))throw new Error('Prepared context or resource identity differs');
const manifestBytes=await fs.readFile(path.join(context,'payload/opt/hyperfide/seed-manifest.json'));
if(digest(manifestBytes.subarray(0,manifestBytes.length-1))!==receipt.manifest_digest)throw new Error('Seed manifest differs');
const manifest=JSON.parse(manifestBytes.toString('utf8'));
for(const item of manifest.files){
 const file=path.resolve(context,'payload',item.path);
 if(!file.startsWith(path.join(context,'payload')+path.sep))throw new Error('Seed path escapes payload');
 const stat=await fs.lstat(file);
 if(item.mode==='symlink'){
  if(!stat.isSymbolicLink()||await fs.readlink(file)!==item.target)throw new Error('Seed link differs');
 }else if(!stat.isFile()||stat.size!==item.size||'0o'+(stat.mode&0o777).toString(8)!==item.mode||digest(await fs.readFile(file))!==item.digest)throw new Error('Seed file differs');
}
const input={manifest_digest:receipt.manifest_digest,dockerfile_digest:digest(await fs.readFile(path.join(context,'Dockerfile'))),configuration_digest:digest(await fs.readFile(path.join(context,'blaxel.toml')))};
const buildInputDigest=digest(JSON.stringify(input)),tag=buildInputDigest.slice(7,39),operationFile=path.join(seedRoot,'push-operation.json');
const operation={schema_version:1,resource_name:receipt.resource_name,tag,build_input_digest:buildInputDigest,preparation_reference:'sandbox/'+receipt.resource_name+':'+tag,input,status:'BUILD_REQUESTED',started_at:new Date().toISOString(),deadline_at:new Date(Date.now()+1200000).toISOString(),build_memory_mib:4096,build_volume_mib:0,cleanup:{owner:'fleet-prerequisite',image_reference:'sandbox/'+receipt.resource_name+':'+tag,retain_until:'prerequisite-execution-completes'}};
await fs.writeFile(operationFile,JSON.stringify(operation,null,2)+'\n',{flag:'wx',mode:0o600});
const key=process.env.BL_API_KEY??process.env.BLAXEL_API_KEY,workspace=process.env.BL_WORKSPACE??process.env.BLAXEL_WORKSPACE;
if(!key||!workspace)throw new Error('Configured Blaxel key and workspace required');
const home=await fs.mkdtemp(path.join(os.tmpdir(),'hyperfide-seed-cli-'));
const log=await fs.open(path.join(seedRoot,'push.log'),'wx',0o600);
let outputBytes=0,terminated=false,writes=Promise.resolve();
try{
 const exitCode=await new Promise((resolve,reject)=>{
  const child=spawn(cli,['push','--yes','--skip-version-warning','--type','sandbox','--name',receipt.resource_name,'--tag',tag,'--directory',context,'--timeout','1200s','--memory','4096','--volume','0','--output','json'],{cwd:context,env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:home,BL_WORKSPACE:workspace,BL_API_KEY:key,BL_INSTALL_SKILLS:'false',BL_INSTALL_SETUP:'false',CI:'true'},stdio:['ignore','pipe','pipe']});
  let killTimer;
  const stop=()=>{terminated=true;child.kill('SIGTERM');killTimer=setTimeout(()=>child.kill('SIGKILL'),1000);};
  const timer=setTimeout(stop,1200000);
  const write=bytes=>{outputBytes+=bytes.length;if(outputBytes>33554432)stop();else writes=writes.then(()=>log.write(bytes)).catch(stop);};
  child.stdout.on('data',write);child.stderr.on('data',write);
  child.once('error',error=>{clearTimeout(timer);if(killTimer)clearTimeout(killTimer);reject(error);});
  child.once('close',code=>{clearTimeout(timer);if(killTimer)clearTimeout(killTimer);resolve(code);});
 });
 operation.status=exitCode===0&&!terminated?'PUSH_COMPLETED':'OUTCOME_UNKNOWN';operation.exit_code=exitCode;
}catch{operation.status='OUTCOME_UNKNOWN';operation.exit_code=null;}
finally{await writes;await log.sync();await log.close();await fs.rm(home,{recursive:true,force:true});}
operation.finished_at=new Date().toISOString();
await fs.writeFile(operationFile,JSON.stringify(operation,null,2)+'\n',{mode:0o600});
process.stdout.write(JSON.stringify({status:operation.status,resource_name:operation.resource_name,tag,exit_code:operation.exit_code})+'\n');
if(operation.status!=='PUSH_COMPLETED')process.exitCode=1;
