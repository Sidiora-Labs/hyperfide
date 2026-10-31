import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdir, open, unlink } from 'node:fs/promises';
import { authorityConfiguration, createAuthorityClient, AuthorityStorage, PrivateStorage, migratePluginStorage, type PluginId } from '../src/index.js';

const configuration = authorityConfiguration(process.env);
if (!configuration || process.env.HYPERFIDE_AUTHORITY_EMBEDDED !== '1') throw Error('Explicit embedded session required');
const command = process.argv.slice(2);
if (!command.length) throw Error('Command required');
const directory = process.env.HYPERFIDE_AUTHORITY_EMBEDDED_DIRECTORY ?? join(homedir(), '.hyperfide', 'authority');
await mkdir(directory, {recursive: true, mode: 0o700});
const lockPath = join(directory, 'session.lock');
const lock = await open(lockPath, 'wx', 0o600);
const path = join(directory, 'state.sqlite');
const client = await createAuthorityClient(configuration);
const plugins: PluginId[] = ['hyperfide-spec','hyperfide-asks','hyperfide-qualify','hyperfide-dispatch'];
try {
  for (const plugin of plugins) {
    const index = new PrivateStorage(path, plugin, '');
    const scopes = index.scopes(); index.close();
    for (const scope of scopes) {
      const local = new PrivateStorage(path, plugin, scope);
      try { await migratePluginStorage(local, new AuthorityStorage(client, plugin, scope)); }
      finally { local.close(); }
    }
  }
  let code: number;
  try {
    code = await new Promise<number>((resolve, reject) => {
      const child = spawn(command[0]!, command.slice(1), { stdio: 'inherit', cwd: new URL('../../../', import.meta.url) });
      const stop = () => child.kill('SIGTERM');
      process.on('SIGTERM', stop); process.on('SIGINT', stop);
      child.once('error', reject);
      child.once('exit', value => {
        process.off('SIGTERM', stop); process.off('SIGINT', stop);
        resolve(value ?? 1);
      });
    });
  } finally {
    // Checkpoint each scope before the owned PostgreSQL helper removes its cluster.
    for (const plugin of plugins) {
      const index = new PrivateStorage(path, plugin, '');
      const scopes = new Set(index.scopes()); index.close();
      for (const row of await client.pluginState({plugin, scope: 'embedded', operation: 'scopes'})) scopes.add(row.key);
      for (const scope of scopes) {
        const local = new PrivateStorage(path, plugin, scope);
        try {
          const remote = await new AuthorityStorage(client, plugin, scope).entries();
          const keep = new Set(remote.map(e => e.key));
          for (const e of await local.entries()) if (!keep.has(e.key)) await local.remove(e.key);
          for (const e of remote) await local.put(e.key, e.value);
        } finally { local.close(); }
      }
    }
  }
  process.exitCode = code;
} finally { await lock.close(); await unlink(lockPath); }
