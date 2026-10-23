import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakePluginHost } from '@hyperfide/plugin-sdk/testing';
import { LaneService, type LaneEvent } from './lanes';
import { createProjectionAdapter, runBinary } from './projection-adapter';
import { registerQualification, type QualificationHost } from './qualification';
import { streamLane } from './app';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });
async function fixture(command = 'printf passing; printf warning >&2; sleep .3') {
  const root = await mkdtemp(join(tmpdir(), 'hyperfide-lane-test-'));
  cleanup.push(() => rm(root, {recursive: true, force: true}));
  const repository = join(root, 'repo');
  await mkdir(join(repository, 'spec/fixture'), {recursive: true});
  await writeFile(join(repository, 'spec/fixture/spec.kvx'), `[task.1.1]\nverify_cmd = ${JSON.stringify(command)}\n`);
  await runBinary('git', ['init', repository]);
  await runBinary('git', ['add', '.'], {cwd: repository});
  await runBinary('git', ['-c','user.name=Hyperfide','-c','user.email=test@hyperfide.local','commit','-m','fixture'], {cwd: repository});
  const binary = join(root, 'hyperfide'), gate = join(root, 'hold');
  await writeFile(binary, `#!${process.execPath}\nif(process.argv[2]==='--version'){console.log('hyperfide fixture');process.exit(0)}\nconsole.log('done:'+process.env.CG_BUSY_TIMEOUT_MS);const fs=require('node:fs');const t=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(gate)})){clearInterval(t)}},20);`, {mode:0o755});
  const adapter = createProjectionAdapter(binary);
  const events: LaneEvent[] = [];
  const lanes = new LaneService(adapter, e => events.push(e));
  cleanup.push(() => lanes.close());
  return {root, repository, binary, gate, adapter, events, lanes, input:{repository, feature:'fixture', task:'1.1'}};
}
async function logContains(lanes: LaneService, id: string, text: string) {
  await vi.waitFor(() => expect(lanes.log(id).map(l => l.text).join('')).toContain(text), {timeout:20000});
}
it('runs committed fixture verification and streams stdout/stderr with provenance', async () => {
  const f = await fixture(); const started = await f.lanes.start(f.input);
  await logContains(f.lanes, started.id, 'passing');
  expect(f.lanes.get(started.id).state).toBe('running');
  const lane = await f.lanes.wait(started.id);
  expect(lane).toMatchObject({state:'passed',exitCode:0,error:null});
  expect(lane.commit).toBe((await runBinary('git',['rev-parse','HEAD'],{cwd:f.repository})).stdout.trim());
  expect(lane.environmentId).toMatch(/^hyperfide-worktree-/);
  expect(lane.environmentPath).not.toBe(f.repository);
  expect(lane.durationMs).toBeGreaterThan(0);
  expect(lane.toolchain).toMatchObject({node:expect.stringMatching(/^v24\./),pnpm:'9.15.0',hyperfide:'hyperfide fixture'});
  expect(f.events.some(e => e.log?.stream === 'stderr')).toBe(true);
  expect(f.lanes.log(lane.id,1).every(e=>e.sequence>1)).toBe(true);
  lane.state='failed'; expect(f.lanes.get(lane.id).state).toBe('passed');
});
it('records a failing verification', async () => {
  const f=await fixture('printf failed; exit 7');
  expect(await f.lanes.wait((await f.lanes.start(f.input)).id)).toMatchObject({state:'failed',exitCode:7});
});
it('queues done lanes across linked worktrees and instances while other repositories run', async () => {
  const f=await fixture(); await writeFile(f.gate,'hold');
  const first=await f.lanes.start({...f.input,mode:'done',busyTimeoutMs:4321});
  await logContains(f.lanes,first.id,'done:4321');
  const linked=join(f.root,'linked'); await runBinary('git',['worktree','add','--detach',linked,'HEAD'],{cwd:f.repository});
  const other=new LaneService(f.adapter); cleanup.push(()=>other.close());
  const second=await other.start({...f.input,repository:linked,mode:'done'});
  expect(second.state).toBe('queued');
  const cancelled=await other.start({...f.input,mode:'done'});
  expect(await other.cancel(cancelled.id)).toMatchObject({state:'cancelled',environmentId:null});
  const separate=await fixture(); expect((await separate.lanes.wait((await separate.lanes.start(separate.input)).id)).state).toBe('passed');
  expect(other.get(second.id).state).toBe('queued');
  await rm(f.gate); await f.lanes.wait(first.id); expect((await other.wait(second.id)).state).toBe('passed');
});
it('kills the entire process group including TERM-resistant descendants', async () => {
  const childProgram = 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)';
  const program = `const {spawn}=require("node:child_process");const c=spawn(process.execPath,["-e",${JSON.stringify(childProgram)}],{stdio:"ignore"});console.log(process.pid+","+c.pid);process.on("SIGTERM",()=>{});setInterval(()=>{},1000)`;
  const f=await fixture(`node -e '${program}'`); const lane=await f.lanes.start(f.input);
  await vi.waitFor(()=>expect(f.lanes.log(lane.id).length).toBeGreaterThan(0),{timeout:20000});
  const pids=f.lanes.log(lane.id).map(e=>e.text).join('').trim().split(',').map(Number);
  expect(pids).toHaveLength(2);
  const alive=async(pid:number)=>{try {return !(await readFile(`/proc/${pid}/stat`,'utf8')).split(') ')[1]!.startsWith('Z');} catch{return false;}};
  expect(await Promise.all(pids.map(alive))).toEqual([true,true]);
  expect((await f.lanes.cancel(lane.id)).state).toBe('cancelled');
  await vi.waitFor(async()=>expect(await Promise.all(pids.map(alive))).toEqual([false,false]));
});
it('wraps verification with the repository PostgreSQL helper', async () => {
  const f=await fixture('printf postgres'); const dir=join(f.repository,'tests/hyperfide/support'); await mkdir(dir,{recursive:true});
  await writeFile(join(dir,'withpg.py'),'import subprocess,sys\nassert sys.argv[1]=="--"\nprint("helper-called",flush=True)\nsys.exit(subprocess.call(sys.argv[2:]))\n');
  await runBinary('git',['add','.'],{cwd:f.repository});
  await runBinary('git',['-c','user.name=Hyperfide','-c','user.email=test@hyperfide.local','commit','-m','helper'],{cwd:f.repository});
  const lane=await f.lanes.wait((await f.lanes.start({...f.input,postgres:true})).id);
  expect(lane.state).toBe('passed'); expect(lane.command).toMatch(/^python3 tests\/hyperfide\/support\/withpg.py --/);
  await logContains(f.lanes,lane.id,'helper-called');
});
it('registers real SDK RPC and realtime APIs and supports ordered replay', async () => {
  const f=await fixture(); const host=createFakePluginHost({pluginId:'hyperfide-qualify'});
  const lanes=registerQualification(Object.values(host).find(v => v && typeof v === 'object' && 'rpc' in v && 'realtime' in v) as QualificationHost,f.adapter); cleanup.push(()=>host.harness.dispose());
  const started=await host.harness.callRpc('start',f.input) as {id:string}; await lanes.wait(started.id);
  expect(await host.harness.callRpc('get',{id:started.id})).toMatchObject({state:'passed'});
  expect(await host.harness.callRpc('list',{})).toHaveLength(1);
  expect(await host.harness.callRpc('log',{id:started.id})).not.toEqual([]);
  expect(await host.harness.callRpc('cancel',{id:started.id})).toMatchObject({state:'passed'});
  expect(host.harness.realtimeSignals.some(e=>e.channel==='hyperfide-qualify:lane')).toBe(true);
  const received:number[]=[]; const entry=(sequence:number)=>({sequence,stream:'stdout' as const,text:String(sequence)});
  let callback!:(event:LaneEvent)=>void; const off=vi.fn(); const lane=lanes.get(started.id);
  const unsubscribe=await streamLane({subscribe(_c,cb){callback=cb;return off;},async log(){callback({lane,log:entry(2)});return [entry(1),entry(2)];}},lane.id,e=>received.push(e.sequence),()=>{});
  callback({lane,log:entry(3)}); expect(received).toEqual([1,2,3]); unsubscribe(); expect(off).toHaveBeenCalledOnce();
});
it('recovers from environment failures and rejects invalid requests',async()=>{
  const f=await fixture(); const adapter={...f.adapter,environment:vi.fn().mockRejectedValueOnce(new Error('unavailable')).mockImplementation(f.adapter.environment)};
  const lanes=new LaneService(adapter);cleanup.push(()=>lanes.close());
  const first=await lanes.start({...f.input,mode:'done'}),second=await lanes.start({...f.input,mode:'done'});
  expect(await lanes.wait(first.id)).toMatchObject({state:'failed',error:'unavailable'});expect((await lanes.wait(second.id)).state).toBe('passed');
  await expect(lanes.start({...f.input,task:'missing'})).rejects.toThrow('Missing verify_cmd');
  await expect(lanes.start({...f.input,busyTimeoutMs:0})).rejects.toThrow('Invalid busy timeout');
  await lanes.close();await expect(lanes.start(f.input)).rejects.toThrow('closed');
});
it('rejects an unpinned toolchain before executing the command', async () => {
  const f = await fixture('printf must-not-run');
  const lanes = new LaneService({...f.adapter, async environment(repository, id) {
    const env = await f.adapter.environment(repository, id);
    const bin = join(f.root, 'wrong-bin'); await mkdir(bin);
    await writeFile(join(bin, 'pnpm'), '#!/bin/sh\nprintf 10.0.0', {mode:0o755});
    env.variables.PATH = `${bin}:${env.variables.PATH}`;
    return env;
  }});
  cleanup.push(() => lanes.close());
  const lane = await lanes.wait((await lanes.start(f.input)).id);
  expect(lane).toMatchObject({state:'failed',exitCode:null,error:'Qualification requires pinned Node 24 and pnpm 9.15.0'});
  expect(lanes.log(lane.id)).toEqual([]);
});
