import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCliRuntimeContext,
  requireThreadId,
  requireThreadIdOrSelf,
  resolveContextProjectId,
  resolveContextThreadId,
  resolveContextSnapshot,
  resolveExplicitIdFlag,
  resolveServerUrl,
} from "../context-env.js";

describe("context-env", () => {
  beforeEach(() => {
    vi.stubEnv("HYPERFIDE_PROJECT_ID", undefined);
    vi.stubEnv("HYPERFIDE_THREAD_ID", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("requires project and thread context when missing", () => {
    expect(() => requireThreadId(undefined)).toThrow(
      "Missing thread ID. Pass <threadId>.",
    );
  });

  it("resolves explicit ID flags without environment fallback", () => {
    vi.stubEnv("HYPERFIDE_THREAD_ID", "thread-env");

    expect(
      resolveExplicitIdFlag({
        flagName: "--parent-thread",
        value: " thread-parent ",
      }),
    ).toBe("thread-parent");
    expect(
      resolveExplicitIdFlag({
        flagName: "--parent-thread",
        value: "   ",
      }),
    ).toBeUndefined();
    expect(
      resolveExplicitIdFlag({
        flagName: "--parent-thread",
        value: undefined,
      }),
    ).toBeUndefined();
  });

  it("rejects invalid explicit ID flags", () => {
    expect(() =>
      resolveExplicitIdFlag({
        flagName: "--parent-thread",
        value: "thread/invalid",
      }),
    ).toThrow('Invalid ID from --parent-thread: "thread/invalid".');
  });

  it("captures a consistent context snapshot", () => {
    vi.stubEnv("HYPERFIDE_PROJECT_ID", "proj-1");
    vi.stubEnv("HYPERFIDE_THREAD_ID", "thread-1");

    expect(resolveContextProjectId()).toBe("proj-1");
    expect(resolveContextThreadId()).toBe("thread-1");
    const snapshot = resolveContextSnapshot();
    expect(snapshot.projectId).toBe("proj-1");
    expect(snapshot.threadId).toBe("thread-1");
    expect(snapshot.serverUrl).toMatch(/^https?:\/\//);
  });

  it("resolves connection settings from one CLI runtime context", () => {
    const context = createCliRuntimeContext({
      cliConfig: {
        HYPERFIDE_HOST_DAEMON_PORT: 4567,
        HYPERFIDE_SERVER_URL: "http://server.test",
      },
    });

    expect(resolveServerUrl(context)).toBe("http://server.test");
    expect(resolveContextSnapshot(context).serverUrl).toBe(
      "http://server.test",
    );
  });

  it("resolves --self from HYPERFIDE_THREAD_ID for thread commands", () => {
    vi.stubEnv("HYPERFIDE_THREAD_ID", "thread-self");

    expect(requireThreadIdOrSelf(undefined, { self: true })).toBe(
      "thread-self",
    );
  });

  it("rejects combining a thread id with --self for thread commands", () => {
    vi.stubEnv("HYPERFIDE_THREAD_ID", "thread-self");

    expect(() =>
      requireThreadIdOrSelf("thread-explicit", { self: true }),
    ).toThrow("Cannot combine a thread ID argument with --self.");
  });
});
