import { expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createFakePluginHost } from '@hyperfide/plugin-sdk/testing';
import { snapshotStorage } from './snapshot-storage.js';
import type { SpecSnapshot } from './shared/model.js';

it('caches snapshots larger than the runtime KV limit, cleans old chunks, and reads legacy snapshots', async () => {
  const host = createFakePluginHost({ pluginId: 'hyperfide-spec' });
  const kv = host.hyperfide.storage.kv;
  const storage = snapshotStorage(kv);
  const key = 'hyperfide-spec:/repository';
  const snapshot: SpecSnapshot = { repository: '/repository', readAt: '', features: [], status: {},
    trace: { large: randomBytes(400_000).toString('base64') } };
  await expect(kv.set(key, snapshot)).rejects.toThrow('256KB');
  await storage.set(key, snapshot);
  expect(await storage.get(key)).toEqual(snapshot);
  const old = await kv.get<{ chunks: string[] }>(key);
  expect(old!.chunks.length).toBeGreaterThan(1);
  await storage.set(key, { ...snapshot, trace: {} });
  for (const chunk of old!.chunks) expect(await kv.get(chunk)).toBeUndefined();
  await kv.set(key, { ...snapshot, trace: {} });
  expect(await storage.get(key)).toEqual({ ...snapshot, trace: {} });
  await host.harness.dispose();
});
