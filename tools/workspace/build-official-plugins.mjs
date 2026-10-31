import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildPluginApp,
  buildPluginHost,
  buildPluginServer,
  resolvePluginBuildToolchain,
} from "../plugin-build/src/index.ts";
import { OFFICIAL_PLUGINS } from "../../core/server/src/services/plugins/builtin-registry.ts";

const repositoryRoot = resolve(import.meta.dirname, "../..");
// Derived from the registry, so a new store-only plugin needs no edit here.
const officialNames = OFFICIAL_PLUGINS.map((plugin) => plugin.name);

const requested = process.argv.slice(2);
const selected =
  requested.length === 0 || requested.includes("all")
    ? officialNames
    : requested;

// Resolves from this repo's own devDependencies; no download here.
const toolchain = await resolvePluginBuildToolchain(
  resolve(repositoryRoot, "node_modules/.hyperfide-toolchain"),
);

for (const plugin of selected) {
  if (!officialNames.includes(plugin)) {
    throw new Error(
      `unknown official plugin ${JSON.stringify(plugin)}; expected ${officialNames.join(", ")}, or all`,
    );
  }
}

const hyperfidePackage = JSON.parse(
  await readFile(
    resolve(repositoryRoot, "apps/launcher/package.json"),
    "utf8",
  ),
);
if (typeof hyperfidePackage.version !== "string") {
  throw new Error("apps/launcher/package.json is missing a version");
}

for (const plugin of selected) {
  const rootDirectory = resolve(repositoryRoot, "plugins", plugin);
  await rm(resolve(rootDirectory, "dist"), { recursive: true, force: true });
  const manifest = JSON.parse(
    await readFile(resolve(rootDirectory, "package.json"), "utf8"),
  );

  const server = await buildPluginServer(
    rootDirectory,
    hyperfidePackage.version,
    toolchain,
  );
  const app = manifest.hyperfide?.app
    ? await buildPluginApp(rootDirectory, hyperfidePackage.version, toolchain)
    : null;
  const host = manifest.hyperfide?.host
    ? await buildPluginHost(rootDirectory, hyperfidePackage.version, toolchain)
    : null;
  const outputs = [server.jsPath, server.metaPath];
  if (app !== null) {
    outputs.push(app.jsPath, app.cssPath, app.metaPath);
  }
  if (host !== null) outputs.push(host.jsPath, host.mapPath, host.metaPath);
  console.log(`${plugin}: built ${outputs.join(", ")}`);
}
