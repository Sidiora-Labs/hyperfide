import { SpecReader, binaryCommand, type SpecStorage } from './reader.js';
import type { SpecRead, SpecRpc } from './shared/model.js';

/** Local runtime projection of the repository-scoped RPC/storage/realtime host. */
export interface SpecReadHost {
  storage: SpecStorage;
  rpc: { register(name: keyof SpecRpc, handler: (input: { feature?: string; id?: string }) => Promise<unknown>): void };
  realtime: { publish(topic: string, snapshot: SpecRead): Promise<void> };
  onDispose(dispose: () => void): void;
}
export async function registerSpecReadModel(host: SpecReadHost, repository: string, binary = 'hyperfide') {
  const reader = new SpecReader(repository, host.storage,
    snapshot => host.realtime.publish('hyperfide-spec:changed', snapshot), binaryCommand(binary));
  host.onDispose(() => reader.close());
  host.rpc.register('features', () => reader.features());
  host.rpc.register('tasks', input => reader.tasks(required(input.feature, 'feature')));
  host.rpc.register('task', input => reader.task(required(input.feature, 'feature'), required(input.id, 'id')));
  host.rpc.register('waves', input => reader.waves(required(input.feature, 'feature')));
  try { await reader.start(); }
  catch (error) { reader.close(); throw error; }
  return reader;
}
function required(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`Missing ${field}`);
  return value;
}
