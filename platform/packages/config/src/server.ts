import type { FeatureFlags } from "@bb/domain";
import type { AppInstallKind, AppSourceOrigin } from "./app-install.js";
import type { AppSurface } from "./app-surface.js";
import type { AppUpdateMode } from "./app-update.js";
import {
  loadCommonConfig,
  type CommonConfig,
  type LoadCommonConfigArgs,
} from "./common.js";
import { loadDatabaseConfig, type DatabaseConfig } from "./database.js";
import { loadDevAppConfig } from "./dev-app.js";
import {
  readEnvVarWithDefault,
  readOptionalEnvVar,
  resolveEnvLoader,
} from "./env.js";
import {
  HYPERFIDE_APP_INSTALL_KIND_ENV,
  HYPERFIDE_APP_SOURCE_COMMIT_ENV,
  HYPERFIDE_APP_SOURCE_ORIGIN_ENV,
  HYPERFIDE_APP_URL_ENV,
  HYPERFIDE_APP_SURFACE_ENV,
  HYPERFIDE_APP_VERSION_ENV,
  HYPERFIDE_CONNECT_GATE_KEYS_URL_ENV,
  HYPERFIDE_EXTERNAL_URL_ENV,
  HYPERFIDE_INHERITED_SKILLS_ROOTS_ENV,
  HYPERFIDE_MARKETPLACE_URL_ENV,
  HYPERFIDE_POSTHOG_API_KEY_ENV,
  HYPERFIDE_SERVER_BIND_HOST_ENV,
  HYPERFIDE_SERVER_LAUNCH_ID_ENV,
  HYPERFIDE_APP_UPDATE_MODE_ENV,
  HYPERFIDE_CLI_LAUNCHER_ENV,
  HYPERFIDE_TELEMETRY_ENV,
  HYPERFIDE_PERF_DIAGNOSTICS_ENV,
  HYPERFIDE_SKIP_ONBOARDING_ENV,
  DEFAULT_HYPERFIDE_APP_URL,
  DEFAULT_HYPERFIDE_APP_SURFACE,
  DEFAULT_HYPERFIDE_APP_VERSION,
  DEFAULT_HYPERFIDE_CONNECT_GATE_KEYS_URL,
  DEFAULT_HYPERFIDE_EXTERNAL_URL,
  DEFAULT_HYPERFIDE_MARKETPLACE_URL,
  DEFAULT_HYPERFIDE_POSTHOG_API_KEY,
  DEFAULT_HYPERFIDE_SERVER_BIND_HOST,
  DEFAULT_HYPERFIDE_TELEMETRY,
  parseServerBindHost,
  type ServerBindHost,
} from "./env-vars.js";
import { loadFeatureFlags } from "./feature-flags.js";
import { assignIfDefined } from "./objects.js";
import { loadHostDaemonPortValue } from "./ports.js";
import { loadServerPortConfig, type ServerPortConfig } from "./server-port.js";

export interface ServerConfig
  extends CommonConfig, DatabaseConfig, ServerPortConfig {
  HYPERFIDE_APP_INSTALL_KIND?: AppInstallKind;
  HYPERFIDE_APP_SOURCE_COMMIT?: string;
  HYPERFIDE_APP_SOURCE_ORIGIN?: AppSourceOrigin;
  HYPERFIDE_APP_URL: string;
  HYPERFIDE_APP_SURFACE: AppSurface;
  HYPERFIDE_APP_VERSION: string;
  HYPERFIDE_CONNECT_GATE_KEYS_URL: string;
  HYPERFIDE_DEV_APP_PORT?: number;
  HYPERFIDE_EXTERNAL_URL: string;
  HYPERFIDE_HOST_DAEMON_PORT: number;
  HYPERFIDE_INHERITED_SKILLS_ROOTS: string[];
  HYPERFIDE_POSTHOG_API_KEY: string;
  HYPERFIDE_MARKETPLACE_URL: string;
  HYPERFIDE_SERVER_BIND_HOST: ServerBindHost;
  HYPERFIDE_SERVER_LAUNCH_ID?: string;
  HYPERFIDE_APP_UPDATE_MODE?: AppUpdateMode;
  HYPERFIDE_CLI_LAUNCHER?: string;
  HYPERFIDE_TELEMETRY: boolean;
  HYPERFIDE_PERF_DIAGNOSTICS: boolean;
  HYPERFIDE_SKIP_ONBOARDING: boolean;
  featureFlags: FeatureFlags;
}

type LoadServerConfigArgs = LoadCommonConfigArgs;

export { parseServerBindHost };
export type { ServerBindHost };

