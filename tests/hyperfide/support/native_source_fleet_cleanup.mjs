import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {promisify} from 'node:util';

const execute=promisify(execFile);
const sha=value=>'sha256:'+createHash('sha256').update(JSON.stringify(value)).digest('hex');
const workerProgram=`
const fs=require('node:fs');
fs.writeFileSync('main.txt',process.argv[1]);
const stat=fs.readFileSync('/proc/self/stat','utf8');
console.log(JSON.stringify({pid:process.pid,start_time:stat.slice(stat.lastIndexOf(')')+2).split(/\\s+/)[19],os_boot_id:fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),uid:process.getuid(),gid:process.getgid()}));
`;

async function observeAbsent(observation){
 assert.equal(process.platform,'linux');
 assert.equal((await fs.readFile('/proc/sys/kernel/random/boot_id','utf8')).trim(),observation.os_boot_id);
 assert.ok(Number.isSafeInteger(observation.pid)&&observation.pid>1);
 assert.ok(Number.isSafeInteger(observation.uid)&&observation.uid>0);
 assert.match(observation.start_time,/^[1-9][0-9]*$/);
 try{
  const current=await fs.readFile('/proc/'+observation.pid+'/stat','utf8');
  assert.notEqual(current.slice(current.lastIndexOf(')')+2).split(/\s+/)[19],observation.start_time,'owned worker process still exists');
 }catch(error){if(error.code!=='ENOENT')throw error;}
 const pids=(await fs.readdir('/proc')).filter(name=>/^[1-9][0-9]*$/.test(name));
 assert.ok(pids.length<100000,'local process observation exceeds its bound');
 for(const pid of pids){
  let status;
  try{status=await fs.readFile('/proc/'+pid+'/status','utf8');}catch(error){if(error.code==='ENOENT'||error.code==='ESRCH')continue;throw error;}
  const uids=/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(status);
  if(uids?.slice(1).some(value=>Number(value)===observation.uid)&&!/^State:\s+[ZX]\b/m.test(status))assert.fail('worker UID still has a live process: '+pid);
 }
 return {observed_at:new Date().toISOString(),pid:observation.pid,start_time:observation.start_time,os_boot_id:observation.os_boot_id,uid:observation.uid,gid:observation.gid,process_absent:true,uid_processes_absent:true};
}

export async function runLocalFleetWorker({root,text,uid,gid,executable=process.execPath}){
 const pending=execute(executable,['-e',workerProgram,text],{cwd:root,uid,gid,env:{PATH:path.dirname(executable),LANG:'C.UTF-8'},timeout:30000,maxBuffer:65536});
 const pid=pending.child.pid;
 const result=await pending;
 assert.equal(result.stderr,'');
 const observation=JSON.parse(result.stdout);
 assert.equal(observation.pid,pid);assert.equal(observation.uid,uid);assert.equal(observation.gid,gid);
 await observeAbsent(observation);
 return {bytes:await fs.readFile(path.join(root,'main.txt')),observation};
}

export async function releaseObservedFleetCompute({resources,controlRoot,scope,attemptId,observation,evidencePath}){
 const {ResourceScheduler}=await import(pathToFileURL(path.join(controlRoot,'scheduler/resources.js')));
 const id=randomUUID(),physical=await observeAbsent(observation);
 const receipt={schema_version:1,kind:'LOCAL_WORKER_PROCESS_ABSENCE',id,scope,attempt_id:attemptId,...physical};
 const digest=sha(receipt);
 await fs.writeFile(evidencePath,JSON.stringify({...receipt,digest},null,2)+'\n',{flag:'wx',mode:0o600});
 const scheduler=new ResourceScheduler();
 try{
  return await resources.gateway.withPrimaryTransaction({timeoutMs:15000,maxRetries:2},async tx=>{
   const rows=(await tx.query(`SELECT r.id,a.capacity_class,r.state FROM hyperfide.reservations r JOIN hyperfide.capacity_accounts a ON a.organisation_id=r.organisation_id AND a.id=r.capacity_account_id WHERE r.organisation_id=$1 AND r.run_id=$2 AND r.attempt_id=$3 ORDER BY r.id FOR SHARE OF r,a`,[scope.organisation_id,scope.run_id,attemptId])).rows;
   assert.ok(rows.length>0,'actual compute reservation required');
   assert.ok(rows.every(row=>row.capacity_class!=='PHYSICAL'&&row.state==='RELEASE_PENDING'),'logical compute release must precede local physical observation');
   const ids=new Set(rows.map(row=>row.id));
   scheduler.registerProofReader('runner.quiescence',async(_tx,request)=>{
    if(request.organisation_id!==scope.organisation_id||request.run_id!==scope.run_id||!ids.has(request.reservation_id))return null;
    await observeAbsent(observation);
    return {id,digest,observed_at:physical.observed_at};
   });
   try{return await scheduler.release(tx,{...scope,reservation_ids:[...ids]});}
   catch(error){console.error(JSON.stringify({stage:'native-fleet-release',code:error.code,message:error.message,constraint:error.constraint,detail:error.detail}));throw error;}
  });
 }finally{scheduler.close();}
}
