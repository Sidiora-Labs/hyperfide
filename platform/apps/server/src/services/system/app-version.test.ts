import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppVersionService } from "./app-version.js";
import { loadServerConfig } from "@hyperfide/config/server";

const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
const channel = { url: "https://updates.hyperfide.example/latest" };
function service(
  fetchImpl: typeof fetch,
  updateChannel?: typeof channel,
  now?: () => number,
) {
  return createAppVersionService({
    config: { appVersion: "2.2.0", isDevelopment: false, updateChannel },
    installKind: "npm",
    sourceCommit: null,
    logger,
    fetchImpl,
    now,
  });
}
afterEach(() => vi.useRealTimers());
describe("system version", () => {
  it("loads an optional scoped npm update package without a default channel", () => {
    const config = loadServerConfig({
      env: { NODE_ENV: "production" },
      homeDir: "/tmp/hyperfide-version-test",
    });
    expect(config.HYPERFIDE_APP_UPDATE_PACKAGE).toBeUndefined();
    expect(
      loadServerConfig({
        env: {
          NODE_ENV: "production",
          HYPERFIDE_APP_UPDATE_PACKAGE: "@hyperfide/app",
        },
        homeDir: "/tmp/hyperfide-version-test",
      }).HYPERFIDE_APP_UPDATE_PACKAGE,
    ).toBe("@hyperfide/app");
    expect(() =>
      loadServerConfig({
        env: {
          NODE_ENV: "production",
          HYPERFIDE_APP_UPDATE_PACKAGE: "package; echo unsafe",
        },
        homeDir: "/tmp/hyperfide-version-test",
      }),
    ).toThrow("must be an npm package name");
  });
  it("makes no request by default", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await service(fetchImpl).getSystemVersion()).toMatchObject({
      latestVersion: null,
      updateAvailable: false,
      upgradeCommand: null,
      source: "npm",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("answers within 100 ms even when fetch never resolves", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise(() => {}));
    const app = service(fetchImpl, channel);
    const started = performance.now();
    expect((await app.getSystemVersion()).latestVersion).toBeNull();
    expect(performance.now() - started).toBeLessThan(100);
    await app.getSystemVersion();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it.each(["404", "throw", "parse"])(
    "caches a %s failure for ten minutes",
    async (failure) => {
      let now = 0;
      const fetchImpl = vi.fn<typeof fetch>(async () => {
        if (failure === "throw") throw new Error("offline");
        return failure === "404"
          ? new Response(null, { status: 404 })
          : Response.json({ version: "invalid" });
      });
      const app = service(fetchImpl, channel, () => now);
      await app.getSystemVersion();
      await new Promise((resolve) => setImmediate(resolve));
      now = 599_999;
      await app.getSystemVersion({ forceRefresh: true });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      now = 600_000;
      await app.getSystemVersion();
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    },
  );
  it("serves cached releases while refreshing", async () => {
    let now = 0;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ version: "2.3.0" }))
      .mockImplementation(() => new Promise(() => {}));
    const app = service(fetchImpl, channel, () => now);
    await app.getSystemVersion();
    await new Promise((resolve) => setImmediate(resolve));
    now = 3_600_000;
    const started = performance.now();
    expect(await app.getSystemVersion()).toMatchObject({
      latestVersion: "2.3.0",
      updateAvailable: true,
    });
    expect(performance.now() - started).toBeLessThan(100);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("times out transports that ignore abort and caches the failure", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise(() => {}));
    const app = service(fetchImpl, channel);
    await app.getSystemVersion();
    await vi.advanceTimersByTimeAsync(5_000);
    await app.getSystemVersion();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(600_000);
    await app.getSystemVersion();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
