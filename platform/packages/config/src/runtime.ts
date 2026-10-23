import { createHash } from "node:crypto";
import { existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";

export type HyperfideRuntimeMode = "dev" | "prod";

interface DevPortSet {
  appPort: number;
  cloudPort: number;
  cloudWorkerPort: number;
  hostDaemonPort: number;
  serverPort: number;
}

export interface DevInstanceConfig {
  dataDir: string;
  homeDir: string;
  instanceId: string;
  ports: DevPortSet;
  repoRoot: string;
  serverUrl: string;
}

interface ResolveDevInstanceConfigArgs {
  homeDir: string;
  repoRoot: string;
}

interface DevProcessEnvArgs {
  baseEnv: NodeJS.ProcessEnv;
  config: DevInstanceConfig;
}

interface ResolveInheritedDevSkillsRootPathsArgs {
  homeDir: string;
  repoRoot: string;
}

interface ParseDataDirEnvValueArgs {
  homeDir: string;
  rawDataDir: string;
}

interface ResolveConfiguredDataDirArgs {
  defaultDataDir: string;
  env: NodeJS.ProcessEnv;
  homeDir: string;
}

interface ResolveProdDataDirArgs {
  homeDir: string;
}

interface ResolveRuntimeDataDirArgs {
  env: NodeJS.ProcessEnv;
  homeDir: string;
  mode: HyperfideRuntimeMode;
  repoRoot?: string;
}

interface ResolveDataDirDatabasePathArgs {
  dataDir: string;
}

interface ParsePortValueArgs {
  name: string;
  rawPort: string;
}

interface ValidatePortNumberArgs {
  name: string;
  value: number;
}

interface ResolvePortFromEnvArgs {
  defaultPort: number;
  env: NodeJS.ProcessEnv;
  name: string;
}

const HYPERFIDE_PROD_DATA_DIR_NAME = ".hyperfide";
const HYPERFIDE_DEV_DATA_ROOT_DIR = ".hyperfide-dev";
export const HYPERFIDE_PROD_SERVER_PORT = 38886;
export const HYPERFIDE_PROD_HOST_DAEMON_PORT = 38887;
export const HYPERFIDE_LOOPBACK_HOST = "127.0.0.1";
const HYPERFIDE_SQLITE_DATABASE_FILE_NAME = "hyperfide.db";

const DEV_HASH_LENGTH = 12;
const DEV_PORT_BUCKETS = 8_000;
const DEV_APP_PORT_BASE = 11_000;
const DEV_SERVER_PORT_BASE = 19_000;
const DEV_HOST_DAEMON_PORT_BASE = 27_000;
const DEV_CLOUD_PORT_BASE = 35_000;
const DEV_CLOUD_WORKER_PORT_BASE = 43_000;
const THREAD_CONTEXT_ENV_KEYS: readonly string[] = [
  "HYPERFIDE_ENVIRONMENT_ID",
  "HYPERFIDE_THREAD_ID",
  "HYPERFIDE_THREAD_STORAGE",
];

const MANAGED_WORKTREE_DIR_NAME = "worktrees";

function createRepoRootHash(repoRootPath: string): string {
  return createHash("sha256").update(repoRootPath).digest("hex");
}

function sanitizeInstanceLabel(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^[._-]+|[._-]+$/gu, "");
  return sanitized.length > 0 ? sanitized : "worktree";
}

function resolveRepoRootLabel(args: ResolveDevInstanceConfigArgs): string {
  const homeRelativePath = relative(args.homeDir, args.repoRoot);
  if (
    homeRelativePath.length > 0 &&
    !homeRelativePath.startsWith("../") &&
    !homeRelativePath.startsWith("..\\") &&
    homeRelativePath !== ".." &&
    !isAbsolute(homeRelativePath)
  ) {
    return homeRelativePath;
  }

  return args.repoRoot;
}

