import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { PrivateStorage, AuthorityStorage, openPluginStorage, migratePluginStorage, type PluginId } from '../src/index.js';

/** Every plugin runs this contract with real SQLite and the signed service transport. */
export function storageContract(plugin: PluginId) {
  const backends = process.env.HYPERFIDE_AUTHORITY_URL ? ['private', 'authority'] : ['private'];
  describe.each(backends)(plugin + ' %s storage', { timeout: 15000 }, backend => {
    test('persists JSON values, isolates scopes and deletes across reopen', async () => {
      const root = await mkdtemp(join(tmpdir(), 'hyperfide-storage-'));
      const scope = randomUUID(), path = join(root, 'state.sqlite');
      const open = (name = scope) => backend === 'private' ? Promise.resolve(new PrivateStorage(path, plugin, name)) : openPluginStorage(plugin, name);
      let store = await open();
      try {
        expect(backend === 'private' ? store instanceof PrivateStorage : store instanceof AuthorityStorage).toBe(true);
        await store.put('cache', { state: 'pending', nested: [true, null, 7], unicode: '\u2603' });
        await store.put('null', null);
        store.close(); store = await open();
        expect(await store.get('cache')).toEqual({ state: 'pending', nested: [true, null, 7], unicode: '\u2603' });
        expect(await store.get('null')).toBeNull();
        const other = await open(randomUUID());
        try { expect(await other.entries()).toEqual([]); } finally { other.close(); }
        await store.put('cache', { state: 'implemented' });
        await store.remove('null');
        expect(await store.get('null')).toBeUndefined();
        expect(await store.entries()).toEqual([{ key: 'cache', value: { state: 'implemented' } }]);
      } finally { store.close(); await rm(root, { recursive: true, force: true }); }
    });
    test('migration round trip is replayable, preserves source and rolls back conflicts', async () => {
      const source = new PrivateStorage(':memory:', plugin, randomUUID());
      const target = backend === 'private' ? new PrivateStorage(':memory:', plugin, randomUUID()) : await openPluginStorage(plugin, randomUUID());
      const restored = new PrivateStorage(':memory:', plugin, randomUUID());
      try {
        const entries = [{ key: 'cache', value: { z: 1, a: ['two'] } }, { key: 'mirror', value: null }];
        await source.import(entries);
        expect(await migratePluginStorage(source, target)).toBe(2);
        expect(await migratePluginStorage(source, target)).toBe(2);
        expect(await migratePluginStorage(target, restored)).toBe(2);
        expect(await restored.entries()).toEqual(await source.entries());
        await expect(target.import([{ key: 'first', value: 'rolled back' }, { key: 'cache', value: false }])).rejects.toThrow();
        expect(await target.get('first')).toBeUndefined();
        expect(await source.entries()).toEqual(entries);
      } finally { source.close(); target.close(); restored.close(); }
    });
  });
}
