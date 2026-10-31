import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildNodeEsmEntry } from "../../../tools/workspace/build-utils.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(packageRoot, "..", "..");
const outputDir = resolve(packageRoot, "dist", "test-bridges");

await mkdir(outputDir, { recursive: true });
await Promise.all([
  buildNodeEsmEntry({
    cleanDist: false,
    entryPoint: resolve(
      workspaceRoot,
      "core/provider-bridge-protocol/src/bridge-worker-entry.ts",
    ),
    outfile: resolve(outputDir, "hyperfide-provider-bridge-worker.mjs"),
    packageRoot,
    sourcemap: false,
  }),
  buildNodeEsmEntry({
    cleanDist: false,
    entryPoint: resolve(
      workspaceRoot,
      "tests/scripted-echo-provider/src/provider-bridge.ts",
    ),
    outfile: resolve(outputDir, "scripted-echo-provider.mjs"),
    packageRoot,
    sourcemap: false,
  }),
]);
