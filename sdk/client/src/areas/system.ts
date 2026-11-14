import { mobileAppDownloads } from "@hyperfide/domain";
import { z } from "zod";
import { HyperfideHttpError } from "../response.js";
import type {
  MachineEnvironmentReplace,
  MachineEnvironmentSet,
  MachineEnvironmentList,
} from "@hyperfide/server-contract";
import type {
  AppKeybindingOverrides,
  AppSettings,
  AppSettingsUpdate,
  ExperimentUpdates,
  Experiments,
  UiPreferenceKey,
  UiPreferenceValue,
} from "@hyperfide/domain";
import type { ProviderUsageResponse } from "@hyperfide/host-daemon-contract";
import type {
  SetAiServiceSelectionRequest,
  SystemAiServicesResponse,
  SystemAppUpdateAcknowledgeRequest,
  SystemAppUpdateApplyRequest,
  SystemAppUpdateQuery,
  SystemAppUpdateStatus,
  SystemCliCommandStatus,
  SystemAttentionResponse,
  SystemConfigReloadResponse,
  SystemConfigResponse,
  SystemMobileAppReleasesResponse,
  SystemExecutionOptionsQuery,
  SystemExecutionOptionsResponse,
  SystemCliSkillsStatusResponse,
  SystemInstallCliSkillsRequest,
  SystemInstallCliSkillsResponse,
  SystemProviderStatesResponse,
  SystemProvidersQuery,
  SystemUsageLimitsQuery,
  SystemVersionQuery,
  SystemVersionResponse,
  SystemVoiceTranscriptionResponse,
  TestAiServiceRequest,
  TestAiServiceResponse,
  UiPreferenceResponse,
  UiPreferencesResponse,
} from "@hyperfide/server-contract";
import { systemVoiceTranscriptionResponseSchema } from "@hyperfide/server-contract";
import {
  readExecutionOptions,
  signalRequestArgs,
  type CreateSdkAreaArgs,
} from "./common.js";

export interface SystemAttentionArgs {
  signal?: AbortSignal;
}

export const systemInstallErrorCodes = [
  "FLEET_INSTALL_INVALID",
  "FLEET_INSTALL_NOT_FOUND",
  "FLEET_INSTALL_SUPERSEDED",
  "FLEET_INSTALL_STALE",
  "FLEET_INSTALL_STALE_OWNER",
  "FLEET_INSTALL_SLOT_STALE",
  "FLEET_INSTALL_SCOPE",
  "FLEET_INSTALL_EXPIRED",
  "FLEET_INSTALL_CLOCK",
  "FLEET_INSTALL_IMAGE_EVIDENCE_REQUIRED",
  "FLEET_INSTALL_ENVIRONMENT_MISMATCH",
  "FLEET_INSTALL_PATH",
  "FLEET_INSTALL_INPUT_MISMATCH",
  "FLEET_INSTALL_DEPENDENCY_INTEGRITY",
  "FLEET_INSTALL_DEPENDENCY_FAILED",
  "FLEET_INSTALL_CONFIGURATION_MISSING",
  "FLEET_INSTALL_CONFIGURATION_PIN",
] as const;
export type SystemInstallErrorCode = (typeof systemInstallErrorCodes)[number];

export class SystemInstallError extends HyperfideHttpError {
  declare readonly code: SystemInstallErrorCode;
  constructor(
    code: SystemInstallErrorCode,
    message: string,
    status: number,
    body: unknown,
  ) {
    super({ code, message, status, body });
    this.name = "SystemInstallError";
  }
}

const installDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const installStatusSchema = z
  .object({
    admission: z
      .object({
        operation_id: z.uuid(),
        environment_id: z.string(),
        environment_generation: z.number().int().positive(),
        sandbox_id: z.uuid(),
        boot_id: z.uuid(),
        boot_generation: z.string().regex(/^[1-9][0-9]*$/),
        input_digest: installDigestSchema,
        admission_digest: installDigestSchema,
        source_revision: z.string(),
      })
      .passthrough(),
    state: z.enum(["ADMITTED", "READY"]),
    receipt: z.record(z.string(), z.unknown()).nullable(),
    receipt_digest: installDigestSchema.nullable(),
  })
  .passthrough();
