import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { setExperiments } from "@hyperfide/db";
import { createMigratedConnection } from "@hyperfide/db/testing";
import { describe, expect, it } from "vitest";
import { NotificationHub } from "../../src/ws/hub.js";
import { startGatedPerformanceDiagnostics } from "../../src/services/system/performance-diagnostics.js";

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check() && Date.now() < deadline) await setTimeout(10);
  expect(check()).toBe(true);
}

describe("performance diagnostics gates", () => {
  it.each([false, true])(
    "requires launch permission %s as well as the live experiment",
    async (allowed) => {
      const db = await createMigratedConnection();
      const dataDir = await mkdtemp(join(tmpdir(), "hyperfide-perf-gates-"));
      const hub = await new NotificationHub();
      const messages: string[] = [];
      const monitor = await startGatedPerformanceDiagnostics({
        allowed,
        dataDir,
        db,
        hub,
        logger: {
          info: (_fields: unknown, message?: string) => {
            messages.push(message ?? "");
          },
          warn: (_fields: unknown, message?: string) => {
            messages.push(message ?? "");
          },
        },
      });
      try {
        expect(monitor.isEnabled()).toBe(false);
        expect(await readdir(dataDir)).toEqual([]);
        await setExperiments(db, { performanceDiagnostics: true });
        await hub.notifySystem(["config-changed"]);
        expect(monitor.isEnabled()).toBe(allowed);
        if (allowed) {
          await until(() =>
            messages.includes("Server performance diagnostics enabled"),
          );
        } else {
          await setTimeout(30);
          expect(messages).toEqual([]);
          expect(await readdir(dataDir)).toEqual([]);
        }
        await setExperiments(db, { performanceDiagnostics: false });
        await hub.notifySystem(["config-changed"]);
        expect(monitor.isEnabled()).toBe(false);
        if (allowed) {
          await until(() =>
            messages.includes("Server performance diagnostics stopped"),
          );
          const captures = await readdir(join(dataDir, "logs", "performance"));
          expect(captures).toHaveLength(1);
          expect(captures[0]).toMatch(/\.cpuprofile$/);
        }
        await setExperiments(db, { performanceDiagnostics: true });
        await hub.notifySystem(["config-changed"]);
        await monitor.stop();
        expect(monitor.isEnabled()).toBe(false);
        await hub.notifySystem(["config-changed"]);
        expect(monitor.isEnabled()).toBe(false);
        const restarted = await startGatedPerformanceDiagnostics({
          allowed,
          dataDir,
          db,
          hub,
          logger: { info: () => {}, warn: () => {} },
        });
        try {
          expect(restarted.isEnabled()).toBe(allowed);
        } finally {
          await restarted.stop();
        }
      } finally {
        await monitor.stop();
        await db.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  );
});
