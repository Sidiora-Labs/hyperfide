import { join } from "node:path";
import { providerNativeSkillRootsSchema } from "@hyperfide/domain";
import { z } from "zod";

const BUNDLED_PROVIDER_IDS = [
  "codex",
  "claude-code",
  "pi",
  "acp-cursor",
] as const;

const HYPERFIDE_APP_CONFIG_FILE_NAME = "config.json";
const HYPERFIDE_APP_ENV_FILE_NAME = "env.json";

export type HyperfideAppManagedConfigKey = "HYPERFIDE_APP_URL" | "HYPERFIDE_LOG_LEVEL";

export const HYPERFIDE_APP_MANAGED_CONFIG_KEYS: HyperfideAppManagedConfigKey[] = [
  "HYPERFIDE_APP_URL",
  "HYPERFIDE_LOG_LEVEL",
];

export const REMOVED_AI_SERVICE_CONFIG_KEYS: readonly string[] = [
  "HYPERFIDE_INFERENCE",
  "HYPERFIDE_INFERENCE_FALLBACK",
  "HYPERFIDE_TRANSCRIPTION",
];

export const REMOVED_AI_SERVICE_CONFIG_MESSAGE =
  "HYPERFIDE_INFERENCE, HYPERFIDE_INFERENCE_FALLBACK, and HYPERFIDE_TRANSCRIPTION were removed. Choose AI services in Settings → AI services or with `hyperfide settings ai-services set <task> <automatic|off|service>`.";

export const PORTABLE_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const REMOVED_CUSTOM_ACP_AGENTS_CONFIG_KEY = "customAcpAgents";
const REMOVED_CUSTOM_ACP_AGENTS_MESSAGE =
  "customAcpAgents in config.json is no longer read. Declare the agents with `hyperfide-platform plugin config provider-acp set customAgents '<json>'`.";

interface HyperfideAppManagedConfigWarningLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

interface ParseHyperfideAppManagedConfigOptions {
  logger?: HyperfideAppManagedConfigWarningLogger;
}

const hyperfideAppManagedConfigValuesSchema = z
  .object({
    HYPERFIDE_APP_URL: z.string().optional(),
    HYPERFIDE_LOG_LEVEL: z.string().optional(),
  })
  .strict();

const ACP_PROVIDER_ID_PATTERN = /^acp-[a-z0-9][a-z0-9-]*$/u;

const customModelProviderIdSchema = z.union([
  z.enum(BUNDLED_PROVIDER_IDS),
  z.string().regex(ACP_PROVIDER_ID_PATTERN),
]);

export const customProviderModelSchema = z
  .object({
    providerId: customModelProviderIdSchema,
    model: z.string().min(1),
    displayName: z.string().min(1).optional(),
  })
  .strict();

const hyperfideAppManagedEnvNameSchema = z.string().regex(PORTABLE_ENV_NAME_PATTERN);

const hyperfideAppManagedEnvConfigSchema = z.record(
  hyperfideAppManagedEnvNameSchema,
  z.string(),
);

const hyperfideAppManagedConfigBoundarySchema = z
  .object({
    config: hyperfideAppManagedConfigValuesSchema.optional(),
    customModels: z.array(z.unknown()).optional(),
    sharedSkillRoots: providerNativeSkillRootsSchema.optional(),
    serverHeaders: z.record(z.string(), z.string()).optional(),
    machineCredential: z.string().min(1).optional(),
    connectMachineId: z.string().min(1).optional(),
    serverUrl: z.string().min(1).optional(),
  })
  .strict();

export const hyperfideAppManagedEnvFileSchema = z
  .object({
    env: hyperfideAppManagedEnvConfigSchema.optional(),
  })
  .strict();

export type HyperfideAppManagedConfigValues = z.infer<
  typeof hyperfideAppManagedConfigValuesSchema
>;
export type CustomProviderModel = z.infer<typeof customProviderModelSchema>;
export type HyperfideAppManagedConfig = Omit<
  z.infer<typeof hyperfideAppManagedConfigBoundarySchema>,
  "customModels"
