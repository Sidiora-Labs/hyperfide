import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const e2eRoot = fileURLToPath(new URL("../../../e2e", import.meta.url));

function yamlFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return yamlFiles(path);
    return entry.name.endsWith(".yaml") ? [path] : [];
  });
}

function flowSource(path: string): string {
  return readFileSync(join(e2eRoot, path), "utf8");
}

describe("Mobile E2E flow boundaries", () => {
  it("routes every hyperfide scheme link through the native-confirmation helper", () => {
    for (const path of yamlFiles(e2eRoot)) {
      expect(readFileSync(path, "utf8"), path).not.toMatch(
        /^\s*- openLink: "hyperfide:\/\//mu,
      );
    }
  });

  it("uses one direct-server pairing boundary in every shell flow", () => {
    for (const flow of [
      "flows/shell-launch.yaml",
      "flows/shell-deep-link.yaml",
      "flows/shell-send.yaml",
      "flows/shell-send-sidebar-swipe.yaml",
    ]) {
      expect(flowSource(flow), flow).toContain(
        "- runFlow: ../subflows/pair-direct-server.yaml",
      );
    }

    const pairing = flowSource("subflows/pair-direct-server.yaml");
    expect(pairing).toContain('visible: ".*(Not now|Ask anything).*"');
    expect(pairing).toContain('- tapOn: "Not now"');
    expect(pairing).toContain('- assertNotVisible: "Not now"');
    expect(pairing).toContain('id: "shell-webview"');
  });

  it("covers native reconnect, profile switching, and deep-link entry points", () => {
    const connect = flowSource("android/connect.yaml");
    expect(connect).toContain("- stopApp");
    expect(connect).toContain("- launchApp");
    expect(connect).toContain('STUB_ACTION: "expire-session"');
    expect(connect).toContain("android-connect-session-recovered");

    const deepLink = flowSource("flows/shell-deep-link.yaml");
    expect(deepLink).toContain('LINK: "hyperfide://threads"');
    expect(deepLink).toContain('LINK: "hyperfide://settings/notifications"');
    expect(deepLink).toContain('id: "connect-screen"');

    const profileStore = readFileSync(
      join(e2eRoot, "../src/lib/profiles/profile-store.test.ts"),
      "utf8",
    );
    expect(profileStore).toContain("setActiveProfile(b.id)");
    expect(profileStore).toContain("activeProfileId).toBe(b.id)");
  });

  it("keeps manager controls read-only in the Fleet WebView journey", () => {
    const fleetView = readFileSync(
      join(
        e2eRoot,
        "../../../plugins/hyperfide-dispatch/src/fleet-view/view.test.tsx",
      ),
      "utf8",
    );
    expect(fleetView).toContain("Manager-directed dispatch is read-only");
    expect(fleetView).toContain(
      'queryByRole("button", { name: "Pause dispatch" })',
    );
    expect(fleetView).toContain(
      'queryByRole("button", { name: "Cancel job-1" })',
    );
  });

  it("runs the Fleet manager journey through both native flow runners", () => {
    const fleetFlow = flowSource("flows/fleet-manager.yaml");
    expect(fleetFlow).toContain(
      'LINK: "hyperfide://plugins/hyperfide-dispatch/fleet"',
    );
    expect(fleetFlow).toContain("Manager-directed dispatch is read-only");
    expect(flowSource("scripts/ci-run-flows.sh")).toContain("fleet-manager");
    expect(flowSource("scripts/ci-android-smoke.sh")).toContain(
      "flows/fleet-manager.yaml",
    );
  });
});
