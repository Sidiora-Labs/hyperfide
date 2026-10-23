import { createDeferredPromise, type DeferredPromise } from "@hyperfide/test-helpers";
import { describe, expect, it } from "vitest";
import type { ServerChangedMessage } from "../../ws/hub.js";
import {
  EnvironmentReadCache,
  WorkspaceReadCaches,
} from "./workspace-read-cache.js";

function createClock(start = 1_000) {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

function createCounter<T>(values: T[]) {
  const loads: DeferredPromise<T>[] = [];
  return {
    loads,
    load: () => {
      const next = createDeferredPromise<T>();
      loads.push(next);
      const value = values[loads.length - 1];
      if (value !== undefined) {
        next.resolve(value);
      }
      return next.promise;
    },
  };
}

function createFakeHub() {
  const listeners = new Set<(message: ServerChangedMessage) => void>();
  return {
    onChangedMessage(listener: (message: ServerChangedMessage) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(message: ServerChangedMessage) {
      for (const listener of listeners) {
        listener(message);
      }
    },
  };
}

const READ = { environmentId: "env-1", hostId: "host-1", key: "k" };

describe("EnvironmentReadCache", () => {
  it("shares one in-flight load between overlapping reads and reuses it inside the TTL", async () => {
    const clock = createClock();
    const cache = new EnvironmentReadCache<string>({
      now: clock.now,
      ttlMs: 3_000,
    });
    const counter = createCounter<string>([]);

    const first = cache.read({ ...READ, load: counter.load });
    const second = cache.read({ ...READ, load: counter.load });
    expect(counter.loads).toHaveLength(1);
    counter.loads[0]?.resolve("a");
    await expect(first).resolves.toBe("a");
    await expect(second).resolves.toBe("a");

    clock.advance(2_999);
    await expect(cache.read({ ...READ, load: counter.load })).resolves.toBe(
      "a",
    );
    expect(counter.loads).toHaveLength(1);

    clock.advance(1);
    const third = cache.read({ ...READ, load: counter.load });
    expect(counter.loads).toHaveLength(2);
    counter.loads[1]?.resolve("b");
    await expect(third).resolves.toBe("b");
  });

  it("keys reads by environment and by input key", async () => {
    const cache = new EnvironmentReadCache<string>({
      now: () => 0,
      ttlMs: 3_000,
    });
    const counter = createCounter(["a", "b", "c"]);

    await cache.read({ ...READ, load: counter.load });
    await cache.read({ ...READ, key: "other", load: counter.load });
    await cache.read({ ...READ, environmentId: "env-2", load: counter.load });
    await cache.read({ ...READ, load: counter.load });
    expect(counter.loads).toHaveLength(3);
  });

  it("does not cache a rejected load and lets the next read retry", async () => {
    const cache = new EnvironmentReadCache<string>({
      now: () => 0,
      ttlMs: 3_000,
    });
    const counter = createCounter<string>([]);

    const first = cache.read({ ...READ, load: counter.load });
    counter.loads[0]?.reject(new Error("boom"));
    await expect(first).rejects.toThrow("boom");

    const second = cache.read({ ...READ, load: counter.load });
    expect(counter.loads).toHaveLength(2);
    counter.loads[1]?.resolve("ok");
    await expect(second).resolves.toBe("ok");
  });

  it("detaches an in-flight probe on invalidation so its result is not reused", async () => {
    const cache = new EnvironmentReadCache<string>({
      now: () => 0,
      ttlMs: 3_000,
    });
    const counter = createCounter<string>([]);

    const stale = cache.read({ ...READ, load: counter.load });
    cache.invalidateEnvironment("env-1");

    const fresh = cache.read({ ...READ, load: counter.load });
    expect(counter.loads).toHaveLength(2);

    counter.loads[0]?.resolve("pre-change");
    counter.loads[1]?.resolve("post-change");
    await expect(stale).resolves.toBe("pre-change");
    await expect(fresh).resolves.toBe("post-change");

    await expect(cache.read({ ...READ, load: counter.load })).resolves.toBe(
      "post-change",
    );
    expect(counter.loads).toHaveLength(2);
  });

  it("invalidates only the entries that belong to the given host", async () => {
    const cache = new EnvironmentReadCache<string>({
      now: () => 0,
      ttlMs: 3_000,
    });
    const counter = createCounter(["a", "b", "c"]);

    await cache.read({ ...READ, load: counter.load });
    await cache.read({
      ...READ,
      environmentId: "env-2",
      hostId: "host-2",
      load: counter.load,
    });
    cache.invalidateHost("host-1");

    await cache.read({
      ...READ,
      environmentId: "env-2",
      hostId: "host-2",
      load: counter.load,
    });
    expect(counter.loads).toHaveLength(2);
    await cache.read({ ...READ, load: counter.load });
    expect(counter.loads).toHaveLength(3);
  });
});

describe("WorkspaceReadCaches", () => {
  const statusResult = {
    outcome: "unavailable" as const,
    failure: {
      code: "unknown" as const,
      workspacePath: "/tmp/env-1",
      message: "no git",
    },
  };

  async function primeStatus(caches: WorkspaceReadCaches) {
    const status = createCounter([statusResult, statusResult, statusResult]);
    await caches.status.read({ ...READ, load: status.load });
    return {
      async readStatus() {
        await caches.status.read({ ...READ, load: status.load });
        return status.loads.length;
      },
    };
  }

  it("refreshes status on workspace and ref changes for that environment only", async () => {
    for (const changes of [
      ["work-status-changed"],
      ["git-refs-changed"],
      ["status-changed"],
      ["work-status-changed", "metadata-changed"],
    ] as const) {
      const hub = createFakeHub();
      const clock = createClock();
      const caches = new WorkspaceReadCaches({ hub, now: clock.now });
      const primed = await primeStatus(caches);

      hub.emit({
        type: "changed",
        entity: "environment",
        id: "env-2",
        changes: [...changes],
      });
      expect(await primed.readStatus()).toBe(1);

      hub.emit({
        type: "changed",
        entity: "environment",
        id: "env-1",
        changes: [...changes],
      });
      expect(await primed.readStatus()).toBe(2);
    }
  });

  it("keeps cached reads across record-only environment changes", async () => {
    const hub = createFakeHub();
    const caches = new WorkspaceReadCaches({ hub, now: () => 0 });
    const primed = await primeStatus(caches);

    hub.emit({
      type: "changed",
      entity: "environment",
      id: "env-1",
      changes: [
        "metadata-changed",
        "thread-storage-changed",
        "diff-viewed-changed",
      ],
    });
    expect(await primed.readStatus()).toBe(1);
  });

  it("drops cached reads for a host when that host connects or disconnects", async () => {
    const hub = createFakeHub();
    const caches = new WorkspaceReadCaches({ hub, now: () => 0 });
    const primed = await primeStatus(caches);

    hub.emit({
      type: "changed",
      entity: "host",
      id: "host-2",
      changes: ["host-connected"],
    });
    expect(await primed.readStatus()).toBe(1);

    hub.emit({
      type: "changed",
      entity: "host",
      id: "host-1",
      changes: ["host-connected"],
    });
    expect(await primed.readStatus()).toBe(2);
  });

  it("keeps a host's cached reads when only its provider model catalog changed", async () => {
    const hub = createFakeHub();
    const caches = new WorkspaceReadCaches({ hub, now: () => 0 });
    const primed = await primeStatus(caches);

    hub.emit({
      type: "changed",
      entity: "host",
      id: "host-1",
      changes: ["provider-model-catalog-changed"],
    });
    expect(await primed.readStatus()).toBe(1);
  });

  it("drops the status cache when a server-side mutation invalidates the environment or host", async () => {
    const hub = createFakeHub();
    const caches = new WorkspaceReadCaches({ hub, now: () => 0 });
    const primed = await primeStatus(caches);

    caches.invalidateEnvironment("env-2");
    caches.invalidateHost("host-2");
    expect(await primed.readStatus()).toBe(1);

    caches.invalidateEnvironment("env-1");
    expect(await primed.readStatus()).toBe(2);

    caches.invalidateHost("host-1");
    expect(await primed.readStatus()).toBe(3);
  });
});

describe("diff-file in-flight reads", () => {
  it("shares concurrent requests, but never reuses a completed result or joins work invalidated by an edit", async () => {
    const hub = createFakeHub();
    const caches = new WorkspaceReadCaches({ hub });
    const result = {
      outcome: "available" as const,
      files: [],
      shortstat: "",
      mergeBaseRef: null,
      truncated: false,
    };
    const counter = createCounter([result]);
    const first = caches.diffFiles.read({ ...READ, load: counter.load });
    const same = caches.diffFiles.read({ ...READ, load: counter.load });
    expect(counter.loads).toHaveLength(1);
    await Promise.all([first, same]);
    const second = caches.diffFiles.read({ ...READ, load: counter.load });
    expect(counter.loads).toHaveLength(2);
    hub.emit({
      type: "changed",
      entity: "environment",
      id: READ.environmentId,
      changes: ["work-status-changed"],
    });
    const afterEdit = caches.diffFiles.read({ ...READ, load: counter.load });
    expect(counter.loads).toHaveLength(3);
    counter.loads[1]?.resolve(result);
    await second;
    const stillPending = caches.diffFiles.read({ ...READ, load: counter.load });
    expect(counter.loads).toHaveLength(3);
    counter.loads[2]?.resolve(result);
    await Promise.all([afterEdit, stillPending]);
  });
});
