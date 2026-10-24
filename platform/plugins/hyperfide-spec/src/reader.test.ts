import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { SpecReader, binaryCommand, type SpecStorage } from './reader.js';
import type { SpecRead, SpecSnapshot } from './shared/model.js';
import { parseKvx, featureFromKvx } from './kvx.js';
import specPlugin from './read-model-server.js';
import { createFakePluginHost } from '@hyperfide/plugin-sdk/testing';
import { BUILTIN_PLUGINS } from '../../../apps/server/src/services/plugins/builtin-registry.js';

const binary = process.env.HYPERFIDE_TEST_BINARY ?? resolve(import.meta.dirname, '../../../../cg');
let repository: string;
let reader: SpecReader | undefined;
let cache: Map<string, SpecSnapshot>;
let storage: SpecStorage;
const fixture = (title = 'Build') => `[meta]
feature = "demo"
name = "Demo"
status = "in_progress"
[req.3]
ac_1 = "Expose tasks # including criteria"
ac_2 = "Publish updates"
${[0, 1, 2].map(wave => `[task.${wave + 1}]
title = "${wave === 1 ? title : `Wave ${wave}`}"
status = "pending"
wave = ${wave}
requires = ${JSON.stringify(wave ? [String(wave)] : [])}
touches = ["src/**"]
verify_cmd = "node --version"
owner = "spec"
reqs = ["3.1", "3.2"]
do_2 = "Second"
do_1 = "First"
`).join('\n')}`;
beforeEach(async () => {
  repository = await mkdtemp(join(tmpdir(), 'hyperfide-spec-'));
  await mkdir(join(repository, 'spec/demo'), { recursive: true });
  await writeFile(join(repository, 'spec/workflow.kvx'), '[meta]\nactive_feature = "demo"\n');
  await writeFile(join(repository, 'spec/demo/spec.kvx'), fixture());
  execFileSync('git', ['init', '-q', repository]);
  execFileSync(binary, ['init'], { cwd: repository, stdio: 'pipe' });
  cache = new Map();
  storage = { async get(key) { return cache.get(key); }, async set(key, value) { cache.set(key, value); } };
});
afterEach(async () => { reader?.close(); reader = undefined; await rm(repository, { recursive: true, force: true }); });

