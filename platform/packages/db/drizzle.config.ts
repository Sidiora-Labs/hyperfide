import { defineConfig } from "drizzle-kit";
import {
  type BbRuntimeMode,
  resolveCurrentDevInstanceConfig,
  resolveDataDirDatabasePath,
  resolveRuntimeDataDir,
  resolveRuntimeMode,
} from "@bb/config/runtime";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(packageRoot, "..", "..");
const runtimeMode = resolveRuntimeMode();

export function resolveDrizzleDataDir(mode: BbRuntimeMode): string {
  if (mode === "dev") {
    return resolveCurrentDevInstanceConfig(repoRoot).dataDir;
  }

  return resolveRuntimeDataDir({
    env: process.env,
    homeDir: homedir(),
    mode,
  });
}

const dataDir = resolveDrizzleDataDir(runtimeMode);
const dbPath = resolve(resolveDataDirDatabasePath({ dataDir }));

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: dbPath,
  },
});
