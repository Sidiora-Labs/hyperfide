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
import {
  buildPluginServer,
  buildPluginHost,
  buildPluginApp,
  copyPluginRuntime,
  resolvePluginBuildToolchain,
} from "@hyperfide/plugin-build";
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
    const manifest = pkg;
    const manifestFile = resolve(stage, "package.json");
    await writeFile(manifestFile, JSON.stringify(manifest, null, 2));
    const toolchain = await resolvePluginBuildToolchain(
      resolve(root, "node_modules/.cache"),
    );
    // Package the daemon implementation; erase its private, type-only contract import.
    const esbuild = await import(toolchain.esbuild);
    const statusSource = await readFile(
      resolve(root, "../../core/host-daemon/src/hyperfide-status.ts"), "utf8",
    );
    const statusModule = await esbuild.transform(statusSource, { loader: "ts", format: "esm" });
    await writeFile(resolve(stage, "hyperfide-status.js"), statusModule.code);
    const hostFile = resolve(stage, "host.ts");
    await writeFile(hostFile, (await readFile(hostFile, "utf8")).replace(
      "../../core/host-daemon/src/hyperfide-status.js", "./hyperfide-status.js",
    ));
    await buildPluginServer(stage, "0.0.0", toolchain);
    // The host builder treats all scoped owners as workspace internals.
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
