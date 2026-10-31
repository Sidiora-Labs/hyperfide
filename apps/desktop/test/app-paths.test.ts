import { normalize } from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveDesktopBridgePath,
  resolveDesktopIconPath,
  resolveDesktopMachineInstallerPath,
  type DesktopPathContext,
} from "../src/app-paths.js";

describe("desktop app paths", () => {
  it("resolves the packaged hyperfide-app bridge beside the active asar", () => {
    const paths: DesktopPathContext = {
      appPath: "/Applications/Hyperfide.app/Contents/Resources/app.asar",
      isPackaged: true,
      resourcesPath: "/Applications/Hyperfide.app/Contents/Resources",
    };

    expect(resolveDesktopBridgePath({ paths })).toBe(
      normalize(
        "/Applications/Hyperfide.app/Contents/Resources/app.asar.unpacked/dist/hyperfide-app-bridge.mjs",
      ),
    );
  });

  it("resolves the universal packaged hyperfide-app bridge beside the selected arch asar", () => {
    const paths: DesktopPathContext = {
      appPath: "/Applications/Hyperfide.app/Contents/Resources/app-arm64.asar",
      isPackaged: true,
      resourcesPath: "/Applications/Hyperfide.app/Contents/Resources",
    };

    expect(resolveDesktopBridgePath({ paths })).toBe(
      normalize(
        "/Applications/Hyperfide.app/Contents/Resources/app-arm64.asar.unpacked/dist/hyperfide-app-bridge.mjs",
      ),
    );
  });

  it("resolves the machine installer inside the hyperfide-app package beside the bridge", () => {
    expect(
      resolveDesktopMachineInstallerPath(
        "/Applications/Hyperfide.app/Contents/Resources/app.asar.unpacked/dist/hyperfide-app-bridge.mjs",
      ),
    ).toBe(
      normalize(
        "/Applications/Hyperfide.app/Contents/Resources/app.asar.unpacked/node_modules/hyperfide-app/server/dist/assets/install-machine.sh",
      ),
    );
  });

  it("uses the release-specific icon inside packaged apps", () => {
    const paths: DesktopPathContext = {
      appPath: "/Applications/hyperfide Nightly.app/Contents/Resources/app.asar",
      isPackaged: true,
      resourcesPath: "/Applications/hyperfide Nightly.app/Contents/Resources",
    };

    expect(
      resolveDesktopIconPath({
        devIcon: false,
        packagedIconFileName: "icon-nightly.png",
        paths,
      }),
    ).toBe(
      normalize(
        "/Applications/hyperfide Nightly.app/Contents/Resources/app.asar/assets/icon-nightly.png",
      ),
    );
  });

  it("keeps the development icon independent of the release channel", () => {
    const paths: DesktopPathContext = {
      appPath: "/checkout/apps/desktop",
      isPackaged: false,
      resourcesPath: "/checkout/apps/desktop",
    };

    expect(
      resolveDesktopIconPath({
        devIcon: true,
        packagedIconFileName: "icon-nightly.png",
        paths,
      }),
    ).toBe(normalize("/checkout/apps/desktop/assets/icon-dev.png"));
  });
});
