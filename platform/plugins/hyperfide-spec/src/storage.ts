import { openPluginStorage, type PluginStorage } from '@hyperfide/authority';
import type { SpecStorage } from './reader.js';
import type { SpecSnapshot } from './shared/model.js';
export const openSpecStorage = (repository: string) => openPluginStorage('hyperfide-spec', repository);
export function specCache(storage: PluginStorage): SpecStorage {
  return { get: key => storage.get<SpecSnapshot>(key), set: (key, value) => storage.put(key, value) };
}
