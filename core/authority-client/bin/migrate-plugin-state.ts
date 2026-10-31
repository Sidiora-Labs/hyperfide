import { readFile } from 'node:fs/promises';
import { openPluginStorage, PrivateStorage, migratePluginStorage, type PluginId, type PluginStateEntry } from '../src/index.js';

// Explicit direction keeps migration reversible and never removes the source.
const [plugin, scope, path, direction, legacyExport] = process.argv.slice(2);
if (!plugin || !['hyperfide-spec','hyperfide-asks','hyperfide-qualify','hyperfide-dispatch'].includes(plugin) || !scope || !path || !['upload','download'].includes(direction ?? '')) {
  throw Error('Usage: migrate-plugin-state.ts <plugin> <scope> <sqlite-path> <upload|download> [legacy-kv-export.json]');
}
if (!process.env.HYPERFIDE_AUTHORITY_URL) throw Error('HYPERFIDE_AUTHORITY_URL is required');
const local = new PrivateStorage(path, plugin as PluginId, scope);
const authority = await openPluginStorage(plugin as PluginId, scope);
try {
  if (legacyExport) {
    const entries = JSON.parse(await readFile(legacyExport, 'utf8')) as PluginStateEntry[];
    await local.import(entries);
  }
  console.log(await migratePluginStorage(direction === 'upload' ? local : authority, direction === 'upload' ? authority : local));
} finally { local.close(); authority.close(); }
