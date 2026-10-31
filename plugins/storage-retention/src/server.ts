import { createStorage } from "./storage.js";
import type { HyperfidePluginApi } from "@hyperfide/plugin-sdk";
import { storageRpc } from "./contract.js";
import { createService } from "./service.js";
import { registerCli } from "./cli.js";

export default function plugin(hyperfide: HyperfidePluginApi) {
  const service = createService(hyperfide);
  const devCleanupEnabled = async () =>
    (await service.state()).policy.deleteDevDataOnCheckoutRemoval;
  const storage = createStorage(hyperfide, devCleanupEnabled);
  hyperfide.events.on("experimental_environment.removed", ({ removal }) =>
    removal.hostId === null
      ? undefined
      : storage.cleanDevelopmentStorage(removal.hostId),
  );
  hyperfide.background.schedule(
    "development-storage-cleanup",
    "0 * * * *",
    storage.reconcileDevelopmentStorage,
  );
  hyperfide.background.service("development-storage-recovery", {
    async start(signal) {
      if (signal.aborted) return;
      const unsubscribe = hyperfide.sdk.subscribe({
        event: "host:changed",
        callback: (event) => {
          if (event.changes.includes("host-connected"))
            void storage.reconcileDevelopmentStorage();
        },
      });
      const unsubscribeConnection = hyperfide.sdk.subscribe({
        event: "realtime:connection",
        callback: (event) => {
          if (event.state === "connected" && event.reconnected)
            void storage.reconcileDevelopmentStorage();
        },
      });
      try {
        await storage.reconcileDevelopmentStorage();
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else
            signal.addEventListener("abort", () => resolve(), { once: true });
        });
      } finally {
        unsubscribe();
        unsubscribeConnection();
      }
    },
  });
  const cleanupEnabled = async () =>
    (await service.state()).policy.deleteStorageOnArchive;
  hyperfide.events.on("thread.archived", async ({ thread }) => {
    if (
      thread.archivedAt === null ||
      thread.pinnedAt !== null ||
      !(await cleanupEnabled())
    )
      return;
    storage.queueArchivedStorage(thread.id, thread.archivedAt);
    await storage.clearPendingArchives(cleanupEnabled);
  });
  for (const event of ["thread.idle", "thread.failed"] as const)
    hyperfide.events.on(event, () => storage.clearPendingArchives(cleanupEnabled));
  for (const event of ["thread.unarchived", "thread.deleted"] as const)
    hyperfide.events.on(event, ({ thread }) =>
      storage.cancelArchivedStorage(thread.id),
    );
  hyperfide.background.schedule("archive-storage-cleanup", "* * * * *", () =>
    storage.clearPendingArchives(cleanupEnabled),
  );
  hyperfide.rpc.register(storageRpc, {
    startCleanup: storage.startCleanup,
    hosts: () => storage.hosts(),
    host: storage.host,
    scanHost: storage.scanHost,
    scanAll: () => storage.scanAll(),
    removeOrphans: (input) => storage.removeOrphans(input),
    clearLargeFiles: storage.clearLargeFiles,
    startClearLargeFiles: storage.startClearLargeFiles,
    retryWorktreeCleanup: (input) => storage.retryWorktreeCleanup(input),
    clearThread: storage.clearThread,
    clearArchivedFiles: storage.clearArchivedFiles,
    startClearArchivedFiles: storage.startClearArchivedFiles,
    removeDevInstances: (input) => storage.removeDevInstances(input),
    state: () => service.state(),
    preview: (policy) => service.preview(policy),
    configure: (policy) => service.configure(policy),
  });
  registerCli(hyperfide, service, storage);
  hyperfide.background.schedule("retention", "0 * * * *", () => service.sweep());
}
