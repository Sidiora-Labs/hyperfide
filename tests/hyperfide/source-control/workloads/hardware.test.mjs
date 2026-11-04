import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {hierarchyLimits,resolveCgroups,cgroupIdentity} from './hardware.mjs';
import {machineIdentity} from './campaign.mjs';
import {deploymentIdentity,observerCounters} from './deployment.mjs';

test('v2 and v1 membership resolve through their actual mount roots',()=>{
 const mounts='31 20 0:30 /parent /sys/fs/cgroup rw - cgroup2 cgroup rw\n32 20 0:31 / /sys/fs/cgroup/cpu rw - cgroup cgroup rw,cpu,cpuacct';
 const rows=resolveCgroups('0::/parent/child\n2:cpu,cpuacct:/slice/job',mounts);
 assert.equal(rows[0].directory,'/sys/fs/cgroup/child');
 assert.equal(rows[1].directory,'/sys/fs/cgroup/cpu/slice/job');
 assert.equal(resolveCgroups('0::/outside',mounts).length,0);
});

test('real limit files include ancestor quotas and change the captured profile',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'hf-cgroup-profile-'));
 try{
  const child=path.join(root,'child');await fs.mkdir(child);
  await fs.writeFile(path.join(root,'cpu.max'),'100000 100000\n');
  await fs.writeFile(path.join(child,'cpu.max'),'max 100000\n');
  await fs.writeFile(path.join(root,'memory.max'),'104857600\n');
  await fs.writeFile(path.join(child,'cpuset.cpus.effective'),'2-3\n');
  const before=hierarchyLimits(child,root,'v2');
  assert.equal(before.levels[0].limits['cpu.max'].value,'max 100000');
  assert.equal(before.levels[1].limits['cpu.max'].value,'100000 100000');
  assert.equal(before.levels[0].limits['memory.max'].state,'unknown');
  await fs.writeFile(path.join(root,'cpu.max'),'200000 100000\n');
  assert.notDeepEqual(hierarchyLimits(child,root,'v2'),before);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('machine identity includes actual available parallelism and explicit cgroup state',()=>{
 const identity=machineIdentity();
 assert.equal(identity.value.available_parallelism,os.availableParallelism());
 assert(['observed','unknown'].includes(cgroupIdentity().state));
 assert.deepEqual(identity.value.cgroups,cgroupIdentity());
 assert.match(identity.digest,/^sha256:[0-9a-f]{64}$/);
});

test('observer refuses a changed server deployment or resource profile',()=>{
 const identity={provider:'owned-provider',service_id:'service',deployment_id:'deployment',image_digest:'sha256:'+'a'.repeat(64),resource_profile_digest:'sha256:'+'b'.repeat(64)};
 deploymentIdentity(identity);
 const counters={backend_identity:'owned-store',real_s3:true,deployment_identity:identity};
 for(const key of ['persisted_revisions','storage_requests','storage_bytes','storage_read_bytes','storage_offered_write_bytes','storage_acknowledged_write_bytes','storage_unknown_write_lengths','storage_failed_write_requests','storage_unknown_write_outcomes','hydrated_bytes','cache_hits','cache_misses','queue_depth','lock_wait_ms','connection_count','publication_lag_ms'])counters[key]=0;
 observerCounters(counters,'owned-store',identity);
 assert.throws(()=>observerCounters({...counters,deployment_identity:{...identity,deployment_id:'other'}},'owned-store',identity));
 assert.throws(()=>observerCounters({...counters,deployment_identity:{...identity,resource_profile_digest:'sha256:'+'c'.repeat(64)}},'owned-store',identity));
});
