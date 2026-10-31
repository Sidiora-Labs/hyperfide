#!/usr/bin/env python3
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[4]
OUT=ROOT/'build/fleet/isolation'
SCRIPT=r'''
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {finalizeFleetIsolation,verifyFleetIsolation} from './core/control-plane/dist/preparation/fleet_isolation.js';
if(process.getuid()!==0)throw new Error('Actual privileged UID transition required');
for(const entry of await fs.readdir('/proc')){if(!/^\d+$/.test(entry))continue;try{const status=await fs.readFile('/proc/'+entry+'/status','utf8');const uid=Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]);if([61811,61812].includes(uid))throw new Error('Test UID is already active');}catch(error){if(!['ENOENT','ESRCH'].includes(error.code))throw error;}}
const parent=await fs.mkdtemp('/tmp/hyperfide-isolation-');await fs.chmod(parent,0o711);
const done=[];
async function fixture(name,mutate){
 const root=path.join(parent,name);await fs.mkdir(root,{mode:0o700});
 const slots=[];
 for(let slot=0;slot<2;slot++){
  const worker_root=path.join(root,'workers',String(slot)),record={slot,worker_slot_id:randomUUID(),slot_generation:'1',uid:61811+slot,gid:61811+slot,worker_root};
  for(const field of ['source','home','build','temporary','dirty']){record[field]=path.join(worker_root,field);await fs.mkdir(record[field],{recursive:true,mode:0o700});}
  await fs.writeFile(path.join(record.source,'owned.txt'),'worker-'+slot,{mode:0o600});await fs.writeFile(path.join(record.source,'.neron'),'pinned-source-config\n',{mode:0o600});slots.push(record);
 }
 const admission={operation_id:randomUUID(),environment_id:name,environment_generation:1,environment_root:root,input_digest:'sha256:'+'a'.repeat(64),admission_digest:'sha256:'+'b'.repeat(64),slot_bindings:slots};
 const receipt={operation_id:admission.operation_id,environment_id:name,environment_generation:1,admission_digest:admission.admission_digest,prepared_root:root,receipt_digest:'sha256:'+'c'.repeat(64),slots:slots.map(s=>({slot:s.slot,worker_slot_id:s.worker_slot_id,...Object.fromEntries(['source','home','build','temporary','dirty'].map(k=>[k,s[k]]))}))};
 if(mutate)await mutate(slots);
 return {admission,receipt,preparedRoot:root};
}
const workerEnv=slot=>({PATH:'/usr/bin:/bin',HOME:slot.home,TMPDIR:slot.temporary,LANG:'C.UTF-8',LC_ALL:'C.UTF-8'});
function run(slot,own,other){
 const body=`import json,os\nown=${JSON.stringify(own)}\nother=${JSON.stringify(other)}\nassert open(own+'/source/owned.txt').read()=='worker-${slot.slot}'\nopen(own+'/build/output','w').write('ok')\nfor target in [other+'/source/owned.txt',other+'/home/steal']:\n try:\n  open(target,'r' if target.endswith('owned.txt') else 'w')\n except PermissionError:\n  pass\n else:\n  raise AssertionError('Cross-worker access succeeded')\ntry:\n os.chmod(own,0o777)\nexcept PermissionError:\n pass\nelse:\n raise AssertionError('Worker altered root-owned isolation barrier')\nprint('uid-access-pass')\n`;
 const r=spawnSync('/usr/bin/setpriv',['--reuid',String(slot.uid),'--regid',String(slot.gid),'--clear-groups','/usr/bin/python3','-c',body],{encoding:'utf8',env:workerEnv(slot)});
 if(r.status!==0)throw new Error('Actual worker UID '+slot.uid+' failed: '+r.stderr);
}
try{
 const current=await fixture('generation');const proof=await finalizeFleetIsolation(current);
 await verifyFleetIsolation({...current,isolation:proof});done.push('actual-private-ownership');
 for(const slot of current.admission.slot_bindings)run(slot,slot.worker_root,current.admission.slot_bindings[1-slot.slot].worker_root);
 done.push('two-distinct-kernel-uids-cross-read-and-write-denied');done.push('root-owned-barrier-cannot-be-chmodded');
 const runtime=path.join(parent,'runtime');
 const modules=['preparation/fleet_readiness_probe.js','preparation/fleet_readiness_contract.js','preparation/fleet_install_inventory.js','preparation/fleet_toolchains.js','preparation/fleet_configurations.js','preparation/fleet_client.js','transport/protocol.js','policy/programme.js','contracts/fleet/index.mjs'];
 await fs.mkdir(runtime,{mode:0o755});const probeNode=path.join(runtime,'node');await fs.copyFile(process.execPath,probeNode);await fs.chmod(probeNode,0o555);await fs.writeFile(path.join(runtime,'package.json'),'{}');
 for(const name of modules){const target=path.join(runtime,name);await fs.mkdir(path.dirname(target),{recursive:true,mode:0o755});await fs.copyFile(path.join('core/control-plane/dist',name),target);await fs.chmod(target,0o444);}
 await fs.writeFile(path.join(runtime,'package.json'),'{"type":"module"}\n',{mode:0o644});
 const sha=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
 const interfacePath=path.join(current.preparedRoot,'interfaces.kvx');await fs.writeFile(interfacePath,'[interface.test]\nkind = \"function\"\npath = \"owned.txt\"\nline = 1\nsignature = \"test()\"\ncallers = []\nstatus = \"active\"\ncontract = \"UID access gate\"\nnotes = \"\"\n',{mode:0o444});
 const slot=current.admission.slot_bindings[0],input={schema_version:1,kind:'FLEET_MANIFEST_V1',operation_id:current.admission.operation_id,environment_root:current.preparedRoot,admission_digest:current.admission.admission_digest,plan_digest:'sha256:'+'d'.repeat(64),package_digest:'sha256:'+'e'.repeat(64),source_manifest_digest:'sha256:'+'f'.repeat(64),source_revision:'git:'+'a'.repeat(40),slot,source_files:[{path:'owned.txt',mode:'100644',size:8,digest:sha('worker-0')}],source_config_digest:sha('pinned-source-config\n'),dependency_inventory_digest:sha('{"entries":[],"kind":"hyperfide.installed-dependency-inventory","schema_version":1}'),toolchain_manifest:{},toolchains:[],configurations:[],interfaces:{target:interfacePath,digest:sha('[interface.test]\nkind = \"function\"\npath = \"owned.txt\"\nline = 1\nsignature = \"test()\"\ncallers = []\nstatus = \"active\"\ncontract = \"UID access gate\"\nnotes = \"\"\n'),catalogue_digest:sha('[interface.test]\nkind = \"function\"\npath = \"owned.txt\"\nline = 1\nsignature = \"test()\"\ncallers = []\nstatus = \"active\"\ncontract = \"UID access gate\"\nnotes = \"\"\n'),source_revision:'git:'+'a'.repeat(40),selected_ids:['interface.test'],max_bytes:65536,max_blocks:10},probes:[],source_state_digest:'sha256:'+'1'.repeat(64),workspace_digest:'sha256:'+'2'.repeat(64)};
 function probe(){return spawnSync('/usr/bin/setpriv',['--reuid',String(slot.uid),'--regid',String(slot.gid),'--clear-groups',probeNode,path.join(runtime,'preparation/fleet_readiness_probe.js')],{input:JSON.stringify(input),encoding:'utf8',env:workerEnv(slot)});}
 let measured=probe();if(measured.status!==0||JSON.parse(measured.stdout).status!=='READY')throw new Error('Actual UID manifest measurement failed: '+measured.stderr);done.push('actual-worker-uid-manifest-measurement');
 let mutation=spawnSync('/usr/bin/setpriv',['--reuid',String(slot.uid),'--regid',String(slot.gid),'--clear-groups','/usr/bin/python3','-c',"from pathlib import Path;Path("+JSON.stringify(path.join(slot.source,'owned.txt'))+").write_text('changed')"],{encoding:'utf8',env:workerEnv(slot)});if(mutation.status!==0)throw new Error('Worker source mutation failed');
 if(probe().status===0)throw new Error('Stale source bytes accepted as ready');done.push('actual-worker-source-corruption-refused');
 mutation=spawnSync('/usr/bin/setpriv',['--reuid',String(slot.uid),'--regid',String(slot.gid),'--clear-groups','/usr/bin/python3','-c',"from pathlib import Path;r=Path("+JSON.stringify(slot.source)+");(r/'owned.txt').write_text('worker-0');(r/'node_modules'/'owned-dependency').mkdir(parents=True);(r/'node_modules'/'owned-dependency'/'index.js').write_text('unexpected dependency')"],{encoding:'utf8',env:workerEnv(slot)});if(mutation.status!==0)throw new Error('Worker dependency mutation failed');
 if(probe().status===0)throw new Error('Changed dependency closure accepted as ready');done.push('actual-worker-dependency-corruption-refused');

 const duplicate=await fixture('duplicate');duplicate.admission.slot_bindings[1].uid=duplicate.admission.slot_bindings[0].uid;
 let refused=false;try{await finalizeFleetIsolation(duplicate);}catch(e){if(e.code==='FLEET_INSTALL_ISOLATION')refused=true;else throw e;}if(!refused)throw new Error('Duplicate worker UID admitted');done.push('duplicate-uid-refused');
 const escaped=await fixture('escaped',async slots=>{await fs.symlink('/etc/passwd',path.join(slots[0].source,'escape'));});refused=false;
 try{await finalizeFleetIsolation(escaped);}catch(e){if(e.code==='FLEET_INSTALL_ISOLATION')refused=true;else throw e;}if(!refused)throw new Error('Absolute private symlink admitted');done.push('escaping-symlink-refused');
 const outside=path.join(parent,'outside');await fs.writeFile(outside,'outside');
 const linked=await fixture('hardlink',async slots=>{await fs.link(outside,path.join(slots[0].source,'hardlink'));});refused=false;
 try{await finalizeFleetIsolation(linked);}catch(e){if(e.code==='FLEET_INSTALL_ISOLATION')refused=true;else throw e;}if(!refused||(await fs.stat(outside)).uid!==0)throw new Error('Mutable hardlink accepted or outside ownership changed');done.push('hardlink-refused-with-outside-owner-preserved');
 console.log(JSON.stringify({status:'PASS',scope:'actual-unix-uid-filesystem-isolation',checks:done,uid_values:current.admission.slot_bindings.map(s=>s.uid)}));
}finally{await fs.rm(parent,{recursive:true,force:true});}
'''

def main():
 OUT.mkdir(parents=True,exist_ok=True)
 if os.geteuid()!=0:
  print('Actual root-owned worker UID isolation requires an isolated privileged test host',file=sys.stderr)
  return 77
 result=subprocess.run(['node','--input-type=module','-e',SCRIPT],cwd=ROOT,text=True,capture_output=True,timeout=60)
 (OUT/'gate.log').write_text(result.stdout+result.stderr)
 if result.returncode:
  print(result.stderr,file=sys.stderr)
  return result.returncode
 report=json.loads(result.stdout)
 (OUT/'receipt.json').write_text(json.dumps(report,indent=2)+'\n')
 print(json.dumps(report))
 return 0

if __name__=='__main__':raise SystemExit(main())