describe('spec read model', () => {
  it('combines real status and trace JSON with complete KVX task fields across three waves', async () => {
    reader = new SpecReader(repository, storage, async () => {}, binaryCommand(binary));
    const snapshot = await reader.refresh();
    expect(snapshot.status.demo).toMatchObject({ feature: 'demo', tasks: 3, next: { id: '1' } });
    expect(snapshot.trace.demo).toMatchObject({ feature: 'demo', tasks: [
      { id: '1', wave: 0 }, { id: '2', wave: 1 }, { id: '3', wave: 2 },
    ] });
    expect(await reader.features()).toMatchObject([{ id: 'demo', name: 'Demo' }]);
    expect((await reader.waves('demo')).map(item => item.wave)).toEqual([0, 1, 2]);
    expect(await reader.task('demo', '2')).toMatchObject({
      id: '2', feature: 'demo', title: 'Build', status: 'pending', wave: 1,
      requires: ['1'], touches: ['src/**'], verify_cmd: 'node --version', owner: 'spec',
      do: ['First', 'Second'], do_1: 'First', do_2: 'Second', reqs: ['3.1', '3.2'],
      criteria: [{ id: '3.1', text: 'Expose tasks # including criteria' }, { id: '3.2', text: 'Publish updates' }],
    });
    await expect(reader.tasks('missing')).rejects.toThrow('Unknown feature missing');
    await expect(reader.task('demo', 'missing')).rejects.toThrow('Unknown task');
    expect(cache.size).toBe(1);
  });
  it('watches edits and republishes the refreshed model', async () => {
    const updates: SpecRead[] = [];
    reader = new SpecReader(repository, storage, async value => { updates.push(value); }, binaryCommand(binary));
    await reader.start();
    await reader.refresh();
    await writeFile(join(repository, 'spec/demo/spec.kvx'), fixture('Edited'));
    await expect.poll(() => updates.at(-1)?.features[0].tasks[1].title).toBe('Edited');
    expect(updates.at(-1)?.stale).toBe(false);
  }, 15000);
  it('serves persistent cached data on binary failure and scopes cache per repository', async () => {
    reader = new SpecReader(repository, storage, async () => {}, binaryCommand(binary));
    await reader.refresh();
    const failed = new SpecReader(repository, storage, async () => {}, async () => { throw new Error('trace timeout'); });
    expect(await failed.refresh()).toMatchObject({ stale: true, features: [{ id: 'demo', stale: true, error: expect.stringContaining('trace timeout') }], error: expect.stringContaining('trace timeout') });
    const other = new SpecReader(join(repository, 'other'), storage, async () => {}, binaryCommand(binary));
    await expect(other.refresh()).rejects.toThrow();
  });
  it('registers RPCs and shuts down through the host lifecycle', async () => {
    expect(BUILTIN_PLUGINS).toContainEqual({ name: 'hyperfide-spec', pluginId: 'hyperfide-spec', autoInstall: true, defaultEnabled: true });
    const host = createFakePluginHost({ pluginId: 'hyperfide-spec' });
    await host.hyperfide.storage.kv.set('spec.repositories', [repository]);
    await host.hyperfide.storage.kv.set('spec.binaryPath', binary);
    try {
      const readers = await specPlugin(host.hyperfide);
      await readers.get(repository)!.refresh();
      const call = host.harness.behavior.callRpc;
      expect(await call('features', {})).toMatchObject([{ id: 'demo' }]);
      expect(await call('task', { feature: 'demo', id: '2' })).toMatchObject({ id: '2', do_1: 'First' });
      expect(await call('waves', { feature: 'demo' })).toHaveLength(3);
      await expect(call('tasks', { feature: 'absent' })).rejects.toThrow('Unknown feature');
      await expect(call('tasks', { feature: 'demo', repository: '/unknown' })).rejects.toThrow('repository');
      expect(await host.hyperfide.storage.kv.get(`hyperfide-spec:${repository}`)).toMatchObject({ repository });
      reader = readers.get(repository);
      host.harness.inspection.realtimeSignals.length = 0;
      await writeFile(join(repository, 'spec/demo/spec.kvx'), fixture('RPC edit'));
      await expect.poll(() => host.harness.inspection.realtimeSignals.length).toBe(1);
      expect(host.harness.inspection.realtimeSignals[0]).toMatchObject({
        channel: 'hyperfide-spec:changed', payload: { repository },
      });
      expect(await call('task', { feature: 'demo', id: '2' })).toMatchObject({ title: 'RPC edit' });
    } finally {
      await host.harness.dispose();
    }
  });

  it('starts with a stale snapshot while the first read runs and publishes its result', async () => {
    let release!: () => void;
    const gate = new Promise<void>(accept => { release = accept; });
    const updates: SpecRead[] = [];
    reader = new SpecReader(repository, storage, async value => { updates.push(value); }, async () => { await gate; return {}; });
    expect(await reader.start()).toMatchObject({ features: [], stale: true });
    expect(await reader.features()).toEqual([]);
    release();
    await reader.refresh();
    await expect.poll(() => updates.length).toBe(1);
    expect(updates[0].features).toHaveLength(1);
    reader.close();
    reader = new SpecReader(repository, storage, async () => {}, async () => { await gate; return {}; });
    expect(await reader.start()).toMatchObject({ stale: true, features: [{ id: 'demo' }] });
    await reader.refresh();
  });

  it('limits feature enrichment to four workers and isolates a failed trace', async () => {
    for (let index = 0; index < 8; index++) {
      await mkdir(join(repository, `spec/feature${index}`));
      await writeFile(join(repository, `spec/feature${index}/spec.kvx`), fixture());
    }
    let active = 0, peak = 0;
    reader = new SpecReader(repository, storage, async () => {}, async args => {
      peak = Math.max(peak, ++active);
      await new Promise(accept => setTimeout(accept, 10));
      active--;
      if (args[1] === 'trace' && args[3] === 'demo') throw new Error('trace failed');
      return {};
    });
    const snapshot = await reader.refresh();
    expect(peak).toBe(4);
    expect(snapshot.features).toHaveLength(9);
    expect(snapshot.features.find(feature => feature.id === 'demo')).toMatchObject({ stale: true, error: expect.stringContaining('trace failed') });
    expect(snapshot.features.filter(feature => !feature.stale)).toHaveLength(8);
  });

  it('terminates a command that exceeds its budget', async () => {
    await expect(binaryCommand(process.execPath, 50)(['-e', 'setInterval(() => {}, 1000)'], repository)).rejects.toThrow();
  });

  it('omits legacy group headings that have no task state', () => {
    const feature = featureFromKvx('legacy', '[task.1]\ntitle = "Group"\n[task.1.1]\ntitle = "Build"\nstatus = "done"\nwave = 1\n');
    expect(feature.tasks.map(task => task.id)).toEqual(['1.1']);
  });

  it('parses multiline arrays, escaped strings and rejects duplicate sections', () => {
    expect(parseKvx('[meta]\nname = "A \\"quote\\"" # comment\nreqs = [\n "1",\n "2"\n]').get('meta')).toEqual({ name: 'A "quote"', reqs: ['1', '2'] });
    expect(() => parseKvx('[meta]\n[meta]')).toThrow('Duplicate');
  });
});