export function loadServerConfig(
  args: LoadServerConfigArgs = {},
): ServerConfig {
  const loader = resolveEnvLoader(args);
  const commonConfig = loadCommonConfig({
    env: loader.env,
    homeDir: loader.context.homeDir,
    mode: loader.mode,
    repoRoot: args.repoRoot,
  });
  const databaseConfig = loadDatabaseConfig({
    commonConfig,
    env: loader.env,
    homeDir: loader.context.homeDir,
    mode: loader.mode,
    repoRoot: args.repoRoot,
  });
  const serverPortConfig = loadServerPortConfig({
    env: loader.env,
    homeDir: loader.context.homeDir,
    mode: loader.mode,
    repoRoot: args.repoRoot,
  });
  const devAppConfig = loadDevAppConfig({
    env: loader.env,
    homeDir: loader.context.homeDir,
    mode: loader.mode,
  });
  const config: ServerConfig = {
    ...commonConfig,
    ...databaseConfig,
    ...serverPortConfig,
    HYPERFIDE_APP_URL: readEnvVarWithDefault({
      context: loader.context,
      defaultValue: DEFAULT_HYPERFIDE_APP_URL,
      definition: HYPERFIDE_APP_URL_ENV,
      env: loader.env,
    }),
    HYPERFIDE_APP_SURFACE: readEnvVarWithDefault({
      context: loader.context,
      defaultValue: DEFAULT_HYPERFIDE_APP_SURFACE,
      definition: HYPERFIDE_APP_SURFACE_ENV,
      env: loader.env,
    }),
    HYPERFIDE_APP_VERSION: readEnvVarWithDefault({
      context: loader.context,
      defaultValue: DEFAULT_HYPERFIDE_APP_VERSION,
      definition: HYPERFIDE_APP_VERSION_ENV,
      env: loader.env,
    }),
    HYPERFIDE_CONNECT_GATE_KEYS_URL: readEnvVarWithDefault({
      context: loader.context,
      defaultValue: DEFAULT_HYPERFIDE_CONNECT_GATE_KEYS_URL,
      definition: HYPERFIDE_CONNECT_GATE_KEYS_URL_ENV,
      env: loader.env,
    }),
    HYPERFIDE_EXTERNAL_URL: readEnvVarWithDefault({
      context: loader.context,
      defaultValue: DEFAULT_HYPERFIDE_EXTERNAL_URL,
      definition: HYPERFIDE_EXTERNAL_URL_ENV,
      env: loader.env,
    }),
    HYPERFIDE_HOST_DAEMON_PORT: loadHostDaemonPortValue({
      env: loader.env,
      homeDir: loader.context.homeDir,
      mode: loader.mode,
      repoRoot: args.repoRoot,
    }),
    HYPERFIDE_INHERITED_SKILLS_ROOTS: readEnvVarWithDefault({
      context: loader.context,
      defaultValue: [],
      definition: HYPERFIDE_INHERITED_SKILLS_ROOTS_ENV,
      env: loader.env,
    }),
    HYPERFIDE_MARKETPLACE_URL: readEnvVarWithDefault({
      context: loader.context,
      defaultValue: DEFAULT_HYPERFIDE_MARKETPLACE_URL,
      definition: HYPERFIDE_MARKETPLACE_URL_ENV,
      env: loader.env,
    }),
    HYPERFIDE_POSTHOG_API_KEY: readEnvVarWithDefault({
      context: loader.context,
      defaultValue: DEFAULT_HYPERFIDE_POSTHOG_API_KEY,
      definition: HYPERFIDE_POSTHOG_API_KEY_ENV,
      env: loader.env,
    }),
    HYPERFIDE_SERVER_BIND_HOST: readEnvVarWithDefault({
      context: loader.context,
      defaultValue: DEFAULT_HYPERFIDE_SERVER_BIND_HOST,
      definition: HYPERFIDE_SERVER_BIND_HOST_ENV,
      env: loader.env,
    }),
    HYPERFIDE_PERF_DIAGNOSTICS: readEnvVarWithDefault({
      context: loader.context,
      definition: HYPERFIDE_PERF_DIAGNOSTICS_ENV,
      env: loader.env,
      defaultValue: false,
    }),
    HYPERFIDE_SKIP_ONBOARDING: readEnvVarWithDefault({
      context: loader.context,
      definition: HYPERFIDE_SKIP_ONBOARDING_ENV,
      env: loader.env,
      defaultValue: false,
    }),
    HYPERFIDE_TELEMETRY: readEnvVarWithDefault({
      context: loader.context,
      defaultValue: DEFAULT_HYPERFIDE_TELEMETRY,
      definition: HYPERFIDE_TELEMETRY_ENV,
      env: loader.env,
    }),
    featureFlags: loadFeatureFlags({
      env: loader.env,
      homeDir: loader.context.homeDir,
      mode: loader.mode,
    }),
  };

  assignIfDefined({
    key: "HYPERFIDE_DEV_APP_PORT",
    target: config,
    value: devAppConfig.HYPERFIDE_DEV_APP_PORT,
  });
  assignIfDefined({
    key: "HYPERFIDE_APP_UPDATE_MODE",
    target: config,
    value: readOptionalEnvVar({
      context: loader.context,
      definition: HYPERFIDE_APP_UPDATE_MODE_ENV,
      env: loader.env,
    }),
  });
  assignIfDefined({
    key: "HYPERFIDE_CLI_LAUNCHER",
    target: config,
    value: readOptionalEnvVar({
      context: loader.context,
      definition: HYPERFIDE_CLI_LAUNCHER_ENV,
      env: loader.env,
    }),
  });
  assignIfDefined({
    key: "HYPERFIDE_APP_INSTALL_KIND",
    target: config,
    value: readOptionalEnvVar({
      context: loader.context,
      definition: HYPERFIDE_APP_INSTALL_KIND_ENV,
      env: loader.env,
    }),
  });
  assignIfDefined({
    key: "HYPERFIDE_APP_SOURCE_ORIGIN",
    target: config,
    value: readOptionalEnvVar({
      context: loader.context,
      definition: HYPERFIDE_APP_SOURCE_ORIGIN_ENV,
      env: loader.env,
    }),
  });
  assignIfDefined({
    key: "HYPERFIDE_APP_SOURCE_COMMIT",
    target: config,
    value: readOptionalEnvVar({
      context: loader.context,
      definition: HYPERFIDE_APP_SOURCE_COMMIT_ENV,
      env: loader.env,
    }),
  });
  assignIfDefined({
    key: "HYPERFIDE_SERVER_LAUNCH_ID",
    target: config,
    value: readOptionalEnvVar({
      context: loader.context,
      definition: HYPERFIDE_SERVER_LAUNCH_ID_ENV,
      env: loader.env,
    }),
  });

  return config;
}
