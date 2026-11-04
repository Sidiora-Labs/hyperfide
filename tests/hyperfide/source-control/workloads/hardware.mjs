import {openSync,readSync,closeSync} from 'node:fs';
import path from 'node:path';

function smallFile(filename,maximum=4096){
 let fd;
 try{
  fd=openSync(filename,'r');const bytes=Buffer.alloc(maximum+1);let length=0;
  while(length<bytes.length){const n=readSync(fd,bytes,length,bytes.length-length,null);if(!n)break;length+=n;}
  return length>maximum?{state:'unknown',reason:'bounded-read-exceeded'}:{state:'observed',value:bytes.subarray(0,length).toString('utf8').trim()};
 }catch(error){return {state:'unknown',reason:error.code??'unreadable'};}
 finally{if(fd!==undefined)closeSync(fd);}
}

const FILES={
 v2:['cpu.max','memory.max','cpuset.cpus.effective','cpuset.cpus','pids.max'],
 v1:['cpu.cfs_quota_us','cpu.cfs_period_us','memory.limit_in_bytes','cpuset.cpus','cpuset.effective_cpus','pids.max'],
};

/** Read every exposed ancestor limit; parent quotas can constrain an unlimited child. */
export function hierarchyLimits(directory,mountpoint,version){
 directory=path.resolve(directory);mountpoint=path.resolve(mountpoint);
 if(directory!==mountpoint&&!directory.startsWith(mountpoint+path.sep))return {state:'unknown',reason:'membership-outside-mount'};
 const levels=[];let current=directory;
 for(let depth=0;depth<32;depth++){
  levels.push({depth,limits:Object.fromEntries(FILES[version].map(name=>[name,smallFile(path.join(current,name))]))});
  if(current===mountpoint)return {state:'observed',levels};
  current=path.dirname(current);
 }
 return {state:'unknown',reason:'ancestor-depth-exceeded',levels};
}

const unescapeMount=value=>value.replace(/\\([0-7]{3})/g,(_,octal)=>String.fromCharCode(parseInt(octal,8)));
export function resolveCgroups(membership,mountinfo){
 const memberships=membership.split('\n').filter(Boolean).map(line=>{
  const parts=line.split(':');return {controllers:(parts[1]??'').split(',').filter(Boolean),directory:parts.slice(2).join(':')};
 });
 const result=[];
 for(const line of mountinfo.split('\n')){
  const split=line.split(' - ');if(split.length!==2)continue;
  const before=split[0].split(' '),after=split[1].split(' '),kind=after[0]==='cgroup2'?'v2':after[0]==='cgroup'?'v1':null;
  if(!kind)continue;
  const mountRoot=unescapeMount(before[3]??''),mountpoint=unescapeMount(before[4]??'');
  const controllers=(after[2]??'').split(',');
  const member=memberships.find(value=>kind==='v2'?value.controllers.length===0:value.controllers.some(controller=>controllers.includes(controller)));
  if(!member||!path.isAbsolute(mountRoot)||!path.isAbsolute(mountpoint)||!path.isAbsolute(member.directory))continue;
  let relative;
  if(member.directory===mountRoot)relative='';
  else if(mountRoot==='/')relative=member.directory.slice(1);
  else if(member.directory.startsWith(mountRoot+'/'))relative=member.directory.slice(mountRoot.length+1);
  else continue;
  if(relative.split('/').some(part=>part==='..'))continue;
  result.push({version:kind,controllers:member.controllers,mountpoint,directory:path.join(mountpoint,relative)});
 }
 return result;
}

export function cgroupIdentity(){
 const membership=smallFile('/proc/self/cgroup',65536),mounts=smallFile('/proc/self/mountinfo',262144);
 if(membership.state!=='observed'||mounts.state!=='observed')return {state:'unknown',membership_state:membership.state,mount_state:mounts.state};
 const resolved=resolveCgroups(membership.value,mounts.value);
 if(!resolved.length)return {state:'unknown',reason:'no-exposed-cgroup-membership'};
 return {state:'observed',hierarchies:resolved.map(item=>({...item,...hierarchyLimits(item.directory,item.mountpoint,item.version)}))};
}
