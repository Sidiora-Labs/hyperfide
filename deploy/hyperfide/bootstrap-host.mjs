#!/usr/bin/env node
// Host preparation only: accounts, trees, units and templates. It never writes or reads a secret.
// Database URLs, keys, certificates and provider configuration are placed by the operator; identity
// enrolment (26.4), migrations, grants, epoch activation and service start remain operator steps.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
const directory=path.dirname(fileURLToPath(import.meta.url));
const RELEASE='/opt/hyperfide/current';
const GROUP={name:'hyperfide',gid:1900};
const ROLES={control:{user:'hyperfide',uid:1900},provisioner:{user:'hyperfide-provisioner',uid:1901},dispatch:{user:'hyperfide-dispatch',uid:1902}};
const IDENTITY={control:{'control-identity.json':'control-identity.example.json'},provisioner:{'provisioner-identity.json':'provisioner-identity.example.json','provisioner-worker.json':'provisioner-worker.example.json'},dispatch:{'dispatch-identity.json':'dispatch-identity.example.json'}};
const OPERATOR={control:[],provisioner:['external-fence.json','pools.json','railway.json','provisioner-worker.key'],dispatch:['dispatch-worker.json','dispatch-worker.key']};
const fail=(code,missing)=>{throw Object.assign(new Error(code),{code},missing?{missing}:{});};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const record=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
async function runtime(name){
 for(const base of ['../../services/dist/','../../services/hyperfide/dist/']){
  const file=path.join(directory,base,name+'.js');
  try{await fs.access(file);}catch(error){if(error.code==='ENOENT')continue;throw error;}
  return import(pathToFileURL(file));
 }
 fail('BOOTSTRAP_RUNTIME_MISSING');
}
// Mirrors recovery/fencing_service.ts configuration() so a gap refuses before the unit starts.
async function fenceConfiguration(filename){
 if(!filename||!path.isAbsolute(filename)||path.resolve(filename)!==filename||await fs.realpath(filename).catch(()=>null)!==filename)fail('EXTERNAL_FENCE_CONFIG_REQUIRED');
 const file=await fs.open(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{
  const stat=await file.stat(),named=await fs.lstat(filename);
  if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid()||(stat.mode&0o777)!==0o600||stat.size<1||stat.size>262144||stat.dev!==named.dev||stat.ino!==named.ino)fail('EXTERNAL_FENCE_CONFIG_UNSAFE');
  let value;try{value=JSON.parse(await file.readFile('utf8'));}catch{fail('EXTERNAL_FENCE_CONFIG_INVALID');}
  const fields=(v,required,optional=[])=>record(v)&&required.every(k=>Object.hasOwn(v,k))&&Object.keys(v).every(k=>required.includes(k)||optional.includes(k));
  if(!fields(value,['schema_version','topology','journal_directory','verifier_file','transport'])||!fields(value.transport,['origin','host','port','certificate','private_key'],['max_concurrent','deadline_ms']))fail('EXTERNAL_FENCE_CONFIG_INVALID');
  if(value.schema_version!==1||!record(value.topology)||value.topology.evidence_scope!=='LIVE_PROVIDER'||typeof value.journal_directory!=='string'||typeof value.verifier_file!=='string'||!path.isAbsolute(value.journal_directory)||!path.isAbsolute(value.verifier_file))fail('EXTERNAL_FENCE_CONFIG_INVALID');
  return value;
 }finally{await file.close();}
}
// Internal object store (v21 2.11): the provisioner's HF_SLICE_SOURCE_CONFIG names the store and its per-region mirrors.
// Preflight refuses a malformed file or a GitHub source; --object-store-freshness reports each mirror against the store.
async function objectStore(env){
 if(!env.HF_SLICE_SOURCE_CONFIG)return null;
 return (await runtime('preparation/object_store')).readObjectStore(env);
}
export async function objectStoreFreshness(repository,env=process.env){
 const store=await runtime('preparation/object_store'),config=store.readObjectStore(env);
 const report=await store.mirrorFreshness(config,repository);
 return {outcome:report.mirrors.every(m=>m.state==='FRESH')?'FRESH':'STALE',...report,services_started:false};
}
// Every absent variable or file a role needs to start, so one refusal names all of them.
async function absent(role,env){
 const prefix=role==='control'?'':role.toUpperCase()+'_';
 const names=['HYPERFIDE_REQUIRE_SYNC_REPLICA','HYPERFIDE_DEPLOYMENT_ID','HYPERFIDE_AUTHORITY_JOURNAL_DIR','HYPERFIDE_SPEC_REVISION',
  'HYPERFIDE_'+prefix+'LISTEN_HOST','HYPERFIDE_'+prefix+'LISTEN_PORT','HYPERFIDE_'+role.toUpperCase()+'_PRIMARY_DATABASE_URL','HF_IDENTITY_CONFIG_FILE',
  ...{control:['HYPERFIDE_CAUSAL_BARRIER_KEY'],dispatch:['HF_EVENT_DISPATCH_CONFIG'],provisioner:['HF_PROVISIONER_EXECUTOR_CONFIG_FILE','HYPERFIDE_EXTERNAL_FENCE_CONFIG_FILE','HYPERFIDE_POOL_CONFIG','HF_RAILWAY_CONFIG']}[role]];
 if(role==='provisioner'){
  // Live Railway installs the runtime (providers/railway/reconciliation.ts installRailwayRuntime), which needs these at start, not at preflight.
  let mode=null;try{mode=JSON.parse(await fs.readFile(env.HF_RAILWAY_CONFIG,'utf8')).mode;}catch{}
  if(mode==='live'||env.HF_RAILWAY_RUNTIME_POLICY)names.push('HF_RAILWAY_RUNTIME_POLICY','HF_RAILWAY_RUNTIME_POLICY_DIGEST','HF_RAILWAY_PROCESS_ROOT','HF_CREDENTIAL_CONFIG_FILE');
 }
 const missing=names.filter(name=>!env[name]);
 if(env.HF_IDENTITY_CONFIG_FILE&&!(await fs.stat(env.HF_IDENTITY_CONFIG_FILE).catch(()=>null))?.isFile())missing.push(env.HF_IDENTITY_CONFIG_FILE);
 return missing;
}
// The first failing check keeps its specific code; the refusal also carries every absent name at once.
export async function preflight(role,env=process.env){
 if(!Object.hasOwn(ROLES,role))fail('BOOTSTRAP_ARGUMENTS');
 const missing=await absent(role,env);
 try{await checks(role,env);}catch(error){if(missing.length)error.missing=missing;throw error;}
 if(missing.length)fail('PREFLIGHT_INPUT_MISSING',missing);
 return {outcome:'SUCCEEDED',role,services_started:false};
}
async function checks(role,env){
 if(Object.keys(env).some(k=>k.startsWith('HYPERFIDE_MIGRATION_')))fail('MIGRATION_CREDENTIAL_EXPOSED');
 if(!['0','1'].includes(env.HYPERFIDE_REQUIRE_SYNC_REPLICA))fail('DURABILITY_POLICY_REQUIRED');
 const journal=env.HYPERFIDE_AUTHORITY_JOURNAL_DIR??'';
 if(!uuid.test(env.HYPERFIDE_DEPLOYMENT_ID??'')||!path.isAbsolute(journal)||path.resolve(journal)!==journal)fail('EXTERNAL_JOURNAL_REQUIRED');
 const st=await fs.lstat(journal).catch(()=>null);
 if(!st?.isDirectory()||st.uid!==process.getuid()||(st.mode&0o077)!==0||await fs.realpath(journal)!==journal)fail('EXTERNAL_JOURNAL_REQUIRED');
 if(role==='control'&&!/^[a-f0-9]{64}$/.test(env.HYPERFIDE_CAUSAL_BARRIER_KEY??''))fail('BARRIER_CONFIG_INVALID');
 const prefix=role==='control'?'':role.toUpperCase()+'_',port=env['HYPERFIDE_'+prefix+'LISTEN_PORT']??'';
 if(!env['HYPERFIDE_'+prefix+'LISTEN_HOST']||!/^[1-9][0-9]{0,4}$/.test(port)||Number(port)>65535||!env.HYPERFIDE_SPEC_REVISION)fail('TRANSPORT_CONFIG');
 let protocol=null;try{protocol=new URL(env['HYPERFIDE_'+role.toUpperCase()+'_PRIMARY_DATABASE_URL']).protocol;}catch{}
 if(!['postgres:','postgresql:'].includes(protocol))fail('DATABASE_CONFIG_INVALID');
 if(!env.HF_IDENTITY_CONFIG_FILE||!(await fs.stat(env.HF_IDENTITY_CONFIG_FILE).catch(()=>null))?.isFile())fail('IDENTITY_CONFIG_REQUIRED');
 if(role==='dispatch'&&!env.HF_EVENT_DISPATCH_CONFIG)fail('DISPATCH_CONFIG_REQUIRED');
 if(role==='provisioner'){
  if(!path.isAbsolute(env.HF_PROVISIONER_EXECUTOR_CONFIG_FILE??''))fail('PROVISIONER_EXECUTOR_CONFIG_INVALID');
  const fence=await fenceConfiguration(env.HYPERFIDE_EXTERNAL_FENCE_CONFIG_FILE);
  (await runtime('recovery/fencing')).externalFenceTopologyDigest(fence.topology);
  await (await runtime('providers/pools')).readDeployment(env);
  (await runtime('providers/railway/preparation')).configuredClient({env});
  await objectStore(env);
 }
}
const rows=text=>text.split('\n').filter(Boolean).map(line=>line.split(':'));
// Every release template is read before the first write, so a missing one refuses with nothing applied and names them all.
async function releaseInputs(){
 const names=['grants.sql'];
 for(const role of Object.keys(ROLES))names.push('env/'+role+'.env.example','policies/'+role+'.example.json',...Object.values(IDENTITY[role]).map(t=>'identity/'+t),role+'.service');
 const inputs=new Map(),missing=[];
 for(const name of names){try{inputs.set(name,await fs.readFile(path.join(directory,name)));}catch(error){if(error.code!=='ENOENT')throw error;missing.push('deploy/hyperfide/'+name);}}
 if(missing.length)fail('BOOTSTRAP_INPUT_MISSING',missing);
 return inputs;
}
export async function bootstrap(root){
 if(process.geteuid()!==0)fail('BOOTSTRAP_ROOT_REQUIRED');
 if(!path.isAbsolute(root)||path.resolve(root)!==root)fail('BOOTSTRAP_ARGUMENTS');
 const inputs=await releaseInputs(),read=name=>inputs.get(name);
 const at=p=>path.join(root,p),created=[],kept=[],differs=[];
 async function syncDirectory(p){const h=await fs.open(p,'r');try{await h.sync();}finally{await h.close();}}
 // Walk every component without following links; only Hyperfide's own directories get ownership and mode enforced.
 async function mkdir(p,owned){
  let current=root;
  for(const part of p.split('/').filter(Boolean)){
   current=path.join(current,part);
   try{await fs.mkdir(current,{mode:0o755});created.push('/'+path.relative(root,current));}catch(e){if(e.code!=='EEXIST')throw e;}
   const st=await fs.lstat(current);if(!st.isDirectory()||st.isSymbolicLink())fail('BOOTSTRAP_UNSAFE_PATH');
  }
  if(owned){await fs.chown(current,owned.uid,owned.gid);await fs.chmod(current,owned.mode);}
 }
 // Create atomically and never replace: a complete temporary file is hard-linked into place.
 async function place(bytes,p,mode,uid,gid,{system=false,release=false}={}){
  const target=at(p);
  const existing=await fs.lstat(target).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  if(existing){
   if(system)return;
   if(!existing.isFile()||existing.nlink!==1||existing.uid!==uid||existing.gid!==gid||(existing.mode&0o777)!==mode)fail('BOOTSTRAP_CONFIG_UNSAFE');
   if(release&&!(await fs.readFile(target)).equals(Buffer.from(bytes)))differs.push(p);else kept.push(p);
   return;
  }
  const temporary=path.join(path.dirname(target),'.'+path.basename(target)+'.bootstrap-'+process.pid);
  const handle=await fs.open(temporary,'wx',0o600);
  try{await handle.writeFile(bytes);await handle.chown(uid,gid);await handle.chmod(mode);await handle.sync();}
  finally{await handle.close();}
  try{await fs.link(temporary,target);}finally{await fs.unlink(temporary);}
  await syncDirectory(path.dirname(target));created.push(p);
 }
 const tool=(name,args)=>{try{execFileSync(name,[...(root==='/'?[]:['--root',root]),...args],{stdio:'pipe'});}catch{fail('BOOTSTRAP_ACCOUNT_FAILED');}};
 await fs.mkdir(root,{recursive:true,mode:0o755});
 if(await fs.realpath(root)!==root)fail('BOOTSTRAP_UNSAFE_PATH');
 await mkdir('/etc');
 // Present on any real host; seeded only so a prefix tree has account databases for useradd --root.
 await place('root:x:0:0:root:/root:/usr/sbin/nologin\n','/etc/passwd',0o644,0,0,{system:true});
 await place('root:x:0:\n','/etc/group',0o644,0,0,{system:true});
 await place('root:*:19000:0:99999:7:::\n','/etc/shadow',0o600,0,0,{system:true});
 await place('root:*::\n','/etc/gshadow',0o600,0,0,{system:true});
 const groups=rows(await fs.readFile(at('/etc/group'),'utf8'));
 const group=groups.find(r=>r[0]===GROUP.name);
 if(group){if(Number(group[2])!==GROUP.gid)fail('BOOTSTRAP_IDENTITY_CONFLICT');}
 else{if(groups.some(r=>Number(r[2])===GROUP.gid))fail('BOOTSTRAP_IDENTITY_CONFLICT');tool('groupadd',['--system','--gid',String(GROUP.gid),GROUP.name]);}
 for(const {user,uid} of Object.values(ROLES)){
  const passwd=rows(await fs.readFile(at('/etc/passwd'),'utf8'));
  if(!passwd.some(r=>r[0]===user)){
   if(passwd.some(r=>Number(r[2])===uid))fail('BOOTSTRAP_IDENTITY_CONFLICT');
   tool('useradd',['--system','--uid',String(uid),'--gid',String(GROUP.gid),'--no-user-group','--no-create-home','--home-dir','/nonexistent','--shell','/usr/sbin/nologin',user]);
  }
  const row=rows(await fs.readFile(at('/etc/passwd'),'utf8')).find(r=>r[0]===user);
  if(!row||Number(row[2])!==uid||Number(row[3])!==GROUP.gid||row[5]!=='/nonexistent'||row[6]!=='/usr/sbin/nologin')fail('BOOTSTRAP_IDENTITY_CONFLICT');
 }
 const shared={uid:0,gid:GROUP.gid,mode:0o750};
 await mkdir('/etc/hyperfide',shared);await mkdir('/var/lib/hyperfide',shared);await mkdir('/etc/systemd/system');
 for(const [role,{uid}] of Object.entries(ROLES)){
  const own={uid,gid:GROUP.gid,mode:0o700},unit='/etc/systemd/system/hyperfide-'+role+'.service';
  await mkdir('/var/lib/hyperfide/'+role,own);
  await mkdir('/var/lib/hyperfide/'+role+'/authority-journal',own);
  if(role==='provisioner')await mkdir('/var/lib/hyperfide/provisioner/preparation',own);
  await place(await read('env/'+role+'.env.example'),'/etc/hyperfide/'+role+'.env',0o600,0,0);
  await place(await read('policies/'+role+'.example.json'),'/etc/hyperfide/'+role+'-policy.json',0o600,uid,GROUP.gid);
  for(const [name,template] of Object.entries(IDENTITY[role]))await place(await read('identity/'+template),'/etc/hyperfide/'+name,0o600,uid,GROUP.gid);
  await place(await read(role+'.service'),unit,0o644,0,0,{release:true});
  await mkdir(unit+'.d',{uid:0,gid:0,mode:0o755});
  await place('[Service]\nEnvironmentFile=/etc/hyperfide/'+role+'.db.env\n',unit+'.d/db-env.conf',0o644,0,0,{release:true});
  await place('[Service]\nExecStartPre='+RELEASE+'/runtime/node '+RELEASE+'/deploy/hyperfide/bootstrap-host.mjs --preflight '+role+'\n',unit+'.d/preflight.conf',0o644,0,0,{release:true});
 }
 await place(await read('grants.sql'),'/etc/hyperfide/grants.sql',0o644,0,0,{release:true});
 const pending=[];
 for(const [role,files] of Object.entries(OPERATOR))for(const name of [role+'.db.env',role+'.crt',role+'.key',...files]){
  const p='/etc/hyperfide/'+name;if(!await fs.lstat(at(p)).catch(()=>null))pending.push(p);
 }
 if(root==='/')execFileSync('systemctl',['daemon-reload'],{stdio:'pipe'});
 return {outcome:'SUCCEEDED',root,group:GROUP,users:Object.values(ROLES),created,kept,differs,operator_pending:pending,services_started:false};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const args=process.argv.slice(2);let result;
  if(args.length===2&&args[0]==='--preflight')result=await preflight(args[1]);
  else if(args.length===2&&args[0]==='--object-store-freshness'){result=await objectStoreFreshness(args[1]);if(result.outcome!=='FRESH')process.exitCode=1;}
  else if(args.length===0)result=await bootstrap(process.env.HYPERFIDE_BOOTSTRAP_ROOT||'/');
  else if(args.length===2&&args[0]==='--root')result=await bootstrap(args[1]);
  else fail('BOOTSTRAP_ARGUMENTS');
  console.log(JSON.stringify(result));
 }catch(error){console.log(JSON.stringify({outcome:'REFUSED',error:{code:error.code??error.message,...(error.missing?{missing:error.missing}:{})},services_started:false}));process.exitCode=78;}
}
