import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const directory='/opt/hyperfide/bin',manifest=JSON.parse(await fs.readFile(path.join(directory,'manifest.json'),'utf8'));
if(manifest.schema_version!==1||manifest.platform!=='linux-x64'||manifest.target_uid!==22001||!Array.isArray(manifest.artifacts)||manifest.artifacts.length!==2)throw Error('RUNTIME_MANIFEST_INVALID');
for(const name of ['hyperfide','hyperfide-native']){const entry=manifest.artifacts.find(value=>value.name===name),bytes=await fs.readFile(path.join(directory,name));if(!entry||entry.size!==bytes.length||entry.digest!=='sha256:'+createHash('sha256').update(bytes).digest('hex'))throw Error('RUNTIME_ARTIFACT_MISMATCH');await fs.chmod(path.join(directory,name),0o755);}
const home=manifest.runtime_home;if(typeof home!=='string'||!/^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(home)||!path.isAbsolute(home)||path.normalize(home)!==home||!['/var/lib/hyperfide/','/opt/hyperfide/','/home/hyperfide/'].some(prefix=>home.startsWith(prefix)))throw Error('RUNTIME_HOME_INVALID');
await fs.mkdir(path.dirname(home),{recursive:true,mode:0o755});await fs.mkdir(home,{mode:0o700});await fs.chown(home,manifest.target_uid,manifest.target_uid);await fs.chmod(home,0o700);

const passwd=await fs.readFile('/etc/passwd','utf8'),group=await fs.readFile('/etc/group','utf8'),user=passwd.trim().split('\n').map(line=>line.split(':')).find(fields=>fields[2]==='22001'),existingGroup=group.trim().split('\n').map(line=>line.split(':')).find(fields=>fields[2]==='22001');
if(user&&(user[3]!=='22001'||user[5]!==home))throw Error('RUNTIME_ACCOUNT_CONFLICT');
if(!user){if(passwd.split('\n').some(line=>line.startsWith('hyperfide-control:')))throw Error('RUNTIME_ACCOUNT_CONFLICT');await fs.appendFile('/etc/passwd','hyperfide-control:x:22001:22001:Hyperfide control:'+home+':/usr/sbin/nologin\n');}
if(!existingGroup){if(group.split('\n').some(line=>line.startsWith('hyperfide-control:')))throw Error('RUNTIME_ACCOUNT_CONFLICT');await fs.appendFile('/etc/group','hyperfide-control:x:22001:\n');}
