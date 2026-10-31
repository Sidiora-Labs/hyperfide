import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {captureDependencyInventory} from './fleet_install_inventory.js';
import {deriveFleetReadinessInputs} from './fleet_readiness_contract.js';
import {parseNeron,parsePackage,parseInterfaces,verifyFleetInterfaceSelection} from '../contracts/fleet/index.mjs';
import {resolveFleetToolchainExecution,fleetToolchainArgv} from './fleet_toolchains.js';

type Data=Record<string,any>;
function canonical(value:any):string{return JSON.stringify(value&&typeof value==='object'?Array.isArray(value)?value.map(v=>JSON.parse(canonical(v))):Object.fromEntries(Object.keys(value).sort().map(k=>[k,JSON.parse(canonical(value[k]))])):value);}
const digest=(value:unknown)=>'sha256:'+createHash('sha256').update(canonical(value)).digest('hex');
const bytesDigest=(value:Buffer)=>'sha256:'+createHash('sha256').update(value).digest('hex');
function refuse():never{throw Object.assign(new Error('Manifest-backed runtime measurement failed'),{code:'FLEET_RUNTIME_NOT_READY'});}
function within(root:string,target:string):boolean{const relative=path.relative(root,target);return path.isAbsolute(target)&&path.resolve(target)===target&&relative!==''&&relative!=='..'&&!relative.startsWith('../')&&!path.isAbsolute(relative);}
async function file(filename:string,maximum=64*1024*1024):Promise<{bytes:Buffer;stat:import('node:fs').Stats}>{
 const handle=await fs.open(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{const before=await handle.stat();if(!before.isFile()||before.size>maximum||before.nlink!==1)refuse();const bytes=await handle.readFile(),after=await handle.stat();if(bytes.length!==before.size||before.ino!==after.ino||before.dev!==after.dev||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)refuse();return {bytes,stat:before};}finally{await handle.close();}
}
async function execute(argv:string[],cwd:string,home:string,temporary:string,timeout:number,expectedVersion?:string,processPath?:string):Promise<{exit_code:number;output_digest:string}>{
 if(!Array.isArray(argv)||!argv.length||argv.some(v=>typeof v!=='string'||v.includes('\0'))||!path.isAbsolute(argv[0]!))refuse();
 return new Promise((resolve,reject)=>{const chunks:Buffer[]=[];let count=0,failed=false;const child=spawn(argv[0]!,argv.slice(1),{cwd,env:{PATH:processPath??'/usr/local/bin:/usr/bin:/bin',HOME:home,TMPDIR:temporary,LANG:'C.UTF-8',LC_ALL:'C.UTF-8'},stdio:['ignore','pipe','pipe'],detached:true});const stop=()=>{failed=true;try{process.kill(-child.pid!,'SIGKILL');}catch{}};const timer=setTimeout(stop,timeout);const collect=(chunk:Buffer)=>{count+=chunk.length;if(count>1048576)stop();else chunks.push(chunk);};child.stdout.on('data',collect);child.stderr.on('data',collect);child.once('error',()=>{clearTimeout(timer);reject(Object.assign(new Error('Runtime probe unavailable'),{code:'FLEET_RUNTIME_NOT_READY'}));});child.once('close',code=>{clearTimeout(timer);try{process.kill(-child.pid!,'SIGKILL');}catch{}if(failed||code===null||expectedVersion!==undefined&&Buffer.concat(chunks).toString('utf8').trim().replace(/^v/,'')!==expectedVersion.replace(/^v/,''))reject(Object.assign(new Error('Runtime probe incomplete'),{code:'FLEET_RUNTIME_NOT_READY'}));else resolve({exit_code:code,output_digest:bytesDigest(Buffer.concat(chunks))});});});
}
export async function probeFleetRuntime(input:Data):Promise<Data>{
 if(input.schema_version!==1||input.kind!=='FLEET_MANIFEST_V1'||!input.slot||process.getuid?.()!==input.slot.uid||process.getgid?.()!==input.slot.gid||input.slot.uid===0)refuse();
 const slot=input.slot as Data;
 for(const key of ['source','home','temporary']){if(!path.isAbsolute(slot[key])||await fs.realpath(slot[key])!==slot[key])refuse();const st=await fs.lstat(slot[key]);if(!st.isDirectory()||st.uid!==slot.uid||st.gid!==slot.gid||(st.mode&0o077)!==0)refuse();}
 if(!Array.isArray(input.source_files)||input.source_files.length>100000||!Array.isArray(input.toolchains)||!Array.isArray(input.configurations)||!Array.isArray(input.probes))refuse();
 const paths=new Set<string>();
 for(const entry of input.source_files as Data[]){const filename=path.resolve(slot.source,entry.path);if(!within(slot.source,filename)||paths.has(entry.path))refuse();paths.add(entry.path);if(await fs.realpath(filename)!==filename)refuse();const actual=await file(filename);if(actual.stat.uid!==slot.uid||actual.stat.gid!==slot.gid||actual.stat.size!==entry.size||bytesDigest(actual.bytes)!==entry.digest||Boolean(actual.stat.mode&0o111)!==(entry.mode==='100755'))refuse();}
 const descriptor=await file(path.join(slot.source,'.neron'),524288);if(bytesDigest(descriptor.bytes)!==input.source_config_digest)refuse();
 const dependencies=await captureDependencyInventory(slot.source);if(dependencies.digest!==input.dependency_inventory_digest)refuse();
 const verifiedTools:Record<string,string>={};for(const tool of input.toolchains as Data[]){const resolved=await fs.realpath(tool.executable),actual=await file(resolved,1024*1024*1024);if(bytesDigest(actual.bytes)!==tool.digest||(actual.stat.mode&0o022)!==0||!(actual.stat.mode&0o111))refuse();verifiedTools[tool.executable]=resolved;}
 const execution=await resolveFleetToolchainExecution(input.toolchain_manifest,verifiedTools);
 const toolMeasurements:Data[]=[];
 for(const tool of input.toolchains as Data[]){const resolved=await fs.realpath(tool.executable),named=await fs.lstat(tool.executable);if(named.isSymbolicLink()&&named.uid!==0)refuse();const actual=await file(resolved,1024*1024*1024);if(bytesDigest(actual.bytes)!==tool.digest||(actual.stat.mode&0o022)!==0||!(actual.stat.mode&0o111))refuse();const result=await execute(fleetToolchainArgv(execution,[tool.executable,'--version']),slot.source,slot.home,slot.temporary,30000,String(tool.version),execution.processEnvironment.PATH);if(result.exit_code!==0)refuse();toolMeasurements.push({executable:tool.executable,digest:tool.digest,version:tool.version,version_output_digest:result.output_digest});}
 const verifyConfigurations=async():Promise<void>=>{for(const config of input.configurations as Data[]){if(await fs.realpath(config.target)!==config.target)refuse();const actual=await file(config.target,1048576);if((actual.stat.mode&0o777)!==parseInt(config.mode,8)||config.private&&(actual.stat.uid!==slot.uid||actual.stat.gid!==slot.gid||!within(slot.home,config.target)))refuse();if(config.kind==='config-ref'&&bytesDigest(actual.bytes)!==config.digest)refuse();if(config.kind==='secret-ref'&&(!config.reference||!config.version||!config.private))refuse();actual.bytes.fill(0);}};
 await verifyConfigurations();
 const verifyInterfaces=async():Promise<void>=>{const selected=input.interfaces;if(!selected||!path.isAbsolute(selected.target)||!within(input.environment_root,selected.target)||await fs.realpath(selected.target)!==selected.target||!Array.isArray(selected.selected_ids)||selected.source_revision!==input.source_revision)refuse();const actual=await file(selected.target,selected.max_bytes);if(actual.stat.uid!==0||(actual.stat.mode&0o777)!==0o444||bytesDigest(actual.bytes)!==selected.digest)refuse();const blocks=parseInterfaces(actual.bytes.toString('utf8'),{maxBytes:selected.max_bytes,maxBlocks:selected.max_blocks});if(canonical(Object.keys(blocks).sort())!==canonical([...selected.selected_ids].sort()))refuse();};
 await verifyInterfaces();
 const probes:Data[]=[];
 for(const probe of input.probes as Data[]){if(probe.cwd!==input.environment_root&&!within(input.environment_root,probe.cwd)||await fs.realpath(probe.cwd)!==probe.cwd)refuse();const result=await execute(fleetToolchainArgv(execution,probe.argv),probe.cwd,slot.home,slot.temporary,probe.timeout_seconds*1000,undefined,execution.processEnvironment.PATH);if(result.exit_code!==probe.expected_exit)refuse();probes.push({name:probe.name,...result});}
 for(const entry of input.source_files as Data[]){const actual=await file(path.join(slot.source,entry.path));if(bytesDigest(actual.bytes)!==entry.digest)refuse();}
 if((await captureDependencyInventory(slot.source)).digest!==input.dependency_inventory_digest||bytesDigest((await file(path.join(slot.source,'.neron'),524288)).bytes)!==input.source_config_digest)refuse();await verifyConfigurations();await verifyInterfaces();
 for(const tool of input.toolchains as Data[])if(bytesDigest((await file(await fs.realpath(tool.executable),1024*1024*1024)).bytes)!==tool.digest)refuse();
 const input_digest=digest(input),measurement_digest=digest({kind:'FLEET_MANIFEST_MEASUREMENT_V1',input_digest,tools:toolMeasurements,dependency_inventory_digest:dependencies.digest,probes});
 return {schema_version:1,kind:'FLEET_MANIFEST_V1',status:'READY',input_digest,measurement_digest,source_state_digest:input.source_state_digest,workspace_digest:input.workspace_digest,probe_results:probes};
}
async function main():Promise<void>{let total=0;const chunks:Buffer[]=[];for await(const part of process.stdin){const bytes=Buffer.isBuffer(part)?part:Buffer.from(part);total+=bytes.length;if(total>4*1024*1024)refuse();chunks.push(bytes);}const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));let result:unknown;
 if(process.argv[2]==='--derive'){
  if(process.getuid?.()!==0||typeof process.argv[3]!=='string'||input.state!=='PREPARED'||!input.receipt)refuse();
  const contextPath=path.resolve(process.argv[3]),contextFile=await file(contextPath,8*1024*1024);if(contextFile.stat.uid!==0||(contextFile.stat.mode&0o022)!==0)refuse();const context=JSON.parse(contextFile.bytes.toString('utf8'));
  if(context.schema_version!==1||context.job_binding?.namespace!=='FLEET_INSTALL'||contextPath!=='/run/hyperfide-stage/'+context.operation_id+'/context.json'||!Array.isArray(context.staging))refuse();
  const read=async(role:string,maximum=4*1024*1024):Promise<Buffer>=>{const matches=context.staging.filter((r:Data)=>r.role===role);if(matches.length!==1)refuse();const ref=matches[0];if(!within(path.dirname(contextPath),ref.path))refuse();const actual=await file(ref.path,maximum);if(actual.stat.uid!==0||(actual.stat.mode&0o022)!==0||bytesDigest(actual.bytes)!==ref.digest||String(actual.bytes.length)!==String(ref.size_bytes))refuse();return actual.bytes;};
  const bootstrap=JSON.parse((await read('input-manifest')).toString('utf8')),install_plan=JSON.parse((await read('fleet.plan')).toString('utf8'));
  const source_config=parseNeron((await read('fleet.source-config')).toString('utf8')),package_spec=parsePackage((await read('fleet.package')).toString('utf8'),{neron:source_config});
  if(bootstrap.kind!=='hyperfide.fleet-install-bootstrap'||digest(install_plan)!==bootstrap.plan_digest||digest(package_spec)!==bootstrap.admission.package_digest||digest(source_config)!==bootstrap.admission.source_config_digest)refuse();
  const {receipt_digest,...body}=input.receipt;if(digest(body)!==receipt_digest)refuse();
  const fragment=await read('fleet.interfaces',package_spec.interfaces.max_bytes),proof=JSON.parse((await read('fleet.interface-proof',package_spec.interfaces.max_bytes)).toString('utf8'));if(bytesDigest(fragment)!==install_plan.interface_fragment_digest)refuse();await verifyFleetInterfaceSelection({fragment:fragment.toString('utf8'),proof,expected:{publicationDigest:install_plan.interface_publication_digest,proofDigest:install_plan.interface_proof_digest,consumerId:install_plan.interface_consumer_id,packageDigest:bootstrap.admission.package_digest,sourceRevision:package_spec.interfaces.source_revision,catalogueDigest:package_spec.interfaces.catalogue_digest,ids:package_spec.interfaces.selected_ids,maxBlocks:package_spec.interfaces.max_blocks,maxBytes:package_spec.interfaces.max_bytes}});
  const inputs=deriveFleetReadinessInputs({admission:bootstrap.admission,package_spec,source_config,install_plan,receipt:input.receipt});result={schema_version:1,kind:'FLEET_READINESS_INPUTS_V1',inputs};
 }else result=await probeFleetRuntime(input);process.stdout.write(JSON.stringify(result)+'\n');}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))void main().catch(()=>{process.stderr.write(JSON.stringify({code:'FLEET_RUNTIME_NOT_READY'})+'\n');process.exitCode=1;});
