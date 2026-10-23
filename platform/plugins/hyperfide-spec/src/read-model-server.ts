import type { HyperfidePluginApi } from '@hyperfide/plugin-sdk';
import { resolve } from 'node:path';
import { SpecReader, binaryCommand } from './reader.js';
import type { SpecSnapshot } from './shared/model.js';
import { specContract } from './shared/contract.js';
import registerBoard from './board/plugin-server.js';

export async function registerSpecReadModel(api: HyperfidePluginApi, repositories: string[], binary = 'hyperfide') {
  const readers = new Map<string, SpecReader>();
  for (const repository of new Set(repositories.map(path => resolve(path)))) {
    const reader = new SpecReader(repository, {
      get: key => api.storage.kv.get<SpecSnapshot>(key),
      set: (key, value) => api.storage.kv.set(key, value),
    }, async snapshot => {
      api.realtime.publish('hyperfide-spec:changed', snapshot);
      api.rpc.experimental_invalidateAll();
    }, binaryCommand(binary));
    readers.set(repository, reader);
    api.onDispose(() => reader.close());
  }
  const select = (repository?: string) => {
    const reader = repository ? readers.get(resolve(repository)) : readers.size === 1 ? readers.values().next().value : undefined;
    if (!reader) throw new Error('Unknown or ambiguous repository');
    return reader;
  };
  api.rpc.register(specContract, {
    features: input => select(input.repository).features(),
    tasks: input => select(input.repository).tasks(input.feature),
    task: input => select(input.repository).task(input.feature, input.id),
    waves: input => select(input.repository).waves(input.feature),
  });
  try { await Promise.all([...readers.values()].map(reader => reader.start())); }
  catch (error) { for (const reader of readers.values()) reader.close(); throw error; }
  return readers;
}

export default async function specPlugin(api: HyperfidePluginApi) {
  registerBoard(api);
  const repositories = await api.storage.kv.get<string[]>('spec.repositories') ??
    (await api.sdk.projects.list()).flatMap(project => project.sources.map(source => source.path));
  const binary = await api.storage.kv.get<string>('spec.binaryPath');
  return registerSpecReadModel(api, repositories, binary);
}
