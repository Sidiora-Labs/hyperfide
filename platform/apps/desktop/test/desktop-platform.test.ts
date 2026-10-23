import { describe, expect, it } from "vitest";
import { resolveHyperfideDesktopPlatform } from "../src/desktop-platform.js";

describe("resolveHyperfideDesktopPlatform", () => {
  it("names each supported desktop platform", () => {
    expect(resolveHyperfideDesktopPlatform("darwin")).toBe("macos");
    expect(resolveHyperfideDesktopPlatform("linux")).toBe("linux");
    expect(resolveHyperfideDesktopPlatform("win32")).toBe("windows");
  });
});
