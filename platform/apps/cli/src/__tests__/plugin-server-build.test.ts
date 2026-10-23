import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PLUGIN_SDK_MAJOR, PLUGIN_SDK_VERSION } from "@hyperfide/domain";
import {
  buildPluginServer,
  resolvePluginBuildToolchain,
} from "@hyperfide/plugin-build";
function testToolchain() {
  return resolvePluginBuildToolchain(join(tmpdir(), "hyperfide-toolchain-unused"));
}

const TEST_HYPERFIDE_VERSION = "0.9.0-test";

const FIXTURE_PACKAGE_JSON = JSON.stringify(
  {
    name: "hyperfide-plugin-server-fixture",
    version: "0.1.0",
    type: "module",
    hyperfide: {
      name: "Server fixture",
      description: "Plugin server build fixture.",
      branding: { icon: "Zap" },
      server: "./server.ts",
    },
  },
  null,
  2,
);

const FIXTURE_LIB_TS = `export const greeting = "PREBUILT_LIB_MARKER";\n`;
const FIXTURE_SERVER_TS = `
import type { HyperfidePluginApi } from "@hyperfide/plugin-sdk";
import { greeting } from "./lib.ts";

export default function plugin(hyperfide: HyperfidePluginApi): void {
  hyperfide.log.info(greeting);
}
`;

describe("buildPluginServer", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "hyperfide-plugin-server-build-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeFixture(): Promise<void> {
    await writeFile(join(root, "package.json"), FIXTURE_PACKAGE_JSON);
    await writeFile(join(root, "lib.ts"), FIXTURE_LIB_TS);
    await writeFile(join(root, "server.ts"), FIXTURE_SERVER_TS);
  }

  it("bundles the server entry into a self-contained ESM dist/server.js with a meta sidecar", async () => {
    await writeFixture();
    const result = await buildPluginServer(
      root,
      TEST_HYPERFIDE_VERSION,
      await testToolchain(),
    );

    expect(result.jsPath).toBe(join(root, "dist", "server.js"));
    const js = await readFile(result.jsPath, "utf8");
    expect(js).toMatch(/export\s*\{|export default/);
    expect(js).toContain("PREBUILT_LIB_MARKER");
    expect(js).not.toContain("@hyperfide/plugin-sdk");
    expect(js).toContain("createRequire");

    const map = await readFile(result.mapPath, "utf8");
    expect(JSON.parse(map)).toMatchObject({ version: 3 });

    const meta = JSON.parse(await readFile(result.metaPath, "utf8"));
    expect(meta).toEqual({
      sdkMajor: PLUGIN_SDK_MAJOR,
      sdkVersion: PLUGIN_SDK_VERSION,
      artifactFormatVersion: 1,
      pluginId: "server-fixture",
      pluginVersion: "0.1.0",
      builtWith: {
        hyperfideVersion: TEST_HYPERFIDE_VERSION,
        pluginSdkVersion: PLUGIN_SDK_VERSION,
      },
    });
  });

  it("keeps a runtime @hyperfide/plugin-sdk import external (bare specifier survives)", async () => {
    await writeFixture();
    await writeFile(
      join(root, "server.ts"),
      `
      import { greeting } from "./lib.ts";
      import * as sdk from "@hyperfide/plugin-sdk";

      export default function plugin(hyperfide: { log: { info(msg: string): void } }): void {
        hyperfide.log.info(greeting + Object.keys(sdk).length);
      }
      `,
    );
    const result = await buildPluginServer(
      root,
      TEST_HYPERFIDE_VERSION,
      await testToolchain(),
    );
    const js = await readFile(result.jsPath, "utf8");
    expect(js).toMatch(/from\s*"@hyperfide\/plugin-sdk"/);
  });

  it("errors clearly when package.json has no hyperfide.server entry", async () => {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "hyperfide-plugin-headless", version: "0.1.0" }),
    );
    await expect(
      buildPluginServer(root, TEST_HYPERFIDE_VERSION, await testToolchain()),
    ).rejects.toThrowError(/no server entry/);
  });

  it("rejects a legacy manifest without required identity and branding", async () => {
    await writeFixture();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "hyperfide-plugin-legacy",
        version: "0.1.0",
        hyperfide: { server: "./server.ts" },
      }),
    );
    await expect(
      buildPluginServer(root, TEST_HYPERFIDE_VERSION, await testToolchain()),
    ).rejects.toThrowError(/hyperfide\.name/);
  });

  it("preserves the previous dist/server.js when a rebuild fails", async () => {
    await writeFixture();
    const first = await buildPluginServer(
      root,
      TEST_HYPERFIDE_VERSION,
      await testToolchain(),
    );
    const before = await readFile(first.jsPath, "utf8");
    const metaBefore = await readFile(first.metaPath, "utf8");

    await writeFile(join(root, "server.ts"), "export default function ( {\n");
    await expect(
      buildPluginServer(root, TEST_HYPERFIDE_VERSION, await testToolchain()),
    ).rejects.toThrowError();

    expect(await readFile(first.jsPath, "utf8")).toBe(before);
    expect(await readFile(first.metaPath, "utf8")).toBe(metaBefore);
  });
});