export type SystemInstallStatusResult = z.infer<typeof installStatusSchema>;
export interface SystemInstallStatusArgs {
  operationId: string;
  runId: string;
  /** Canonical control-plane HTTPS origin, separate from the web API. */
  authorityUrl: string;
  /** Sign these exact bytes with the enrolled runner identity. */
  authenticate(request: {
    endpoint: string;
    method: "POST";
    body: Uint8Array;
    signal: AbortSignal;
  }): HeadersInit | Promise<HeadersInit>;
  signal?: AbortSignal;
}

async function readInstallStatus(
  transport: CreateSdkAreaArgs["transport"],
  input: SystemInstallStatusArgs,
): Promise<SystemInstallStatusResult> {
  const origin = new URL(input.authorityUrl);
  if (origin.protocol !== "https:" || origin.origin !== input.authorityUrl) {
    throw new TypeError(
      "Install status requires a canonical control-plane HTTPS origin",
    );
  }
  z.uuid().parse(input.runId);
  z.uuid().parse(input.operationId);
  const operationId = crypto.randomUUID();
  const payload = new TextEncoder().encode(
    JSON.stringify({
      run_id: input.runId,
      component: "fleet-install",
      action: "fleet.install.status",
      input: { operation_id: input.operationId },
      expected_version: null,
      authority: null,
    }),
  );
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", payload));
  const body = new TextEncoder().encode(
    JSON.stringify({
      protocol_version: 1,
      operation_id: operationId,
      idempotency_key: operationId,
      correlation_id: operationId,
      causation_id: null,
      payload_digest:
        "sha256:" +
        Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join(""),
      payload_b64: btoa(String.fromCharCode(...payload))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, ""),
    }),
  );
  const signal = input.signal
    ? AbortSignal.any([input.signal, AbortSignal.timeout(15000)])
    : AbortSignal.timeout(15000);
  const endpoint = new URL("/v1/invoke", origin).href;
  const headers = new Headers(
    await input.authenticate({
      endpoint,
      method: "POST",
      body: body.slice(),
      signal,
    }),
  );
  headers.set("content-type", "application/json");
  const response = await transport.fetch(endpoint, {
    method: "POST",
    body,
    headers,
    signal,
  });
  const value: unknown = await response.json();
  const envelope = z
    .object({
      protocol_version: z.literal(1),
      operation_id: z.literal(operationId),
      ok: z.boolean(),
      result: z.unknown().optional(),
      error: z
        .object({ code: z.string(), message: z.string() })
        .passthrough()
        .optional(),
    })
    .passthrough()
    .parse(value);
  if (!envelope.ok) {
    if (!envelope.error)
      throw new Error("Control-plane install error is missing");
    const { code, message } = envelope.error;
    const typedCode = systemInstallErrorCodes.find(
      (candidate) => candidate === code,
    );
    if (typedCode)
      throw new SystemInstallError(typedCode, message, response.status, value);
    throw new HyperfideHttpError({
      code,
      message,
      status: response.status,
      body: value,
    });
  }
  if (!response.ok)
    throw new Error(
      "Control-plane install response has inconsistent HTTP status",
    );
  const result = installStatusSchema.parse(envelope.result);
  if (
    result.admission.operation_id !== input.operationId ||
    (result.state === "READY"
      ? !result.receipt ||
        !result.receipt_digest ||
        result.receipt.receipt_digest !== result.receipt_digest
      : result.receipt !== null || result.receipt_digest !== null)
  ) {
    throw new Error(
      "Control-plane install status differs from the requested operation or readiness state",
    );
  }
  return result;
}

export interface SystemConfigArgs {
  signal?: AbortSignal;
}

export interface SystemExecutionOptionsArgs extends SystemExecutionOptionsQuery {
  signal?: AbortSignal;
}

export interface SystemUsageLimitsArgs extends Omit<
  SystemUsageLimitsQuery,
  "refresh"
> {
  refresh?: boolean;
  signal?: AbortSignal;
}

export interface SystemVersionArgs {
  force?: boolean;
  signal?: AbortSignal;
}

export interface SystemAppUpdateArgs {
  force?: boolean;
  signal?: AbortSignal;
}

export type SystemApplyAppUpdateArgs = SystemAppUpdateApplyRequest;
export type SystemAcknowledgeAppUpdateArgs = SystemAppUpdateAcknowledgeRequest;
export type SystemAppUpdateStatusResult = SystemAppUpdateStatus;

