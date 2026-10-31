import { gzipSync, gunzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import type { SpecSnapshot } from './shared/model.js';
import type { SpecStorage } from './reader.js';

interface Kv {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}
interface PackedSnapshot { repository: string; encoding: 'gzip'; chunks: string[] }

// Repository-wide traces exceed the runtime's 256 KiB per-value KV limit.
export function snapshotStorage(kv: Kv): SpecStorage {
  return {
    async get(key) {
      const value = await kv.get<SpecSnapshot | PackedSnapshot>(key);
      if (!value || !('encoding' in value)) return value;
      const chunks = await Promise.all(value.chunks.map(chunk => kv.get<string>(chunk)));
      if (chunks.some(chunk => chunk === undefined)) return undefined;
      return JSON.parse(gunzipSync(Buffer.from(chunks.join(''), 'base64')).toString()) as SpecSnapshot;
    },
    async set(key, value) {
      const packed = gzipSync(JSON.stringify(value)).toString('base64');
      const size = 128 * 1024;
      const previous = await kv.get<SpecSnapshot | PackedSnapshot>(key);
      const generation = randomUUID();
      const chunks = Array.from({ length: Math.ceil(packed.length / size) }, (_, index) =>
        `${key}:chunk:${generation}:${index}`);
      try {
        for (const [index, chunk] of chunks.entries()) {
          await kv.set(chunk, packed.slice(index * size, (index + 1) * size));
        }
        await kv.set(key, { repository: value.repository, encoding: 'gzip', chunks } satisfies PackedSnapshot);
      } catch (error) {
        await Promise.allSettled(chunks.map(chunk => kv.delete(chunk)));
        throw error;
      }
      if (previous && 'encoding' in previous) {
        await Promise.allSettled(previous.chunks.map(chunk => kv.delete(chunk)));
      }
    },
  };
}
