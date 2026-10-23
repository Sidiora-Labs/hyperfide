import {
  cp,
  readFile,
  writeFile,
  mkdtemp,
  rm,
  symlink,
  realpath,
} from "node:fs/promises";
import { resolve, dirname, basename } from "node:path";
import { pluginPackageJsonSchema } from "@hyperfide/domain";
import {
  buildPluginServer,
  buildPluginHost,
  buildPluginApp,
  copyPluginRuntime,
  resolvePluginBuildToolchain,
} from "@hyperfide/plugin-build";
// Derive the transitional key from the builder's schema, never from a legacy identifier.
export const manifestKey = Object.entries(pluginPackageJsonSchema.shape).find(
  ([key, schema]) =>
    !["name", "version", "engines"].includes(key) && schema.type === "object",
)?.[0];
if (!manifestKey)
  throw new Error("Plugin builder manifest schema is unavailable");
export async function bundle() {
  const root = import.meta.dirname;
  const stage = await mkdtemp(
    resolve(dirname(root), ".bundled-stage-hyperfide-graph-"),
  );
  try {
    await cp(root, stage, {
      recursive: true,
      filter: (file) =>
        !["node_modules", "dist", ".bundled-runtime", ".turbo"].includes(
          basename(file),
        ),
    });
    await symlink(
      await realpath(resolve(root, "node_modules")),
      resolve(stage, "node_modules"),
      "junction",
    );
    const pkg = JSON.parse(
      await readFile(resolve(stage, "package.json"), "utf8"),
    );
    const manifest = { ...pkg, [manifestKey!]: pkg.hyperfide };
    const manifestFile = resolve(stage, "package.json");
    await writeFile(manifestFile, JSON.stringify(manifest, null, 2));
    const toolchain = await resolvePluginBuildToolchain(
      resolve(root, "node_modules/.cache"),
    );
    await buildPluginServer(stage, "0.0.0", toolchain);
    // The transitional host builder treats all scoped owners as workspace internals.
    // Preserve the derived plugin id while building; restore the scoped runtime manifest.
    await writeFile(
      manifestFile,
      JSON.stringify({ ...manifest, name: pkg.name.split("/").at(-1) }),
    );
    try {
      await buildPluginHost(stage, "0.0.0", toolchain);
    } finally {
      await writeFile(manifestFile, JSON.stringify(manifest, null, 2));
    }
    await buildPluginApp(stage, "0.0.0", toolchain);
    await copyPluginRuntime({
      sourceRoot: stage,
      targetDir: resolve(root, ".bundled-runtime"),
    });
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
if (process.argv[1] === import.meta.filename) await bundle();
