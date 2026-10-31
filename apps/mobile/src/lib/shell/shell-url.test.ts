import { describe, expect, it } from "vitest";
import {
  buildShellUrl,
  isExternallyOpenable,
  isShellNavigation,
  shellPathFromUrl,
} from "./shell-url";

const ROOT = "https://bee.hyperfide.example";
const PREFIXED = "https://box.example.ts.net/hyperfide";

describe("buildShellUrl", () => {
  it("joins a page path onto a server mounted at the root", () => {
    expect(buildShellUrl(ROOT, "/")).toBe("https://bee.hyperfide.example/");
    expect(buildShellUrl(`${ROOT}/`, "/threads/thr_1")).toBe(
      "https://bee.hyperfide.example/threads/thr_1",
    );
    expect(buildShellUrl(ROOT, "/threads/thr_1?tab=diff")).toBe(
      "https://bee.hyperfide.example/threads/thr_1?tab=diff",
    );
  });

  it("keeps a server's path prefix", () => {
    expect(buildShellUrl(PREFIXED, "/")).toBe("https://box.example.ts.net/hyperfide/");
    expect(buildShellUrl(PREFIXED, "/threads/thr_1")).toBe(
      "https://box.example.ts.net/hyperfide/threads/thr_1",
    );
  });

  it("tolerates a path with no leading slash", () => {
    expect(buildShellUrl(ROOT, "threads/thr_1")).toBe(
      "https://bee.hyperfide.example/threads/thr_1",
    );
  });
});

describe("isShellNavigation", () => {
  it("keeps the profile's own pages in the WebView", () => {
    expect(isShellNavigation("https://bee.hyperfide.example/threads/x", ROOT)).toBe(
      true,
    );
    expect(isShellNavigation("https://bee.hyperfide.example/", ROOT)).toBe(true);
  });

  it("sends another origin to the system browser", () => {
    expect(isShellNavigation("https://example.com/docs", ROOT)).toBe(false);
    expect(isShellNavigation("https://other.hyperfide.example/", ROOT)).toBe(false);
    expect(isShellNavigation("http://bee.hyperfide.example/", ROOT)).toBe(false);
  });

  it("does not let a sibling path escape a prefixed mount", () => {
    expect(isShellNavigation("https://box.example.ts.net/hyperfide/x", PREFIXED)).toBe(
      true,
    );
    expect(
      isShellNavigation("https://box.example.ts.net/hyperfideadmin", PREFIXED),
    ).toBe(false);
    expect(
      isShellNavigation("https://box.example.ts.net/other", PREFIXED),
    ).toBe(false);
  });

  it("refuses a URL that will not parse", () => {
    expect(isShellNavigation("not a url", ROOT)).toBe(false);
    expect(isShellNavigation("https://bee.hyperfide.example/", "not a url")).toBe(
      false,
    );
  });
});

describe("shellPathFromUrl", () => {
  it("returns the page path, minus any mount prefix", () => {
    expect(shellPathFromUrl("https://bee.hyperfide.example/threads/x?a=1", ROOT)).toBe(
      "/threads/x?a=1",
    );
    expect(shellPathFromUrl("https://bee.hyperfide.example/", ROOT)).toBe("/");
    expect(
      shellPathFromUrl("https://box.example.ts.net/hyperfide/threads/x", PREFIXED),
    ).toBe("/threads/x");
    expect(shellPathFromUrl("https://box.example.ts.net/hyperfide", PREFIXED)).toBe(
      "/",
    );
  });

  it("returns null for a URL outside the profile", () => {
    expect(shellPathFromUrl("https://example.com/x", ROOT)).toBeNull();
  });
});

describe("isExternallyOpenable", () => {
  it("allows only the schemes a system browser should receive", () => {
    expect(isExternallyOpenable("https://example.com")).toBe(true);
    expect(isExternallyOpenable("http://10.0.0.2:1234/x")).toBe(true);
    expect(isExternallyOpenable("mailto:a@b.com")).toBe(true);
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "about:blank",
      "tel:+1234",
      "",
    ]) {
      expect(isExternallyOpenable(url), url).toBe(false);
    }
  });
});
