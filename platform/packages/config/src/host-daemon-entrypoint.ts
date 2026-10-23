import {
  readOptionalEnvVar,
  resolveEnvLoader,
  type EnvLoaderArgs,
} from "./env.js";
import {
  HYPERFIDE_SERVER_HEADERS_ENV,
  HYPERFIDE_BRIDGE_DIR_ENV,
  HYPERFIDE_CLI_DIR_ENV,
  HYPERFIDE_CONNECT_MACHINE_CREDENTIAL_ENV,
  HYPERFIDE_HOST_ENROLL_KEY_ENV,
  HYPERFIDE_HOST_DAEMON_AUTO_UPDATE_ENV,
  HYPERFIDE_HOST_DAEMON_SUPERVISED_ENV,
  HYPERFIDE_HOST_ID_ENV,
} from "./env-vars.js";
import { assignIfDefined } from "./objects.js";

export interface HostDaemonEntrypointConfig {
  HYPERFIDE_BRIDGE_DIR?: string;
  HYPERFIDE_CLI_DIR?: string;
  HYPERFIDE_SERVER_HEADERS?: Record<string, string>;
  HYPERFIDE_HOST_ENROLL_KEY?: string;
  HYPERFIDE_HOST_DAEMON_AUTO_UPDATE?: boolean;
  HYPERFIDE_HOST_DAEMON_SUPERVISED?: boolean;
  HYPERFIDE_HOST_ID?: string;
}

type LoadHostDaemonEntrypointConfigArgs = EnvLoaderArgs;

export function loadHostDaemonEntrypointConfig(
  args: LoadHostDaemonEntrypointConfigArgs = {},
): HostDaemonEntrypointConfig {
  const loader = resolveEnvLoader(args);
  const config: HostDaemonEntrypointConfig = {};
  const bridgeDir = readOptionalEnvVar({
    context: loader.context,
    definition: HYPERFIDE_BRIDGE_DIR_ENV,
    env: loader.env,
  });
  const cliDir = readOptionalEnvVar({
    context: loader.context,
    definition: HYPERFIDE_CLI_DIR_ENV,
    env: loader.env,
  });
  const enrollKey = readOptionalEnvVar({
    context: loader.context,
    definition: HYPERFIDE_HOST_ENROLL_KEY_ENV,
    env: loader.env,
  });
  const autoUpdate = readOptionalEnvVar({
    context: loader.context,
    definition: HYPERFIDE_HOST_DAEMON_AUTO_UPDATE_ENV,
    env: loader.env,
  });
  const supervised = readOptionalEnvVar({
    context: loader.context,
    definition: HYPERFIDE_HOST_DAEMON_SUPERVISED_ENV,
    env: loader.env,
  });
  const machineCredential = readOptionalEnvVar({
    context: loader.context,
    definition: HYPERFIDE_CONNECT_MACHINE_CREDENTIAL_ENV,
    env: loader.env,
  });
  const serverHeaders =
    readOptionalEnvVar({
      context: loader.context,
      definition: HYPERFIDE_SERVER_HEADERS_ENV,
      env: loader.env,
    }) ??
    (machineCredential === undefined
      ? undefined
      : { "x-hyperfide-connect-machine": machineCredential });
  const hostId = readOptionalEnvVar({
    context: loader.context,
    definition: HYPERFIDE_HOST_ID_ENV,
    env: loader.env,
  });

  assignIfDefined({
    key: "HYPERFIDE_BRIDGE_DIR",
    target: config,
    value: bridgeDir,
  });
  assignIfDefined({
    key: "HYPERFIDE_CLI_DIR",
    target: config,
    value: cliDir,
  });
  assignIfDefined({
    key: "HYPERFIDE_SERVER_HEADERS",
    target: config,
    value: serverHeaders,
  });
  assignIfDefined({
    key: "HYPERFIDE_HOST_DAEMON_AUTO_UPDATE",
    target: config,
    value: autoUpdate,
  });
  assignIfDefined({
    key: "HYPERFIDE_HOST_DAEMON_SUPERVISED",
    target: config,
    value: supervised,
  });
  assignIfDefined({
    key: "HYPERFIDE_HOST_ENROLL_KEY",
    target: config,
    value: enrollKey,
  });
  assignIfDefined({
    key: "HYPERFIDE_HOST_ID",
    target: config,
    value: hostId,
  });
  return config;
}
