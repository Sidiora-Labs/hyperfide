import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HYPERFIDE_APP_VERSION_FALLBACK = "0.0.0-dev";
const PARENT_LOOKUP_MAX_DEPTH = 8;

interface ResolveHyperfideAppVersionArgs {
  env: NodeJS.ProcessEnv;
  fromDir: string;
}

interface HyperfideAppPackageJson {
  name: string;
  version: string;
}

function isHyperfideAppPackageJson(value: unknown): value is HyperfideAppPackageJson {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string" &&
    "version" in value &&
    typeof value.version === "string" &&
    value.version.length > 0
  );
}

function readHyperfideAppVersionAt(packageJsonPath: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    if (!isHyperfideAppPackageJson(parsed) || parsed.name !== "hyperfide-app") {
      return null;
    }
    return parsed.version;
  } catch {
    return null;
  }
}

function trimEnvValue(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function resolveHyperfideAppVersion(args: ResolveHyperfideAppVersionArgs): string {
  const envValue = trimEnvValue(args.env.HYPERFIDE_APP_VERSION);
  if (envValue !== undefined) {
    return envValue;
  }

  let currentDir = resolve(args.fromDir);
  for (let depth = 0; depth < PARENT_LOOKUP_MAX_DEPTH; depth += 1) {
    const candidatePath = join(currentDir, "package.json");
    const candidateVersion = readHyperfideAppVersionAt(candidatePath);
    if (candidateVersion !== null) {
      return candidateVersion;
    }
    // Locate the launcher by manifest identity while package paths are migrated.
    try {
      const packages = join(currentDir, "packages");
      for (const entry of readdirSync(packages)) {
        const version = readHyperfideAppVersionAt(join(packages, entry, "package.json"));
        if (version !== null) return version;
      }
    } catch { /* This ancestor need not be a workspace. */ }
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  return HYPERFIDE_APP_VERSION_FALLBACK;
}

export function resolveHyperfideCliVersion(): string {
  return resolveHyperfideAppVersion({
    env: process.env,
    fromDir: dirname(fileURLToPath(import.meta.url)),
  });
}