function resolveInstanceId(args: ResolveDevInstanceConfigArgs): string {
  const hash = createRepoRootHash(args.repoRoot);
  const label = resolveRepoRootLabel(args);
  return `${sanitizeInstanceLabel(label)}-${hash.slice(0, DEV_HASH_LENGTH)}`;
}

function resolvePortOffset(repoRootPath: string): number {
  const hash = createRepoRootHash(repoRootPath);
  return Number.parseInt(hash.slice(0, 8), 16) % DEV_PORT_BUCKETS;
}

function reservePackagedAppPorts(port: number): number {
  if (port === HYPERFIDE_PROD_SERVER_PORT) return 59_000;
  if (port === HYPERFIDE_PROD_HOST_DAEMON_PORT) return 59_001;
  return port;
}

function resolvePorts(repoRootPath: string): DevPortSet {
  const offset = resolvePortOffset(repoRootPath);
  return {
    appPort: DEV_APP_PORT_BASE + offset,
    cloudPort: reservePackagedAppPorts(DEV_CLOUD_PORT_BASE + offset),
    cloudWorkerPort: DEV_CLOUD_WORKER_PORT_BASE + offset,
    hostDaemonPort: DEV_HOST_DAEMON_PORT_BASE + offset,
    serverPort: DEV_SERVER_PORT_BASE + offset,
  };
}

function expandHomeDirectory(pathValue: string, homeDir: string): string {
  if (pathValue === "~") {
    return homeDir;
  }

  if (
    pathValue.startsWith("~/") ||
    (process.platform === "win32" && pathValue.startsWith("~\\"))
  ) {
    return resolve(homeDir, pathValue.slice(2));
  }

  return resolve(pathValue);
}

export function resolveRuntimeMode(
  nodeEnv: string | undefined = process.env.NODE_ENV,
): HyperfideRuntimeMode {
  return nodeEnv === "production" ? "prod" : "dev";
}

export function resolveProdDataDir(args: ResolveProdDataDirArgs): string {
  const dataDir = join(args.homeDir, HYPERFIDE_PROD_DATA_DIR_NAME);
  const legacyDir = join(args.homeDir, String.fromCharCode(46, 98, 98));
  if (!existsSync(dataDir) && existsSync(legacyDir)) {
    try {
      renameSync(legacyDir, dataDir);
      console.error(`Hyperfide migrated data from ${legacyDir} to ${dataDir}`);
    } catch (error) {
      if (existsSync(legacyDir) || !existsSync(dataDir)) throw error;
    }
  }
  return dataDir;
}

export function parseDataDirEnvValue(args: ParseDataDirEnvValueArgs): string {
  const trimmedDataDir = args.rawDataDir.trim();
  if (trimmedDataDir.length === 0) {
    throw new Error("HYPERFIDE_DATA_DIR must not be empty");
  }

  return expandHomeDirectory(trimmedDataDir, args.homeDir);
}

export function resolveConfiguredDataDir(
  args: ResolveConfiguredDataDirArgs,
): string {
  const rawDataDir = args.env.HYPERFIDE_DATA_DIR;
  if (rawDataDir === undefined) {
    return args.defaultDataDir;
  }

  return parseDataDirEnvValue({
    homeDir: args.homeDir,
    rawDataDir,
  });
}

export function resolveDevInstanceConfig(
  args: ResolveDevInstanceConfigArgs,
): DevInstanceConfig {
  const instanceId = resolveInstanceId(args);
  const dataDir = join(args.homeDir, HYPERFIDE_DEV_DATA_ROOT_DIR, instanceId);
  const ports = resolvePorts(args.repoRoot);
  const serverUrl = `http://${HYPERFIDE_LOOPBACK_HOST}:${ports.serverPort}`;
  return {
    dataDir,
    homeDir: args.homeDir,
    instanceId,
    ports,
    repoRoot: args.repoRoot,
    serverUrl,
  };
}

export function resolveCurrentDevInstanceConfig(
  repoRoot: string,
): DevInstanceConfig {
  return resolveDevInstanceConfig({
    homeDir: homedir(),
    repoRoot,
  });
}

