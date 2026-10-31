import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openPluginStorage, PrivateStorage, migratePluginStorage, type PluginStorage } from '@hyperfide/authority';
export const openDispatchStorage = (directory: string) => openPluginStorage('hyperfide-dispatch', directory, { path: join(directory, 'state.sqlite') });
/** Import the pre-storage JSON ledger once; keep the original files for rollback. */
export async function migrateDispatchDirectory(directory: string, storage: PluginStorage) {
  if (await storage.get('migration:json')) return;
  const entries = [];
  for (const file of await readdir(directory)) {
    if (!file.endsWith('.json')) continue;
    const value = JSON.parse(await readFile(join(directory, file), 'utf8'));
    entries.push({ key: file === 'budget.json' ? 'budget' : 'job:' + value.id, value });
  }
  const source = new PrivateStorage(':memory:', 'hyperfide-dispatch', directory);
  try {
    for (const entry of entries) await source.put(entry.key, entry.value);
    await migratePluginStorage(source, storage);
    await storage.put('migration:json', true);
  } finally { source.close(); }
}
