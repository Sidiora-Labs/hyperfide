import { defineConfig } from "drizzle-kit";
import {
  type BbRuntimeMode,
  resolveCurrentDevInstanceConfig,
  resolveDataDirDatabasePath,
  resolveRuntimeDataDir,
  resolveRuntimeMode,
} from "@hyperfide/config/runtime";
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
const dbPath =
  process.env.HYPERFIDE_DATABASE_URL?.replace(/^sqlite:(?:\/\/)?/, "") ??
  resolve(resolveDataDirDatabasePath({ dataDir }));

export default defineConfig(
  process.env.HYPERFIDE_DATABASE_URL?.match(/^postgres(?:ql)?:/)
    ? {
        schema: "./src/schema-postgres.ts",
        out: "./drizzle-postgres",
        dialect: "postgresql",
        schemaFilter: ["platform"],
        dbCredentials: { url: process.env.HYPERFIDE_DATABASE_URL },
      }
    : {
        schema: "./src/schema.ts",
        out: "./drizzle",
        dialect: "sqlite",
        dbCredentials: {
          url: dbPath,
        },
      },
);
