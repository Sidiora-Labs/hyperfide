import {
  readOptionalEnvVar,
  resolveEnvLoader,
  type EnvLoaderArgs,
  type EnvVarDefinition,
} from "./env.js";
import {
  HYPERFIDE_HOST_DAEMON_PORT_ENV,
  HYPERFIDE_SERVER_PORT_ENV,
} from "./env-vars.js";
import {
  HYPERFIDE_PROD_HOST_DAEMON_PORT,
  HYPERFIDE_PROD_SERVER_PORT,
  resolveDevInstanceConfig,
} from "./runtime.js";

export interface RuntimePortLoaderArgs extends EnvLoaderArgs {
  repoRoot?: string;
}

interface RuntimePortDefaultArgs {
  homeDir: string;
  repoRoot?: string;
}

interface LoadRuntimePortValueArgs extends RuntimePortLoaderArgs {
  definition: EnvVarDefinition<number>;
  prodDefault: number;
  devDefault: number | undefined;
}

function resolveDevServerPortDefault(
  args: RuntimePortDefaultArgs,
): number | undefined {
  if (args.repoRoot === undefined) {
    return undefined;
  }

  return resolveDevInstanceConfig({
    homeDir: args.homeDir,
    repoRoot: args.repoRoot,
  }).ports.serverPort;
}

function resolveDevHostDaemonPortDefault(
  args: RuntimePortDefaultArgs,
): number | undefined {
  if (args.repoRoot === undefined) {
    return undefined;
  }

  return resolveDevInstanceConfig({
    homeDir: args.homeDir,
    repoRoot: args.repoRoot,
  }).ports.hostDaemonPort;
}

function loadRuntimePortValue(args: LoadRuntimePortValueArgs): number {
  const loader = resolveEnvLoader(args);
  const configuredPort = readOptionalEnvVar({
    context: loader.context,
    definition: args.definition,
    env: loader.env,
  });
  if (configuredPort !== undefined) {
    return configuredPort;
  }

  if (loader.mode === "prod") {
    return args.prodDefault;
  }

  if (args.devDefault !== undefined) {
    return args.devDefault;
  }

  throw new Error(
    `${args.definition.name} is required unless repoRoot is provided for development`,
  );
}

export function loadServerPortValue(args: RuntimePortLoaderArgs = {}): number {
  const loader = resolveEnvLoader(args);
  return loadRuntimePortValue({
    ...args,
    definition: HYPERFIDE_SERVER_PORT_ENV,
    devDefault: resolveDevServerPortDefault({
      homeDir: loader.context.homeDir,
      repoRoot: args.repoRoot,
    }),
    env: loader.env,
    homeDir: loader.context.homeDir,
    mode: loader.mode,
    prodDefault: HYPERFIDE_PROD_SERVER_PORT,
  });
}

export function loadHostDaemonPortValue(
  args: RuntimePortLoaderArgs = {},
): number {
  const loader = resolveEnvLoader(args);
  return loadRuntimePortValue({
    ...args,
    definition: HYPERFIDE_HOST_DAEMON_PORT_ENV,
    devDefault: resolveDevHostDaemonPortDefault({
      homeDir: loader.context.homeDir,
      repoRoot: args.repoRoot,
    }),
    env: loader.env,
    homeDir: loader.context.homeDir,
    mode: loader.mode,
    prodDefault: HYPERFIDE_PROD_HOST_DAEMON_PORT,
  });
}
