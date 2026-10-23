import { experimental_defineHostEntry } from '@hyperfide/plugin-sdk/host';
import { SpecReader } from '../reader.js';
import { openSpecStorage, specCache } from '../storage.js';
import { boardContract } from './contract.js';
import { createBoardServer } from './server.js';

export async function withBoard<T>(repository: string, use: (board: ReturnType<typeof createBoardServer>) => Promise<T>) {
  const storage = await openSpecStorage(repository);
  const reader = new SpecReader(repository, specCache(storage), async () => {});
  try {
    await reader.refresh();
    return await use(createBoardServer(repository, feature => reader.tasks(feature), 'hyperfide', undefined, storage));
  } finally { reader.close(); storage.close(); }
}
export default experimental_defineHostEntry({
  contract: boardContract,
  handlers: {
    boardTasks: input => withBoard(input.repository, board => board.tasks(input.feature)),
    boardAction: input => withBoard(input.repository, board => board.action(input.feature, input.id, input.action)),
  },
});
