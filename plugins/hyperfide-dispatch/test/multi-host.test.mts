import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FleetService, FileFleetAuthority } from '../../../core/server/src/services/machines/fleet-projection.ts';
import { createFleetRoutes } from '../../../core/server/src/routes/fleet.ts';
import { FleetWorker, createFleetHttpTransport } from '../../../core/host-daemon/src/fleet-worker.ts';
import { scheduleHost } from '../src/host-capacity.ts';
import { enrollRailwayHost } from '../../machine-railway/src/fleet-bootstrap.ts';
import { createProvider } from '../../machine-railway/src/provider.ts';
import { createMachineBootstrapApi } from '../../../core/server/src/services/machines/bootstrap.ts';

async function fixture(run: (f: any) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'hyperfide-fleet-'));
  let now = 0;
  const path = join(directory, 'authority.json');
  const authority = new FileFleetAuthority(path);
  const authorize = async (credential: string) => credential === 'Bearer operator' ? 'operator-1' : null;
  const service = new FleetService(authority, scheduleHost, authorize, () => now, 100);
  const routes = createFleetRoutes(service);
  const request = (url: any, init: any) => routes.request(new Request(String(url).replace('/api/v1/fleet', ''), init));
  const transport = createFleetHttpTransport('http://fleet', request as typeof fetch);
  try { await run({ service, authority, path, routes, transport, advance: (ms: number) => { now += ms; }, authorize, clock: () => now }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
const issue = (service: FleetService, id: string, capacity = 1) => service.issue('Bearer operator', id, capacity, 1000);
const settle = () => new Promise(resolve => setImmediate(resolve));

test('operator enrollment is durable, single use, scoped, expiring and authenticated', () => fixture(async ({ service, authority, routes, advance, path }) => {
  await assert.rejects(service.issue('stranger', 'a', 1, 1000), /authorized/);
  const { token } = await issue(service, 'a');
  const disk = await readFile(path, 'utf8');
  assert.ok(!disk.includes(token));
  assert.equal(JSON.parse(disk).enrollments[0].operatorId, 'operator-1');
  const results = await Promise.allSettled([service.enroll(token), service.enroll(token)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const identity = results.find(r => r.status === 'fulfilled')!.value;
  assert.equal(identity.hostId, 'a');
  await assert.rejects(service.poll('other', identity.session), /session/);
  const expiring = await issue(service, 'b'); advance(1001);
  await assert.rejects(service.enroll(expiring.token), /token/);
  assert.equal((await routes.request('http://fleet/', { headers: { authorization: 'stranger' } })).status, 403);
  assert.equal((await routes.request('http://fleet/enroll', { method: 'POST', body: '{' })).status, 400);
  const before = await authority.transaction((s: any) => s.jobs.length);
  await assert.rejects(service.enqueue('stranger', 'job', 'thread', 'payload'));
  assert.equal(await authority.transaction((s: any) => s.jobs.length), before);
}));

test('two in-process daemons schedule by capacity and execute threads on the assigned sandbox', () => fixture(async ({ service, transport, routes }) => {
  const seen: Record<string, string[]> = { a: [], b: [] };
  const a = new FleetWorker(transport, async job => { seen.a.push(job.threadId); });
  const b = new FleetWorker(transport, async job => { seen.b.push(job.threadId); });
  await a.enroll((await issue(service, 'a', 1)).token);
  await b.enroll((await issue(service, 'b', 2)).token);
  for (let i = 0; i < 4; i++) await service.enqueue('Bearer operator', `job-${i}`, `thread-${i}`, 'echo');
  let state = await service.snapshot('Bearer operator');
  assert.equal(state.jobs.filter((j: any) => j.state === 'running').length, 3);
  assert.equal(state.hosts.find((h: any) => h.id === 'b').jobs.length, 2);
  const page = await routes.request('http://fleet/view', { headers: { authorization: 'Bearer operator' } });
  const html = await page.text();
  assert.ok(html.includes('2 / 2') && html.includes('thread-0'));
  await Promise.all([a.tick(), b.tick()]);
  await settle(); await settle();
  await Promise.all([a.tick(), b.tick()]); await settle(); await settle();
  state = await service.snapshot('Bearer operator');
  assert.equal(state.jobs.filter((j: any) => j.state === 'completed').length, 4);
  assert.equal(seen.a.length + seen.b.length, 4);
  a.stop(); b.stop(); await Promise.all([a.drain(), b.drain()]);
}));

test('host loss retries once elsewhere, survives restart, and fences old completions', () => fixture(async ({ service, path, advance, authorize, clock }) => {
  const a = await service.enroll((await issue(service, 'a')).token);
  const b = await service.enroll((await issue(service, 'b')).token);
  await service.enqueue('Bearer operator', 'job', 'thread', 'echo');
  assert.equal((await service.poll(a.hostId, a.session))[0].attempt, 1);
  advance(60); await service.poll(b.hostId, b.session); advance(41);
  const restarted = new FleetService(new FileFleetAuthority(path), scheduleHost, authorize, clock, 100);
  const retried = await restarted.poll(b.hostId, b.session);
  assert.equal(retried[0].attempt, 2); assert.deepEqual(retried[0].previousHosts, ['a']);
  await assert.rejects(restarted.complete(a.hostId, a.session, 'job', 1, true), /Stale/);
  advance(101);
  const final = await restarted.snapshot('Bearer operator');
  assert.equal(final.jobs[0].state, 'failed'); assert.equal(final.jobs[0].attempt, 2);
  await restarted.poll(a.hostId, a.session);
  assert.equal((await restarted.snapshot('Bearer operator')).jobs[0].state, 'failed');
}));

test('a lost daemon aborts its old thread when it reconnects after reassignment', () => fixture(async ({ service, transport, advance }) => {
  let aborted = false;
  const a = new FleetWorker(transport, async (_job, signal) => {
    await new Promise<void>(resolve => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
  });
  let executions = 0;
  const b = new FleetWorker(transport, async () => { executions++; });
  await a.enroll((await issue(service, 'a')).token);
  await b.enroll((await issue(service, 'b')).token);
  await service.enqueue('Bearer operator', 'lost-job', 'lost-thread', 'echo');
  await a.tick();
  advance(60); await b.tick(); advance(41);
  await b.tick(); await b.drain();
  await a.tick(); await a.drain();
  assert.equal(aborted, true);
  assert.equal(executions, 1);
  const state = await service.snapshot('Bearer operator');
  assert.equal(state.jobs[0].state, 'completed');
  assert.equal(state.jobs[0].hostId, 'b');
  assert.equal(state.jobs[0].attempt, 2);
  a.stop(); b.stop();
}));

test('a failed completion acknowledgement does not rerun the thread', () => fixture(async ({ service, transport }) => {
  let executions = 0;
  let acknowledgements = 0;
  const worker = new FleetWorker({ ...transport, complete: async (...args: [string, string, string, number, boolean]) => {
    if (++acknowledgements === 1) throw new Error('Authority temporarily unavailable');
    await transport.complete(...args);
  } }, async () => { executions++; });
  await worker.enroll((await issue(service, 'a')).token);
  await service.enqueue('Bearer operator', 'job', 'thread', 'echo');
  await worker.tick(); await worker.drain();
  assert.equal((await service.snapshot('Bearer operator')).jobs[0].state, 'running');
  await worker.tick(); await worker.drain();
  assert.equal((await service.snapshot('Bearer operator')).jobs[0].state, 'completed');
  assert.equal(executions, 1);
  assert.equal(acknowledgements, 2);
  worker.stop();
}));

test('fake Railway machine bootstrap enrolls a sandbox, then its daemon receives the thread', () => fixture(async ({ service, transport }) => {
  const { token } = await issue(service, 'sandbox-1');
  let stdin = ''; const commands: string[] = []; const ran: string[] = [];
  const worker = new FleetWorker(transport, async job => { ran.push(job.threadId); });
  const machine = {
    id: 'sandbox-1',
    writeFile: async (_path: string, data: string, options: any) => { assert.equal(options.mode, 0o600); stdin = data; },
    exec: async (command: string) => {
      commands.push(command);
      assert.ok(!command.includes(token));
      if (!command.startsWith('rm ')) await worker.enroll(JSON.parse(stdin).credential);
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false, truncated: false, ms: 0 };
    },
  };
  const allocations = new Map<string, unknown>();
  const provider = createProvider({
    providerId: 'hyperfide-machine-fake', capabilities: { checkpoint: true, list: true },
    create: async () => machine as any, connect: async () => machine as any, list: async () => [],
  }, async () => ({ token: 'fake-provider-token', environmentId: 'fake-environment' }), {
    get: async <T,>(key: string) => allocations.get(key) as T | undefined,
    set: async (key, value) => { allocations.set(key, value); },
  });
  const allocation = await provider.create({ key: 'machine-job', checkpoint: async () => {} } as any);
  assert.equal(allocation.status, 'created');
  const bootstrap = createMachineBootstrapApi({
    prepare: async () => ({ id: 'sandbox-1', hostId: 'sandbox-1', state: 'pending', bootstrap: {
      hostId: 'sandbox-1', serverUrl: 'http://fleet', credential: token, expiresAt: 1000,
    } }),
    waitForConnection: async () => {
      const state = await service.snapshot('Bearer operator');
      assert.equal(state.hosts.find((h: any) => h.id === 'sandbox-1').online, true);
      return { hostId: 'sandbox-1', hostName: 'Fake sandbox' };
    },
    clearPending() {},
  });
  assert.deepEqual(await enrollRailwayHost(machine as any, bootstrap, { key: 'machine-job', report: { step() {}, log() {} }, signal: new AbortController().signal }), { hostId: 'sandbox-1' });
  assert.equal(commands.length, 2);
  await service.enqueue('Bearer operator', 'sandbox-job', 'sandbox-thread', 'echo');
  await worker.tick(); await settle(); await settle();
  assert.deepEqual(ran, ['sandbox-thread']);
  await worker.drain(); worker.stop();
}));
