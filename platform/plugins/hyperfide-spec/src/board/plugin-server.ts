import type { PluginRpc } from '@hyperfide/plugin-sdk';
import { resolve } from 'node:path';
import { SpecReader, binaryCommand } from '../reader.js';
import { openSpecStorage, specCache } from '../storage.js';
import { boardContract } from './contract.js';
import { createBoardServer } from './server.js';

export async function withBoard<T>(repository: string, use: (board: ReturnType<typeof createBoardServer>) => Promise<T>, binary?: string) {
  const storage = await openSpecStorage(repository);
  const reader = new SpecReader(repository, specCache(storage), async () => {}, binaryCommand(binary));
  try {
    await reader.refresh();
    return await use(createBoardServer(repository, feature => reader.tasks(feature), binary, undefined, storage));
  } finally { reader.close(); storage.close(); }
}
export default function boardPlugin(api: { rpc: PluginRpc }, repositories: string[], binary?: string) {
  const allowed = new Set(repositories.map(repository => resolve(repository)));
  registerBoardHandlers(api, async (repository, use) => {
    const path = resolve(repository);
    if (!allowed.has(path)) throw new Error('Unknown repository');
    return withBoard(path, use, binary);
  });
}

type UseBoard = <T>(repository: string, use: (board: ReturnType<typeof createBoardServer>) => Promise<T>) => Promise<T>;
export function registerBoardHandlers(api: { rpc: PluginRpc }, useBoard: UseBoard) {
  api.rpc.register(boardContract, {
    boardTasks: input => useBoard(input.repository, board => board.tasks(input.feature)),
    boardTask: input => useBoard(input.repository, board => board.task!(input.feature, input.id)),
    boardAction: input => useBoard(input.repository, board => board.action(input.feature, input.id, input.action)),
  });
}
