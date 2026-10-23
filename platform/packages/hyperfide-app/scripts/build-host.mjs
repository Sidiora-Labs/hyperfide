import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildNodeEsmEntry,
  copyDirectory,
  pruneUnreferencedChunks,
} from "../../../scripts/build-utils.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptsDir, "..");
const workspaceRoot = resolve(packageRoot, "..", "..");
const hostPackageRoot = resolve(packageRoot, "host-package");
const hostDaemonSource = resolve(workspaceRoot, "apps", "host-daemon", "dist");
const hostDaemonTarget = resolve(hostPackageRoot, "host-daemon", "dist");
const dependencyNames = [
  "@parcel/watcher",
  "fs-native-extensions",
  "node-pty",
  "pino",
  "pino-pretty",
  "pino-roll",
];
const hostDaemonFiles = [
  "hyperfide-parcel-watcher-child.mjs",
  "hyperfide-plugin-host-worker.mjs",
  "hyperfide-provider-bridge-worker.mjs",
  "daemon-bundle.mjs",
];

const sourcePackageJson = JSON.parse(
  await readFile(resolve(packageRoot, "package.json"), "utf8"),
);
const dependencies = Object.fromEntries(
  dependencyNames.map((name) => {
    const version = sourcePackageJson.dependencies?.[name];
    if (typeof version !== "string") {
      throw new Error(`Missing hyperfide-platform host dependency ${name}`);
    }
    return [name, version];
  }),
);

await rm(hostPackageRoot, { force: true, recursive: true });
await buildNodeEsmEntry({
  cleanDist: true,
  entryPoint: resolve(packageRoot, "src", "bin", "hyperfide-app.ts"),
  executable: true,
  outfile: resolve(hostPackageRoot, "dist", "hyperfide-app.js"),
  packageRoot: hostPackageRoot,
  sourcemap: false,
});
await buildNodeEsmEntry({
  cleanDist: false,
  entryPoint: resolve(packageRoot, "src", "bin", "hyperfide.ts"),
  executable: true,
  outfile: resolve(hostPackageRoot, "dist", "hyperfide.js"),
  packageRoot: hostPackageRoot,
  sourcemap: false,
});
await buildNodeEsmEntry({
  cleanDist: false,
  entryPoint: resolve(packageRoot, "src", "bin", "hyperfide-host-daemon.ts"),
  executable: true,
  outfile: resolve(hostPackageRoot, "dist", "hyperfide-host-daemon.js"),
  packageRoot: hostPackageRoot,
  sourcemap: false,
});

await mkdir(hostDaemonTarget, { recursive: true });
await copyFile(
  resolve(hostDaemonSource, "hyperfide"),
  resolve(hostDaemonTarget, "hyperfide"),
);
await chmod(resolve(hostDaemonTarget, "hyperfide"), 0o755);
await copyFile(
  resolve(hostDaemonSource, "hyperfide.cmd"),
  resolve(hostDaemonTarget, "hyperfide.cmd"),
);
await copyDirectory({
  from: resolve(hostDaemonSource, "hyperfide-chunks"),
  to: resolve(hostDaemonTarget, "hyperfide-chunks"),
});
await pruneUnreferencedChunks({
  chunkDir: resolve(hostDaemonTarget, "hyperfide-chunks"),
  entry: resolve(hostDaemonTarget, "hyperfide"),
});
for (const fileName of hostDaemonFiles) {
  await copyFile(
    resolve(hostDaemonSource, fileName),
    resolve(hostDaemonTarget, fileName),
  );
}

await copyFile(
  resolve(packageRoot, "README.md"),
  resolve(hostPackageRoot, "README.md"),
);
await writeFile(
  resolve(hostPackageRoot, "package.json"),
  `${JSON.stringify(
    {
      name: sourcePackageJson.name,
      version: sourcePackageJson.version,
      description: "hyperfide enrolled host runtime",
      type: "module",
      os: [...new Set([...sourcePackageJson.os, "win32"])],
      bin: {
        hyperfide: "dist/hyperfide.js",
        "hyperfide-app": "dist/hyperfide-app.js",
        "hyperfide-host-daemon": "dist/hyperfide-host-daemon.js",
      },
      files: ["dist", "host-daemon", "README.md"],
      engines: sourcePackageJson.engines,
      dependencies,
    },
    null,
    2,
  )}\n`,
);

process.stdout.write("hyperfide-app: built enrolled host package\n");
