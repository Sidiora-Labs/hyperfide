import {
  getProjectExecutionDefaults,
  upsertProjectExecutionDefaults,
} from "@hyperfide/db";
import type {
  ProjectExecutionDefaults,
  RecordedThreadExecutionOptions,
  ResolvedThreadExecutionOptions,
  Thread,
} from "@hyperfide/domain";
import type { AppDeps } from "../../types.js";
import type {
  ThreadCreateServiceRequest,
  ThreadCreateServiceRequestInput,
} from "./thread-create-request.js";
import {
  buildProviderThreadExecutionDefaults,
  resolveCreateThreadExecutionDefaults,
} from "./thread-default-policy.js";
import { getLastExecutionOptions } from "./thread-events.js";

interface RememberProjectExecutionDefaultsForCreateArgs {
  execution: ResolvedThreadExecutionOptions;
  request: ThreadCreateServiceRequest;
}

interface ResolveProjectExecutionDefaultsForCreateArgs {
  executionInputSources?: ThreadCreateServiceRequestInput["executionInputSources"];
  model?: ThreadCreateServiceRequestInput["model"];
  parentThread: Pick<Thread, "id" | "providerId"> | null;
  projectId: string;
  providerId?: ThreadCreateServiceRequestInput["providerId"];
}

interface ResolvedProjectExecutionDefaultsForCreate {
  executionDefaults: ProjectExecutionDefaults | null;
  providerId: string;
  providerFallbackCandidates: readonly string[];
  requestedModel: string | null;
}

type CreateExecutionInputSources =
  ThreadCreateServiceRequestInput["executionInputSources"];
type CreateExecutionInputField = keyof NonNullable<CreateExecutionInputSources>;

interface ResolveRequestedCreateExecutionValueArgs<TValue> {
  field: CreateExecutionInputField;
  sources: CreateExecutionInputSources;
  value: TValue | undefined;
}

function shouldRememberProjectExecutionDefaults(args: {
  environment: ThreadCreateServiceRequest["environment"];
  origin: ThreadCreateServiceRequest["origin"];
  originKind?: ThreadCreateServiceRequest["originKind"];
}): boolean {
  // Reusing an existing worktree is a one-off in a specific environment, not
  // a fresh default-shaping event. Don't overwrite the project's stored
  // execution defaults with the picker selections made for that single thread.
  if (args.environment.type === "reuse") return false;
  if (args.originKind !== null) return false;
  return args.origin === "app";
}

interface InheritableParentExecution {
  execution: RecordedThreadExecutionOptions;
  providerId: string;
}

async function resolveInheritableParentExecution(
  deps: Pick<AppDeps, "db" | "providerRegistry">,
  parentThread: Pick<Thread, "id" | "providerId"> | null,
): Promise<InheritableParentExecution | null> {
  if (parentThread === null) {
    return null;
  }
  const { providerId } = parentThread;
  if (
    (await deps.providerRegistry.disabledProviderIds()).has(providerId) ||
    deps.providerRegistry.get(providerId)?.info.available !== true
  ) {
    return null;
  }
  const execution = await getLastExecutionOptions(deps, parentThread.id);
  return execution === null ? null : { execution, providerId };
}

function resolveRequestedCreateExecutionValue<TValue>({
  field,
  sources,
  value,
}: ResolveRequestedCreateExecutionValueArgs<TValue>): TValue | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (sources === undefined) {
    return value;
  }
  return sources[field] === undefined ? undefined : value;
}

/**
 * Resolves the create's provider through the defaults ladder. This is the only
 * place a thread's provider is chosen: it is immutable afterwards, because a
 * provider session IS the conversation and no other provider can continue one
 * it never started.
 */
export async function resolveProjectExecutionDefaultsForCreate(
  deps: Pick<AppDeps, "db" | "providerRegistry">,
  args: ResolveProjectExecutionDefaultsForCreateArgs,
): Promise<ResolvedProjectExecutionDefaultsForCreate> {
  const storedDefaults = await getProjectExecutionDefaults(deps.db, {
    projectId: args.projectId,
  });
  const requestedProviderId = resolveRequestedCreateExecutionValue({
    field: "providerId",
    sources: args.executionInputSources,
    value: args.providerId,
  });
  const requestedModel = resolveRequestedCreateExecutionValue({
    field: "model",
    sources: args.executionInputSources,
    value: args.model,
  });
  const parent = await resolveInheritableParentExecution(
    deps,
    args.parentThread,
  );
  const resolution = await resolveCreateThreadExecutionDefaults(
    deps.providerRegistry,
    {
      requestedProviderId: requestedProviderId ?? parent?.providerId,
      storedDefaults,
    },
  );
  const { providerId, providerFallbackCandidates } = resolution;
  const executionDefaults =
    parent !== null && providerId === parent.providerId
      ? {
          ...(resolution.executionDefaults ??
            buildProviderThreadExecutionDefaults(deps.providerRegistry, {
              providerId,
              model: parent.execution.model,
            })),
          model: parent.execution.model,
          reasoningLevel: parent.execution.reasoningLevel,
        }
      : resolution.executionDefaults;

  return {
    executionDefaults,
    providerId,
    providerFallbackCandidates,
    requestedModel: requestedModel ?? null,
  };
}

export async function rememberProjectExecutionDefaultsForCreate(
  deps: Pick<AppDeps, "db">,
  args: RememberProjectExecutionDefaultsForCreateArgs,
): Promise<void> {
  if (!shouldRememberProjectExecutionDefaults(args.request)) {
    return;
  }

  await upsertProjectExecutionDefaults(deps.db, {
    projectId: args.request.projectId,
    providerId: args.request.providerId,
    model: args.execution.model,
    reasoningLevel: args.execution.reasoningLevel,
    permissionMode: args.execution.permissionMode,
    serviceTier: args.execution.serviceTier,
  });
}