export interface SystemCliCommandArgs {
  signal?: AbortSignal;
}

export type SystemCliCommandStatusResult = SystemCliCommandStatus;

export interface SystemVoiceTranscriptionArgs {
  file: Blob;
  prompt?: string;
  signal?: AbortSignal;
}

export type SystemAttentionResult = SystemAttentionResponse;
export type SystemConfigResult = SystemConfigResponse;
export type SystemAiServicesResult = SystemAiServicesResponse;
export type SystemSetAiServiceSelectionArgs = SetAiServiceSelectionRequest;
export type SystemTestAiServiceArgs = TestAiServiceRequest;
export type SystemTestAiServiceResult = TestAiServiceResponse;

export interface SystemAiServicesArgs {
  signal?: AbortSignal;
}
export type SystemExecutionOptionsResult = SystemExecutionOptionsResponse;
export type SystemReloadConfigResult = SystemConfigReloadResponse;
export type SystemInstallCliSkillsArgs = SystemInstallCliSkillsRequest;
export interface SystemCliSkillsStatusArgs {
  hostIds?: readonly string[];
  signal?: AbortSignal;
}
export type SystemCliSkillsStatusResult = SystemCliSkillsStatusResponse;
export type SystemInstallCliSkillsResult = SystemInstallCliSkillsResponse;
export type SystemVoiceTranscriptionResult = SystemVoiceTranscriptionResponse;
export type SystemUpdateExperimentsResult = Experiments;
export type SystemUpdateGeneralSettingsResult = AppSettings & {
  showUnhandledProviderEvents?: boolean;
};
export type SystemUpdateKeyboardSettingsResult = AppKeybindingOverrides;
export type SystemUsageLimitsResult = ProviderUsageResponse;
export interface SystemProviderStatesArgs extends SystemProvidersQuery {
  signal?: AbortSignal;
}
export type SystemProviderStatesResult = SystemProviderStatesResponse;
export type SystemVersionResult = SystemVersionResponse;

export interface SystemUiPreferencesArgs {
  signal?: AbortSignal;
}
export type SystemUiPreferencesResult = UiPreferencesResponse;
export interface SystemUpdateUiPreferenceArgs<Key extends UiPreferenceKey> {
  expectedRevision: number;
  key: Key;
  value: UiPreferenceValue<Key>;
}
export interface SystemResetUiPreferenceArgs<Key extends UiPreferenceKey> {
  key: Key;
}
export type SystemUiPreferenceResult<Key extends UiPreferenceKey> =
  UiPreferenceResponse<Key>;

export interface SystemUiPreferencesArea {
  list(args?: SystemUiPreferencesArgs): Promise<SystemUiPreferencesResult>;
  set<Key extends UiPreferenceKey>(
    args: SystemUpdateUiPreferenceArgs<Key>,
  ): Promise<SystemUiPreferenceResult<Key>>;
  reset<Key extends UiPreferenceKey>(
    args: SystemResetUiPreferenceArgs<Key>,
  ): Promise<SystemUiPreferenceResult<Key>>;
}

