import { durableMemorySchema, type DurableMemory } from '../../memory/durable-memory.js';
import { execFile } from 'node:child_process';
import { watch, type FSWatcher } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { featureFromKvx } from './kvx.js';
import type { SpecRead, SpecSnapshot, SpecRpc } from './shared/model.js';
import { taskReceipts } from '../receipt-detail.js';

export interface SpecStorage {
  get(key: string): Promise<SpecSnapshot | undefined>;
  set(key: string, value: SpecSnapshot): Promise<void>;
}
export type SpecCommand = (args: string[], repository: string) => Promise<Record<string, unknown>>;
// Two sequential CLI calls give each feature at most 30 seconds of enrichment.
export function binaryCommand(binary = process.env.HYPERFIDE_BIN || 'hyperfide', timeout = 15_000): SpecCommand {
  return (args, repository) => new Promise((accept, reject) => {
    execFile(binary, args, { cwd: repository, timeout, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) { reject(new Error(error.killed ? `Spec command exceeded ${timeout}ms budget` : stderr.trim() || error.message)); return; }
      try {
        const value: unknown = JSON.parse(stdout);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid spec JSON');
        accept(value as Record<string, unknown>);
      } catch (error) { reject(error); }
    });
  });
}
export class SpecReader implements SpecRpc {
  readonly repository: string;
  private readonly key: string;
  private current?: SpecRead;
  private pending?: Promise<SpecRead>;
  private watcher?: FSWatcher;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private dirty = false;
  constructor(repository: string, private storage: SpecStorage,
    private publish: (snapshot: SpecRead) => Promise<void>,
    private command: SpecCommand = binaryCommand()) {
    this.repository = resolve(repository);
    this.key = `hyperfide-spec:${this.repository}`;
  }
  async refresh(): Promise<SpecRead> {
    if (this.pending) return this.pending;
    this.pending = this.read().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async read(): Promise<SpecRead> {
    try {
      const entries = await readdir(join(this.repository, 'spec'), { withFileTypes: true });
      const features: SpecSnapshot['features'] = [];
      const errors: string[] = [];
      const status: Record<string, unknown> = {}, trace: Record<string, unknown> = {};
      const queue = entries.filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
      const readFeature = async (entry: typeof queue[number]) => {
        let source: string;
        try { source = await readFile(join(this.repository, 'spec', entry.name, 'spec.kvx'), 'utf8'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
        const args = ['-f', entry.name, '--json'];
        const feature = featureFromKvx(entry.name, source);
        try {
          status[entry.name] = await this.command(['spec', 'status', ...args], this.repository);
          trace[entry.name] = await this.command(['spec', 'trace', ...args], this.repository);
          // The CLI exposes counts/next and trace evidence, not the complete task fields.
          const evidence = (trace[entry.name] as { tasks?: { id: string; title: string; status: string; wave: number }[] }).tasks;
          for (const item of evidence ?? []) {
            const task = feature.tasks.find(task => task.id === item.id);
            if (task) Object.assign(task, { title: item.title, status: item.status, wave: item.wave });
          }
          const next = (status[entry.name] as { next?: { id: string; status?: string } }).next;
          if (next?.status) {
            const task = feature.tasks.find(task => task.id === next.id);
            if (task) task.status = next.status as typeof task.status;
          }
        } catch (error) {
          feature.stale = true;
          feature.error = String(error);
          errors.push(`${entry.name}: ${error}`);
        }
        features.push(feature);
      };
      await Promise.all(Array.from({ length: 4 }, async () => {
        for (let entry; (entry = queue.shift());) await readFeature(entry);
      }));
      features.sort((a, b) => a.id.localeCompare(b.id));
      const snapshot: SpecSnapshot = { repository: this.repository, readAt: new Date().toISOString(), features, status, trace };
      this.current = { ...snapshot, stale: errors.length > 0, ...(errors.length ? { error: errors.join('; ') } : {}) };
      await this.storage.set(this.key, snapshot);
    } catch (error) {
      const cached = this.current ?? await this.storage.get(this.key);
      if (!cached || cached.repository !== this.repository) throw error;
      this.current = { ...cached, stale: true, error: String(error) };
    }
    return this.current;
  }
  async snapshot() { return this.current ?? this.refresh(); }
  async features() { return (await this.snapshot()).features; }
  async tasks(feature: string) {
    const found = (await this.features()).find(item => item.id === feature);
    if (!found) throw new Error(`Unknown feature ${feature}`);
    return found.tasks;
  }
  async task(feature: string, id: string) {
    const found = (await this.tasks(feature)).find(item => item.id === id);
    if (!found) throw new Error(`Unknown task ${feature}/${id}`);
    const recalledDecisions: DurableMemory[] = [];
    for (const type of ['decision', 'constraint']) {
      // Recall is an enrichment: a binary without durable memory, a repository that is not a Hyperfide project,
      // or a stubbed command yields no decisions, not a failure.
      const result = await this.command(['recall', '--task', `${feature}/${id}`, '--type', type, '-n', '1000', '--json'], this.repository)
        .catch((): Record<string, unknown> => ({}));
      const memories = Array.isArray(result.memories) ? result.memories : [];
      recalledDecisions.push(...memories.map(value => durableMemorySchema.parse(value))
        .filter(memory => memory.task === `${feature}/${id}` && memory.type === type));
    }
    return { ...found, recalledDecisions, receipts: await taskReceipts(this.repository, id, `spec/${feature}/spec.kvx`) };
  }
  async waves(feature: string) {
    const tasks = await this.tasks(feature);
    return [...new Set(tasks.map(task => task.wave))].sort((a, b) => a - b)
      .map(wave => ({ wave, tasks: tasks.filter(task => task.wave === wave) }));
  }
  async start() {
    this.closed = false;
    if (!this.watcher) {
      this.watcher = watch(join(this.repository, 'spec'), { recursive: true }, (_event, file) => {
        if (file && !String(file).endsWith('.kvx')) return;
        this.dirty = true;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => { void this.republish(); }, 50);
      });
    }
    const cached = await this.storage.get(this.key);
    this.current = { ...(cached?.repository === this.repository ? cached : {
      repository: this.repository, readAt: '', features: [], status: {}, trace: {},
    }), stale: true, error: 'Refreshing spec snapshot' };
    void this.refresh().then(snapshot => {
      if (!this.closed) return this.publish(snapshot);
    }).catch(() => {});
    return this.current;
  }
  private async republish() {
    if (this.closed) return;
    try {
      // Drain changes that arrive while a slow trace is still running.
      if (this.pending) await this.pending;
      while (this.dirty && !this.closed) {
        this.dirty = false;
        const snapshot = await this.refresh();
        if (!this.closed) await this.publish(snapshot);
      }
    } catch {
      // No successful cache exists yet; a later edit retries the read.
    }
  }
  close() { this.closed = true; this.watcher?.close(); this.watcher = undefined; clearTimeout(this.timer); }
}
