/** Fixed ROOT probe: requested provider sizes never enter the measured envelope. */
export const BOOTSTRAP_BUDGET_PROBE=String.raw`
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const input=JSON.parse(process.argv[1]);
const read=p=>fs.readFileSync(p,'utf8').trim();
if(process.getuid()!==0)throw Error('BUDGET_ROOT_REQUIRED');
const manifestBytes=fs.readFileSync(input.manifest_path),hash=b=>'sha256:'+require('node:crypto').createHash('sha256').update(b).digest('hex');
if(hash(manifestBytes)!==input.manifest_digest)throw Error('BUDGET_MANIFEST_CHANGED');
const manifest=JSON.parse(manifestBytes);if(Object.keys(manifest.binding).length!==Object.keys(input.binding).length||Object.keys(input.binding).some(key=>manifest.binding[key]!==input.binding[key]))throw Error('BUDGET_BOOT_CHANGED');
const kernel=read('/proc/sys/kernel/random/boot_id');if(kernel!==input.kernel_boot_id)throw Error('BUDGET_KERNEL_CHANGED');
const cgroup=read('/proc/self/cgroup');
const mode=input.measurement_mode,pid1={comm:read('/proc/1/comm'),cmdline:fs.readFileSync('/proc/1/cmdline').toString().split('\0').filter(Boolean),exe:fs.readlinkSync('/proc/1/exe')},cpuinfo=read('/proc/cpuinfo'),online=read('/sys/devices/system/cpu/online');
if(!['CGROUP_V2','BLAXEL_MICROVM_V1'].includes(mode))throw Error('BUDGET_MEASUREMENT_MODE_REQUIRED');
const relative=cgroup.split('\n').find(x=>x.startsWith('0::'))?.slice(3);if(relative===undefined||relative.includes('..'))throw Error('BUDGET_CGROUP_REQUIRED');
let current=path.resolve('/sys/fs/cgroup','.'+relative);if(!current.startsWith('/sys/fs/cgroup'))throw Error('BUDGET_CGROUP_REQUIRED');
const limits=[];for(;;){const item={path:current};for(const name of ['cpu.max','memory.max','cpuset.cpus.effective']){try{item[name]=read(path.join(current,name));}catch{}}limits.push(item);if(current==='/sys/fs/cgroup')break;current=path.dirname(current);}
let cpu=null,memory=null;for(const row of limits){if(row['cpu.max']){const [quota,period]=row['cpu.max'].split(/\s+/);if(quota!=='max'&&/^\d+$/.test(quota)&&/^\d+$/.test(period)&&BigInt(period)>0n){const n=BigInt(quota)*1000n/BigInt(period);cpu=cpu===null||n<cpu?n:cpu;}}if(row['memory.max']&&/^\d+$/.test(row['memory.max'])){const n=BigInt(row['memory.max']);memory=memory===null||n<memory?n:memory;}}
const onlineIds=new Set();for(const range of online.split(',')){const parts=range.split('-').map(Number),first=parts[0],last=parts.length===1?first:parts[1];if(!Number.isSafeInteger(first)||!Number.isSafeInteger(last)||first<0||last<first||last>65535)throw Error('BUDGET_ONLINE_CPU_REQUIRED');for(let n=first;n<=last;n++)onlineIds.add(n);}
const affinity=os.availableParallelism();if(!Number.isSafeInteger(affinity)||affinity<1||affinity>onlineIds.size)throw Error('BUDGET_AFFINITY_REQUIRED');
const meminfo=read('/proc/meminfo'),match=/^MemTotal:\s+(\d+) kB$/m.exec(meminfo);
if(mode==='BLAXEL_MICROVM_V1'){if(!input.provider_limits||!pid1.cmdline.some(arg=>/(?:^|\/)sandbox-api$/.test(arg))||!cpuinfo.includes('hypervisor')||!match)throw Error('BUDGET_MICROVM_ISOLATION_REQUIRED');const guestCpu=BigInt(affinity)*1000n,guestMemory=BigInt(match[1])*1024n;cpu=cpu===null||guestCpu<cpu?guestCpu:cpu;memory=memory===null||guestMemory<memory?guestMemory:memory;cpu=cpu<BigInt(input.provider_limits.cpu_millis)?cpu:BigInt(input.provider_limits.cpu_millis);memory=memory<BigInt(input.provider_limits.memory_bytes)?memory:BigInt(input.provider_limits.memory_bytes);}
if(!match||BigInt(match[1])<1n)throw Error('BUDGET_MEMTOTAL_REQUIRED');memory=memory===null?null:(memory<BigInt(match[1])*1024n?memory:BigInt(match[1])*1024n);
if(cpu===null||memory===null||cpu<=0n||memory<=0n)throw Error('BUDGET_FINITE_CGROUP_REQUIRED');
cpu=cpu<BigInt(affinity)*1000n?cpu:BigInt(affinity)*1000n;
const mountinfo=read('/proc/self/mountinfo'),mounts=mountinfo.split('\n').map(line=>{const [left,right]=line.split(' - '),a=left.split(' '),b=right?.split(' ');if(!b)throw Error('BUDGET_MOUNT_REQUIRED');return {mountpoint:a[4].replace(/\040/g,' '),type:b[0],options:b.slice(2).join(' ')};});
const mountFor=target=>mounts.filter(m=>target===m.mountpoint||target.startsWith(m.mountpoint==='/'?'/':m.mountpoint+'/')).sort((a,b)=>b.mountpoint.length-a.mountpoint.length)[0];
const target=path.dirname(manifest.template.environment_root);let backing=mountFor(target),depth=0;while(backing?.type==='overlay'){if(++depth>4)throw Error('BUDGET_STORAGE_BACKING_REQUIRED');const upper=/(?:^|,)upperdir=([^,]+)/.exec(backing.options)?.[1];if(!upper||!upper.startsWith('/'))throw Error('BUDGET_STORAGE_BACKING_REQUIRED');const next=mountFor(upper);if(!next||next===backing){if(mode==='BLAXEL_MICROVM_V1'&&input.storage_policy==='RESERVE_DISK_FROM_MEMORY'){backing={type:'UNKNOWN',mountpoint:upper};break;}throw Error('BUDGET_STORAGE_BACKING_REQUIRED');}backing=next;}if(!backing||!['tmpfs','ramfs','ext4','xfs','btrfs','UNKNOWN'].includes(backing.type))throw Error('BUDGET_STORAGE_BACKING_REQUIRED');
const stat=fs.statfsSync(target,{bigint:true}),disk=stat.bavail*stat.bsize;
if(disk<1n||stat.blocks<1n||stat.bsize<1n)throw Error('BUDGET_FILESYSTEM_REQUIRED');
console.log(JSON.stringify({schema_version:1,kind:'FLEET_BOOT_BUDGET_MEASUREMENT_V1',binding:input.binding,manifest_digest:input.manifest_digest,kernel_boot_id:kernel,uid:process.getuid(),observed_at:new Date().toISOString(),hard_limits:{cpu_millis:String(cpu),memory_bytes:String(memory),disk_bytes:String(disk)},measurement_mode:mode,evidence:{cgroup,limits,affinity,online_cpus:online,pid1,cpuinfo,meminfo,provider_limits:input.provider_limits??null,contract_sources:input.contract_sources,mountinfo,filesystem:{path:target,backing_type:backing.type,storage_treatment:input.storage_policy==='RESERVE_DISK_FROM_MEMORY'?'CONSERVATIVE_RAM':'UNCONFIRMED',backing_mountpoint:backing.mountpoint,type:String(stat.type),block_size:String(stat.bsize),blocks:String(stat.blocks),available_blocks:String(stat.bavail)}}}));
`;