export interface SystemArea {
  installStatus(
    args: SystemInstallStatusArgs,
  ): Promise<SystemInstallStatusResult>;
  setMachineEnvironmentVariable(
    input: MachineEnvironmentSet,
  ): Promise<MachineEnvironmentList>;
  deleteMachineEnvironmentVariable(input: {
    name: string;
  }): Promise<MachineEnvironmentList>;
  machineEnvironment(): Promise<MachineEnvironmentList>;
  replaceMachineEnvironment(
    input: MachineEnvironmentReplace,
  ): Promise<MachineEnvironmentList>;
  aiServices(args?: SystemAiServicesArgs): Promise<SystemAiServicesResult>;
  attention(args?: SystemAttentionArgs): Promise<SystemAttentionResult>;
  config(args?: SystemConfigArgs): Promise<SystemConfigResult>;
  executionOptions(
    args?: SystemExecutionOptionsArgs,
  ): Promise<SystemExecutionOptionsResult>;
  cliSkillsStatus(
    args?: SystemCliSkillsStatusArgs,
  ): Promise<SystemCliSkillsStatusResult>;
  installCliSkills(
    args: SystemInstallCliSkillsArgs,
  ): Promise<SystemInstallCliSkillsResult>;
  reloadConfig(): Promise<SystemReloadConfigResult>;
  setAiServiceSelection(
    args: SystemSetAiServiceSelectionArgs,
  ): Promise<SystemAiServicesResult>;
  testAiService(
    args: SystemTestAiServiceArgs,
  ): Promise<SystemTestAiServiceResult>;
  transcribeVoice(
    args: SystemVoiceTranscriptionArgs,
  ): Promise<SystemVoiceTranscriptionResult>;
  uiPreferences: SystemUiPreferencesArea;
  mobileAppDownloads(): typeof mobileAppDownloads;
  mobileAppReleases(): Promise<SystemMobileAppReleasesResponse>;
  updateExperiments(
    args: ExperimentUpdates,
  ): Promise<SystemUpdateExperimentsResult>;
  updateGeneralSettings(
    args: AppSettingsUpdate,
  ): Promise<SystemUpdateGeneralSettingsResult>;
  updateKeyboardSettings(
    args: AppKeybindingOverrides,
  ): Promise<SystemUpdateKeyboardSettingsResult>;
  providerStates(
    args?: SystemProviderStatesArgs,
  ): Promise<SystemProviderStatesResult>;
  usageLimits(args?: SystemUsageLimitsArgs): Promise<SystemUsageLimitsResult>;
  version(args?: SystemVersionArgs): Promise<SystemVersionResult>;
  appUpdate(args?: SystemAppUpdateArgs): Promise<SystemAppUpdateStatusResult>;
  applyAppUpdate(
    args: SystemApplyAppUpdateArgs,
  ): Promise<SystemAppUpdateStatusResult>;
  acknowledgeAppUpdate(
    args: SystemAcknowledgeAppUpdateArgs,
  ): Promise<SystemAppUpdateStatusResult>;
  experimental_cliCommand(
    args?: SystemCliCommandArgs,
  ): Promise<SystemCliCommandStatusResult>;
  experimental_installCliCommand(): Promise<SystemCliCommandStatusResult>;
  experimental_removeCliCommand(): Promise<SystemCliCommandStatusResult>;
}

function versionQuery(args: SystemVersionArgs | undefined): SystemVersionQuery {
  return args?.force === undefined
    ? {}
    : { force: args.force ? "true" : "false" };
}

function appUpdateQuery(
  args: SystemAppUpdateArgs | undefined,
): SystemAppUpdateQuery {
  return args?.force === undefined
    ? {}
    : { force: args.force ? "true" : "false" };
}

