import { describe, expect, it } from "vitest";
import { resolveShellIncomingLink } from "./shell-links";

const profiles = [
  { id: "p_bee", serverUrl: "https://bee.hyperfide.example" },
  { id: "p_lan", serverUrl: "http://10.0.0.7:38886" },
  { id: "p_prefix", serverUrl: "https://box.example.ts.net/hyperfide" },
];

const context = {
  profiles,
  activeProfileId: "p_bee",
  developerRoutesEnabled: false,
};

describe("resolveShellIncomingLink", () => {
  it.each([
    ["hyperfide://", "/webview"],
    ["hyperfide://threads/thr_1", "/webview?path=%2Fthreads%2Fthr_1"],
    ["hyperfide://connect?code=ABCD-EFGH", "/connect?code=ABCD-EFGH"],
    ["hyperfide://settings/servers/add", "/settings/servers/add"],
    ["hyperfide://settings/device", "/settings/device"],
    ["hyperfide://settings/notifications", "/settings/notifications"],
    ["hyperfide://settings", "/webview?path=%2Fsettings"],
    ["hyperfide://settings/general", "/webview?path=%2Fsettings%2Fgeneral"],
    ["hyperfide://connections", "/webview?path=%2Fconnections"],
  ])("routes the scheme link %s to %s", (url, path) => {
    expect(resolveShellIncomingLink(url, context)).toEqual({
      kind: "navigate",
      path,
      profileId: null,
    });
  });

  it("hides developer routes in a release bundle", () => {
    expect(resolveShellIncomingLink("hyperfide://dev/webview-spike", context)).toEqual(
      { kind: "navigate", path: "/", profileId: null },
    );
    expect(
      resolveShellIncomingLink("hyperfide://dev/webview-spike", {
        ...context,
        developerRoutesEnabled: true,
      }),
    ).toEqual({
      kind: "navigate",
      path: "/dev/webview-spike",
      profileId: null,
    });
  });

  it("opens a web link on the profile that owns it", () => {
    expect(
      resolveShellIncomingLink("https://bee.hyperfide.example/threads/x?a=1", context),
    ).toEqual({
      kind: "navigate",
      path: "/webview?path=%2Fthreads%2Fx%3Fa%3D1",
      profileId: null,
    });
  });

  it("names the profile when a link switches servers", () => {
    const resolution = resolveShellIncomingLink(
      "http://10.0.0.7:38886/threads/x",
      context,
    );
    expect(resolution).toEqual({
      kind: "navigate",
      path: "/webview?profileId=p_lan&path=%2Fthreads%2Fx",
      profileId: "p_lan",
    });
  });

  it("names only the profile when a link switches servers at the root", () => {
    expect(resolveShellIncomingLink("http://10.0.0.7:38886/", context)).toEqual(
      {
        kind: "navigate",
        path: "/webview?profileId=p_lan",
        profileId: "p_lan",
      },
    );
  });

  it("strips a profile's mount prefix from the page path", () => {
    const resolution = resolveShellIncomingLink(
      "https://box.example.ts.net/hyperfide/threads/x",
      context,
    );
    expect(resolution).toEqual({
      kind: "navigate",
      path: "/webview?profileId=p_prefix&path=%2Fthreads%2Fx",
      profileId: "p_prefix",
    });
  });

  it("offers to add a server the phone does not know", () => {
    const resolution = resolveShellIncomingLink(
      "https://other.hyperfide.example/threads/x",
      context,
    );
    expect(resolution.kind).toBe("unknown-server");
    if (resolution.kind !== "unknown-server") throw new Error("unreachable");
    expect(resolution.serverUrl).toBe("https://other.hyperfide.example");
    expect(resolution.path).toBe("/webview?path=%2Fthreads%2Fx");
  });

  it("leaves a foreign scheme alone", () => {
    expect(
      resolveShellIncomingLink("exp+hyperfide-app://expo-development-client", context),
    ).toEqual({ kind: "passthrough" });
  });
});
