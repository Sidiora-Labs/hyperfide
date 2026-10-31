import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../../',import.meta.url)),state=path.join(root,'state'),uid=22001;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function refuse(code){throw Object.assign(new Error(code),{code});}
async function machineIdentity(){
 let existing;try{existing=await fs.readFile('/etc/machine-id','utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
 if(typeof existing==='string'&&/^[0-9a-f]{32}\n?$/.test(existing)&&!/^(0{32}|f{32})\n?$/.test(existing))return 'existing-os';
 const replica=process.env.RAILWAY_REPLICA_ID;if(!uuid.test(replica??'')||process.getuid?.()!==0)refuse('CONTROL_MACHINE_IDENTITY_REQUIRED');
 const temporary='/etc/.hyperfide-machine-id-'+randomUUID(),file=await fs.open(temporary,'wx',0o444);
 try{await file.writeFile(replica.replaceAll('-','')+'\n');await file.sync();}finally{await file.close();}
 await fs.rename(temporary,'/etc/machine-id');return 'railway-replica-id';
}
async function main(){
 const isRailway=Boolean(process.env.RAILWAY_SERVICE_ID),replica=process.env.RAILWAY_REPLICA_ID;
 let mounted=false;
 if(isRailway){
  if(!uuid.test(process.env.HYPERFIDE_FLEET_CONTROL_SERVICE_ID??'')||process.env.HYPERFIDE_FLEET_CONTROL_SERVICE_ID!==process.env.RAILWAY_SERVICE_ID||!process.env.HYPERFIDE_FLEET_CONTROL_VOLUME_NAME||process.env.HYPERFIDE_FLEET_CONTROL_VOLUME_NAME!==process.env.RAILWAY_VOLUME_NAME||process.env.RAILWAY_VOLUME_MOUNT_PATH!==state)refuse('CONTROL_VOLUME_SCOPE_MISMATCH');
  mounted=(await fs.readFile('/proc/self/mountinfo','utf8')).split('\n').some(line=>line.split(' ')[4]===state);if(!mounted)refuse('CONTROL_VOLUME_MOUNT_REQUIRED');
 }
 if(process.getuid?.()===0&&(!isRailway||!mounted))refuse('CONTROL_VOLUME_INITIALIZER_SCOPE');
 const machineOrigin=await machineIdentity();
 if(process.getuid?.()===0){
  if(!isRailway||!mounted)refuse('CONTROL_VOLUME_INITIALIZER_SCOPE');
  if(await fs.realpath(state)!==state)refuse('CONTROL_VOLUME_PATH');
  const file=await fs.open(state,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try{const stat=await file.stat();if(!stat.isDirectory()||![0,uid].includes(stat.uid))refuse('CONTROL_VOLUME_OWNER');await file.chown(uid,uid);await file.chmod(0o700);}finally{await file.close();}
  process.setgroups([]);process.setgid(uid);process.setuid(uid);
 }
 const stat=await fs.lstat(state);
 if(process.getuid?.()!==uid||process.geteuid?.()!==uid||process.getgid?.()!==uid||process.getegid?.()!==uid||process.getgroups().some(group=>group!==uid)||!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==uid||stat.gid!==uid||(stat.mode&0o077)!==0||await fs.realpath(state)!==state)refuse('CONTROL_RUNTIME_IDENTITY');
 const metadata={schema_version:1,observed_at:new Date().toISOString(),runtime_uid:process.getuid(),runtime_gid:process.getgid(),supplementary_groups:process.getgroups(),machine_id_origin:machineOrigin,provider_replica_id:uuid.test(replica??'')?replica:null,volume:{path:state,uid:stat.uid,gid:stat.gid,mode:'0700',mounted}};
 const temporary=path.join(state,'startup.'+randomUUID()+'.json'),file=await fs.open(temporary,'wx',0o600);try{await file.writeFile(JSON.stringify(metadata));await file.sync();}finally{await file.close();}await fs.rename(temporary,path.join(state,'container-startup.json'));const directory=await fs.open(state,'r');try{await directory.sync();}finally{await directory.close();}
 process.stderr.write(JSON.stringify({event:'control_runtime_identity',runtime_uid:uid,volume_uid:stat.uid,machine_id_origin:machineOrigin,mount_verified:mounted})+'\n');
 const child=spawn(process.execPath,[path.join(root,'deploy/hyperfide/fleet-control/start.mjs')],{env:process.env,stdio:'inherit'});let stopping=false;
 const stop=()=>{stopping=true;child.kill('SIGTERM');};process.on('SIGTERM',stop);process.on('SIGINT',stop);
 await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>{process.exitCode=code??(stopping&&signal==='SIGTERM'?0:1);resolve();});});
}
void main().catch(error=>{process.stderr.write(JSON.stringify({event:'control_initializer_failed',error:{code:typeof error.code==='string'?error.code:'CONTROL_INITIALIZER_FAILED'}})+'\n');process.exitCode=78;});
