#!/usr/bin/env node
// Host preparation only. Identity enrollment, migrations and service start remain operator steps.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
const directory=path.dirname(fileURLToPath(import.meta.url));
const roles=['control','provisioner','dispatch'];
const user=role=>role==='control'?'hyperfide':'hyperfide-'+role;
const fail=code=>{throw Object.assign(new Error(code),{code});};
async function runtime(name){
 const deployed='/opt/hyperfide/current/services/dist/'+name+'.js';
 try{await fs.access(deployed);return import(pathToFileURL(deployed));}
 catch(error){if(error.code!=='ENOENT')throw error;return import(new URL('../../services/hyperfide/dist/'+name+'.js',import.meta.url));}
}
export async function preflight(role,env=process.env){
 if(!roles.includes(role))fail('BOOTSTRAP_ARGUMENTS');
 if(Object.keys(env).some(k=>k.startsWith('HYPERFIDE_MIGRATION_')))fail('MIGRATION_CREDENTIAL_EXPOSED');
 if(!['0','1'].includes(env.HYPERFIDE_REQUIRE_SYNC_REPLICA))fail('DURABILITY_POLICY_REQUIRED');
 if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(env.HYPERFIDE_DEPLOYMENT_ID??'')||!path.isAbsolute(env.HYPERFIDE_AUTHORITY_JOURNAL_DIR??''))fail('EXTERNAL_JOURNAL_REQUIRED');
 const journal=await fs.lstat(env.HYPERFIDE_AUTHORITY_JOURNAL_DIR).catch(()=>null);
 if(!journal?.isDirectory()||journal.isSymbolicLink()||journal.uid!==process.getuid()||(journal.mode&0o077)!==0||await fs.realpath(env.HYPERFIDE_AUTHORITY_JOURNAL_DIR)!==env.HYPERFIDE_AUTHORITY_JOURNAL_DIR)fail('EXTERNAL_JOURNAL_REQUIRED');
 if(role==='control'&&!/^[a-f0-9]{64}$/.test(env.HYPERFIDE_CAUSAL_BARRIER_KEY??''))fail('BARRIER_CONFIG_INVALID');
 const prefix=role==='control'?'':role.toUpperCase()+'_';
 if(!env['HYPERFIDE_'+prefix+'LISTEN_HOST']||!/^\d+$/.test(env['HYPERFIDE_'+prefix+'LISTEN_PORT']??'')||Number(env['HYPERFIDE_'+prefix+'LISTEN_PORT'])<1||Number(env['HYPERFIDE_'+prefix+'LISTEN_PORT'])>65535||!env.HYPERFIDE_SPEC_REVISION)fail('TRANSPORT_CONFIG');
 const db=env['HYPERFIDE_'+role.toUpperCase()+'_PRIMARY_DATABASE_URL'];
 try{if(!['postgres:','postgresql:'].includes(new URL(db).protocol))fail('DATABASE_CONFIG_INVALID');}catch{fail('DATABASE_CONFIG_INVALID');}
 if(role==='provisioner'){
  const filename=env.HYPERFIDE_EXTERNAL_FENCE_CONFIG_FILE;
  if(!filename||!path.isAbsolute(filename)||path.resolve(filename)!==filename||await fs.realpath(filename).catch(()=>null)!==filename)fail('EXTERNAL_FENCE_CONFIG_REQUIRED');
  const st=await fs.lstat(filename);
  if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.uid!==process.getuid()||(st.mode&0o777)!==0o600||st.size<1||st.size>262144)fail('EXTERNAL_FENCE_CONFIG_UNSAFE');
  let config;try{config=JSON.parse(await fs.readFile(filename,'utf8'));}catch{fail('EXTERNAL_FENCE_CONFIG_INVALID');}
  const fields=(v,required,optional=[])=>v&&typeof v==='object'&&!Array.isArray(v)&&required.every(k=>Object.hasOwn(v,k))&&Object.keys(v).every(k=>[...required,...optional].includes(k));
  if(!fields(config,['schema_version','topology','journal_directory','verifier_file','transport'])||!fields(config.transport,['origin','host','port','certificate','private_key'],['max_concurrent','deadline_ms'])||config.schema_version!==1||config.topology?.evidence_scope!=='LIVE_PROVIDER'||typeof config.journal_directory!=='string'||typeof config.verifier_file!=='string'||!path.isAbsolute(config.journal_directory)||!path.isAbsolute(config.verifier_file))fail('EXTERNAL_FENCE_CONFIG_INVALID');
  (await runtime('recovery/fencing')).externalFenceTopologyDigest(config.topology);
  await (await runtime('providers/pools')).readDeployment(env);
  (await runtime('providers/railway/preparation')).configuredClient({env});
 }
 return {outcome:'SUCCEEDED',role,services_started:false};
}
async function bootstrap(root){
 if(process.geteuid()!==0)fail('BOOTSTRAP_ROOT_REQUIRED');
 if(!path.isAbsolute(root)||path.resolve(root)!==root)fail('BOOTSTRAP_ARGUMENTS');
 const at=p=>path.join(root,p);
 // Walk each component without following links, including existing host trees.
 async function mkdir(p,mode,uid=0,gid=0){
  const target=at(p);let current=root;
  for(const part of path.relative(root,target).split('/').filter(Boolean)){
   current=path.join(current,part);try{await fs.mkdir(current,{mode:0o755});}catch(e){if(e.code!=='EEXIST')throw e;}
   const st=await fs.lstat(current);if(!st.isDirectory()||st.isSymbolicLink())fail('BOOTSTRAP_UNSAFE_PATH');
  }
  await fs.chown(target,uid,gid);await fs.chmod(target,mode);
 }
 async function install(source,p,mode,uid=0,gid=0){
  const target=at(p);let handle;
  try{handle=await fs.open(target,'wx',mode);}catch(e){if(e.code!=='EEXIST')throw e;const st=await fs.lstat(target);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.uid!==uid||st.gid!==gid||(st.mode&0o777)!==mode)fail('BOOTSTRAP_CONFIG_UNSAFE');return;}
  try{await handle.writeFile(source);await handle.chown(uid,gid);await handle.chmod(mode);await handle.sync();}finally{await handle.close();}
 }
 await fs.mkdir(root,{recursive:true,mode:0o755});
 if(await fs.realpath(root)!==root)fail('BOOTSTRAP_UNSAFE_PATH');
 await mkdir('/etc',0o755);
 if(root!=='/'){
  await install('root:x:0:0:root:/root:/bin/sh\n','/etc/passwd',0o644);
  await install('root:x:0:\n','/etc/group',0o644);
 }
 for(const role of roles){
  let passwd=await fs.readFile(at('/etc/passwd'),'utf8');
  if(!passwd.split('\n').some(l=>l.startsWith(user(role)+':'))){
   execFileSync('useradd',[...(root==='/'?[]:['--root',root]),'--system','--user-group','--no-create-home','--home-dir','/nonexistent','--shell','/usr/sbin/nologin',user(role)],{stdio:'pipe'});
  }
  passwd=await fs.readFile(at('/etc/passwd'),'utf8');const row=passwd.split('\n').find(l=>l.startsWith(user(role)+':')).split(':');
  if(Number(row[2])===0||row[5]!=='/nonexistent'||row[6]!=='/usr/sbin/nologin')fail('BOOTSTRAP_IDENTITY_UNSAFE');
 }
 await mkdir('/etc/hyperfide',0o711);await mkdir('/var/lib/hyperfide',0o711);
 await mkdir('/usr/lib/hyperfide',0o755);await mkdir('/etc/systemd/system',0o755);
 await install(await fs.readFile(fileURLToPath(import.meta.url)),'/usr/lib/hyperfide/bootstrap-host.mjs',0o755);
 for(const role of roles){
  const row=(await fs.readFile(at('/etc/passwd'),'utf8')).split('\n').find(l=>l.startsWith(user(role)+':')).split(':');const uid=Number(row[2]),gid=Number(row[3]);
  await mkdir('/var/lib/hyperfide/'+role,0o700,uid,gid);
  await mkdir('/var/lib/hyperfide/'+role+'/authority-journal',0o700,uid,gid);
  if(role==='provisioner')await mkdir('/var/lib/hyperfide/provisioner/preparation',0o700,uid,gid);
  await install(await fs.readFile(path.join(directory,'env',role+'.env.example')),'/etc/hyperfide/'+role+'.env',0o640,0,gid);
  await install(await fs.readFile(path.join(directory,'policies',role+'.example.json')),'/etc/hyperfide/'+role+'-policy.json',0o600,uid,gid);
  const unit=(await fs.readFile(path.join(directory,role+'.service'),'utf8')).replace('[Service]','[Service]\nExecStartPre=/opt/hyperfide/current/runtime/node /usr/lib/hyperfide/bootstrap-host.mjs --preflight '+role);
  await install(unit,'/etc/systemd/system/hyperfide-'+role+'.service',0o644);
 }
 await install(await fs.readFile(path.join(directory,'grants.sql')),'/etc/hyperfide/grants.sql',0o600);
 if(root==='/')execFileSync('systemctl',['daemon-reload'],{stdio:'pipe'});
 return {outcome:'SUCCEEDED',root,users:'useradd',services_started:false,grants:'installed; trusted database operator must apply grants.sql'};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const args=process.argv.slice(2);let result;
  if(args.length===2&&args[0]==='--preflight')result=await preflight(args[1]);
  else if(args.length===0||args.length===2&&args[0]==='--root')result=await bootstrap(args[1]??'/');
  else fail('BOOTSTRAP_ARGUMENTS');
  console.log(JSON.stringify(result));
 }catch(error){console.log(JSON.stringify({outcome:'REFUSED',error:{code:error.code??error.message},services_started:false}));process.exitCode=78;}
}
