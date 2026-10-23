import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { AuthorityError, authorityConfiguration, createAuthorityClient, type AuthorityClient } from './index.js';

export type PluginId = 'hyperfide-spec' | 'hyperfide-asks' | 'hyperfide-qualify' | 'hyperfide-dispatch';
export interface PluginStateEntry { key: string; value: unknown }
export interface PluginStateRequest {
  plugin: PluginId; scope: string;
  operation: 'list' | 'get' | 'write' | 'import' | 'scopes';
  key?: string;
  after?: string;
  entries?: PluginStateEntry[];
  remove?: string[];
}
export interface PluginStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  entries(): Promise<PluginStateEntry[]>;
  import(entries: PluginStateEntry[]): Promise<void>;
  close(): void;
}
const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical((v as Record<string, unknown>)[k])).join(',') + '}';
  return JSON.stringify(v);
};
export function validateEntries(entries: PluginStateEntry[]) {
  if (entries.length > 128 || new Set(entries.map(e => e.key)).size !== entries.length) throw Error('Invalid storage batch');
  for (const e of entries) if (!e.key || e.key.length > 2048 || Buffer.byteLength(JSON.stringify(e.value) ?? '') > 256 * 1024 || e.value === undefined) throw Error('Invalid storage entry');
}
export class PrivateStorage implements PluginStorage {
  private db: DatabaseSync;
  constructor(path: string, private plugin: PluginId, private scope: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS plugin_state(plugin TEXT, scope TEXT, key TEXT, value TEXT NOT NULL, PRIMARY KEY(plugin,scope,key))');
  }
  scopes(): string[] {
    return this.db.prepare('SELECT DISTINCT scope FROM plugin_state WHERE plugin=? ORDER BY scope').all(this.plugin).map(r => String(r.scope));
  }
  async entries(): Promise<PluginStateEntry[]> {
    return this.db.prepare('SELECT key,value FROM plugin_state WHERE plugin=? AND scope=? ORDER BY key').all(this.plugin, this.scope)
      .map(r => ({ key: String(r.key), value: JSON.parse(String(r.value)) }));
  }
  async get<T>(key: string): Promise<T | undefined> {
    const row = this.db.prepare('SELECT value FROM plugin_state WHERE plugin=? AND scope=? AND key=?').get(this.plugin, this.scope, key);
    return row ? JSON.parse(String(row.value)) as T : undefined;
  }
  async put(key: string, value: unknown) {
    validateEntries([{ key, value }]);
    this.db.prepare('INSERT INTO plugin_state VALUES(?,?,?,?) ON CONFLICT(plugin,scope,key) DO UPDATE SET value=excluded.value').run(this.plugin, this.scope, key, JSON.stringify(value));
  }
  async remove(key: string) { this.db.prepare('DELETE FROM plugin_state WHERE plugin=? AND scope=? AND key=?').run(this.plugin, this.scope, key); }
  async import(entries: PluginStateEntry[]) {
    validateEntries(entries);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const e of entries) {
        const row = this.db.prepare('SELECT value FROM plugin_state WHERE plugin=? AND scope=? AND key=?').get(this.plugin, this.scope, e.key);
        const old = row ? JSON.parse(String(row.value)) as unknown : undefined;
        if (old !== undefined && canonical(old) !== canonical(e.value)) throw Error('Plugin migration conflict');
        this.db.prepare('INSERT INTO plugin_state VALUES(?,?,?,?) ON CONFLICT(plugin,scope,key) DO UPDATE SET value=excluded.value').run(this.plugin, this.scope, e.key, JSON.stringify(e.value));
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}
export class AuthorityStorage implements PluginStorage {
  constructor(private client: AuthorityClient, private plugin: PluginId, private scope: string) {}
  private async invoke(input: PluginStateRequest, identity?: { operationId: string; idempotencyKey: string }) {
    for (let attempt = 0; ; attempt++) {
      try { return await this.client.pluginState(input, identity); }
      catch (error) {
        // Only the service's explicit known-aborted outcome permits an automatic retry.
        if (!(error instanceof AuthorityError) || error.code !== 'TX_RETRY_EXHAUSTED' || attempt === 4) throw error;
        await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)));
      }
    }
  }
  async entries() {
    const entries: PluginStateEntry[] = [];
    let after = '';
    for (;;) {
      const page = await this.invoke({ plugin: this.plugin, scope: this.scope, operation: 'list', after });
      if (!page.length) return entries;
      entries.push(...page);
      after = page[page.length - 1]!.key;
    }
  }
  async get<T>(key: string): Promise<T | undefined> {
    return (await this.invoke({ plugin: this.plugin, scope: this.scope, operation: 'get', key }))[0]?.value as T | undefined;
  }
  private async write(operation: 'write' | 'import', entries: PluginStateEntry[], remove: string[] = []) {
    validateEntries(entries);
    await this.invoke({ plugin: this.plugin, scope: this.scope, operation, entries, remove },
      { operationId: randomUUID(), idempotencyKey: randomUUID() });
  }
  async put(key: string, value: unknown) { await this.write('write', [{ key, value }]); }
  async remove(key: string) { await this.write('write', [], [key]); }
  async import(entries: PluginStateEntry[]) { await this.write('import', entries); }
  close() {}
}
export async function openPluginStorage(plugin: PluginId, scope: string, options: { path?: string; env?: NodeJS.ProcessEnv } = {}): Promise<PluginStorage> {
  const config = authorityConfiguration(options.env ?? process.env);
  if (config) return new AuthorityStorage(await createAuthorityClient(config), plugin, scope);
  return new PrivateStorage(options.path ?? join(homedir(), '.hyperfide', 'plugins', plugin, 'state.sqlite'), plugin, scope);
}
/** Copy without deleting the source; conflicting imports roll back the entire bounded batch. */
export async function migratePluginStorage(source: PluginStorage, target: PluginStorage) {
  const entries = await source.entries();
  const existing = new Map((await target.entries()).map(e => [e.key, canonical(e.value)]));
  for (const e of entries) if (existing.has(e.key) && existing.get(e.key) !== canonical(e.value)) throw Error('Plugin migration conflict');
  let batch: PluginStateEntry[] = [], size = 0;
  for (const e of entries) {
    const bytes = Buffer.byteLength(JSON.stringify(e));
    if (batch.length && (batch.length === 128 || size + bytes > 512 * 1024)) {
      await target.import(batch); batch = []; size = 0;
    }
    batch.push(e); size += bytes;
  }
  if (batch.length) await target.import(batch);
  const migrated = new Map((await target.entries()).map(e => [e.key, canonical(e.value)]));
  for (const e of entries) if (migrated.get(e.key) !== canonical(e.value)) throw Error('Plugin migration verification failed');
  return entries.length;
}
