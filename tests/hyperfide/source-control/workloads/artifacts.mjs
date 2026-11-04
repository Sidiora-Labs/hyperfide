import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
export async function artifact(filename,directory){
 const stat=await fs.lstat(filename);if(!stat.isFile()||stat.isSymbolicLink())throw Error('Artifact must be a regular file');const hash=createHash('sha256');for await(const bytes of createReadStream(filename))hash.update(bytes);return{path:path.relative(directory,filename),size:stat.size,sha256:'sha256:'+hash.digest('hex')};
}
export async function captureArtifacts(directory){
 const values=[];for(const entry of await fs.readdir(directory,{withFileTypes:true})){if(!entry.isFile()||['receipt.json','verification.json','campaign-state.sqlite'].includes(entry.name)||entry.name.endsWith('.log')||entry.name.includes('.tmp')||entry.name.endsWith('-wal')||entry.name.endsWith('-shm'))continue;values.push(await artifact(path.join(directory,entry.name),directory));}return values.sort((a,b)=>a.path.localeCompare(b.path));
}
export async function verifyArtifacts(directory,records){
 for(const record of records){const filename=path.resolve(directory,record.path);if(!filename.startsWith(path.resolve(directory)+path.sep))throw Error('Artifact escapes campaign directory');const current=await artifact(filename,directory);if(current.size!==record.size||current.sha256!==record.sha256)throw Error('Campaign artifact changed: '+record.path);}
}
