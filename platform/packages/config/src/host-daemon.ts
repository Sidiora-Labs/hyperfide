import {
  readEnvVarWithDefault,
  readOptionalEnvVar,
  resolveEnvLoader,
  type EnvLoaderArgs,
} from "./env.js";
import {
  loadCommonConfig,
  type CommonConfig,
  type LoadCommonConfigArgs,
} from "./common.js";
import {
  HYPERFIDE_APP_URL_ENV,
  HYPERFIDE_DEV_APP_PORT_ENV,
  DEFAULT_HYPERFIDE_APP_URL,
} from "./env-vars.js";
import { assignIfDefined } from "./objects.js";
import { loadHostDaemonPortValue } from "./ports.js";
import { validateOptionalUrl } from "./public-url.js";
import { validatePortNumber } from "./runtime.js";
import { loadServerUrlValue } from "./server-url.js";

interface HostDaemonConnectionConfig {
  HYPERFIDE_APP_URL: string;
  HYPERFIDE_DEV_APP_PORT?: number;
  HYPERFIDE_HOST_DAEMON_PORT: number;
  HYPERFIDE_SERVER_URL: string;
}

interface HostDaemonConfig extends CommonConfig, HostDaemonConnectionConfig {}

interface LoadHostDaemonConnectionConfigArgs extends EnvLoaderArgs {
  hostDaemonPort?: number;
  repoRoot?: string;
  serverUrl?: string;
}

interface LoadHostDaemonConfigArgs
  extends LoadCommonConfigArgs, LoadHostDaemonConnectionConfigArgs {}

interface HostDaemonStartConfig {
  dataDir: string;
  connectionConfig: HostDaemonConnectionConfig;
}

interface LoadHostDaemonStartConfigArgs extends LoadHostDaemonConfigArgs {
  dataDir?: string;
}

function resolveHostDaemonPort(
  args: LoadHostDaemonConnectionConfigArgs,
): number {
  if (args.hostDaemonPort !== undefined) {
    return validatePortNumber({
      name: "HYPERFIDE_HOST_DAEMON_PORT",
      value: args.hostDaemonPort,
    });
  }

  return loadHostDaemonPortValue(args);
}

export function loadHostDaemonConnectionConfig(
  args: LoadHostDaemonConnectionConfigArgs = {},
): HostDaemonConnectionConfig {
  const loader = resolveEnvLoader(args);
  const config: HostDaemonConnectionConfig = {
    HYPERFIDE_APP_URL: validateOptionalUrl(
      "HYPERFIDE_APP_URL",
      readEnvVarWithDefault({
        context: loader.context,
        defaultValue: DEFAULT_HYPERFIDE_APP_URL,
        definition: HYPERFIDE_APP_URL_ENV,
        env: loader.env,
      }),
    ),
    HYPERFIDE_HOST_DAEMON_PORT: resolveHostDaemonPort({
      ...args,
      env: loader.env,
      homeDir: loader.context.homeDir,
      mode: loader.mode,
    }),
    HYPERFIDE_SERVER_URL: loadServerUrlValue({
      ...args,
      env: loader.env,
      homeDir: loader.context.homeDir,
      mode: loader.mode,
    }),
  };
  const devAppPort = readOptionalEnvVar({
    context: loader.context,
    definition: HYPERFIDE_DEV_APP_PORT_ENV,
    env: loader.env,
  });

  assignIfDefined({
    key: "HYPERFIDE_DEV_APP_PORT",
    target: config,
    value: devAppPort,
  });

  return config;
}

export function loadHostDaemonConfig(
  args: LoadHostDaemonConfigArgs = {},
): HostDaemonConfig {
  return {
    ...loadCommonConfig(args),
    ...loadHostDaemonConnectionConfig(args),
  };
}

export function loadHostDaemonStartConfig(
  args: LoadHostDaemonStartConfigArgs,
): HostDaemonStartConfig {
  if (args.dataDir === undefined) {
    const config = loadHostDaemonConfig(args);
    return {
      connectionConfig: config,
      dataDir: config.HYPERFIDE_DATA_DIR,
    };
  }

  return {
    connectionConfig: loadHostDaemonConnectionConfig(args),
    dataDir: args.dataDir,
  };
}
