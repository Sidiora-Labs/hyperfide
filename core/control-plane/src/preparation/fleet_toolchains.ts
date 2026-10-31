import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fail,DIGEST} from '../transport/protocol.js';

type RecordValue=Record<string,any>;
export interface FleetToolchainReceipt{name:string;version:string;executable:string;digest:string}
export interface FleetToolchainProcessEnvironment{PATH:string}
export interface FleetToolchainExecution{commands:Record<string,string[]>;processEnvironment:FleetToolchainProcessEnvironment}
export interface FleetToolchainPreparation extends FleetToolchainExecution{receipts:FleetToolchainReceipt[];executables:Record<string,string>}
const MAX_EXECUTABLE_BYTES=1024*1024*1024;
const TRUSTED_BASE_PATH=['/usr/local/sbin','/usr/local/bin','/usr/sbin','/usr/bin','/sbin','/bin'];

function inside(root:string,target:string):boolean{
 const relative=path.relative(root,target);
 return relative!==''&&!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep);
}
function absolute(value:unknown):value is string{return typeof value==='string'&&path.isAbsolute(value)&&path.resolve(value)===value&&!value.includes('\0');}
function overlap(a:string,b:string):boolean{return a===b||inside(a,b)||inside(b,a);}
async function directory(filename:string):Promise<void>{
 const info=await fs.lstat(filename);
 if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid?.()||(info.mode&0o022)!==0||await fs.realpath(filename)!==filename)
  fail('FLEET_INSTALL_TOOLCHAIN_PATH','Toolchain output requires an owned protected directory');
}
async function parents(root:string,filename:string):Promise<void>{
 let current=root;await directory(current);
 for(const name of path.relative(root,path.dirname(filename)).split(path.sep).filter(Boolean)){
  current=path.join(current,name);
  try{await fs.mkdir(current,{mode:0o755});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  await directory(current);
 }
}
async function pinnedFile(filename:string,expected:string,owned:boolean):Promise<void>{
 const file=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const before=await file.stat();
  if(!before.isFile()||owned&&(before.uid!==process.getuid?.()||before.nlink!==1||(before.mode&0o777)!==0o555)||(before.mode&0o022)!==0||(before.mode&0o111)===0||before.size<1||before.size>MAX_EXECUTABLE_BYTES)
   fail('FLEET_INSTALL_TOOLCHAIN_PIN','Bounded immutable executable required');
  const digest=createHash('sha256'),buffer=Buffer.allocUnsafe(1024*1024);let total=0;
  while(true){const {bytesRead}=await file.read(buffer,0,buffer.length,null);if(!bytesRead)break;total+=bytesRead;if(total>MAX_EXECUTABLE_BYTES)fail('FLEET_INSTALL_TOOLCHAIN_PIN','Executable exceeds the trusted byte bound');digest.update(buffer.subarray(0,bytesRead));}
  const after=await file.stat();
  if(total!==before.size||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||'sha256:'+digest.digest('hex')!==expected)
   fail('FLEET_INSTALL_TOOLCHAIN_PIN','Executable bytes differ from the admitted artifact');
 }finally{await file.close();}
}
async function artifact(source:string,target:string,digest:string):Promise<void>{
 if(!absolute(source)||await fs.realpath(source)!==source)fail('FLEET_INSTALL_TOOLCHAIN_PATH','Protected staged toolchain artifact required');
 const input=await fs.open(source,constants.O_RDONLY|constants.O_NOFOLLOW),temporary=target+'.'+randomUUID()+'.tmp';let created=false;
 try{
  const before=await input.stat();
  if(!before.isFile()||before.uid!==process.getuid?.()||(before.mode&0o022)!==0||before.size<1||before.size>MAX_EXECUTABLE_BYTES)
   fail('FLEET_INSTALL_TOOLCHAIN_PIN','Bounded owned artifact without untrusted writes required');
  const output=await fs.open(temporary,'wx',0o500);created=true;
  try{
   const hash=createHash('sha256'),buffer=Buffer.allocUnsafe(1024*1024);let total=0;
   while(true){const {bytesRead}=await input.read(buffer,0,buffer.length,null);if(!bytesRead)break;total+=bytesRead;if(total>MAX_EXECUTABLE_BYTES)fail('FLEET_INSTALL_TOOLCHAIN_PIN','Artifact exceeds the trusted byte bound');const bytes=buffer.subarray(0,bytesRead);hash.update(bytes);await output.writeFile(bytes);}
   const after=await input.stat();
   if(total!==before.size||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||'sha256:'+hash.digest('hex')!==digest)
    fail('FLEET_INSTALL_TOOLCHAIN_PIN','Artifact bytes differ from the admitted toolchain');
   await output.chmod(0o555);await output.sync();
  }finally{await output.close();}
  try{await fs.link(temporary,target);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;const existing=await fs.lstat(target);if(existing.isSymbolicLink())fail('FLEET_INSTALL_TOOLCHAIN_PATH','Existing toolchain destination must not be a symlink');await pinnedFile(target,digest,true);}
  const parent=await fs.open(path.dirname(target),'r');try{await parent.sync();}finally{await parent.close();}
 }finally{await input.close();if(created)await fs.unlink(temporary);}
}
function reservedPaths(manifest:RecordValue,root:string):string[]{
 const result=[path.join(root,'.installer-home')];
 for(const [key,value]of Object.entries(manifest)as Array<[string,RecordValue]>){
  if(key.startsWith('mount.')||key.startsWith('configuration.'))if(absolute(value.target))result.push(value.target);
 }
 for(const value of [manifest.interfaces?.output,manifest.readiness?.receipt])if(absolute(value))result.push(value);
 if(manifest.workers)for(const field of ['source','home','build','temporary','dirty']){
  const template=manifest.workers[field+'_template'];
  if(typeof template!=='string'||!Number.isSafeInteger(manifest.workers.slots)||manifest.workers.slots<1||manifest.workers.slots>1024)continue;
  for(let slot=0;slot<manifest.workers.slots;slot++){
   const target=template.replace('{slot}',String(slot));if(!absolute(target))continue;
   result.push(target);if(path.dirname(target)!==root)result.push(path.dirname(target));
  }
 }
 return result;
}
async function nodeShebang(executable:string):Promise<string[]|null>{
 const file=await fs.open(executable,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const buffer=Buffer.alloc(512),{bytesRead}=await file.read(buffer,0,buffer.length,0),header=buffer.subarray(0,bytesRead).toString('utf8');
  if(!header.startsWith('#!'))return null;
  const words=header.slice(2).split('\n')[0]!.trim().split(/\s+/),interpreter=words[0]!;
  if(path.basename(interpreter)==='env'&&words.includes('node')){
   if(words.length!==2||words[1]!=='node')fail('FLEET_INSTALL_TOOLCHAIN_INTERPRETER','Node env shebang options require a supported explicit interpreter contract');
   return [];
  }
  if(absolute(interpreter)&&path.basename(interpreter)==='node'){
   const flags=words.slice(1);if(flags.length>1||flags.some(flag=>!/^--[A-Za-z0-9_.=-]+$/.test(flag)))fail('FLEET_INSTALL_TOOLCHAIN_INTERPRETER','Node shebang flags are not supported by this interpreter contract');
   return flags;
  }
  return null;
 }finally{await file.close();}
}
export async function resolveFleetToolchainExecution(manifest:RecordValue,executables:Record<string,string>):Promise<FleetToolchainExecution>{
 const tools=(Object.entries(manifest)as Array<[string,RecordValue]>).filter(([key])=>key.startsWith('toolchain.')).map(([,tool])=>tool);
 const nodes=tools.filter(tool=>tool.kind==='node');
 if(nodes.length>1||tools.some(tool=>['npm','pnpm'].includes(tool.kind))&&nodes.length!==1)
  fail('FLEET_INSTALL_TOOLCHAIN_INTERPRETER','Package managers require one explicit pinned Node toolchain');
 const resolved=new Map<string,string>();
 for(const tool of tools){const executable=executables[tool.executable];if(!absolute(tool.executable)||!absolute(executable))fail('FLEET_INSTALL_TOOLCHAIN_INTERPRETER','Every declared tool requires its verified executable mapping');resolved.set(tool.executable,await fs.realpath(executable));}
 const node=nodes[0]?resolved.get(nodes[0].executable)!:null;
 if(node&&path.basename(node)!=='node')fail('FLEET_INSTALL_TOOLCHAIN_INTERPRETER','The pinned Node executable must have basename node for child process resolution');
 const directories=[...new Set([...(node?[path.dirname(node)]:[]),...[...resolved.values()].map(executable=>path.dirname(executable)),...TRUSTED_BASE_PATH])];
 if(directories.some(directory=>directory.includes(':')||!absolute(directory))||directories.join(':').length>32768)
  fail('FLEET_INSTALL_TOOLCHAIN_INTERPRETER','Verified toolchain directories cannot form a bounded PATH');
 const commands:Record<string,string[]>=Object.create(null);
 for(const tool of tools){
  const executable=resolved.get(tool.executable)!,flags=await nodeShebang(executable);
  if(flags!==null&&!node)fail('FLEET_INSTALL_TOOLCHAIN_INTERPRETER','A Node script requires an explicit pinned Node interpreter');
  commands[tool.executable]=flags===null?[executable]:[node!,...flags,executable];
 }
 return {commands,processEnvironment:{PATH:directories.join(':')}};
}
export function fleetToolchainArgv(execution:FleetToolchainExecution,argv:string[]):string[]{
 if(!argv.length||!absolute(argv[0]))fail('FLEET_INSTALL_COMMAND','Absolute approved executable required');
 const command=execution.commands[argv[0]!];return command?[...command,...argv.slice(1)]:[...argv];
}
export async function runFleetInstallProcess(argv:string[],cwd:string,timeout:number,home:string,environment?:FleetToolchainProcessEnvironment):Promise<{exit_code:number;duration_ms:number;output:Buffer}>{
 if(!argv.length||!absolute(argv[0])||argv.some(value=>typeof value!=='string'||value.includes('\0'))||!absolute(cwd)||!absolute(home)||!Number.isSafeInteger(timeout)||timeout<1||timeout>3600000)
  fail('FLEET_INSTALL_COMMAND','Absolute approved executable and bounded timeout required');
 const processPath=environment?.PATH??TRUSTED_BASE_PATH.join(':');
 if(environment&&(Object.keys(environment).join(',')!=='PATH'||typeof environment.PATH!=='string'||processPath.length>32768||processPath.split(':').some(directory=>!absolute(directory))))
  fail('FLEET_INSTALL_COMMAND','Explicit bounded toolchain PATH required');
 const started=performance.now(),child=spawn(argv[0]!,argv.slice(1),{cwd,detached:true,stdio:['ignore','pipe','pipe'],env:{PATH:processPath,HOME:home,TMPDIR:home,LANG:'C.UTF-8',CI:'1',COREPACK_ENABLE_NETWORK:'0'}}),chunks:Buffer[]=[];let bytes=0,timedOut=false;
 const capture=(chunk:Buffer):void=>{bytes+=chunk.length;if(bytes<=65536)chunks.push(chunk);};child.stdout.on('data',capture);child.stderr.on('data',capture);
 const timer=setTimeout(()=>{timedOut=true;try{process.kill(-child.pid!,'SIGKILL');}catch{child.kill('SIGKILL');}},timeout);
 let exit:number|null;try{exit=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});}finally{clearTimeout(timer);}
 if(timedOut)fail('FLEET_INSTALL_TIMEOUT','Declared installation command timed out');
 if(bytes>65536)fail('FLEET_INSTALL_OUTPUT','Declared command exceeded bounded output capture');
 return {exit_code:exit??128,duration_ms:Math.floor(performance.now()-started),output:Buffer.concat(chunks)};
}
export async function prepareFleetToolchains(input:{manifest:RecordValue;environmentRoot:string;stagingRoot:string;artifactPaths:Record<string,string>;home:string}):Promise<FleetToolchainPreparation>{
 const {manifest,environmentRoot:root,stagingRoot:staging,artifactPaths,home}=input;
 if(!absolute(root)||root==='/'||!absolute(staging)||staging==='/'||root===staging)fail('FLEET_INSTALL_TOOLCHAIN_PATH','Distinct canonical final and staged environment roots required');
 await directory(staging);
 const reserved=reservedPaths(manifest,root),receipts:FleetToolchainReceipt[]=[],executables:Record<string,string>=Object.create(null),targets:string[]=[];
 const tools=(Object.entries(manifest)as Array<[string,RecordValue]>).filter(([key])=>key.startsWith('toolchain.'));
 for(const [section,tool]of tools){
  if(!absolute(tool.executable)||!DIGEST.test(tool.artifact_digest)||typeof tool.version!=='string'||!tool.version||!['image','coordinator-artifact'].includes(tool.delivery))fail('FLEET_INSTALL_TOOLCHAIN_PIN','Exact supported toolchain identity required');
  if(targets.some(target=>overlap(target,tool.executable)))fail('FLEET_INSTALL_TOOLCHAIN_PATH','Toolchain executable destinations overlap');targets.push(tool.executable);
  if(tool.delivery==='coordinator-artifact'&&(!inside(root,tool.executable)||reserved.some(target=>overlap(target,tool.executable))))
   fail('FLEET_INSTALL_TOOLCHAIN_PATH','Artifact executable must occupy a private generation path outside other install outputs');
 }
 for(const [section,tool]of tools){
  const name=section.slice(10);let executable:string;
  if(tool.delivery==='coordinator-artifact'){
   const source=artifactPaths[name];if(typeof source!=='string')fail('FLEET_INSTALL_TOOLCHAIN_MISSING','Required authenticated toolchain artifact is unavailable');
   executable=path.join(staging,path.relative(root,tool.executable));await parents(staging,executable);await artifact(source,executable,tool.artifact_digest);
  }else{executable=await fs.realpath(tool.executable);await pinnedFile(executable,tool.artifact_digest,false);}
  executables[tool.executable]=executable;
 }
 const execution=await resolveFleetToolchainExecution(manifest,executables);
 for(const [section,tool]of tools){
  const name=section.slice(10),executable=executables[tool.executable]!;
  const result=await runFleetInstallProcess(fleetToolchainArgv(execution,[tool.executable,'--version']),staging,30000,home,execution.processEnvironment);
  if(result.exit_code!==0||result.output.toString().trim().replace(/^v/,'')!==tool.version.replace(/^v/,''))fail('FLEET_INSTALL_TOOLCHAIN_VERSION','Actual executable version differs from its admitted pin');
  await pinnedFile(executable,tool.artifact_digest,tool.delivery==='coordinator-artifact');
  receipts.push({name,version:tool.version,executable:tool.executable,digest:tool.artifact_digest});
 }
 return {receipts,executables,...execution};
}
