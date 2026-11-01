import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {gunzipSync} from 'node:zlib';
import https from 'node:https';
import {spawn} from 'node:child_process';
import {createHash,randomUUID,X509Certificate,createPrivateKey,createPublicKey} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const hash=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const emit=(event,code)=>process.stderr.write(JSON.stringify({event,...(code?{code}:{})})+'\n');
function refuse(code){throw Object.assign(new Error(code),{code});}
async function immutableFile(filename,bytes){
 const temporary=filename+'.'+randomUUID(),file=await fs.open(temporary,'wx',0o600);
 try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
 try{await fs.link(temporary,filename);}catch(error){if(error.code!=='EEXIST')throw error;const old=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);try{const stat=await old.stat();if(!stat.isFile()||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0||stat.size!==bytes.length||hash(await old.readFile())!==hash(bytes))refuse('CONTROL_BOOTSTRAP_GENERATION_CONFLICT');}finally{await old.close();}}finally{await fs.unlink(temporary);}
 const directory=await fs.open(path.dirname(filename),'r');try{await directory.sync();}finally{await directory.close();}
}
async function preserveStartupError(event){
 const bytes=Buffer.from(JSON.stringify({schema_version:1,observed_at:new Date().toISOString(),error:event.error,...(typeof event.component_id==='string'?{component_id:event.component_id}:{})}));
 if(bytes.length>65536)return;
 const file=await fs.open(path.join(root,'state/control-startup-error.json'),constants.O_WRONLY|constants.O_CREAT|constants.O_TRUNC|constants.O_NOFOLLOW,0o600);
 try{const stat=await file.stat();if(!stat.isFile()||stat.uid!==process.getuid?.()||stat.nlink!==1||(stat.mode&0o077)!==0)refuse('CONTROL_DIAGNOSTIC_PATH');await file.writeFile(bytes);await file.sync();}finally{await file.close();}
}
async function configureNativePlanner(){
 const directory='/opt/hyperfide/bin',metadata=await fs.open(path.join(directory,'manifest.json'),constants.O_RDONLY|constants.O_NOFOLLOW);let manifest;
 try{const stat=await metadata.stat();if(!stat.isFile()||stat.uid!==0||(stat.mode&0o022)!==0||stat.size>65536)refuse('CONTROL_NATIVE_RUNTIME_MANIFEST');manifest=JSON.parse(await metadata.readFile('utf8'));}finally{await metadata.close();}
 const artifact=manifest.schema_version===1&&Array.isArray(manifest.artifacts)?manifest.artifacts.find(value=>value.name==='hyperfide-native'):null;
 if(!artifact||typeof artifact.digest!=='string'||!/^sha256:[0-9a-f]{64}$/.test(artifact.digest)||!Number.isSafeInteger(artifact.size)||artifact.size<1)refuse('CONTROL_NATIVE_RUNTIME_MANIFEST');
 const binary=path.join(directory,'hyperfide-native'),file=await fs.open(binary,constants.O_RDONLY|constants.O_NOFOLLOW);let actual;
 try{const before=await file.stat();if(!before.isFile()||before.uid!==0||(before.mode&0o022)!==0||(before.mode&0o111)===0||before.size!==artifact.size)refuse('CONTROL_NATIVE_RUNTIME_DRIFT');const digest=createHash('sha256');for await(const chunk of file.createReadStream({autoClose:false}))digest.update(chunk);actual='sha256:'+digest.digest('hex');const after=await file.stat();if(before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs)refuse('CONTROL_NATIVE_RUNTIME_DRIFT');}finally{await file.close();}
 if(actual!==artifact.digest||process.env.HF_NATIVE_CONNECTOR_PLANNER_BINARY&&process.env.HF_NATIVE_CONNECTOR_PLANNER_BINARY!==binary||process.env.HF_NATIVE_CONNECTOR_PLANNER_DIGEST&&process.env.HF_NATIVE_CONNECTOR_PLANNER_DIGEST!==actual)refuse('CONTROL_NATIVE_RUNTIME_DRIFT');
 process.env.HF_NATIVE_CONNECTOR_PLANNER_BINARY=binary;process.env.HF_NATIVE_CONNECTOR_PLANNER_DIGEST=actual;
}
async function prepare(){
 const prefix='HYPERFIDE_FLEET_CONTROL_BOOTSTRAP_B64_',legacy=process.env.HYPERFIDE_FLEET_CONTROL_BOOTSTRAP_B64,count=process.env[prefix+'CHUNK_COUNT'],parts=Object.keys(process.env).filter(key=>key.startsWith(prefix)&&key!==prefix+'CHUNK_COUNT'&&process.env[key]);let encoded=legacy;
 if(count||parts.length){
  if(legacy||!count||!/^([1-9]|[1-3][0-9]|4[0-3])$/.test(count)||parts.length!==Number(count))refuse('CONTROL_BOOTSTRAP_CHUNKS');
  encoded='';for(let index=0;index<Number(count);index++){const key=prefix+'CHUNK_'+String(index).padStart(3,'0'),part=process.env[key];if(!part||part.length>32768||!parts.includes(key))refuse('CONTROL_BOOTSTRAP_CHUNKS');encoded+=part;if(encoded.length>1398104)refuse('CONTROL_BOOTSTRAP_CHUNKS');}
 }
 const expected=process.env.HYPERFIDE_FLEET_CONTROL_BOOTSTRAP_SHA256;
 if(!encoded||!expected||encoded.length>1398104)refuse('CONTROL_BOOTSTRAP_REQUIRED');
 const transport=Buffer.from(encoded,'base64');if(transport.toString('base64')!==encoded)refuse('CONTROL_BOOTSTRAP_DIGEST');
 const bytes=transport[0]===0x1f&&transport[1]===0x8b?gunzipSync(transport,{maxOutputLength:1048576}):transport;if(bytes.length>1048576||hash(bytes)!==expected)refuse('CONTROL_BOOTSTRAP_DIGEST');
 const bundle=JSON.parse(bytes.toString('utf8'));
 if(!bundle||bundle.schema_version!==1||typeof bundle.generation!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(bundle.generation)||Object.keys(bundle).sort().join(',')!==(bundle.authority_adoption===undefined?'component_ids,files,generation,schema_version,spec_revision':'authority_adoption,component_ids,files,generation,schema_version,spec_revision')||typeof bundle.spec_revision!=='string'||!bundle.spec_revision||!Array.isArray(bundle.component_ids)||!bundle.component_ids.length||bundle.component_ids.length>256||new Set(bundle.component_ids).size!==bundle.component_ids.length||typeof bundle.files!=='object'||!bundle.files||Array.isArray(bundle.files))refuse('CONTROL_BOOTSTRAP_SCHEMA');
 const adoption=bundle.authority_adoption;
 if(adoption!==undefined&&(!adoption||Array.isArray(adoption)||Object.keys(adoption).sort().join(',')!=='deployment_id,document_file'||typeof adoption.deployment_id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(adoption.deployment_id)||adoption.deployment_id!==process.env.HYPERFIDE_DEPLOYMENT_ID||typeof adoption.document_file!=='string'||!/^[A-Za-z][A-Za-z0-9._-]{0,127}\.json$/.test(adoption.document_file)||!Object.hasOwn(bundle.files,adoption.document_file)))refuse('CONTROL_AUTHORITY_ADOPTION_INVALID');
 const state=path.join(root,'state'),directory=path.join(state,'bootstrap',bundle.generation);await fs.mkdir(directory,{recursive:true,mode:0o700});if(await fs.realpath(directory)!==directory)refuse('CONTROL_BOOTSTRAP_PATH');const stat=await fs.lstat(directory);if(stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0)refuse('CONTROL_BOOTSTRAP_PATH');
 await immutableFile(path.join(directory,'.digest'),Buffer.from(expected));
 for(const [name,contents] of Object.entries(bundle.files)){
  if(!/^[A-Za-z][A-Za-z0-9._-]{0,127}\.(json|crt|key|pem|kvx)$/.test(name)||typeof contents!=='string'||contents.length>1048576)refuse('CONTROL_BOOTSTRAP_PATH');
  const decoded=Buffer.from(contents,'base64');if(decoded.toString('base64')!==contents)refuse('CONTROL_BOOTSTRAP_ENCODING');
  await immutableFile(path.join(directory,name),decoded);decoded.fill(0);
 }
 for(const name of ['control-policy.json','control-identity.json','control.crt','control.key','tls-ca.crt'])if(!Object.hasOwn(bundle.files,name))refuse('CONTROL_BOOTSTRAP_REQUIRED');
 const identity=JSON.parse(await fs.readFile(path.join(directory,'control-identity.json'),'utf8')),origin=new URL(identity.origin);
 if(origin.protocol!=='https:'||origin.origin!==identity.origin||origin.username||origin.password||origin.search||origin.hash)refuse('CONTROL_ORIGIN_INVALID');
 const certificate=new X509Certificate(await fs.readFile(path.join(directory,'control.crt'))),privateKey=createPrivateKey(await fs.readFile(path.join(directory,'control.key')));
 if(!certificate.checkHost('control.local')||!certificate.publicKey.equals(createPublicKey(privateKey)))refuse('CONTROL_TLS_IDENTITY');
 const components=path.join(directory,'components');await fs.mkdir(components,{mode:0o700,recursive:true});if(await fs.realpath(components)!==components)refuse('CONTROL_BOOTSTRAP_PATH');
 const registrations=new Map(),registrationRoot=path.join(root,'core/control-plane/components');
 for(const name of await fs.readdir(registrationRoot)){
  if(!name.endsWith('.json')||name==='schema.json')continue;const raw=await fs.readFile(path.join(registrationRoot,name)),definition=JSON.parse(raw.toString('utf8'));
  if(typeof definition.id!=='string')continue;
  if(definition.schema_version!==1||definition.api_version!==1||typeof definition.module!=='string'||typeof definition.entry!=='string'||!Array.isArray(definition.roles)||!Array.isArray(definition.actions)||registrations.has(definition.id))refuse('CONTROL_COMPONENT_INVALID');
  registrations.set(definition.id,{name,raw,definition});
 }
 const selected=new Set(bundle.component_ids),names=new Set();
 for(const id of bundle.component_ids){const registration=registrations.get(id);if(!registration||registration.definition.requires?.some(required=>!selected.has(required)))refuse('CONTROL_COMPONENT_CLOSURE');names.add(registration.name);await immutableFile(path.join(components,registration.name),registration.raw);}
 if((await fs.readdir(components)).some(name=>!names.has(name)))refuse('CONTROL_BOOTSTRAP_GENERATION_CONFLICT');
 const rawPort=process.env.PORT;if(!rawPort||!/^\d+$/.test(rawPort))refuse('CONTROL_PORT_REQUIRED');const port=Number(rawPort);if(port<1||port>65535||port===9443)refuse('CONTROL_PORT_INVALID');
 if(!process.env.HYPERFIDE_CONTROL_PRIMARY_DATABASE_URL||process.env.HYPERFIDE_MIGRATION_DATABASE_URL||process.env.HYPERFIDE_MIGRATION_JOB)refuse('CONTROL_RUNTIME_DATABASE_SCOPE');
 await configureNativePlanner();
 process.env.HF_IDENTITY_CONFIG_FILE=path.join(directory,'control-identity.json');
 delete process.env.HYPERFIDE_FLEET_CONTROL_BOOTSTRAP_B64;
 for(const key of Object.keys(process.env))if(key.startsWith('HYPERFIDE_FLEET_CONTROL_BOOTSTRAP_B64_'))delete process.env[key];
 return {port,directory,components,adoption,origin:identity.origin,specRevision:bundle.spec_revision,ca:await fs.readFile(path.join(directory,'tls-ca.crt'))};
}
async function adoptAuthority(config){
 if(config.adoption===undefined)return;
 const state=path.join(root,'state'),journalRoot=process.env.HYPERFIDE_AUTHORITY_JOURNAL_DIR;
 if(typeof journalRoot!=='string'||!path.isAbsolute(journalRoot)||path.resolve(journalRoot)!==journalRoot||!journalRoot.startsWith(state+'/')||(journalRoot===path.join(state,'bootstrap')||journalRoot.startsWith(path.join(state,'bootstrap')+'/')))refuse('CONTROL_AUTHORITY_JOURNAL_PATH');
 await fs.mkdir(journalRoot,{recursive:true,mode:0o700});const stat=await fs.lstat(journalRoot);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0||await fs.realpath(journalRoot)!==journalRoot)refuse('CONTROL_AUTHORITY_JOURNAL_PATH');
 const [{createResourceContainer},{FileExternalAuthorityJournal},{lookupAuthorityActivation,assertExternalAuthorityCurrent},{strictJSON}]=await Promise.all([import(pathToFileURL(path.join(root,'core/control-plane/dist/storage/runtime.js'))),import(pathToFileURL(path.join(root,'core/control-plane/dist/storage/authority_journal.js'))),import(pathToFileURL(path.join(root,'core/control-plane/dist/storage/durability.js'))),import(pathToFileURL(path.join(root,'core/control-plane/dist/transport/protocol.js')))]);
 const bytes=await fs.readFile(path.join(config.directory,config.adoption.document_file)),document=strictJSON(bytes,1048576);
 if(!document||document.deployment_id!==config.adoption.deployment_id||document.state!=='ACTIVE')refuse('CONTROL_AUTHORITY_ADOPTION_INVALID');
 const signal=AbortSignal.timeout(30000),resources=createResourceContainer({role:'control',env:Object.freeze({...process.env}),signal});
 try{
  const journal=new FileExternalAuthorityJournal(journalRoot,input=>lookupAuthorityActivation(resources,input));
  await journal.adoptCommitted({deployment_id:config.adoption.deployment_id,document:bytes.toString('utf8'),signal});
  const current=await assertExternalAuthorityCurrent(resources,journal,{deployment_id:config.adoption.deployment_id,timeoutMs:15000,signal});
  process.stderr.write(JSON.stringify({event:'authority_journal_adopted',deployment_id:current.deployment_id,epoch:current.epoch,sequence:current.sequence,evidence_digest:current.evidence_digest})+'\n');
 }finally{await resources.close();}
}
async function main(){
 const state=path.join(root,'state'),owner=await fs.lstat(state);if(process.getuid?.()!==22001||process.geteuid?.()!==22001||process.getgid?.()!==22001||!owner.isDirectory()||owner.isSymbolicLink()||owner.uid!==22001||owner.gid!==22001||(owner.mode&0o077)!==0)refuse('CONTROL_RUNTIME_IDENTITY');
 const config=await prepare();await adoptAuthority(config);let ready=false,stopping=false;
 const child=spawn(process.execPath,['--import',path.join(root,'deploy/hyperfide/fleet-env.mjs'),path.join(root,'core/control-plane/dist/control.js'),'--mode','https','--host','127.0.0.1','--port','9443','--tls-cert',path.join(config.directory,'control.crt'),'--tls-key',path.join(config.directory,'control.key'),'--policy',path.join(config.directory,'control-policy.json'),'--spec-revision',config.specRevision,'--components',config.components],{env:process.env,stdio:['ignore','ignore','pipe']});
 let pending='';child.stderr.on('data',part=>{pending+=part.toString('utf8');if(pending.length>65536)pending='';let split;while((split=pending.indexOf('\n'))>=0){const line=pending.slice(0,split);pending=pending.slice(split+1);try{const event=JSON.parse(line);if(event.event==='ready'&&event.role==='control'&&event.mode==='https'){ready=true;emit('control_ready');}else if(event.error?.code){emit('control_error',String(event.error.code));void preserveStartupError(event).catch(()=>emit('control_error','CONTROL_DIAGNOSTIC_WRITE_FAILED'));}}catch{}}});
 const allowed=new Set(['content-type','content-length','content-encoding','hf-credential-id','hf-request-time','hf-request-nonce','hf-request-signature']);
 const server=http.createServer({maxHeaderSize:16384,requestTimeout:130000,headersTimeout:5000},(request,response)=>{
  if(request.method==='GET'&&request.url==='/healthz'){response.writeHead(ready?200:503,{'Content-Type':'application/json','Cache-Control':'no-store'});response.end(JSON.stringify({ready}));return;}
  if(!ready){response.writeHead(503);response.end();return;}
  if(request.method!=='POST'||!['/v1/invoke','/v1/enroll'].includes(request.url??'')){response.writeHead(404);response.end();return;}
  const headers=['Host','control.local'];for(let index=0;index<request.rawHeaders.length;index+=2)if(allowed.has(request.rawHeaders[index].toLowerCase())||(request.url==='/v1/enroll'&&request.rawHeaders[index].toLowerCase()==='authorization'))headers.push(request.rawHeaders[index],request.rawHeaders[index+1]);
  const upstream=https.request({hostname:'127.0.0.1',port:9443,servername:'control.local',path:request.url,method:'POST',headers,ca:config.ca,rejectUnauthorized:true,minVersion:'TLSv1.3',agent:false,timeout:125000},incoming=>{response.writeHead(incoming.statusCode??502,{'Content-Type':'application/json','Cache-Control':'no-store'});incoming.pipe(response);incoming.once('aborted',()=>response.destroy());incoming.once('error',()=>response.destroy());});
  upstream.once('timeout',()=>upstream.destroy());upstream.once('error',()=>{if(!response.headersSent)response.writeHead(502);response.end();});request.once('aborted',()=>upstream.destroy());response.once('close',()=>{if(!response.writableEnded)upstream.destroy();});request.pipe(upstream);
 });
 server.maxConnections=128;server.maxRequestsPerSocket=128;
 const stop=()=>{if(stopping)return;stopping=true;ready=false;if(server.listening)server.close();server.closeIdleConnections();child.kill('SIGTERM');setTimeout(()=>{server.closeAllConnections();child.kill('SIGKILL');},5000).unref();};
 process.on('SIGTERM',stop);process.on('SIGINT',stop);
 child.once('error',()=>{emit('control_error','CONTROL_PROCESS_UNAVAILABLE');process.exitCode=1;stop();});child.once('exit',code=>{ready=false;if(!stopping)process.exitCode=code===0?1:code??1;stop();});
 await new Promise((resolve,reject)=>{server.once('error',error=>{stop();reject(error);});server.listen(config.port,'0.0.0.0',resolve);});emit('ingress_listening');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))void main().catch(error=>{emit('control_start_failed',typeof error.code==='string'?error.code:'CONTROL_BOOTSTRAP_INVALID');process.exitCode=78;});
