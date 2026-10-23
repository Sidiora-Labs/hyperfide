import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { BUILTIN_PLUGINS } from "../../apps/server/src/services/plugins/builtin-registry.js";
import { bundle, manifestKey } from "./bundle.js";
it("is bundled, enabled by default and adapts to the builder schema", async () => {
  const bundled = JSON.parse(
    await readFile(
      new URL("../../packages/bundled-plugins/package.json", import.meta.url),
      "utf8",
    ),
  );
  expect(bundled.dependencies["@hyperfide/hyperfide-graph"]).toBe(
    "workspace:*",
  );
  expect(
    BUILTIN_PLUGINS.find((p) => p.pluginId === "hyperfide-graph"),
  ).toMatchObject({ autoInstall: true, defaultEnabled: true });
  expect(manifestKey).toBeTruthy();
});

it("builds a loadable server, app and host runtime with the scoped package identity", async () => {
  await bundle();
  const base = new URL("./.bundled-runtime/", import.meta.url);
  const manifest = JSON.parse(
    await readFile(new URL("package.json", base), "utf8"),
  );
  expect(manifest.name).toBe("@hyperfide/hyperfide-graph");
  const entries = manifest[manifestKey!];
  for (const part of ["server", "host", "app"]) {
    expect(entries[part]).toBe(`./dist/${part}.js`);
    expect(
      (await readFile(new URL(entries[part], base), "utf8")).length,
    ).toBeGreaterThan(0);
  }
}, 60000);