export function resolveInheritedDevSkillsRootPaths(
  args: ResolveInheritedDevSkillsRootPathsArgs,
): string[] {
  const roots = [join(resolveProdDataDir({ homeDir: args.homeDir }), "skills")];
  const segments = resolve(args.repoRoot).split(/[\\/]+/u);
  const worktreesIndex = segments.lastIndexOf(MANAGED_WORKTREE_DIR_NAME);
  if (worktreesIndex <= 0) {
    return roots;
  }

  const parentDataDir = segments.slice(0, worktreesIndex).join("/");
  if (parentDataDir.length === 0) {
    return roots;
  }

  return Array.from(new Set([join(parentDataDir, "skills"), ...roots]));
}

export function resolveRuntimeDataDir(args: ResolveRuntimeDataDirArgs): string {
  if (args.env.HYPERFIDE_DATA_DIR !== undefined) {
    return parseDataDirEnvValue({
      homeDir: args.homeDir,
      rawDataDir: args.env.HYPERFIDE_DATA_DIR,
    });
  }

  if (args.mode === "prod") {
    return resolveProdDataDir({ homeDir: args.homeDir });
  }

  if (args.repoRoot === undefined) {
    throw new Error(
      "repoRoot is required to resolve development HYPERFIDE_DATA_DIR",
    );
  }

  return resolveDevInstanceConfig({
    homeDir: args.homeDir,
    repoRoot: args.repoRoot,
  }).dataDir;
}

export function resolveDataDirDatabasePath(
  args: ResolveDataDirDatabasePathArgs,
): string {
  return join(args.dataDir, HYPERFIDE_SQLITE_DATABASE_FILE_NAME);
}

export function parsePortValue(args: ParsePortValueArgs): number {
  const port = Number(args.rawPort);
  if (String(port) !== args.rawPort) {
    throw new Error(`${args.name} must be a valid TCP port`);
  }

  return validatePortNumber({
    name: args.name,
    value: port,
  });
}

export function validatePortNumber(args: ValidatePortNumberArgs): number {
  if (Number.isInteger(args.value) && args.value >= 1 && args.value <= 65_535) {
    return args.value;
  }

  throw new Error(`${args.name} must be a valid TCP port`);
}

export function resolvePortFromEnv(args: ResolvePortFromEnvArgs): number {
  const rawPort = args.env[args.name];
  if (rawPort === undefined) {
    return args.defaultPort;
  }

  return parsePortValue({
    name: args.name,
    rawPort,
  });
}

export function stripThreadContextEnv(
  baseEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  for (const key of THREAD_CONTEXT_ENV_KEYS) {
    delete env[key];
  }
  return env;
}

export function toDevProcessEnv(args: DevProcessEnvArgs): NodeJS.ProcessEnv {
  const env = stripThreadContextEnv(args.baseEnv);
  const inheritedSkillsRootPaths = resolveInheritedDevSkillsRootPaths({
    homeDir: args.config.homeDir,
    repoRoot: args.config.repoRoot,
  });
  return {
    ...env,
    HYPERFIDE_DATA_DIR: args.config.dataDir,
    HYPERFIDE_DEV_APP_PORT: String(args.config.ports.appPort),
    HYPERFIDE_DEV_CONNECT_BASE_URL: `http://hyperfide.localhost:${args.config.ports.cloudPort}`,
    HYPERFIDE_HOST_DAEMON_PORT: String(args.config.ports.hostDaemonPort),
    HYPERFIDE_INHERITED_SKILLS_ROOTS: inheritedSkillsRootPaths.join(delimiter),
    HYPERFIDE_SERVER_PORT: String(args.config.ports.serverPort),
    HYPERFIDE_SERVER_URL: args.config.serverUrl,
    NODE_ENV: "development",
  };
}

export function resolveCurrentDevProcessEnv(
  repoRoot: string,
  baseEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return toDevProcessEnv({
    baseEnv,
    config: resolveCurrentDevInstanceConfig(repoRoot),
  });
}
