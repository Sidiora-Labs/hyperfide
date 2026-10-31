import fs from 'node:fs/promises';
import path from 'node:path';
import {fail} from '../transport/protocol.js';
import type {InstallAdmission} from './fleet_client.js';
import {canonicalJSON} from './manifests.js';

type RecordValue=Record<string,any>;
export interface FleetIsolationSlot {slot:number;worker_slot_id:string;slot_generation:string;uid:number;gid:number;worker_root:string;source:string;home:string;build:string;temporary:string;dirty:string}
export interface FleetIsolationReceipt {schema_version:1;operation_id:string;prepared_receipt_digest:string;environment_id:string;environment_generation:number;input_digest:string;method:'UNIX_UID_GID';status:'ENFORCED';slots:FleetIsolationSlot[]}
const roots=['source','home','build','temporary','dirty'] as const;
function refused(message:string):never{return fail('FLEET_INSTALL_ISOLATION',message);}
function inside(root:string,target:string):void{const relative=path.relative(root,target);if(!path.isAbsolute(target)||path.resolve(target)!==target||!relative||relative==='..'||relative.startsWith('../')||path.isAbsolute(relative))refused('Worker path must remain inside its admitted root');}
async function ancestors(root:string):Promise<void>{
 let current=path.dirname(root);
 while(true){const st=await fs.lstat(current);if(!st.isDirectory()||st.isSymbolicLink()||(st.mode&0o022)!==0&&!(st.uid===0&&(st.mode&0o1000)!==0)||(st.mode&0o001)===0)refused('Prepared environment requires protected traversable parent directories');const parent=path.dirname(current);if(parent===current)break;current=parent;}
}
function slots(admission:InstallAdmission,receipt:RecordValue,preparedRoot:string):FleetIsolationSlot[]{
 if(receipt.operation_id!==admission.operation_id||receipt.environment_id!==admission.environment_id||receipt.environment_generation!==admission.environment_generation||receipt.admission_digest!==admission.admission_digest||receipt.prepared_root!==preparedRoot||(admission as unknown as RecordValue).environment_root!==preparedRoot||!path.isAbsolute(preparedRoot)||path.resolve(preparedRoot)!==preparedRoot)refused('Prepared receipt differs from current admitted environment');
 const bindings=admission.slot_bindings as unknown as FleetIsolationSlot[],records=receipt.slots as RecordValue[];
 if(!Array.isArray(bindings)||!bindings.length||bindings.length>1024||!Array.isArray(records)||records.length!==bindings.length)refused('Every worker requires an admitted private identity');
 const seenUid=new Set<number>(),seenGid=new Set<number>(),seenRoot:string[]=[];
 for(const b of bindings){
  if(!Number.isSafeInteger(b.uid)||b.uid<1||b.uid>2147483647||!Number.isSafeInteger(b.gid)||b.gid<1||b.gid>2147483647||seenUid.has(b.uid)||seenGid.has(b.gid)||!Number.isSafeInteger(b.slot)||b.slot<0||typeof b.slot_generation!=='string'||!(/^[1-9][0-9]*$/).test(b.slot_generation))refused('Admitted workers require distinct nonroot UID and GID identities');
  seenUid.add(b.uid);seenGid.add(b.gid);inside(preparedRoot,b.worker_root);
  if(seenRoot.some(other=>b.worker_root===other||b.worker_root.startsWith(other+'/')||other.startsWith(b.worker_root+'/')))refused('Worker roots cannot overlap');seenRoot.push(b.worker_root);
  const row=records.filter(r=>r.slot===b.slot&&r.worker_slot_id===b.worker_slot_id);if(row.length!==1)refused('Receipt worker identity differs');
  for(const name of roots){inside(b.worker_root,b[name]);if(row[0]![name]!==b[name])refused('Receipt worker path differs from admitted slot');}
  for(const name of roots)for(const other of roots)if(name!==other&&(b[name]===b[other]||b[name].startsWith(b[other]+'/')))refused('Writable worker roots must remain separate');
 }
 return bindings.map(b=>({...b}));
}
async function walk(root:string,directory:string,uid:number,gid:number,apply:boolean):Promise<void>{
 const st=await fs.lstat(directory);
 if(st.isSymbolicLink()){
  const target=await fs.readlink(directory);if(path.isAbsolute(target))refused('Absolute private-view symlinks are unsupported');inside(root,path.resolve(path.dirname(directory),target));
  if(apply)await fs.lchown(directory,uid,gid);else if(st.uid!==uid||st.gid!==gid)refused('Private symlink identity differs');return;
 }
 if(!st.isDirectory()&&!st.isFile()||st.isFile()&&st.nlink!==1)refused('Private views cannot contain devices or mutable hardlinks');
 if(st.isDirectory())for(const entry of await fs.readdir(directory))await walk(root,path.join(directory,entry),uid,gid,apply);
 const mode=st.isDirectory()?0o700:st.mode&0o700;
 if(apply){await fs.chown(directory,uid,gid);await fs.chmod(directory,mode);}else if(st.uid!==uid||st.gid!==gid||(st.mode&0o777)!==mode)refused('Private tree ownership or mode differs');
}
export async function finalizeFleetIsolation(input:{admission:InstallAdmission;receipt:RecordValue;preparedRoot:string}):Promise<FleetIsolationReceipt>{
 if(process.getuid?.()!==0)refused('UID isolation finalization requires the admitted privileged runner');
 const selected=slots(input.admission,input.receipt,input.preparedRoot);await ancestors(input.preparedRoot);
 const base=await fs.lstat(input.preparedRoot);if(!base.isDirectory()||base.isSymbolicLink())refused('Prepared root must be an ordinary directory');
 for(const b of selected){
  let ancestor=path.dirname(b.worker_root);while(ancestor!==input.preparedRoot){inside(input.preparedRoot,ancestor);const st=await fs.lstat(ancestor);if(!st.isDirectory()||st.isSymbolicLink())refused('Private view ancestors must be ordinary directories');await fs.chown(ancestor,0,0);await fs.chmod(ancestor,0o711);ancestor=path.dirname(ancestor);}
  const barrier=await fs.lstat(b.worker_root);if(!barrier.isDirectory()||barrier.isSymbolicLink())refused('Worker barrier must be an ordinary directory');
  for(const name of roots)await walk(b.worker_root,b[name],b.uid,b.gid,true);
  await fs.chown(b.worker_root,0,b.gid);await fs.chmod(b.worker_root,0o710);
 }
 await fs.chown(input.preparedRoot,0,0);await fs.chmod(input.preparedRoot,0o711);
 const isolation:FleetIsolationReceipt={schema_version:1,operation_id:input.admission.operation_id,prepared_receipt_digest:input.receipt.receipt_digest,environment_id:input.admission.environment_id,environment_generation:input.admission.environment_generation,input_digest:input.admission.input_digest,method:'UNIX_UID_GID',status:'ENFORCED',slots:selected};
 await verifyFleetIsolation({...input,isolation});return isolation;
}
export async function verifyFleetIsolation(input:{admission:InstallAdmission;receipt:RecordValue;preparedRoot?:string;isolation:FleetIsolationReceipt}):Promise<void>{
 const preparedRoot=input.preparedRoot??input.receipt.prepared_root,selected=slots(input.admission,input.receipt,preparedRoot),p=input.isolation;
 if(p.schema_version!==1||p.method!=='UNIX_UID_GID'||p.status!=='ENFORCED'||p.operation_id!==input.admission.operation_id||p.prepared_receipt_digest!==input.receipt.receipt_digest||p.environment_id!==input.admission.environment_id||p.environment_generation!==input.admission.environment_generation||p.input_digest!==input.admission.input_digest||canonicalJSON(p.slots)!==canonicalJSON(selected))refused('Isolation evidence differs from admitted environment');
 await ancestors(preparedRoot);
 const base=await fs.lstat(preparedRoot);if(!base.isDirectory()||base.isSymbolicLink()||base.uid!==0||(base.mode&0o777)!==0o711)refused('Prepared generation traversal differs');
 for(const b of selected){const barrier=await fs.lstat(b.worker_root);if(!barrier.isDirectory()||barrier.isSymbolicLink()||barrier.uid!==0||barrier.gid!==b.gid||(barrier.mode&0o777)!==0o710)refused('Worker barrier differs');for(const name of roots)await walk(b.worker_root,b[name],b.uid,b.gid,false);}
}