> & {
  customModels?: CustomProviderModel[];
};
export type HyperfideAppManagedEnvConfig = z.infer<typeof hyperfideAppManagedEnvConfigSchema>;
export type HyperfideAppManagedEnvFile = z.infer<typeof hyperfideAppManagedEnvFileSchema>;

function parseCustomModels(
  entries: readonly unknown[] | undefined,
  options: ParseHyperfideAppManagedConfigOptions,
): CustomProviderModel[] | undefined {
  if (entries === undefined) {
    return undefined;
  }

  const customModels: CustomProviderModel[] = [];
  for (const [index, entry] of entries.entries()) {
    const result = customProviderModelSchema.safeParse(entry);
    if (!result.success) {
      options.logger?.warn(
        { error: result.error.message, index },
        "Ignoring invalid custom model config entry",
      );
      continue;
    }
    customModels.push(result.data);
  }

  return customModels;
}

function withoutRemovedAiServiceConfig(
  rawConfig: unknown,
  options: ParseHyperfideAppManagedConfigOptions,
): unknown {
  if (typeof rawConfig !== "object" || rawConfig === null) return rawConfig;
  const values: unknown = Reflect.get(rawConfig, "config");
  if (typeof values !== "object" || values === null) return rawConfig;
  const removed = REMOVED_AI_SERVICE_CONFIG_KEYS.filter((key) =>
    Object.hasOwn(values, key),
  );
  if (removed.length === 0) return rawConfig;
  options.logger?.warn({ keys: removed }, REMOVED_AI_SERVICE_CONFIG_MESSAGE);
  return {
    ...rawConfig,
    config: Object.fromEntries(
      Object.entries(values).filter(([key]) => !removed.includes(key)),
    ),
  };
}

function withoutRemovedCustomAcpAgents(
  rawConfig: unknown,
  options: ParseHyperfideAppManagedConfigOptions,
): unknown {
  if (
    typeof rawConfig !== "object" ||
    rawConfig === null ||
    !Object.hasOwn(rawConfig, REMOVED_CUSTOM_ACP_AGENTS_CONFIG_KEY)
  ) {
    return rawConfig;
  }
  options.logger?.warn(
    { key: REMOVED_CUSTOM_ACP_AGENTS_CONFIG_KEY },
    REMOVED_CUSTOM_ACP_AGENTS_MESSAGE,
  );
  return Object.fromEntries(
    Object.entries(rawConfig).filter(
      ([key]) => key !== REMOVED_CUSTOM_ACP_AGENTS_CONFIG_KEY,
    ),
  );
}

export function parseHyperfideAppManagedConfig(
  rawConfig: unknown,
  options: ParseHyperfideAppManagedConfigOptions = {},
): HyperfideAppManagedConfig {
  const parsed = hyperfideAppManagedConfigBoundarySchema.parse(
    withoutRemovedCustomAcpAgents(
      withoutRemovedAiServiceConfig(rawConfig, options),
      options,
    ),
  );
  const customModels = parseCustomModels(parsed.customModels, options);
  const config: HyperfideAppManagedConfig = {};
  if (parsed.config !== undefined) {
    config.config = parsed.config;
  }
  if (customModels !== undefined) {
    config.customModels = customModels;
  }
  if (parsed.sharedSkillRoots !== undefined) {
    config.sharedSkillRoots = parsed.sharedSkillRoots;
  }
  if (parsed.serverUrl !== undefined) {
    config.serverUrl = parsed.serverUrl;
  }
  if (parsed.serverHeaders !== undefined) {
    config.serverHeaders = parsed.serverHeaders;
  }
  if (parsed.machineCredential !== undefined) {
    config.machineCredential = parsed.machineCredential;
  }
  if (parsed.connectMachineId !== undefined) {
    config.connectMachineId = parsed.connectMachineId;
  }
  return config;
}

export function formatHyperfideAppConfigPath(dataDir: string): string {
  return join(dataDir, HYPERFIDE_APP_CONFIG_FILE_NAME);
}

export function formatHyperfideAppEnvPath(dataDir: string): string {
  return join(dataDir, HYPERFIDE_APP_ENV_FILE_NAME);
}
