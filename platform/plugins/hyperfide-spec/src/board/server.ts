import { DurableMemoryBridge } from '../../../memory/durable-memory.js';
import { openSpecStorage } from '../storage.js';
import type { PluginStorage } from '@hyperfide/authority';
import { taskReceipts } from '../../receipt-detail.js';
import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { BoardAction, BoardRpc, Task } from './model.js';

export type CommandRunner = (binary: string, args: string[], cwd: string) => Promise<void>;
export async function latestReceipt(repository: string, id: string): Promise<string | undefined> {
  if (!/^[a-zA-Z0-9_.-]+$/.test(id) || id === '.' || id === '..') return;
  const directory = join(repository, 'artifacts/hyperfide/tasks', id);
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const receipts = await Promise.all(entries.filter(entry => entry.isDirectory()).map(async entry => {
    const path = join('artifacts/hyperfide/tasks', id, entry.name, 'receipt.json');
    try { return { path, time: (await stat(join(repository, path))).mtimeMs }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }));
  const latest = receipts.filter(receipt => receipt !== undefined).sort((a, b) => b.time - a.time)[0];
  return latest ? './' + latest.path.split('/').map(encodeURIComponent).join('/') : undefined;
}
const run: CommandRunner = (binary, args, cwd) => new Promise((resolve, reject) => {
  execFile(binary, args, { cwd }, (error, stdout, stderr) => {
    if (error) reject(new Error(stderr.trim() || stdout.trim() || error.message));
    else resolve();
  });
});

// Repository and binary are server configuration, never client supplied paths.
export function createBoardServer(repository: string, readTasks: BoardRpc['tasks'],
  binary: string | undefined = undefined, execute: CommandRunner = run, suppliedStorage?: PluginStorage): BoardRpc {
  const tasks = async (feature: string) => {
    const storage = suppliedStorage ?? await openSpecStorage(repository);
    try {
      const rows = await Promise.all((await readTasks(feature)).map(async task => ({
        ...task, receipts: await taskReceipts(repository, task.id, `spec/${feature}/spec.kvx`), latestReceipt: await latestReceipt(repository, task.id),
      })));
      await storage.put('board:' + feature, rows);
      return rows;
    } finally { if (!suppliedStorage) storage.close(); }
  };
  return {
    tasks,
    async task(feature, id) {
      const found = (await readTasks(feature)).find(task => task.id === id);
      if (!found) throw new Error(`Unknown task ${id}`);
      const memory = new DurableMemoryBridge({ ...process.env, ...(binary ? { HYPERFIDE_BIN: binary } : {}) });
      return { ...found, latestReceipt: await latestReceipt(repository, id), recalledDecisions: await memory.recall({ repository, task: `${feature}/${id}` }) };
    },
    async action(feature: string, id: string, action: BoardAction) {
      if (action !== 'start' && action !== 'implemented') throw new Error('Unsupported board action');
      if (!/^[a-zA-Z0-9_.-]+$/.test(feature) || !/^[a-zA-Z0-9_.-]+$/.test(id)) {
        throw new Error('Invalid feature or task');
      }
      const tasks: Task[] = await readTasks(feature);
      if (!tasks.some(task => task.id === id)) throw new Error(`Unknown task ${id}`);
      await execute(binary ?? 'hyperfide', ['spec', action, id, '-f', feature], repository);
    },
  };
}
