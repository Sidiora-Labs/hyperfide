import {
  readEnvVarWithDefault,
  readOptionalEnvVar,
  resolveEnvLoader,
  type EnvLoaderArgs,
} from "./env.js";
import {
  HYPERFIDE_DEV_APP_HOST_ENV,
  HYPERFIDE_DEV_APP_PORT_ENV,
  DEFAULT_HYPERFIDE_DEV_APP_HOST,
} from "./env-vars.js";
import { assignIfDefined } from "./objects.js";

interface DevAppConfig {
  HYPERFIDE_DEV_APP_HOST: string;
  HYPERFIDE_DEV_APP_PORT?: number;
}

type LoadDevAppConfigArgs = EnvLoaderArgs;

export function loadDevAppConfig(
  args: LoadDevAppConfigArgs = {},
): DevAppConfig {
  const loader = resolveEnvLoader(args);
  const config: DevAppConfig = {
    HYPERFIDE_DEV_APP_HOST: readEnvVarWithDefault({
      context: loader.context,
      defaultValue: DEFAULT_HYPERFIDE_DEV_APP_HOST,
      definition: HYPERFIDE_DEV_APP_HOST_ENV,
      env: loader.env,
    }),
  };
  const appPort = readOptionalEnvVar({
    context: loader.context,
    definition: HYPERFIDE_DEV_APP_PORT_ENV,
    env: loader.env,
  });

  assignIfDefined({
    key: "HYPERFIDE_DEV_APP_PORT",
    target: config,
    value: appPort,
  });

  return config;
}
