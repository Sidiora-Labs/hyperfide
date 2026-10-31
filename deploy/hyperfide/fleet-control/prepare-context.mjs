import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const digest=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const allowed=['core/control-plane/package.json','core/control-plane/package-lock.json','core/control-plane/tsconfig.json','core/control-plane/scripts','core/control-plane/src','core/control-plane/components','core/control-plane/migrations','contracts/fleet','deploy/hyperfide/fleet-control','deploy/hyperfide/fleet-env.mjs','deploy/hyperfide/dist-stamp.mjs'];
async function main(){
 const args=process.argv.slice(2),input={};if(args.length!==12)throw Error('CONTEXT_ARGUMENTS');for(let i=0;i<args.length;i+=2){if(!['--output','--cli','--cli-sha256','--native','--native-sha256','--runtime-home'].includes(args[i])||Object.hasOwn(input,args[i]))throw Error('CONTEXT_ARGUMENTS');input[args[i]]=args[i+1];}
 const output=path.resolve(input['--output']),base=path.join(root,'build/fleet');if(!output.startsWith(base+'/')||await fs.realpath(path.dirname(output))!==path.dirname(output))throw Error('CONTEXT_OUTPUT_SCOPE');
 const home=input['--runtime-home'];if(!/^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(home)||!path.isAbsolute(home)||path.normalize(home)!==home||!['/var/lib/hyperfide/','/opt/hyperfide/','/home/hyperfide/'].some(prefix=>home.startsWith(prefix)))throw Error('CONTEXT_RUNTIME_HOME');
 await fs.mkdir(output,{mode:0o700});const entries=[];
 async function copy(relative){
  if(['node_modules','dist','private','__pycache__','.git','.codegraph'].includes(path.basename(relative))||/^\.env(?:\.|$)/.test(path.basename(relative)))return;
  const source=path.join(root,relative),target=path.join(output,relative),stat=await fs.lstat(source);if(stat.isSymbolicLink())throw Error('CONTEXT_SYMLINK');
  if(stat.isDirectory()){await fs.mkdir(target,{recursive:true,mode:0o755});for(const name of (await fs.readdir(source)).sort())await copy(path.join(relative,name));return;}
  if(!stat.isFile())throw Error('CONTEXT_FILE_TYPE');const bytes=await fs.readFile(source);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes,{mode:stat.mode&0o111?0o755:0o644});entries.push({path:relative,digest:digest(bytes),size:bytes.length});
 }
 for(const relative of allowed)await copy(relative);
 const directory=path.join(output,'.fleet-runtime');await fs.mkdir(directory,{mode:0o755});const artifacts=[];
 for(const [name,file,expected] of [['hyperfide',input['--cli'],input['--cli-sha256']],['hyperfide-native',input['--native'],input['--native-sha256']]]){
  if(!/^sha256:[0-9a-f]{64}$/.test(expected))throw Error('CONTEXT_ARTIFACT_PIN');const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink())throw Error('CONTEXT_ARTIFACT_TYPE');const bytes=await fs.readFile(file);
  if(digest(bytes)!==expected||bytes.subarray(0,4).toString('hex')!=='7f454c46'||bytes[4]!==2||bytes[5]!==1||bytes.readUInt16LE(18)!==62)throw Error('CONTEXT_ARTIFACT_IDENTITY');
  await fs.writeFile(path.join(directory,name),bytes,{mode:0o755});artifacts.push({name,digest:expected,size:bytes.length});
 }
 await fs.writeFile(path.join(directory,'manifest.json'),JSON.stringify({schema_version:1,platform:'linux-x64',runtime_home:home,target_uid:22001,artifacts},null,2)+'\n',{mode:0o644});
 entries.sort((a,b)=>a.path.localeCompare(b.path));await fs.writeFile(path.join(output,'context-manifest.json'),JSON.stringify({schema_version:1,source_digest:digest(JSON.stringify(entries)),files:entries,artifacts},null,2)+'\n',{mode:0o644});
 console.log(JSON.stringify({output,files:entries.length,source_digest:digest(JSON.stringify(entries)),artifacts}));
}
void main().catch(error=>{console.error(JSON.stringify({ok:false,error:{code:error.message}}));process.exitCode=78;});
