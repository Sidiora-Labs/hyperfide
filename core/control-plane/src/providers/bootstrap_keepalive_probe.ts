/** Keeps only the already enrolled observer awake; it has no daemon or worker launch authority. */
export const BOOTSTRAP_KEEPALIVE_PROBE=String.raw`
const fs=require('node:fs'),crypto=require('node:crypto');
const input=JSON.parse(process.argv[1]);
const fail=()=>{throw Error('BOOTSTRAP_KEEPALIVE_IDENTITY');};
const digest=bytes=>'sha256:'+crypto.createHash('sha256').update(bytes).digest('hex');
if(digest(fs.readFileSync(input.manifest_path))!==input.manifest_digest)fail();
const manifest=JSON.parse(fs.readFileSync(input.manifest_path,'utf8'));
if(manifest.bootstrap_id!==input.binding.provisioning_intent_id||manifest.binding.boot_id!==input.binding.boot_id||manifest.binding.sandbox_id!==input.binding.sandbox_id||!Number.isSafeInteger(input.daemon.pid)||!Number.isSafeInteger(input.daemon.pgid)||!Number.isFinite(input.deadline_ms))fail();
const check=()=>{if(fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()!==input.daemon.os_boot_id)fail();const stat=fs.readFileSync('/proc/'+input.daemon.pid+'/stat','utf8'),tail=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/);if(tail[0]==='Z'||tail[0]==='X'||tail[2]!==String(input.daemon.pgid)||tail[19]!==input.daemon.start_time)fail();};
if(Date.now()>=input.deadline_ms)fail();check();process.stdout.write(JSON.stringify({schema_version:1,kind:'FLEET_BOOTSTRAP_KEEPALIVE_V1',request_digest:input.request_digest,binding:input.binding,daemon:input.daemon,deadline_at:new Date(input.deadline_ms).toISOString()})+'\n');
const timer=setInterval(()=>{try{check();if(Date.now()>=input.deadline_ms){clearInterval(timer);process.exit(0);}}catch{clearInterval(timer);process.exit(78);}},1000);
`;
