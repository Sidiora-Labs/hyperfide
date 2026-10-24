import { readFile } from "node:fs/promises";
import {
  hyperfideAppManagedEnvFileSchema,
  formatHyperfideAppConfigPath,
  formatHyperfideAppEnvPath,
  parseHyperfideAppManagedConfig,
  type HyperfideAppManagedConfig,
  type HyperfideAppManagedEnvConfig,
  type HyperfideAppManagedEnvFile,
} from "@hyperfide/config/hyperfide-app-managed-config";
import { validateOptionalUrl } from "@hyperfide/config/public-url";
import type { ServerLogger, ServerRuntimeConfig } from "../../types.js";
import type { NotificationHub } from "../../ws/hub.js";

interface ApplyHyperfideAppManagedConfigArgs {
  baseConfig: ServerRuntimeConfig;
  managedConfig: HyperfideAppManagedConfig;
  targetConfig: ServerRuntimeConfig;
}

interface ReadHyperfideAppManagedConfigArgs {
  configPath: string;
  logger?: ServerLogger;
}

interface ReadHyperfideAppManagedEnvArgs {
  envPath: string;
}

interface CreateHyperfideAppManagedConfigReloaderArgs {
  config: ServerRuntimeConfig;
  hub: NotificationHub;
  logger: ServerLogger;
}

interface ReloadHyperfideAppManagedConfigArgs {
  notify: boolean;
}

export interface HyperfideAppManagedConfigReloader {
  reload(args: ReloadHyperfideAppManagedConfigArgs): Promise<void>;
}

interface ApplyManagedProcessEnvArgs {
  baseEnv: NodeJS.ProcessEnv;
  managedEnv: HyperfideAppManagedEnvConfig;
  managedKeys: Set<string>;
}

function cloneRuntimeConfig(config: ServerRuntimeConfig): ServerRuntimeConfig {
  return { ...config };
}

function replaceRuntimeConfig(
  targetConfig: ServerRuntimeConfig,
  nextConfig: ServerRuntimeConfig,
): void {
  if (nextConfig.appUrl === undefined) {
    delete targetConfig.appUrl;
  }
  Object.assign(targetConfig, nextConfig);
}

function setOptionalAppUrl(
  config: ServerRuntimeConfig,
  value: string | undefined,
): void {
  if (value === undefined) {
    delete config.appUrl;
    return;
  }
  config.appUrl = value;
}

function applyManagedProcessEnv(args: ApplyManagedProcessEnvArgs): void {
  for (const key of args.managedKeys) {
    const baseValue = args.baseEnv[key];
    if (baseValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = baseValue;
    }
  }

  args.managedKeys.clear();
  for (const [key, value] of Object.entries(args.managedEnv)) {
    process.env[key] = value;
    args.managedKeys.add(key);
  }
}

export function applyHyperfideAppManagedConfig(
  args: ApplyHyperfideAppManagedConfigArgs,
): void {
  const managedConfig = args.managedConfig.config ?? {};

  args.targetConfig.customModels =
    args.managedConfig.customModels ?? args.baseConfig.customModels;
  args.targetConfig.sharedSkillRoots =
    args.managedConfig.sharedSkillRoots ?? args.baseConfig.sharedSkillRoots;

  setOptionalAppUrl(
    args.targetConfig,
    managedConfig.HYPERFIDE_APP_URL !== undefined
      ? validateOptionalUrl(
          "HYPERFIDE_APP_URL",
          managedConfig.HYPERFIDE_APP_URL,
        )
      : args.baseConfig.appUrl,
  );
}

async function readHyperfideAppManagedConfig(
  args: ReadHyperfideAppManagedConfigArgs,
): Promise<HyperfideAppManagedConfig> {
  try {
    const rawConfig = await readFile(args.configPath, "utf8");
    return parseHyperfideAppManagedConfig(JSON.parse(rawConfig), {
      logger: args.logger,
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function readHyperfideAppManagedEnv(
  args: ReadHyperfideAppManagedEnvArgs,
): Promise<HyperfideAppManagedEnvFile> {
  try {
    const rawConfig = await readFile(args.envPath, "utf8");
    return hyperfideAppManagedEnvFileSchema.parse(JSON.parse(rawConfig));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

export async function createHyperfideAppManagedConfigReloader(
  args: CreateHyperfideAppManagedConfigReloaderArgs,
): Promise<HyperfideAppManagedConfigReloader> {
  const baseConfig = cloneRuntimeConfig(args.config);
  const baseEnv = { ...process.env };
  const configPath = formatHyperfideAppConfigPath(args.config.dataDir);
  const envPath = formatHyperfideAppEnvPath(args.config.dataDir);
  const managedEnvKeys = new Set<string>();

  async function reload(
    reloadArgs: ReloadHyperfideAppManagedConfigArgs,
  ): Promise<void> {
    const managedConfig = await readHyperfideAppManagedConfig({
      configPath,
      logger: args.logger,
    });
    const managedEnvFile = await readHyperfideAppManagedEnv({ envPath });
    const nextConfig = cloneRuntimeConfig(args.config);
    applyHyperfideAppManagedConfig({
      baseConfig,
      managedConfig,
      targetConfig: nextConfig,
    });
    applyManagedProcessEnv({
      baseEnv,
      managedEnv: managedEnvFile.env ?? {},
      managedKeys: managedEnvKeys,
    });
    replaceRuntimeConfig(args.config, nextConfig);
    if (reloadArgs.notify) {
      await args.hub.notifySystem(["config-changed"]);
    }
  }

  try {
    await reload({ notify: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    args.logger.warn(
      { configPath, error: message },
      "Ignoring invalid hyperfide-app managed config during startup",
    );
  }

  return {
    reload,
  };
}