export function createSystemArea(args: CreateSdkAreaArgs): SystemArea {
  const { transport } = args;
  const uiPreferences: SystemUiPreferencesArea = {
    async list(input) {
      return transport.readJson(
        transport.api.v1.preferences.ui.$get(
          {},
          ...signalRequestArgs(input?.signal),
        ),
      );
    },
    async set(input) {
      const body = await transport.readJson(
        transport.api.v1.preferences.ui[":key"].$put({
          json: {
            expectedRevision: input.expectedRevision,
            value: input.value,
          },
          param: { key: input.key },
        }),
      );
      return body as UiPreferenceResponse<typeof input.key>;
    },
    async reset(input) {
      const body = await transport.readJson(
        transport.api.v1.preferences.ui[":key"].$delete({
          param: { key: input.key },
        }),
      );
      return body as UiPreferenceResponse<typeof input.key>;
    },
  };
  return {
    uiPreferences,
    installStatus(input) {
      return readInstallStatus(transport, input);
    },
    async setMachineEnvironmentVariable(input) {
      return transport.readJson(
        transport.api.v1.settings["machine-environment"].$post({ json: input }),
      );
    },
    async deleteMachineEnvironmentVariable(input) {
      return transport.readJson(
        transport.api.v1.settings["machine-environment"].$delete({
          json: input,
        }),
      );
    },
    async machineEnvironment() {
      return transport.readJson(
        transport.api.v1.settings["machine-environment"].$get(),
      );
    },
    async replaceMachineEnvironment(input) {
      return transport.readJson(
        transport.api.v1.settings["machine-environment"].$put({ json: input }),
      );
    },
    async attention(input) {
      return transport.readJson(
        transport.api.v1.system.attention.$get(
          {},
          ...signalRequestArgs(input?.signal),
        ),
      );
    },
    async aiServices(input) {
      return transport.readJson(
        transport.api.v1.system["ai-services"].$get(
          {},
          ...signalRequestArgs(input?.signal),
        ),
      );
    },
    async setAiServiceSelection(input) {
      return transport.readJson(
        transport.api.v1.system["ai-services"].selection.$put({ json: input }),
      );
    },
    async testAiService(input) {
      return transport.readJson(
        transport.api.v1.system["ai-services"].test.$post({ json: input }),
      );
    },
    async config(input) {
      return transport.readJson(
        transport.api.v1.system.config.$get(
          {},
          ...signalRequestArgs(input?.signal),
        ),
      );
    },
    async executionOptions(input = {}) {
      return readExecutionOptions(transport, input);
    },
    async cliSkillsStatus(input = {}) {
      return transport.readJson(
        transport.api.v1.system["cli-skills"].$get(
          {
            query:
              input.hostIds === undefined
                ? {}
                : { hostIds: input.hostIds.join(",") },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async installCliSkills(input) {
      return transport.readJson(
        transport.api.v1.system["cli-skills"].install.$post({ json: input }),
      );
    },
    async reloadConfig() {
      return transport.readJson(transport.api.v1.system.config.reload.$post());
    },
    async transcribeVoice(input) {
      if (input.file.size === 0) {
        throw new Error("Audio file must not be empty");
      }
      const form = new FormData();
      form.set("file", input.file);
      if (input.prompt !== undefined) form.set("prompt", input.prompt);
      const baseUrl = transport.baseUrl.replace(/\/$/u, "");
      const response = await transport.resolve(
        transport.fetch(`${baseUrl}/api/v1/system/voice-transcription`, {
          method: "POST",
          body: form,
          signal: input.signal,
        }),
      );
      return systemVoiceTranscriptionResponseSchema.parse(
        await response.json(),
      );
    },
    async mobileAppReleases() {
      return transport.readJson(
        transport.api.v1.system["mobile-app-releases"].$get(),
      );
    },
    mobileAppDownloads() {
      return { ...mobileAppDownloads };
    },
    async updateExperiments(input) {
      return transport.readJson(
        transport.api.v1.settings.experiments.$put({ json: input }),
      );
    },
    async updateGeneralSettings(input) {
      return transport.readJson(
        transport.api.v1.settings.general.$put({ json: input }),
      );
    },
    async updateKeyboardSettings(input) {
      return transport.readJson(
        transport.api.v1.settings.keyboard.$put({ json: input }),
      );
    },
    async providerStates(input = {}) {
      return transport.readJson(
        transport.api.v1.system.providers.state.$get(
          {
            query: {
              environmentId: input.environmentId,
              hostId: input.hostId,
            },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async usageLimits(input = {}) {
      return transport.readJson(
        transport.api.v1.system["usage-limits"].$get(
          {
            query: {
              hostId: input.hostId,
              providerId: input.providerId,
              refresh:
                input.refresh === undefined
                  ? undefined
                  : input.refresh
                    ? "true"
                    : "false",
            },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async version(input) {
      return transport.readJson(
        transport.api.v1.system.version.$get(
          { query: versionQuery(input) },
          ...signalRequestArgs(input?.signal),
        ),
      );
    },
    async appUpdate(input) {
      return transport.readJson(
        transport.api.v1.system["app-update"].$get(
          { query: appUpdateQuery(input) },
          ...signalRequestArgs(input?.signal),
        ),
      );
    },
    async applyAppUpdate(input) {
      return transport.readJson(
        transport.api.v1.system["app-update"].apply.$post({ json: input }),
      );
    },
    async acknowledgeAppUpdate(input) {
      return transport.readJson(
        transport.api.v1.system["app-update"].acknowledge.$post({
          json: input,
        }),
      );
    },
    async experimental_cliCommand(input) {
      return transport.readJson(
        transport.api.v1.system["cli-command"].$get(
          {},
          ...signalRequestArgs(input?.signal),
        ),
      );
    },
    async experimental_installCliCommand() {
      return transport.readJson(
        transport.api.v1.system["cli-command"].install.$post({}),
      );
    },
    async experimental_removeCliCommand() {
      return transport.readJson(
        transport.api.v1.system["cli-command"].remove.$post({}),
      );
    },
  };
}
