import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { SpecReader, binaryCommand, type SpecStorage } from './reader.js';
import type { SpecRead, SpecSnapshot } from './shared/model.js';
import { parseKvx } from './kvx.js';
import { registerSpecReadModel, type SpecReadHost } from './read-model-server.js';
import { specReadModelPlugin } from '../../../packages/bundled-plugins/hyperfide-spec.js';

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
    let finish!: (value: SpecRead) => void;
    const update = new Promise<SpecRead>(accept => { finish = accept; });
    reader = new SpecReader(repository, storage, async value => { finish(value); }, binaryCommand(binary));
    await reader.start();
    await writeFile(join(repository, 'spec/demo/spec.kvx'), fixture('Edited'));
    const snapshot = await update;
    expect(snapshot.features[0].tasks[1].title).toBe('Edited');
    expect(snapshot.stale).toBe(false);
  }, 15000);
  it('serves persistent cached data on binary failure and scopes cache per repository', async () => {
    reader = new SpecReader(repository, storage, async () => {}, binaryCommand(binary));
    const original = await reader.refresh();
    const failed = new SpecReader(repository, storage, async () => {}, async () => { throw new Error('trace timeout'); });
    expect(await failed.refresh()).toMatchObject({ stale: true, readAt: original.readAt, error: expect.stringContaining('trace timeout') });
    const other = new SpecReader(join(repository, 'other'), storage, async () => {}, binaryCommand(binary));
    await expect(other.refresh()).rejects.toThrow();
  });
  it('registers RPCs and shuts down through the host lifecycle', async () => {
    expect(specReadModelPlugin.pluginId).toBe('hyperfide-spec');
    expect(specReadModelPlugin.register).toBe(registerSpecReadModel);
    const handlers = new Map<string, (input: { feature?: string; id?: string }) => Promise<unknown>>();
    let dispose = () => {};
    const host: SpecReadHost = { storage, rpc: { register(name, fn) { handlers.set(name, fn); } },
      realtime: { async publish() {} }, onDispose(fn) { dispose = fn; } };
    reader = await registerSpecReadModel(host, repository, binary);
    expect([...handlers.keys()]).toEqual(['features', 'tasks', 'task', 'waves']);
    expect(await handlers.get('task')!({ feature: 'demo', id: '2' })).toMatchObject({ id: '2' });
    await expect(handlers.get('tasks')!({ feature: 'absent' })).rejects.toThrow('Unknown feature');
    dispose();
  });
  it('parses multiline arrays, escaped strings and rejects duplicate sections', () => {
    expect(parseKvx('[meta]\nname = "A \\"quote\\"" # comment\nreqs = [\n "1",\n "2"\n]').get('meta')).toEqual({ name: 'A "quote"', reqs: ['1', '2'] });
    expect(() => parseKvx('[meta]\n[meta]')).toThrow('Duplicate');
  });
});
