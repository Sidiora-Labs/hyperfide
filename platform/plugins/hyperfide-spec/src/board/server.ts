import { openSpecStorage } from '../storage.js';
import type { PluginStorage } from '@hyperfide/authority';
import { execFile } from 'node:child_process';
import type { BoardAction, BoardRpc, Task } from './read-model-projection';

export type CommandRunner = (binary: string, args: string[], cwd: string) => Promise<void>;
const run: CommandRunner = (binary, args, cwd) => new Promise((resolve, reject) => {
  execFile(binary, args, { cwd }, (error, stdout, stderr) => {
    if (error) reject(new Error(stderr.trim() || stdout.trim() || error.message));
    else resolve();
  });
});

// Repository and binary are server configuration, never client supplied paths.
export function createBoardServer(repository: string, readTasks: BoardRpc['tasks'],
  binary = 'hyperfide', execute: CommandRunner = run, suppliedStorage?: PluginStorage): BoardRpc {
  const tasks = async (feature: string) => {
    const storage = suppliedStorage ?? await openSpecStorage(repository);
    try {
      const rows = await readTasks(feature);
      await storage.put('board:' + feature, rows);
      return rows;
    } finally { if (!suppliedStorage) storage.close(); }
  };
  return {
    tasks,
    async action(feature: string, id: string, action: BoardAction) {
      if (action !== 'start' && action !== 'implemented') throw new Error('Unsupported board action');
      if (!/^[a-zA-Z0-9_.-]+$/.test(feature) || !/^[a-zA-Z0-9_.-]+$/.test(id)) {
        throw new Error('Invalid feature or task');
      }
      const tasks: Task[] = await readTasks(feature);
      if (!tasks.some(task => task.id === id)) throw new Error(`Unknown task ${id}`);
      await execute(binary, ['spec', action, id, '-f', feature], repository);
    },
  };
}
