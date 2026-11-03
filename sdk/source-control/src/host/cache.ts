import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  assertObjectId,
  nativeObjectId,
  type SourceObject,
  type SourceScope,
  workspaceError,
} from "./client.js";

export interface CacheLimits {
  max_bytes: number;
  max_entries: number;
  max_object_bytes: number;
}
export interface CachedObject {
  object: SourceObject;
  release(): Promise<void>;
}
export class NativeObjectCache {
  private readonly counters = {
    hits: 0,
    misses: 0,
    coalesced: 0,
    downloads: 0,
    downloaded_bytes: 0,
    evictions: 0,
  };
  get metrics() {
    return { ...this.counters };
  }
  private count(key: keyof NativeObjectCache["counters"], amount = 1): void {
    this.counters[key] = Math.min(
      Number.MAX_SAFE_INTEGER,
      this.counters[key] + amount,
    );
  }

  private readonly pending = new Map<string, Promise<SourceObject>>();
  private queue: Promise<void> = Promise.resolve();
  constructor(
    readonly root: string,
    readonly limits: CacheLimits,
  ) {
    for (const n of Object.values(limits))
      if (!Number.isSafeInteger(n) || n <= 0)
        workspaceError(
          "CACHE_BUDGET",
          "Positive bounded cache limits required",
        );
  }
  private directory(scope: SourceScope): string {
    const domain = createHash("sha256")
      .update(JSON.stringify([scope.organisation_id, scope.security_domain_id]))
      .digest("hex");
    return path.join(this.root, domain);
  }
  private async initialize(scope: SourceScope): Promise<string> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      workspaceError("CACHE_PATH", "Cache root must be a private directory");
    const dir = this.directory(scope);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const domain = await fs.lstat(dir);
    if (!domain.isDirectory() || domain.isSymbolicLink())
      workspaceError("CACHE_PATH", "Cache security domain must be a directory");
    return dir;
  }
  private async read(dir: string, id: string): Promise<SourceObject | null> {
    const stem = path.join(dir, id.slice(7));
    try {
      const stat = await fs.lstat(stem + ".data");
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > this.limits.max_object_bytes
      )
        workspaceError("CACHE_INTEGRITY", "Invalid cache object");
      const meta = JSON.parse(await fs.readFile(stem + ".json", "utf8")) as {
        kind: string;
        size: number;
      };
      const payload = await fs.readFile(stem + ".data");
      if (
        payload.length !== meta.size ||
        nativeObjectId(meta.kind, payload) !== id
      )
        workspaceError("CACHE_INTEGRITY", "Cached object checksum mismatch");
      await fs.utimes(stem + ".json", new Date(), new Date());
      return { object_id: id, kind: meta.kind, payload };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  private async exclusive<T>(body: () => Promise<T>): Promise<T> {
    const before = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((r) => {
      release = r;
    });
    await before;
    try {
      return await body();
    } finally {
      release();
    }
  }
  private async reserve(dir: string, needed: number): Promise<void> {
    const entries: {
      stem: string;
      bytes: number;
      accessed: number;
      pinned: boolean;
    }[] = [];
    for (const domain of await fs.readdir(this.root, { withFileTypes: true })) {
      if (!domain.isDirectory() || !/^[a-f0-9]{64}$/.test(domain.name))
        continue;
      const base = path.join(this.root, domain.name);
      const names = await fs.readdir(base);
      for (const name of names) {
        if (!/^[a-f0-9]{64}\.data$/.test(name)) continue;
        const stem = path.join(base, name.slice(0, -5));
        try {
          const stat = await fs.lstat(stem + ".data");
          const metadata = await fs.lstat(stem + ".json");
          entries.push({
            stem,
            bytes: stat.size,
            accessed: metadata.mtimeMs,
            pinned: names.some((n) =>
              n.startsWith(name.slice(0, -5) + ".pin-"),
            ),
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
    let bytes = entries.reduce((sum, e) => sum + e.bytes, 0),
      count = entries.length;
    for (const item of entries.sort((a, b) => a.accessed - b.accessed)) {
      if (
        bytes + needed <= this.limits.max_bytes &&
        count + 1 <= this.limits.max_entries
      )
        break;
      if (item.pinned) continue;
      await fs.rm(item.stem + ".data", { force: true });
      await fs.rm(item.stem + ".json", { force: true });
      bytes -= item.bytes;
      count--;
      this.count("evictions");
    }
    if (
      bytes + needed > this.limits.max_bytes ||
      count + 1 > this.limits.max_entries
    )
      workspaceError(
        "CACHE_PRESSURE",
        "Pinned cache objects exceed the clean cache budget",
      );
    void dir;
  }
  async acquire(
    scope: SourceScope,
    id: string,
    download: () => Promise<SourceObject>,
    authorize: () => Promise<void>,
  ): Promise<CachedObject> {
    assertObjectId(id);
    await authorize();
    const dir = await this.initialize(scope),
      stem = path.join(dir, id.slice(7));
    const pin = stem + ".pin-" + randomUUID();
    await fs.writeFile(pin, "", { flag: "wx", mode: 0o400 });
    try {
      const existing = await this.read(dir, id);
      let object = existing;
      this.count(existing ? "hits" : "misses");
      if (!object) {
        const key = dir + "/" + id;
        let pending = this.pending.get(key);
        if (pending) this.count("coalesced");
        if (!pending) {
          pending = (async () => {
            this.count("downloads");
            const value = await download();
            this.count("downloaded_bytes", value.payload.length);
            if (
              value.object_id !== id ||
              value.payload.length > this.limits.max_object_bytes ||
              nativeObjectId(value.kind, value.payload) !== id
            )
              workspaceError(
                "OBJECT_INTEGRITY",
                "Downloaded cache object failed verification",
              );
            await this.exclusive(async () => {
              if (await this.read(dir, id)) return;
              await this.reserve(dir, value.payload.length);
              const temporary = stem + ".tmp-" + randomUUID();
              const handle = await fs.open(temporary, "wx", 0o400);
              try {
                await handle.writeFile(value.payload);
                await handle.sync();
              } finally {
                await handle.close();
              }
              try {
                await fs.rename(temporary, stem + ".data");
                await fs.writeFile(
                  stem + ".json",
                  JSON.stringify({
                    kind: value.kind,
                    size: value.payload.length,
                  }),
                  { mode: 0o400 },
                );
              } finally {
                await fs.rm(temporary, { force: true });
              }
            });
            return value;
          })();
          this.pending.set(key, pending);
          pending.finally(() => this.pending.delete(key)).catch(() => {});
        }
        object = await pending;
      }
      await authorize();
      let active = true;
      return {
        object,
        release: async () => {
          if (active) {
            active = false;
            await fs.rm(pin, { force: true });
          }
        },
      };
    } catch (error) {
      await fs.rm(pin, { force: true });
      throw error;
    }
  }
}
