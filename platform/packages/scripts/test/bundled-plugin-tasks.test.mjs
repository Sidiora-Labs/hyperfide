import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BUNDLED_PLUGINS } from "../../../apps/server/src/services/plugins/builtin-registry.ts";

const root = resolve(import.meta.dirname, "../../..");
const turboSource = readFileSync(resolve(root, "turbo.json"), "utf8");
const turbo = JSON.parse(turboSource.replace(/^\s*\/\/.*$/gm, ""));

describe("bundled plugin task graph", () => {
  it("prepares every registered plugin before assembly with separate output ownership", () => {
    const expected = BUNDLED_PLUGINS.map(({ name }) => {
      const manifest = JSON.parse(
        readFileSync(resolve(root, "plugins", name, "package.json"), "utf8"),
      );
      // Plugins that bundle themselves with esbuild, and plugins that run the plugin-build CLI from its
      // workspace build output instead of the linked bin (their turbo task waits for that build).
      const esbuildBuilders = ["hyperfide-qualify", "environment-slices"];
      const cliBuilders = ["hyperfide-asks", "hyperfide-spec", "machine-railway"];
      const customBuilders = {
        "hyperfide-qualify": "node prepare.mjs",
        "environment-slices": "node prepare.mjs",
        "hyperfide-graph": "node --conditions=source --import tsx build-runtime.ts",
        "hyperfide-asks": "node ../../packages/plugin-build/dist/cli.js prepare-bundled",
        "hyperfide-spec": "node ../../packages/plugin-build/dist/cli.js prepare-bundled",
        "machine-railway": "node ../../packages/plugin-build/dist/cli.js prepare-bundled",
      };
      expect(manifest.scripts["prepare:bundled"]).toBe(
        customBuilders[name] ?? "hyperfide-plugin-build prepare-bundled",
      );
      if (esbuildBuilders.includes(name)) {
        expect(manifest.devDependencies.esbuild).toBeTruthy();
      } else if (cliBuilders.includes(name)) {
        expect(turbo.tasks[`${manifest.name}#prepare:bundled`].dependsOn).toContain(
          "@hyperfide/plugin-build#build",
        );
      } else {
        expect(manifest.devDependencies["@hyperfide/plugin-build"]).toBe("workspace:*");
      }
      return manifest.name;
    });
    const bundle = JSON.parse(
      readFileSync(
        resolve(root, "packages/bundled-plugins/package.json"),
        "utf8",
      ),
    );
    expect(Object.keys(bundle.dependencies).sort()).toEqual(expected.sort());
    const assembly = turbo.tasks["@hyperfide/bundled-plugins#build"];
    expect(assembly.dependsOn).toEqual([
      "^prepare:bundled",
    ]);
    expect(assembly.outputs).toEqual(["dist/**"]);
    const plugin = turbo.tasks["prepare:bundled"];
    expect(plugin.outputs).toEqual([".bundled-runtime/**"]);
    expect(plugin.dependsOn).toEqual(["topo", "^build"]);
    expect(plugin.inputs).toContain("!.bundled-runtime/**");
    expect(plugin.inputs).toContain("!dist/**");
    expect(
      plugin.inputs.some((input) => input.includes("$TURBO_ROOT$/plugins/")),
    ).toBe(false);
  });
});
