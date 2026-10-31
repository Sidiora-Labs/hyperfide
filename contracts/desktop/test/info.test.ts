import { describe, expect, it } from "vitest";
import { hyperfideDesktopInfoSchema } from "../src/info.js";

const baseInfo = {
  lastCheckedAt: null,
  latestVersion: "0.0.32",
  pendingVersion: null,
  platform: "macos",
  updateAvailable: true,
  updateDownloaded: false,
  version: "0.0.31",
} as const;

describe("hyperfideDesktopInfoSchema", () => {
  it("accepts both explicit download state and legacy shell payloads", () => {
    expect(
      hyperfideDesktopInfoSchema.safeParse({
        ...baseInfo,
        downloadState: "downloading",
      }).success,
    ).toBe(true);
    expect(hyperfideDesktopInfoSchema.safeParse(baseInfo).success).toBe(true);
    expect(
      hyperfideDesktopInfoSchema.safeParse({
        ...baseInfo,
        lastCheckedAt: "2026-05-21T00:00:00.000Z",
      }).success,
    ).toBe(true);
  });

  it("rejects an unknown download state", () => {
    expect(
      hyperfideDesktopInfoSchema.safeParse({
        ...baseInfo,
        downloadState: "available",
      }).success,
    ).toBe(false);
  });

  it("accepts linux", () => {
    expect(
      hyperfideDesktopInfoSchema.safeParse({
        ...baseInfo,
        platform: "linux",
      }).success,
    ).toBe(true);
  });

  it("rejects win32", () => {
    expect(
      hyperfideDesktopInfoSchema.safeParse({
        ...baseInfo,
        platform: "win32",
      }).success,
    ).toBe(false);
  });
});
