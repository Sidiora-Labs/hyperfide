"""Disposable fleet qualification fixture.

FLEET_PROJECTION is the removable local interface for unmerged tasks 5.3-5.6.
It uses local Git repositories as fake machines; no cloud or model is contacted.
"""
from pathlib import Path
import json
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]


class PlatformBuildAbsent(Exception):
    pass


def run_fleet():
    tsx = ROOT / 'platform/node_modules/.bin/tsx'
    if not tsx.is_file():
        raise PlatformBuildAbsent('platform dependencies absent; run pnpm -C platform install')
    with tempfile.TemporaryDirectory(prefix='hyperfide-fleet-') as directory:
        entry = Path(directory) / 'fleet-projection.mts'
        entry.write_text(FLEET_PROJECTION)
        result = subprocess.run([str(tsx), str(entry), directory], cwd=ROOT,
                                capture_output=True, text=True, timeout=120)
        if result.returncode:
            raise RuntimeError(f'fleet fixture failed ({result.returncode}):\n{result.stderr}\n{result.stdout}')
        return json.loads(result.stdout)


FLEET_PROJECTION = r'''
import {execFileSync, spawn} from 'node:child_process';
import {mkdirSync, writeFileSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
const root = process.argv[2];
const repo = join(root, 'integration');
const git = (cwd, ...args) => execFileSync('git', args, {cwd, encoding:'utf8',
  env:{...process.env, GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'/dev/null'}}).trim();
const identity = cwd => {git(cwd,'config','user.name','Hyperfide fixture'); git(cwd,'config','user.email','fixture@hyperfide.test');};
mkdirSync(repo);
git(repo,'init','-b','main'); identity(repo);
mkdirSync(join(repo,'spec/fleet'),{recursive:true});
const spec = ['A','B','C'].map(id => `[task.${id}]\nstatus = "pending"\nrequires = ${id === 'A' ? '[]' : '["A"]'}\n`).join('\n');
writeFileSync(join(repo,'spec/fleet/spec.kvx'),spec);
git(repo,'add','.'); git(repo,'commit','-m','Create fleet spec');
const initial = git(repo,'rev-parse','HEAD');
const machines = [], events = [], ledgers = [];
let tick = 0, active = 0, peak = 0;
const cap = 2, keys = ['fixture-key-1', 'fixture-key-2'], leasedKeys = new Set();
const event = (job,state) => {const item={task:job.task,state,sequence:++tick}; events.push(item); job.timeline.push(item); job.state=state;};
class FakeMachineProvider {
  create(checkpoint) {
    const machine={id:`machine-${machines.length+1}`,provider:'fake',state:'running',checkpoint,path:join(root,`machine-${machines.length+1}`)};
    mkdirSync(machine.path); machines.push(machine); return machine;
  }
  upload(machine,bundle) {git(machine.path,'clone','-b','main',bundle,'.');identity(machine.path);}
  destroy(machine) {machine.state='destroyed';}
}
const provider = new FakeMachineProvider();
const storage = join(root,'ledger.json');
const persist = () => writeFileSync(storage,JSON.stringify(ledgers));
// The image builder executes local base steps against the uploaded commit bundle.
const builder=provider.create('parent');
const baseBundle=join(root,'base.bundle'); git(repo,'bundle','create',baseBundle,'main');
provider.upload(builder,baseBundle);
const steps=[];
for (const name of ['clone','cg','service','platform','index','tools']) {
  const start=performance.now();
  if (name === 'clone') git(builder.path,'fsck','--no-dangling');
  else git(builder.path,'rev-parse','HEAD');
  steps.push({name,state:'succeeded',duration:performance.now()-start});
}
const image={checkpoint:`hf-base-${initial.slice(0,10)}`,commit:initial,steps};
provider.destroy(builder);
writeFileSync(join(root,'image.json'),JSON.stringify(image));
const statuses=()=>Object.fromEntries([...readFileSync(join(repo,'spec/fleet/spec.kvx'),'utf8').matchAll(/\[task\.(\w+)\]\nstatus = "(\w+)"/g)].map(m=>[m[1],m[2]]));
const echoRunner = async (machine,job) => {
  // Actual child processes overlap; the barrier below makes parallelism observable.
  const code=`const fs=require('node:fs'); fs.writeFileSync('result-${job.task}.txt','echo ${job.task}\\n');`;
  await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['-e',code],{cwd:machine.path,stdio:'pipe'});
    child.on('error',reject); child.on('close',code=>code===0?resolve():reject(Error('echo runner failed')));
  });
  const path=join(machine.path,'spec/fleet/spec.kvx');
  writeFileSync(path,readFileSync(path,'utf8').replace(`[task.${job.task}]\nstatus = "pending"`,`[task.${job.task}]\nstatus = "implemented"`));
  git(machine.path,'add','.');git(machine.path,'commit','-m',`Implement ${job.task}`);
  job.workerCommit=git(machine.path,'rev-parse','HEAD');
};
async function dispatch(tasks) {
  if (tasks.length > cap || active + tasks.length > cap) throw Error('concurrency cap exceeded');
  const tip=git(repo,'rev-parse','HEAD');
  const bundle=join(root,`input-${tick}.bundle`);git(repo,'bundle','create',bundle,'main');
  let release; const barrier=new Promise(resolve=>{release=resolve;}); let entered=0;
  await Promise.all(tasks.map(async task=>{
    const job={task,state:'created',attempt:1,base:tip,timeline:[],log:[]};ledgers.push(job);event(job,'created');
    job.key=keys.find(key=>!leasedKeys.has(key));
    if (!job.key) throw Error('key pool exhausted');
    leasedKeys.add(job.key);
    const machine=provider.create(image.checkpoint);job.machine=machine.id;
    provider.upload(machine,bundle);git(machine.path,'checkout','-b',`worker-${task}`);
    event(job,'prepared');active++;peak=Math.max(peak,active); event(job,'running');
    if (++entered===tasks.length) release(); await barrier;
    try {
      await echoRunner(machine,job);job.log.push(`echo ${task}`);
      job.bundle=join(root,`result-${task}.bundle`);git(machine.path,'bundle','create',job.bundle,`worker-${task}`);
      event(job,'packed');
    } finally {active--;leasedKeys.delete(job.key);provider.destroy(machine);persist();}
  }));
}
function collectAndIntegrate() {
  for (const job of ledgers.filter(j=>j.state==='packed')) {
    git(repo,'fetch',job.bundle,`worker-${job.task}:refs/heads/sandbox/${job.task}`);event(job,'collected');
    git(repo,'merge-tree','--write-tree','HEAD',`sandbox/${job.task}`);
    git(repo,'merge','--no-ff',`sandbox/${job.task}`,'-m',`Integrate ${job.task} [spec:fleet/${job.task}]`);
    job.merge=git(repo,'rev-parse','HEAD'); event(job,'merged');persist();
  }
}
const ready=()=>Object.entries(statuses()).filter(([id,state])=>state==='pending' && !ledgers.some(j=>j.task===id) && (id==='A'||ledgers.some(j=>j.task==='A'&&j.state==='merged'))).map(([id])=>id);
const first=ready();await dispatch(first);
const beforeCollect=ready();collectAndIntegrate();
const second=ready();await dispatch(second);
const parallelSnapshot=JSON.parse(readFileSync(storage,'utf8'));
collectAndIntegrate();
// Reload persisted records for the dashboard RPC read model.
function dashboardRpc(method) {
  if(method!=='fleet.snapshot') throw Error('unknown RPC');
  return {machines:machines.map(({path,...m})=>m),jobs:JSON.parse(readFileSync(storage,'utf8')),
    budget:{cap,inFlight:active,keys:keys.length,backoffUntil:null},image:JSON.parse(readFileSync(join(root,'image.json'),'utf8'))};
}
const merges=ledgers.map(j=>({task:j.task,hash:j.merge,message:git(repo,'show','-s','--format=%s',j.merge),
  parents:git(repo,'show','-s','--format=%P',j.merge).split(' '),worker:j.workerCommit,
  content:git(repo,'show',`${j.merge}:result-${j.task}.txt`)}));
console.log(JSON.stringify({interface:'fleet-projection',initial,image,first,beforeCollect,second,peak,
  ledgers:JSON.parse(readFileSync(storage,'utf8')),parallelSnapshot,merges,statuses:statuses(),dashboard:dashboardRpc('fleet.snapshot')}));
'''
