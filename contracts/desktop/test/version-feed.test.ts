import { describe, expect, it } from "vitest";
import {
  hyperfideDesktopThemeSchema,
  hyperfideDesktopVersionFeedSchema,
  hyperfideDesktopWindowStateSchema,
} from "../src/index.js";

const checkedAt = "2026-05-21T00:00:00.000Z";

describe("desktop info schema", () => {
  it("accepts the desktop theme values", () => {
    expect(hyperfideDesktopThemeSchema.safeParse("dark").success).toBe(true);
    expect(hyperfideDesktopThemeSchema.safeParse("light").success).toBe(true);
    expect(hyperfideDesktopThemeSchema.safeParse("system").success).toBe(true);
    expect(
      hyperfideDesktopThemeSchema.safeParse({
        canvasColor: "oklch(0.195 0 0)",
        inkColor: "oklch(0.81 0 0)",
        mode: "dark",
      }).success,
    ).toBe(false);
  });

  it("accepts strict desktop window state payloads", () => {
    expect(
      hyperfideDesktopWindowStateSchema.safeParse({ isFullScreen: true }).success,
    ).toBe(true);
    expect(
      hyperfideDesktopWindowStateSchema.safeParse({
        isFullScreen: true,
        extra: true,
      }).success,
    ).toBe(false);
  });
});

describe("desktop version feed schema", () => {
  it("accepts the isolated nightly desktop channel", () => {
    expect(
      hyperfideDesktopVersionFeedSchema.safeParse({
        channel: "nightly",
        files: [
          {
            sha512: "BASE64_SHA512_FROM_ELECTRON_BUILDER",
            size: 123456789,
            url: "hyperfide-nightly-0.0.2-nightly.1.1-arm64.zip",
          },
        ],
        minimumSystemVersion: null,
        path: "hyperfide-nightly-0.0.2-nightly.1.1-arm64.zip",
        platform: "macos",
        releaseDate: checkedAt,
        releaseName: "hyperfide Nightly desktop 0.0.2-nightly.1.1",
        releaseNotes: null,
        schemaVersion: 1,
        sha512: "BASE64_SHA512_FROM_ELECTRON_BUILDER",
        stagingPercentage: null,
        version: "0.0.2-nightly.1.1",
      }).success,
    ).toBe(true);
  });

  it("rejects malformed version feed payloads", () => {
    expect(
      hyperfideDesktopVersionFeedSchema.safeParse({
        channel: "latest",
        files: [],
        minimumSystemVersion: null,
        path: "hyperfide-0.0.2-universal.zip",
        platform: "macos",
        releaseDate: checkedAt,
        releaseName: "hyperfide desktop 0.0.2",
        releaseNotes: null,
        schemaVersion: 1,
        sha512: "BASE64_SHA512_FROM_ELECTRON_BUILDER",
        stagingPercentage: null,
        version: "0.0.2",
      }).success,
    ).toBe(false);
  });
});
