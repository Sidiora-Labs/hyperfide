import { openPluginStorage, type PluginStorage } from '@hyperfide/authority';
import type { PublicationStore, Publication } from './publication';
export const openQualifyStorage = (repository: string) => openPluginStorage('hyperfide-qualify', repository);
export function publicationStore(storage: PluginStorage): PublicationStore {
  return { get: key => storage.get<Publication>('publication:' + key), put: (key, value) => storage.put('publication:' + key, value) };
}

/** Import historical receipt metadata; evidence remains at its recorded artifact paths. */
export async function migrateQualifyArtifacts(repository: string, storage: PluginStorage) {
  const { readdir, readFile } = await import('node:fs/promises');
  const { join, relative } = await import('node:path');
  const { PrivateStorage, migratePluginStorage } = await import('@hyperfide/authority');
  const source = new PrivateStorage(':memory:', 'hyperfide-qualify', repository);
  try {
    const root = join(repository, 'artifacts/hyperfide/tasks');
    for (const task of await readdir(root, { withFileTypes: true })) {
      if (!task.isDirectory()) continue;
      for (const lane of await readdir(join(root, task.name), { withFileTypes: true })) {
        if (!lane.isDirectory()) continue;
        const path = join(root, task.name, lane.name, 'receipt.json');
        let value: unknown;
        try { value = JSON.parse(await readFile(path, 'utf8')); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
        await source.put('receipt:' + relative(repository, path), value);
      }
    }
    return await migratePluginStorage(source, storage);
  } finally { source.close(); }
}
