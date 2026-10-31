import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  buildNodeEsmEntry,
  copyDirectory,
} from "../../../tools/workspace/build-utils.mjs";

const execFileAsync = promisify(execFile);
const scriptsDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptsDir, "..");
const workspaceRoot = resolve(packageRoot, "..", "..");

async function assertPathExists(pathToCheck, label) {
  try {
    await access(pathToCheck);
  } catch {
    throw new Error(
      `Missing ${label} at ${pathToCheck}. Build @hyperfide/app, @hyperfide/server, and @hyperfide/host-daemon before packaging hyperfide-app.`,
    );
  }
}

async function copyBuildOutput({ from, label, to }) {
  await assertPathExists(from, label);
  await copyDirectory({ from, to });
}

async function buildPublicSdkDeclarations() {
  await execFileAsync(
    "node",
    [resolve(scriptsDir, "build-public-sdk-dts.mjs")],
    { cwd: packageRoot },
  );
}

const entrypoints = [
  ["hyperfide-app", "hyperfide-app.js"],
  ["hyperfide", "hyperfide.js"],
  ["hyperfide-server", "hyperfide-server.js"],
  ["hyperfide-host-daemon", "hyperfide-host-daemon.js"],
];

for (const [sourceName, outputName] of entrypoints) {
  await buildNodeEsmEntry({
    cleanDist: sourceName === "hyperfide-app",
    entryPoint: resolve(packageRoot, "src", "bin", `${sourceName}.ts`),
    executable: true,
    outfile: resolve(packageRoot, "dist", outputName),
    packageRoot,
  });
}

await buildNodeEsmEntry({
  cleanDist: false,
  entryPoint: resolve(packageRoot, "src", "public-sdk.ts"),
  outfile: resolve(packageRoot, "dist", "index.js"),
  packageRoot,
});
await buildPublicSdkDeclarations();
await buildNodeEsmEntry({
  cleanDist: false,
  entryPoint: resolve(scriptsDir, "prune-hyperfide-chunks.mjs"),
  outfile: resolve(packageRoot, "dist", "prune-hyperfide-chunks.mjs"),
  packageRoot,
});

await copyBuildOutput({
  from: resolve(workspaceRoot, "apps", "web", "dist"),
  label: "@hyperfide/app dist",
  to: resolve(packageRoot, "app", "dist"),
});
await copyBuildOutput({
  from: resolve(workspaceRoot, "core", "server", "dist"),
  label: "@hyperfide/server dist",
  to: resolve(packageRoot, "server", "dist"),
});
await copyBuildOutput({
  from: resolve(workspaceRoot, "tools", "bundled-plugins", "dist"),
  label: "@hyperfide/bundled-plugins dist",
  to: resolve(packageRoot, "server", "dist", "builtin-plugins"),
});
await copyBuildOutput({
  from: resolve(workspaceRoot, "core", "host-daemon", "dist"),
  label: "@hyperfide/host-daemon dist",
  to: resolve(packageRoot, "host-daemon", "dist"),
});
// The hyperfide CLI is code-split into host-daemon/dist/hyperfide-chunks. A turbo cache hit
// restores core/host-daemon/dist without clearing it first, so the copy can
// carry an earlier build's hashed chunks; ship only the ones `hyperfide` reaches.
await assertPathExists(
  resolve(packageRoot, "host-daemon", "dist", "hyperfide-chunks"),
  "bundled hyperfide CLI chunks",
);
const pruneRun = await execFileAsync(
  "node",
  [resolve(packageRoot, "dist", "prune-hyperfide-chunks.mjs")],
  { cwd: packageRoot },
);
process.stderr.write(pruneRun.stderr);

process.stdout.write("hyperfide-app: built package assets\n");
