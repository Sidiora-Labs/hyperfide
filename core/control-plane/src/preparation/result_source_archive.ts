import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {validateFleetSourceArchive,sourceArchiveCanonical,sourceArchiveDigest} from '../artifacts/fleet_source_archive.js';
type Data=Record<string,any>;
type Tree={files:Map<string,Data>;directories:Map<string,Tree>};
const tree=():Tree=>({files:new Map(),directories:new Map()});
const canonical=sourceArchiveCanonical;
const gitObject=(kind:string,bytes:Buffer)=>createHash('sha1').update(Buffer.from(kind+' '+bytes.length+'\0')).update(bytes).digest('hex');
function refuse():never{throw new Error('RESULT_SOURCE_ARCHIVE_INVALID');}
export function deriveArchiveGitIdentity(value:unknown):{source_object_id:string;source_tree_id:string;commit_bytes:Buffer;archive_digest:string;inventory_digest:string}{
 const archive=validateFleetSourceArchive(value) as Data,root=tree();
 for(const file of archive.files){const parts=file.path.split('/');if(parts.some((part:string)=>part.toLowerCase()==='.git'))refuse();let current=root;for(const part of parts.slice(0,-1)){if(current.files.has(part))refuse();let child=current.directories.get(part);if(!child){child=tree();current.directories.set(part,child);}current=child;}const name=parts.at(-1)!;if(current.files.has(name)||current.directories.has(name))refuse();current.files.set(name,file);}
 const digestTree=(node:Tree):string=>{const entries=[...node.files].map(([name,file])=>({name,sort:name,mode:file.mode,digest:gitObject('blob',Buffer.from(file.content_base64,'base64'))})).concat([...node.directories].map(([name,child])=>({name,sort:name+'/',mode:'40000',digest:digestTree(child)})));entries.sort((a,b)=>Buffer.compare(Buffer.from(a.sort),Buffer.from(b.sort)));return gitObject('tree',Buffer.concat(entries.map(entry=>Buffer.concat([Buffer.from(entry.mode+' '+entry.name+'\0'),Buffer.from(entry.digest,'hex')]))));};
 const archive_digest=sourceArchiveDigest(Buffer.from(canonical(archive))),inventory_digest=sourceArchiveDigest(Buffer.from(canonical(archive.files.map(({content_base64:_content,...file}:Data)=>file))));
 const source_tree_id=digestTree(root),commit_bytes=Buffer.from('tree '+source_tree_id+'\nauthor Hyperfide Source Archive <source-archive@hyperfide.invalid> 0 +0000\ncommitter Hyperfide Source Archive <source-archive@hyperfide.invalid> 0 +0000\n\nDerived representation of FLEET_SOURCE_ARCHIVE_V1\narchive '+archive_digest+'\ninventory '+inventory_digest+'\n');
 return {source_object_id:gitObject('commit',commit_bytes),source_tree_id,commit_bytes,archive_digest,inventory_digest};
}
/** Git objects are a local adapter; the immutable captured archive remains the source authority. */
export async function materializeResultSourceArchive(bytes:Buffer,target:string,expected:Data,home:string):Promise<{source_object_id:string;source_tree_id:string;archive_digest:string;inventory_digest:string}>{
 const archive=validateFleetSourceArchive(JSON.parse(bytes.toString('utf8'))) as Data,derived=deriveArchiveGitIdentity(archive);
 if(sourceArchiveDigest(bytes)!==expected.archive_digest||bytes.toString('utf8')!==canonical(archive)||derived.archive_digest!==expected.archive_digest||derived.inventory_digest!==expected.inventory_digest||canonical(archive.binding)!==canonical(expected.binding)||canonical(archive.baseline)!==canonical(expected.baseline)||derived.source_object_id!==expected.derived_git.source_object_id||derived.source_tree_id!==expected.derived_git.source_tree_id)refuse();
 if(!path.isAbsolute(target)||path.resolve(target)!==target)refuse();const parent=path.dirname(target);if(await fs.realpath(parent)!==parent)refuse();await fs.mkdir(target,{mode:0o700});
 for(const file of archive.files){const destination=path.join(target,file.path);await fs.mkdir(path.dirname(destination),{recursive:true,mode:0o700});await fs.writeFile(destination,Buffer.from(file.content_base64,'base64'),{flag:'wx',mode:file.mode==='100755'?0o755:0o644});await fs.chmod(destination,file.mode==='100755'?0o755:0o644);}
 const run=(args:string[],input?:Buffer)=>execFileSync('/usr/bin/git',['-c','core.hooksPath=/dev/null','-c','maintenance.auto=false','-c','gc.auto=0',...args],{cwd:target,input,encoding:'utf8',timeout:30000,env:{PATH:'/usr/bin:/bin',HOME:home,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}}).trim();
 run(['init','-q','--object-format=sha1']);
 // update-index --cacheinfo binds captured modes and blobs without trusting worktree filters or Git configuration.
 for(const file of archive.files){const blob=run(['hash-object','-w','--stdin'],Buffer.from(file.content_base64,'base64'));run(['update-index','--add','--cacheinfo',file.mode,blob,file.path]);}
 if(run(['write-tree'])!==derived.source_tree_id||run(['hash-object','-t','commit','-w','--stdin'],derived.commit_bytes)!==derived.source_object_id)refuse();
 run(['update-ref','HEAD',derived.source_object_id]);
 if(run(['rev-parse','HEAD'])!==derived.source_object_id||run(['rev-parse','HEAD^{tree}'])!==derived.source_tree_id||run(['status','--porcelain','--untracked-files=all']))refuse();
 for(const file of archive.files){const filename=path.join(target,file.path),st=await fs.lstat(filename);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size!==file.size||sourceArchiveDigest(await fs.readFile(filename))!==file.digest||(st.mode&0o111)!==(file.mode==='100755'?0o111:0))refuse();}
 return {source_object_id:derived.source_object_id,source_tree_id:derived.source_tree_id,archive_digest:derived.archive_digest,inventory_digest:derived.inventory_digest};
}
