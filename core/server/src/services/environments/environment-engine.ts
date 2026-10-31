import { emitPluginEnvironmentRemoved } from "../plugins/plugin-thread-events.js";
import { withHostCleanup } from "../hosts/cleanup-context.js";
import { findHostDataDir } from "../lib/entity-lookup.js";
import { getLatestThreadSequence, updateThread } from "@hyperfide/db";
import {
  assertEnvironmentPathAvailable,
  findBlockingEnvironmentPathClaim,
} from "./path-admission.js";
import { saveThreadProvisionContext } from "../threads/thread-startup-store.js";
import {
  refreshAttachedEnvironmentBranch,
  resolveProviderOperationContext,
} from "../threads/thread-environment-placement.js";
import { withEnvironmentCleanupSlot } from "./cleanup-concurrency.js";
import { ensureHostSessionReadyForWork } from "../hosts/host-lifecycle.js";
import { foreignProjectOwnedPathRefusal } from "../threads/workspace-path-claims.js";
import {
  cancelPendingEnvironmentHook,
  runEnvironmentHook,
  ENVIRONMENT_HOOK_TIMEOUT_MS,
} from "./environment-hooks.js";
import { eq, and, isNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  releaseFinishedEnvironmentPreparationOwners,
  environmentHasLiveThreads,
  environments,
  environmentHookOperations,
  getEnvironment,
  getHost,
  getThread,
  findProjectEnvironmentByHostPath,
  getPreparingEnvironment,
  claimEnvironmentPath,
  bindEnvironmentPath,
  listProviderLifecycleEnvironments,
  updatePreparingEnvironment,
  type DbConnection,
  type DbTransaction,
  type EnvironmentRow,
  events,
  type DbNotifier,
  type DbQueryConnection,
  threads,
  markHostEnvironmentsDestroyed,
} from "@hyperfide/db";
import {
  canonicalizeHostPath,
  isAbsoluteHostPath,
  jsonValueSchema,
  type Environment,
  type EnvironmentMachineSelection,
  type Host,
  type JsonValue,
  type Project,
  type ProvisioningTranscriptEntry,
  type SystemThreadProvisioningStatus,
  type ThreadStatus,
  threadScope,
} from "@hyperfide/domain";
import { type ThreadResponse } from "@hyperfide/server-contract";
import {
  type PluginEnvironmentProviderCreateContext,
  type PluginEnvironmentProviderCreateResult,
  type PluginEnvironmentProviderProgress,
  type PluginEnvironmentProviderRestoreContext,
} from "@hyperfide/plugin-sdk/environment-provider";
import {
  type ThreadProvisioningDeps,
  ensureWorkspaceReadyEventInTransaction,
  queueChildSetupFailureNotification,
} from "../threads/thread-provisioning-environment.js";
import { toEnvironmentResponse } from "./environment-response.js";
import {
  getEnvironmentProvider,
  invokeEnvironmentProvider,
  listEnvironmentProviders,
  requestEnvironmentProvisioningRecheck,
  type PluginEnvironmentProviderRecord,
} from "../plugins/plugin-environment-provider-registry.js";
import {
  applyLoggedEnvironmentLifecycleEvent,
  applyLoggedEnvironmentLifecycleEventInTransaction,
} from "./lifecycle-outcome.js";
import { buildEnvironmentProvisionCommand } from "../threads/thread-create-helpers.js";
import { recordProvisionedEnvironmentWorkspace } from "@hyperfide/db/internal-environment-lifecycle";
import { type AppDeps } from "../../types.js";
import {
  appendThreadProvisioningEvent,
  appendSystemErrorEventInTransaction,
  appendThreadProvisioningEventInTransaction,
  buildCwdBranchEntries,
} from "../threads/thread-events.js";
import { type EnvironmentProvisionRequest } from "./environment-provision-request.js";
import {
  createLiveHostCommandExecution,
  expectedLiveHostCommandErrorLogFields,
  LIVE_DAEMON_COMMAND_TIMEOUT_MS,
  runLiveHostCommand,
} from "../hosts/live-command.js";
import { applyLoggedThreadLifecycleEventInTransaction } from "../threads/lifecycle-outcome.js";
import {
  clearThreadProvisionSchedule,
  getThreadProvisionContext,
} from "../threads/thread-startup-store.js";
import { advanceThreadProvisioning } from "../threads/thread-provisioning.js";
import {
  finalizeStoppedThreadInTransaction,
  requestThreadStopForCurrentState,
} from "../threads/thread-lifecycle.js";
import {
  emptyCommandResultSideEffects,
  type CommandResultPostCommitAction,
  type CommandResultSideEffectsDeps,
  type CommandResultReportForType,
  type CommandResultSideEffectsResult,
  type HostDaemonCommandExecutionRecord,
  type HostDaemonCommandForType,
} from "../../internal/command-result-side-effects.js";
import { errorMessage } from "../lib/error-log-fields.js";
import { perDbRegistry } from "../lib/per-db-registry.js";
import {
  callHostOnlineRpc,
  isHostUnavailableApiError,
} from "../hosts/online-rpc.js";
import { ApiError } from "../../errors.js";

type Deps = ThreadProvisioningDeps;

export interface ProviderOperationContext {
  thread: ThreadResponse;
  project: Project;
  host: Host;
  machine: EnvironmentMachineSelection;
  projectCheckout: { path: string; experimental_ownsPath: boolean } | null;
  gitRemote: string | null;
  inputs: JsonValue | null;
  suggestedBranchName: string;
  environment: Environment | null;
}

interface ActiveOperation {
  kind: "create" | "attach" | "remove";
  controller: AbortController;
  done: Promise<void>;
  cancellation: Promise<void> | null;
}

const resourceSchema = jsonValueSchema.refine(
  (value) => Buffer.byteLength(JSON.stringify(value)) <= 16_384,
  "Resource exceeds 16 KiB",
);
const createResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("created"),
    path: z.string().min(1),
    ownsPath: z.boolean().default(false),
    mergeBaseBranch: z.string().min(1).nullable().optional(),
    resource: resourceSchema.optional(),
  }),
  z.object({
    status: z.literal("failed"),
    message: z.string().min(1),
  }),
]);
const removeResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("removed") }),
  z.object({ status: z.literal("failed"), message: z.string().min(1) }),
]);
const environmentOperations = new WeakMap<
  object,
  Map<string, ActiveOperation>
>();

async function writeEnvironment(
  deps: Pick<Deps, "db" | "hub">,
  environmentId: string,
  change: Partial<EnvironmentRow>,
): Promise<void> {
  await deps.db
    .update(environments)
    .set({ ...change, updatedAt: Date.now() })
    .where(eq(environments.id, environmentId))
    .run();
  await deps.hub.notifyEnvironment(environmentId, ["metadata-changed"]);
}

async function mutateProvisioning(
  deps: Deps,
  provisioning: EnvironmentRow,
  phases: EnvironmentRow["status"][],
  change: (row: EnvironmentRow) => void,
): Promise<boolean> {
  const row = await getEnvironment(deps.db, provisioning.id);
  if (
    row === null ||
    row.attempt !== provisioning.attempt ||
    row.ownerThreadId !== provisioning.ownerThreadId ||
    !phases.includes(row.status)
  )
    return false;
  const before = JSON.stringify(row);
  const expectedStatus = row.status;
  change(row);
  if (JSON.stringify(row) === before) return false;
  const updated = await updatePreparingEnvironment(
    deps.db,
    row,
    expectedStatus,
  );
  if (updated) await deps.hub.notifyEnvironment(row.id, ["metadata-changed"]);
  return updated;
}

function provisioningReporter(
  deps: Deps,
  provisioning: EnvironmentRow,
): PluginEnvironmentProviderProgress {
  const report = async (
    change: (row: EnvironmentRow) => void,
    step: string | null,
  ) => {
    const before = await getEnvironment(deps.db, provisioning.id);
    if (!(await mutateProvisioning(deps, provisioning, ["creating"], change)))
      return;
    const owner = provisioning.ownerThreadId;
    if (owner === null) return;
    const context = await getThreadProvisionContext(deps.db, owner);
    if (context !== null)
      await deps.db.transaction(async (tx) => {
        const row = await getEnvironment(tx, provisioning.id);
        if (
          row === null ||
          row.status !== "creating" ||
          row.teardownStatus !== null ||
          (await getThread(tx, owner))?.status !== "starting"
        )
          return;
        const entries: ProvisioningTranscriptEntry[] = [];
        const key = (text: string) => `provider-step-${row.attempt}-${text}`;
        if (step !== null) {
          if (before?.statusMessage)
            entries.push({
              type: "step",
              key: key(before.statusMessage),
              text: before.statusMessage,
              status: "completed",
            });
          entries.push({
            type: "step",
            key: key(step),
            text: step,
            status: "started",
          });
        }
        if (row.pendingLog !== "")
          entries.push({
            type: "output",
            key: `provider-output-${row.attempt}-${Date.now()}`,
            text: row.pendingLog,
          });
        if (entries.length > 0)
          await appendThreadProvisioningEventInTransaction(tx, {
            threadId: owner,
            environmentId: row.id,
            provisioningId: context.state.provisioningId,
            status: "active",
            entries,
          });
        await tx
          .update(environments)
          .set({ pendingLog: "" })
          .where(eq(environments.id, row.id))
          .run();
        await deps.hub.notifyThread(owner, ["events-appended"], {
          timelineSequence: await getLatestThreadSequence(deps.db, {
            threadId: owner,
          }),
          eventTypes: ["system/thread-provisioning"],
        });
      });
    requestEnvironmentProvisioningRecheck(owner);
  };
  return {
    step: async (text) =>
      await report(
        (row) => {
          row.statusMessage = text.slice(0, 200);
        },
        text.slice(0, 200),
      ),
    log: async (text) =>
      await report((row) => {
        row.pendingLog = (row.pendingLog + text).slice(-16_384);
      }, null),
  };
}

function emptyReporter(): PluginEnvironmentProviderProgress {
  return { step: () => undefined, log: () => undefined };
}

async function runTrackedOperation(args: {
  kind: ActiveOperation["kind"];
  map: Map<string, ActiveOperation>;
  key: string;
  run: (signal: AbortSignal) => Promise<void>;
}): Promise<ActiveOperation> {
  const existing = args.map.get(args.key);
  if (existing !== undefined) return existing;
  const controller = new AbortController();
  const operation: ActiveOperation = {
    kind: args.kind,
    controller,
    done: Promise.resolve(),
    cancellation: null,
  };
  operation.done = args.run(controller.signal).finally(async () => {
    await operation.cancellation;
    if (args.map.get(args.key) === operation) args.map.delete(args.key);
  });
  args.map.set(args.key, operation);
  return operation;
}

const REMOVE_RETRY_MS = 60_000;
const MAX_REMOVE_ATTEMPTS = 5;
const PROVIDER_OWNER_MISMATCH_MESSAGE =
  "The environment provider belongs to a different plugin or has no recorded owner. Automatic removal is blocked.";
const PROVIDER_LIFECYCLE_SWEEP_YIELD_INTERVAL = 25;

const RETIRED_CREATE_CONTEXT_FIELDS = { rebuild: false, previous: null };

async function invokeCreate(
  record: PluginEnvironmentProviderRecord,
  context: PluginEnvironmentProviderCreateContext,
): Promise<PluginEnvironmentProviderCreateResult> {
  const invocation = await invokeEnvironmentProvider(
    record,
    "environment create",
    () =>
      record.provider.create({ ...RETIRED_CREATE_CONTEXT_FIELDS, ...context }),
  );
  if (!invocation.ok) throw new Error(invocation.error);
  if (invocation.value === null)
    throw new Error("The environment provider became unavailable.");
  return createResultSchema.parse(invocation.value);
}

async function invokeRestore(
  record: PluginEnvironmentProviderRecord,
  context: PluginEnvironmentProviderRestoreContext,
): Promise<PluginEnvironmentProviderCreateResult> {
  const restore = record.provider.restore;
  if (restore === null) {
    return {
      status: "failed",
      message: `The "${record.provider.displayName}" environment provider cannot restore a removed environment.`,
    };
  }
  const invocation = await invokeEnvironmentProvider(
    record,
    "environment restore",
    () => restore(context),
  );
  if (!invocation.ok) throw new Error(invocation.error);
  if (invocation.value === null)
    throw new Error("The environment provider became unavailable.");
  return createResultSchema.parse(invocation.value);
}

async function runCreate(
  deps: Deps,
  record: PluginEnvironmentProviderRecord,
  provisioning: EnvironmentRow,
  context: ProviderOperationContext,
  outerSignal: AbortSignal,
): Promise<void> {
  const signal = outerSignal;
  let changed = false;
  await mutateProvisioning(deps, provisioning, ["creating"], (row) => {
    row.hostId = context.host.id;
  });
  try {
    const previous =
      context.environment === null
        ? null
        : await getEnvironment(deps.db, context.environment.id);
    const operation = {
      thread: context.thread,
      project: context.project,
      host: context.host,
      projectCheckout: context.projectCheckout,
      gitRemote: context.gitRemote,
      inputs: context.inputs,
      pathKey: provisioning.environmentProviderInstanceKey ?? provisioning.id,
      attempt: provisioning.attempt,
      experimental_claimPath: async (value: string) => {
        const path = z
          .string()
          .min(1)
          .refine(isAbsoluteHostPath)
          .refine((path) => !path.includes("\0"))
          .parse(value);
        if (signal.aborted) return false;
        const normalizedPath = canonicalizeHostPath(path);
        if (
          (await findBlockingEnvironmentPathClaim(deps, {
            hostId: context.host.id,
            path: normalizedPath,
            owner: provisioning,
          })) !== null
        )
          return false;
        return await claimEnvironmentPath(
          deps.db,
          provisioning,
          normalizedPath,
        );
      },
      report: provisioningReporter(deps, provisioning),
      signal: signal,
    };
    let result =
      provisioning.providerOwnsPath && provisioning.path !== null
        ? {
            status: "created" as const,
            path: provisioning.path,
            ownsPath: true,
            mergeBaseBranch: provisioning.mergeBaseBranch ?? undefined,
            resource: provisioning.resource ?? undefined,
          }
        : previous?.status === "destroyed"
          ? await invokeRestore(record, {
              ...operation,
              previous: {
                environment: await toEnvironmentResponse(deps.db, previous),
                resource:
                  previous.teardownStatus === "removed"
                    ? null
                    : previous.resource,
              },
            })
          : await invokeCreate(record, {
              ...operation,
              suggestedBranchName: context.suggestedBranchName,
            });
    if (result.status === "created") {
      let adoptedExistingEnvironment = false;
      let existingProviderOwnsLifecycle = false;
      try {
        const producedPath = canonicalizeHostPath(result.path);
        await ensureHostSessionReadyForWork(deps, {
          hostId: context.host.id,
        });
        await findBlockingEnvironmentPathClaim(deps, {
          hostId: context.host.id,
          path: producedPath,
          owner: provisioning,
        });
        await deps.db.transaction(
          async () => {
            const refusal = await foreignProjectOwnedPathRefusal(deps.db, {
              hostId: context.host.id,
              path: producedPath,
              projectId: context.project.id,
            });
            if (refusal !== null) throw new Error(refusal);
            const claimed = await claimEnvironmentPath(
              deps.db,
              provisioning,
              producedPath,
              true,
            );
            if (!claimed)
              throw new Error(
                "Workspace path is already claimed by another provisioning.",
              );
            const existing = await findProjectEnvironmentByHostPath(
              deps.db,
              context.project.id,
              context.host.id,
              producedPath,
            );
            if (
              existing !== null &&
              existing.environmentProviderId !== null &&
              (existing.environmentProviderId !== record.provider.id ||
                existing.environmentProviderPluginId !== record.pluginId)
            ) {
              throw new Error(
                `Workspace ${producedPath} is owned by the "${existing.environmentProviderId}" environment provider (plugin "${existing.environmentProviderPluginId ?? "unknown"}").`,
              );
            }
            existingProviderOwnsLifecycle =
              existing?.environmentProviderId != null;
            const reservedId = provisioning.id;
            provisioning = await bindEnvironmentPath(
              deps.db,
              provisioning,
              producedPath,
            );
            adoptedExistingEnvironment = provisioning.id !== reservedId;
          },
          { behavior: "immediate" },
        );
        result = { ...result, path: producedPath };
      } catch (error) {
        await mutateProvisioning(
          deps,
          provisioning,
          ["creating", "ready", "error"],
          (row) => {
            row.teardownStatus = "removed";
            row.claimPath = null;
            row.path = null;
            row.resource = null;
          },
        );
        throw error;
      }
      const produced = result;
      await mutateProvisioning(
        deps,
        provisioning,
        ["creating", "ready", "error"],
        (row) => {
          row.hostId = context.host.id;
          row.path = produced.path;
          if (!adoptedExistingEnvironment) {
            row.providerOwnsPath = produced.ownsPath;
          }
          if (!adoptedExistingEnvironment || !existingProviderOwnsLifecycle) {
            row.mergeBaseBranch = produced.mergeBaseBranch ?? null;
            row.resource = produced.resource ?? null;
          } else if (produced.mergeBaseBranch !== undefined) {
            row.mergeBaseBranch = produced.mergeBaseBranch;
          }
        },
      );
      signal.throwIfAborted();
    }
    changed = await mutateProvisioning(
      deps,
      provisioning,
      ["creating", "ready"],
      (row) => {
        if (result.status === "created") {
          row.status = row.status === "ready" ? "ready" : "provisioning";
        } else {
          row.status = "error";
          row.statusMessage = result.message;
        }
      },
    );
  } catch (error) {
    const current = await getEnvironment(deps.db, provisioning.id);
    if (
      signal.aborted &&
      current?.attempt === provisioning.attempt &&
      current.teardownStatus === "running"
    )
      return;
    changed = await mutateProvisioning(
      deps,
      provisioning,
      ["creating"],
      (row) => {
        row.status = "error";
        row.statusMessage = `The "${record.provider.id}" environment provider (plugin "${record.pluginId}") failed: ${errorMessage(error)}`;
      },
    );
  } finally {
    if (
      changed ||
      (await getPreparingEnvironment(deps.db, context.thread.id))?.status ===
        "ready"
    ) {
      const row = await getPreparingEnvironment(deps.db, context.thread.id);
      const startup = await getThreadProvisionContext(
        deps.db,
        context.thread.id,
      );
      if (
        row !== null &&
        startup !== null &&
        (row.status === "ready" || row.status === "provisioning")
      ) {
        await appendThreadProvisioningEvent(deps, {
          threadId: context.thread.id,
          environmentId: row.id,
          provisioningId: startup.state.provisioningId,
          status: "active",
          entries: [
            {
              type: "step",
              key: `provider-step-${row.attempt}-${row.statusMessage}`,
              text: row.statusMessage ?? "Creating environment",
              status: "completed",
            },
          ],
        });
        await deps.hub.notifyThread(context.thread.id, ["events-appended"], {
          timelineSequence: await getLatestThreadSequence(deps.db, {
            threadId: context.thread.id,
          }),
          eventTypes: ["system/thread-provisioning"],
        });
      }
      requestEnvironmentProvisioningRecheck(context.thread.id);
    }
  }
}

export async function markProviderEnvironmentAttached(
  db: DbConnection | DbTransaction,
  threadId: string,
  environmentId: string,
): Promise<void> {
  const row = await getPreparingEnvironment(db, threadId);
  if (row === null || (row.status !== "provisioning" && row.status !== "ready"))
    return;
  if (row.id !== environmentId)
    throw new Error("Provisioning must attach its reserved environment");
  await db
    .update(environments)
    .set({
      ownerThreadId: null,
      claimPath: null,
      retireAt: null,
    })
    .where(eq(environments.id, row.id))
    .run();
}

export async function cancelProviderEnvironmentCreation(
  deps: Deps,
  threadId: string,
): Promise<void> {
  const row = await getPreparingEnvironment(deps.db, threadId);
  if (row === null) return;
  if (row.teardownStatus === "removed") {
    if (row.status !== "destroyed")
      await writeEnvironment(deps, row.id, { status: "destroyed" });
    return;
  }
  if (row.teardownStatus === null) {
    await updatePreparingEnvironment(deps.db, {
      ...row,
      teardownStatus: "running",
      retireAt: Date.now(),
    });
  }
  await sweepProviderEnvironment(deps, row.id);
  let current = await getPreparingEnvironment(deps.db, threadId);
  if (current !== null && current.id !== row.id) {
    await sweepProviderEnvironment(deps, current.id);
    current = await getPreparingEnvironment(deps.db, threadId);
  }
  if (current !== null && current.teardownStatus !== "removed")
    throw new Error(
      current.teardownMessage ?? "Environment cleanup could not complete",
    );
}

export async function requestEnvironmentRemoval(
  deps: Deps,
  environmentId: string,
): Promise<boolean> {
  const row = await getEnvironment(deps.db, environmentId);
  if (row === null) return false;
  const removingMachine =
    (await getHost(deps.db, row.hostId))?.phase === "removing";
  if (
    !removingMachine &&
    (await environmentHasLiveThreads(deps.db, environmentId))
  )
    return false;
  if (row.ownerThreadId !== null && row.teardownStatus === null) {
    const owner = await getThread(deps.db, row.ownerThreadId);
    if (
      !removingMachine &&
      owner !== null &&
      owner.status === "starting" &&
      owner.archivedAt === null &&
      owner.deletedAt === null
    )
      return false;
    await updatePreparingEnvironment(deps.db, {
      ...row,
      teardownStatus: "running",
      retireAt: Date.now(),
    });
  }
  if (row.status === "destroyed") return true;
  if (row.environmentProviderId === null) {
    return (
      await applyLoggedEnvironmentLifecycleEvent(deps, {
        environmentId,
        event: { type: "destroy.recorded" },
      })
    ).applied;
  }
  if (row.teardownStatus === null) {
    await deps.db
      .update(environments)
      .set({
        retireAt: Date.now(),
        teardownStatus: "running",
      })
      .where(eq(environments.id, environmentId))
      .run();
    await deps.hub.notifyEnvironment(environmentId, ["metadata-changed"]);
  }
  return true;
}

async function runRemove(
  deps: Deps,
  environmentId: string,
  attempt: number,
  resumeOnly: boolean,
  signal: AbortSignal,
): Promise<void> {
  const row = await getEnvironment(deps.db, environmentId);
  if (
    row === null ||
    row.environmentProviderId === null ||
    row.teardownStatus !== "running"
  )
    return;
  const record = getEnvironmentProvider(row.environmentProviderId);
  if (
    record === undefined ||
    record.pluginId !== row.environmentProviderPluginId
  )
    throw new Error(
      `Environment provider "${row.environmentProviderId}" is unavailable or belongs to another plugin`,
    );
  await withHostCleanup(deps, row.hostId, async () => {
    try {
      if (row.providerOwnsPath && row.hostId !== null && row.path !== null) {
        await runEnvironmentHook(deps, {
          projectId: row.projectId,
          id: `environment:${environmentId}:${row.environmentProviderInstanceKey}:teardown`,
          hostId: row.hostId,
          path: row.path,
          kind: "teardown",
          resumeOnly,
          report: {
            step: () => undefined,
            log: (text) =>
              deps.logger.warn(
                { environmentId, text },
                "Environment teardown hook",
              ),
          },
          signal,
        });
      }
      const invocation = await invokeEnvironmentProvider(
        record,
        "environment remove",
        async () =>
          record.provider.remove({
            environment:
              row.ownerThreadId !== null
                ? null
                : await toEnvironmentResponse(deps.db, row),
            hostId: row.hostId,
            path: row.path,
            pathKey: row.environmentProviderInstanceKey ?? row.id,
            resource: row.resource,
            attempt,
            report: emptyReporter(),
            signal,
          }),
      );
      if (!invocation.ok) throw new Error(invocation.error);
      if (invocation.value === null)
        throw new Error("The environment provider became unavailable.");
      const result = removeResultSchema.parse(invocation.value);
      if (result.status === "failed") {
        await writeEnvironmentTeardownFailure(
          deps,
          environmentId,
          result.message,
        );
        return;
      }
      await deps.db.transaction(async () => {
        await writeEnvironment(deps, environmentId, {
          teardownStatus: "removed",
          teardownMessage: null,
          claimPath: null,
          resource: null,
          retireAt: null,
        });
        await applyLoggedEnvironmentLifecycleEvent(deps, {
          environmentId,
          event: { type: "destroy.recorded" },
        });
      });
      emitPluginEnvironmentRemoved({
        environmentId,
        removedAt: Date.now(),
        hostId: row.hostId,
        path: row.path,
        providerOwnedPath: row.providerOwnsPath,
      });
    } catch (error) {
      await writeEnvironmentTeardownFailure(
        deps,
        environmentId,
        errorMessage(error),
      );
    }
  });
}

async function writeEnvironmentTeardownFailure(
  deps: Pick<Deps, "db" | "hub">,
  environmentId: string,
  message: string,
): Promise<void> {
  const row = await getEnvironment(deps.db, environmentId);
  if (row === null) return;
  const exhausted = row.teardownAttempt >= MAX_REMOVE_ATTEMPTS;
  const written = await deps.db
    .update(environments)
    .set({
      teardownStatus: "failed",
      teardownMessage: exhausted
        ? `Needs recovery: ${message} Inspect the workspace, then run hyperfide environment cleanup ${environmentId} --recover.`
        : message,
      retireAt: exhausted
        ? null
        : Date.now() +
          REMOVE_RETRY_MS * 2 ** Math.max(0, row.teardownAttempt - 1),
      updatedAt: Date.now(),
    })
    .where(
      and(
        eq(environments.id, environmentId),
        or(
          isNull(environments.teardownStatus),
          ne(environments.teardownStatus, "removed"),
        ),
      ),
    )
    .returning({ id: environments.id })
    .all();
  if (written.length > 0)
    await deps.hub.notifyEnvironment(environmentId, ["metadata-changed"]);
}

async function removeEnvironment(
  deps: Deps,
  environmentId: string,
): Promise<void> {
  const map = perDbRegistry(environmentOperations, deps.db);
  const active = map.get(environmentId);
  if (active !== undefined) {
    const row = await getEnvironment(deps.db, environmentId);
    if (active.kind === "create" && row?.teardownStatus === "running")
      active.controller.abort();
    await active.done;
    if (active.kind === "remove") return;
  }
  const operation = await runTrackedOperation({
    kind: "remove",
    map,
    key: environmentId,
    run: async (signal) => {
      const row = await getEnvironment(deps.db, environmentId);
      return row === null
        ? Promise.resolve()
        : await withEnvironmentCleanupSlot(
            deps.db,
            row.hostId,
            async () =>
              await sweepProviderEnvironmentInSlot(deps, environmentId, signal),
          );
    },
  });
  await operation.done;
}

async function sweepProviderEnvironmentInSlot(
  deps: Deps,
  environmentId: string,
  signal: AbortSignal,
): Promise<void> {
  let row = await getEnvironment(deps.db, environmentId);
  if (
    row === null ||
    row.environmentProviderId === null ||
    row.teardownStatus === "removed"
  )
    return;
  const environmentProviderId = row.environmentProviderId;
  const machineRemoving =
    (await getHost(deps.db, row.hostId))?.phase === "removing";
  const shared =
    !machineRemoving &&
    (await environmentHasLiveThreads(deps.db, environmentId));
  if (
    !machineRemoving &&
    row.ownerThreadId !== null &&
    row.teardownStatus !== null &&
    (shared || (row.status === "ready" && row.path !== null))
  ) {
    const released = {
      ownerThreadId: null,
      claimPath: null,
      retireAt: null,
      teardownStatus: null,
    };
    await writeEnvironment(deps, environmentId, released);
    row = { ...row, ...released };
  }
  const cancelled = row.ownerThreadId !== null && row.teardownStatus !== null;
  if (!cancelled && row.ownerThreadId !== null) return;
  const record = getEnvironmentProvider(environmentProviderId);
  if (record === undefined) return;
  const now = Date.now();
  if (shared) {
    if (row.retireAt !== null && row.teardownStatus === null)
      await writeEnvironment(deps, environmentId, { retireAt: null });
    return;
  }
  if (record.pluginId !== row.environmentProviderPluginId) {
    if (row.teardownMessage !== PROVIDER_OWNER_MISMATCH_MESSAGE)
      await writeEnvironment(deps, environmentId, {
        teardownStatus: "failed",
        teardownMessage: PROVIDER_OWNER_MISMATCH_MESSAGE,
      });
    return;
  }
  if (row.teardownAttempt >= MAX_REMOVE_ATTEMPTS) {
    if (
      row.retireAt !== null ||
      !row.teardownMessage?.startsWith("Needs recovery:")
    )
      await writeEnvironmentTeardownFailure(
        deps,
        environmentId,
        row.teardownMessage ?? "Cleanup did not complete.",
      );
    return;
  }
  if (row.retireAt === null) {
    if (
      !cancelled &&
      record.provider.policy.retireGraceMs === null &&
      row.status !== "destroyed"
    )
      return;
    const retireAt =
      row.status === "destroyed" || cancelled
        ? now
        : now + (record.provider.policy.retireGraceMs ?? 0);
    await writeEnvironment(deps, environmentId, { retireAt });
    row = { ...row, retireAt };
  }
  if (row.retireAt !== null && row.retireAt > now) return;
  if (!(await requestEnvironmentRemoval(deps, environmentId))) return;
  row = await getEnvironment(deps.db, environmentId);
  if (row === null || row.teardownStatus === "removed") return;
  if (
    row.teardownStatus === "failed" &&
    row.retireAt !== null &&
    row.retireAt > now
  )
    return;
  const attempt =
    row.teardownStatus === "running" && row.teardownAttempt > 0
      ? row.teardownAttempt
      : row.teardownAttempt + 1;
  await writeEnvironment(deps, environmentId, {
    status: row.status === "destroyed" ? "destroyed" : "error",
    teardownStatus: "running",
    teardownAttempt: attempt,
    teardownMessage: null,
  });
  try {
    const setupOperation = await deps.db
      .select({ finishedAt: environmentHookOperations.finishedAt })
      .from(environmentHookOperations)
      .where(
        eq(
          environmentHookOperations.id,
          `environment:${row.id}:${row.environmentProviderInstanceKey}:setup`,
        ),
      )
      .get();
    const setupUnresolved =
      (setupOperation !== undefined && setupOperation.finishedAt === null) ||
      cancelled ||
      ((row.status === "provisioning" || row.status === "error") &&
        (await deps.db
          .select({ id: environmentHookOperations.id })
          .from(environmentHookOperations)
          .where(
            eq(
              environmentHookOperations.id,
              `environment:${row.id}:${row.environmentProviderInstanceKey}:teardown`,
            ),
          )
          .get()) === undefined);
    if (setupUnresolved && row.providerOwnsPath && row.path !== null) {
      await cancelPendingEnvironmentHook(deps, {
        id: `environment:${row.id}:${row.environmentProviderInstanceKey}:setup`,
        hostId: row.hostId,
      });
    }
    await runRemove(
      deps,
      environmentId,
      attempt,
      row.teardownAttempt > 0,
      signal,
    );
  } catch (error) {
    await writeEnvironmentTeardownFailure(
      deps,
      environmentId,
      errorMessage(error),
    );
  }
}

export async function cleanupEnvironment(
  deps: Deps,
  environmentId: string,
): Promise<boolean> {
  const row = await getEnvironment(deps.db, environmentId);
  if (
    row === null ||
    row.environmentProviderId === null ||
    !row.providerOwnsPath ||
    (await environmentHasLiveThreads(deps.db, environmentId))
  )
    return false;
  if (row.teardownStatus === "removed") return true;
  if (row.teardownAttempt >= MAX_REMOVE_ATTEMPTS)
    throw new ApiError(
      409,
      "invalid_request",
      `Needs recovery. Inspect the workspace, then run hyperfide environment cleanup ${environmentId} --recover.`,
    );
  await writeEnvironment(deps, environmentId, { retireAt: Date.now() });
  void sweepProviderEnvironment(deps, environmentId).catch((error) => {
    deps.logger.warn(
      { environmentId, error: errorMessage(error) },
      "Environment removal will retry",
    );
  });
  return true;
}

export async function recoverEnvironmentCleanup(
  deps: Deps,
  environmentId: string,
): Promise<void> {
  const map = perDbRegistry(environmentOperations, deps.db);
  if (map.has(environmentId))
    throw new ApiError(
      409,
      "invalid_request",
      "Environment cleanup is still running",
    );
  await (
    await runTrackedOperation({
      kind: "remove",
      map,
      key: environmentId,
      run: async (signal) => {
        const row = await getEnvironment(deps.db, environmentId);
        if (
          row === null ||
          row.environmentProviderId === null ||
          row.teardownStatus !== "failed" ||
          (await environmentHasLiveThreads(deps.db, environmentId))
        )
          throw new ApiError(
            409,
            "invalid_request",
            "Recovery requires a failed, unused provider-managed environment",
          );
        const workspacePath = row.providerOwnsPath ? row.path : null;
        await withEnvironmentCleanupSlot(deps.db, row.hostId, async () => {
          if (workspacePath !== null) {
            const inspection = await callHostOnlineRpc(deps, {
              hostId: row.hostId,
              timeoutMs: 30_000,
              command: {
                type: "environment.inspect_cleanup",
                environmentId,
                path: workspacePath,
              },
            });
            if (
              !inspection.supported ||
              inspection.active ||
              inspection.pids.length > 0 ||
              inspection.unreadablePids.length > 0
            )
              throw new ApiError(
                409,
                "invalid_request",
                `Recovery refused: ${!inspection.supported ? "process inspection requires Linux" : inspection.active ? "setup or a hook is still running" : inspection.pids.length > 0 ? `workspace processes remain (${inspection.pids.join(", ")})` : `cannot inspect same-user processes (${inspection.unreadablePids.join(", ")})`}`,
              );
          }
          const current = await getEnvironment(deps.db, environmentId);
          if (
            current === null ||
            current.path !== row.path ||
            current.environmentProviderInstanceKey !==
              row.environmentProviderInstanceKey ||
            current.teardownStatus !== "failed" ||
            (await environmentHasLiveThreads(deps.db, environmentId))
          )
            throw new ApiError(
              409,
              "invalid_request",
              "Environment changed during recovery inspection; inspect it again",
            );
          await deps.db.transaction(async () => {
            if (workspacePath !== null)
              for (const kind of ["setup", "teardown"] as const) {
                const id = `environment:${row.id}:${row.environmentProviderInstanceKey}:${kind}`;
                const finishedAt = Date.now();
                if (
                  kind === "teardown" &&
                  (await deps.db
                    .select({ id: environmentHookOperations.id })
                    .from(environmentHookOperations)
                    .where(eq(environmentHookOperations.id, id))
                    .get()) === undefined
                )
                  continue;
                await deps.db
                  .insert(environmentHookOperations)
                  .values({
                    id,
                    operationId: id,
                    hostId: row.hostId,
                    path: workspacePath,
                    kind,
                    startedAt: finishedAt,
                    finishedAt,
                    error:
                      "Interrupted hook acknowledged by explicit cleanup recovery",
                  })
                  .onConflictDoUpdate({
                    target: environmentHookOperations.id,
                    set: {
                      finishedAt,
                      error:
                        "Interrupted hook acknowledged by explicit cleanup recovery",
                    },
                    setWhere: isNull(environmentHookOperations.finishedAt),
                  })
                  .run();
              }
            await writeEnvironment(deps, environmentId, {
              teardownAttempt: 0,
              retireAt: Date.now(),
              teardownMessage: null,
            });
          });
          await sweepProviderEnvironmentInSlot(deps, environmentId, signal);
        });
      },
    })
  ).done;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export async function sweepProviderLifecycles(deps: Deps): Promise<void> {
  const pending: Promise<void>[] = [];
  for (const record of listEnvironmentProviders()) {
    for (const row of await listProviderLifecycleEnvironments(
      deps.db,
      record.provider.id,
      {
        pluginId: record.pluginId,
        teardownMessage: PROVIDER_OWNER_MISMATCH_MESSAGE,
      },
    )) {
      pending.push(
        sweepProviderEnvironment(deps, row.id).catch((error) => {
          deps.logger.warn(
            { environmentId: row.id, error: errorMessage(error) },
            "Environment removal will retry",
          );
        }),
      );
      if (pending.length % PROVIDER_LIFECYCLE_SWEEP_YIELD_INTERVAL === 0)
        await yieldToEventLoop();
    }
    await yieldToEventLoop();
  }
  await Promise.all(pending);
  await releaseFinishedEnvironmentPreparationOwners(deps.db);
}

export async function providerEnvironmentHasPendingWork(
  db: DbConnection | DbTransaction,
  threadId: string,
): Promise<boolean> {
  const row = await getPreparingEnvironment(db, threadId);
  if (row === null) return false;
  return row.teardownStatus !== "removed";
}

export async function refreshProviderRetirement(
  deps: {
    db: DbConnection | DbTransaction;
    hub: Pick<Deps["hub"], "notifyEnvironment">;
  },
  environmentId: string,
): Promise<void> {
  const row = await getEnvironment(deps.db, environmentId);
  if (
    row === null ||
    row.environmentProviderId === null ||
    row.teardownStatus !== null
  )
    return;
  const provider = getEnvironmentProvider(row.environmentProviderId);
  if (provider === undefined) return;
  const grace = provider.provider.policy.retireGraceMs;
  const retireAt =
    grace === null || (await environmentHasLiveThreads(deps.db, environmentId))
      ? null
      : (row.retireAt ?? Date.now() + grace);
  if (row.retireAt === retireAt) return;
  await deps.db
    .update(environments)
    .set({ retireAt })
    .where(eq(environments.id, environmentId))
    .run();
  await deps.hub.notifyEnvironment(environmentId, ["metadata-changed"]);
}

type EnvironmentProvisionCommand =
  HostDaemonCommandForType<"environment.attach">;
type EnvironmentProvisionCommandResultReport =
  CommandResultReportForType<"environment.attach">;
type EnvironmentProvisionCancelCommand =
  HostDaemonCommandForType<"environment.attach.cancel">;
type EnvironmentProvisionCancelCommandResultReport =
  CommandResultReportForType<"environment.attach.cancel">;

interface EnvironmentProvisionReadDeps {
  db: DbQueryConnection;
}

interface EnvironmentProvisionWriteDeps extends EnvironmentProvisionReadDeps {
  db: DbConnection | DbTransaction;
  hub: DbNotifier;
}

interface EnvironmentProvisionTransactionDeps extends EnvironmentProvisionWriteDeps {
  db: DbTransaction;
  logger: AppDeps["logger"];
  pendingInteractions: AppDeps["pendingInteractions"];
}

interface AdvanceEnvironmentProvisioningArgs {
  removal?: boolean;
  threadId?: string;
  creation?: {
    record: PluginEnvironmentProviderRecord;
    context?: ProviderOperationContext;
  };
  environmentId: string | null | undefined;
  request?: EnvironmentProvisionRequest | null;
}

interface SettleEnvironmentProvisionCommandResultArgs {
  command: EnvironmentProvisionCommand;
  deps: EnvironmentProvisionTransactionDeps;
  execution: HostDaemonCommandExecutionRecord;
  report: EnvironmentProvisionCommandResultReport;
}

interface SettleEnvironmentProvisionCancelCommandResultArgs {
  command: EnvironmentProvisionCancelCommand;
  deps: EnvironmentProvisionTransactionDeps;
  execution: HostDaemonCommandExecutionRecord;
  report: EnvironmentProvisionCancelCommandResultReport;
}

interface FailEnvironmentProvisioningDurablyArgs {
  environmentId: string;
  failureEntry: ProvisioningTranscriptEntry;
  failureReason: string;
  provisioningId: string;
}

interface StartTrackedEnvironmentProvisionCommandArgs {
  environment: EnvironmentRow;
  request: EnvironmentProvisionRequest;
}

interface SettleEnvironmentProvisionOutcomeArgs extends SettleEnvironmentProvisionCommandResultArgs {
  headSha: string | null;
  initiatorStreamed: boolean;
  mergeBaseBranch: string | null;
}

interface InterruptUnrecoverableEnvironmentProvisioningArgs {
  environmentId: string;
  reason: string;
}

interface InterruptEnvironmentProvisioningForHostArgs {
  hostId: string;
  reason: string;
}

interface LiveEnvironmentThread {
  environmentId: string | null;
  id: string;
  status: ThreadStatus;
}

interface StopRequestedEnvironmentProvisionThread {
  id: string;
  status: ThreadStatus;
}

interface AppendThreadProvisioningEventToEnvironmentThreadsArgs {
  entries: ProvisioningTranscriptEntry[];
  environmentId: string;
  fallbackProvisioningId: string;
  status: SystemThreadProvisioningStatus;
  threads?: LiveEnvironmentThread[];
}

async function listLiveEnvironmentThreads(
  deps: EnvironmentProvisionReadDeps,
  environmentId: string,
): Promise<LiveEnvironmentThread[]> {
  return await deps.db
    .select({
      environmentId: threads.environmentId,
      id: threads.id,
      status: threads.status,
    })
    .from(threads)
    .where(
      and(eq(threads.environmentId, environmentId), isNull(threads.deletedAt)),
    )
    .all();
}

async function listStopRequestedEnvironmentProvisionThreads(
  deps: EnvironmentProvisionReadDeps,
  environmentId: string,
): Promise<StopRequestedEnvironmentProvisionThread[]> {
  return await deps.db
    .select({
      id: threads.id,
      status: threads.status,
    })
    .from(threads)
    .where(
      and(
        eq(threads.environmentId, environmentId),
        eq(threads.status, "stopping"),
        isNull(threads.archivedAt),
        isNull(threads.deletedAt),
      ),
    )
    .all();
}

async function resolveLiveThreadProvisioningId(
  deps: EnvironmentProvisionReadDeps,
  thread: LiveEnvironmentThread,
  fallbackProvisioningId: string,
): Promise<string> {
  const context = await getThreadProvisionContext(deps.db, thread.id);
  if (context?.state.environmentId === thread.environmentId) {
    return context.state.provisioningId;
  }
  return fallbackProvisioningId;
}

async function appendThreadProvisioningEventToEnvironmentThreadsInTransaction(
  deps: EnvironmentProvisionTransactionDeps,
  args: AppendThreadProvisioningEventToEnvironmentThreadsArgs,
): Promise<void> {
  const liveThreads =
    args.threads ??
    (await listLiveEnvironmentThreads(deps, args.environmentId));

  for (const thread of liveThreads) {
    const provisioningId = await resolveLiveThreadProvisioningId(
      deps,
      thread,
      args.fallbackProvisioningId,
    );
    await appendThreadProvisioningEventInTransaction(deps.db, {
      entries: args.entries,
      environmentId: args.environmentId,
      provisioningId,
      status: args.status,
      threadId: thread.id,
    });
    deps.hub.notifyThread(thread.id, ["events-appended"], {
      timelineSequence: await getLatestThreadSequence(deps.db, {
        threadId: thread.id,
      }),
      eventTypes: ["system/thread-provisioning"],
    });
  }
}

async function hasActiveThreadProvisioningContext(
  deps: EnvironmentProvisionReadDeps,
  thread: LiveEnvironmentThread,
): Promise<boolean> {
  const context = await getThreadProvisionContext(deps.db, thread.id);
  return context?.state.environmentId === thread.environmentId;
}

async function shouldPreserveThreadProvisionCancellationOutcome(
  deps: EnvironmentProvisionReadDeps,
  args: { provisioningId: string; thread: LiveEnvironmentThread },
): Promise<boolean> {
  if (args.thread.status === "stopping") return true;
  return (
    (await deps.db
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.threadId, args.thread.id),
          eq(events.type, "system/thread-provisioning"),
          sql`json_extract(${events.data}, '$.status') = 'cancelled'`,
          or(
            sql`json_extract(${events.data}, '$.provisioningId') = ${args.provisioningId}`,
            sql`${events.sequence} = (select max(last.sequence) from events last where last.thread_id = ${args.thread.id} and last.environment_id = ${args.thread.environmentId} and last.type = 'system/thread-provisioning')`,
          ),
        ),
      )
      .limit(1)
      .get()) !== undefined
  );
}

async function recordEnvironmentProvisioningFailureInTransaction(
  deps: EnvironmentProvisionTransactionDeps,
  args: FailEnvironmentProvisioningDurablyArgs,
): Promise<string[]> {
  const environment = await getEnvironment(deps.db, args.environmentId);
  if (!environment) {
    return [];
  }
  const liveThreads = await listLiveEnvironmentThreads(deps, environment.id);
  const failureThreads = (
    await Promise.all(
      liveThreads.map(async (value, index, array) =>
        (await (async (thread) =>
          !(await shouldPreserveThreadProvisionCancellationOutcome(deps, {
            provisioningId: args.provisioningId,
            thread,
          })))(value))
          ? [value]
          : [],
      ),
    )
  ).flat();
  if (failureThreads.length === 0 && liveThreads.length > 0) {
    if (environment.status === "destroyed") return [];
    const outcome = await applyLoggedEnvironmentLifecycleEventInTransaction(
      deps,
      {
        environmentId: environment.id,
        event: { type: "provision.cancelled" },
      },
    );
    if (outcome.applied)
      deps.hub.notifyEnvironment(environment.id, outcome.changes);
    return [];
  }

  const failureOutcome =
    await applyLoggedEnvironmentLifecycleEventInTransaction(deps, {
      environmentId: environment.id,
      event: { type: "provision.failed" },
    });
  if (failureOutcome.applied) {
    deps.hub.notifyEnvironment(environment.id, failureOutcome.changes);
  }

  await appendThreadProvisioningEventToEnvironmentThreadsInTransaction(deps, {
    environmentId: environment.id,
    fallbackProvisioningId: args.provisioningId,
    status: "failed",
    threads: failureThreads,
    entries: [args.failureEntry],
  });

  const failedThreadIds: string[] = [];
  for (const thread of failureThreads) {
    clearThreadProvisionSchedule(thread.id);
    await appendSystemErrorEventInTransaction(deps, {
      threadId: thread.id,
      environmentId: environment.id,
      code: "thread_provisioning_failed",
      message: "Provisioning thread failed",
      detail: args.failureReason,
      scope: threadScope(),
    });
    const outcome = await applyLoggedThreadLifecycleEventInTransaction(deps, {
      event: { type: "run.failed" },
      threadId: thread.id,
    });
    if (outcome.applied) {
      deps.hub.notifyThread(thread.id, ["status-changed"]);
      failedThreadIds.push(thread.id);
    }
  }

  return failedThreadIds;
}

export async function settleEnvironmentProvisionCommandResult(
  args: SettleEnvironmentProvisionCommandResultArgs,
): Promise<CommandResultSideEffectsResult> {
  return await settleEnvironmentProvisionOutcome({
    ...args,
    headSha: null,
    initiatorStreamed: true,
    mergeBaseBranch:
      (await getEnvironment(args.deps.db, args.command.environmentId))
        ?.mergeBaseBranch ?? null,
  });
}

async function settleEnvironmentProvisionOutcome(
  args: SettleEnvironmentProvisionOutcomeArgs,
): Promise<CommandResultSideEffectsResult> {
  const postCommitActions: CommandResultPostCommitAction[] = [];
  const initiator = args.command.initiator;
  if (
    args.command.setupScriptTimeoutMs !== null &&
    (args.report.ok || args.report.errorCode === "setup_script_failed")
  ) {
    const environment = await getEnvironment(
      args.deps.db,
      args.command.environmentId,
    );
    if (environment !== null)
      await args.deps.db
        .update(environmentHookOperations)
        .set({
          finishedAt: Date.now(),
          error: args.report.ok ? null : args.report.errorMessage,
        })
        .where(
          eq(
            environmentHookOperations.id,
            `environment:${environment.id}:${environment.environmentProviderInstanceKey}:setup`,
          ),
        )
        .run();
  }
  if (!initiator && !args.report.ok) {
    const outcome = await applyLoggedEnvironmentLifecycleEventInTransaction(
      args.deps,
      {
        environmentId: args.command.environmentId,
        event: { type: "provision.failed" },
      },
    );
    if (outcome.applied) {
      args.deps.hub.notifyEnvironment(
        args.command.environmentId,
        outcome.changes,
      );
    }
    return emptyCommandResultSideEffects();
  }

  const boundThreads = await args.deps.db
    .select()
    .from(threads)
    .where(eq(threads.environmentId, args.command.environmentId))
    .all();

  if (args.report.ok) {
    await recordProvisionedEnvironmentWorkspace(
      args.deps.db,
      args.deps.hub,
      args.command.environmentId,
      {
        path: args.report.result.path,
        isGitRepo: args.report.result.isGitRepo,
        isWorktree: args.report.result.isWorktree,
        branchName: args.report.result.branchName,
        defaultBranch: args.report.result.defaultBranch,
        ...(args.mergeBaseBranch === null
          ? {}
          : { baseBranch: null, mergeBaseBranch: args.mergeBaseBranch }),
      },
    );
    const provisionedOutcome =
      await applyLoggedEnvironmentLifecycleEventInTransaction(args.deps, {
        environmentId: args.command.environmentId,
        event: { type: "provision.succeeded" },
      });
    if (provisionedOutcome.applied) {
      args.deps.hub.notifyEnvironment(
        args.command.environmentId,
        provisionedOutcome.changes,
      );
    }
    args.deps.hub.notifyEnvironment(args.command.environmentId, [
      "work-status-changed",
    ]);
    if (!initiator) {
      return emptyCommandResultSideEffects();
    }
    const environmentProvisioningId = initiator.provisioningId;

    const cwdBranchEntries = buildCwdBranchEntries({
      path: args.report.result.path,
      branchName: args.report.result.branchName,
      headSha: args.headSha,
    });

    for (const thread of boundThreads) {
      if (thread.deletedAt !== null) {
        await finalizeStoppedThreadInTransaction(args.deps, {
          threadId: thread.id,
        });
        continue;
      }
      if (
        thread.archivedAt !== null ||
        (await shouldPreserveThreadProvisionCancellationOutcome(args.deps, {
          provisioningId: environmentProvisioningId,
          thread,
        }))
      ) {
        continue;
      }

      const entries =
        thread.id === initiator.threadId && args.initiatorStreamed
          ? []
          : cwdBranchEntries;

      if (!(await hasActiveThreadProvisioningContext(args.deps, thread))) {
        await appendThreadProvisioningEventInTransaction(args.deps.db, {
          threadId: thread.id,
          environmentId: args.command.environmentId,
          provisioningId: environmentProvisioningId,
          status: thread.status === "starting" ? "active" : "completed",
          entries,
        });
        args.deps.hub.notifyThread(thread.id, ["events-appended"], {
          timelineSequence: await getLatestThreadSequence(args.deps.db, {
            threadId: thread.id,
          }),
          eventTypes: ["system/thread-provisioning"],
        });
        continue;
      }

      await ensureWorkspaceReadyEventInTransaction(args.deps, {
        threadId: thread.id,
        environmentId: args.command.environmentId,
        entries,
      });
      postCommitActions.push({
        run: async (deps) =>
          await advanceThreadProvisioning(deps, { threadId: thread.id }),
      });
    }

    return { postCommitActions };
  }

  if (!initiator) {
    return emptyCommandResultSideEffects();
  }
  const environmentProvisioningId = initiator.provisioningId;
  const failedThreadIds =
    await recordEnvironmentProvisioningFailureInTransaction(args.deps, {
      environmentId: args.command.environmentId,
      failureReason: args.report.errorMessage,
      provisioningId: environmentProvisioningId,
      failureEntry: {
        type: "step",
        key: "workspace-failed",
        text: "Workspace setup failed",
        status: "failed",
        startedAt: args.execution.createdAt,
        metadata: { durationMs: Date.now() - args.execution.createdAt },
      },
    });
  for (const threadId of failedThreadIds) {
    postCommitActions.push({
      run: async (deps) => {
        const thread = await getThread(deps.db, threadId);
        if (thread && thread.deletedAt === null)
          await queueChildSetupFailureNotification(deps, thread);
      },
    });
  }
  return { postCommitActions };
}

export async function settleEnvironmentProvisionCancelCommandResult(
  args: SettleEnvironmentProvisionCancelCommandResultArgs,
): Promise<CommandResultSideEffectsResult> {
  const stoppedThreads = await listStopRequestedEnvironmentProvisionThreads(
    args.deps,
    args.command.environmentId,
  );
  if (!args.report.ok) {
    const environment = await getEnvironment(
      args.deps.db,
      args.command.environmentId,
    );
    args.deps.logger.warn(
      {
        activeProvisionState:
          environment?.status === "provisioning" ? "provisioning" : null,
        executionId: args.execution.id,
        environmentId: args.command.environmentId,
        errorCode: args.report.errorCode,
        errorMessage: args.report.errorMessage,
        stoppedThreadCount: stoppedThreads.length,
        stoppedThreadIds: stoppedThreads.map((thread) => thread.id),
      },
      "Environment provision cancel command failed",
    );

    if (!environment || stoppedThreads.length === 0) {
      return emptyCommandResultSideEffects();
    }

    return {
      postCommitActions: [
        {
          run: async (deps) => {
            for (const thread of stoppedThreads) {
              await requestThreadStopForCurrentState(
                deps,
                {
                  environmentId: args.command.environmentId,
                  id: thread.id,
                  status: thread.status,
                },
                {
                  hostId: environment.hostId,
                  id: environment.id,
                },
              );
            }
          },
        },
      ],
    };
  }

  const postCommitActions: CommandResultPostCommitAction[] = [];
  const cancelledOutcome =
    await applyLoggedEnvironmentLifecycleEventInTransaction(args.deps, {
      environmentId: args.command.environmentId,
      event: { type: "provision.cancelled" },
    });
  if (cancelledOutcome.applied) {
    args.deps.hub.notifyEnvironment(
      args.command.environmentId,
      cancelledOutcome.changes,
    );
  }

  for (const thread of stoppedThreads) {
    await finalizeStoppedThreadInTransaction(args.deps, {
      threadId: thread.id,
    });
  }

  return { postCommitActions };
}

async function interruptUnrecoverableEnvironmentProvisioning(
  deps: CommandResultSideEffectsDeps,
  args: InterruptUnrecoverableEnvironmentProvisioningArgs,
): Promise<void> {
  const environment = await getEnvironment(deps.db, args.environmentId);
  if (!environment || environment.status !== "provisioning") {
    return;
  }

  const now = Date.now();
  const failedThreadIds = await deps.db.transaction(
    async (tx) => {
      return await recordEnvironmentProvisioningFailureInTransaction(
        {
          ...deps,
          db: tx,
        },
        {
          environmentId: environment.id,
          failureReason: args.reason,
          provisioningId: `env-${environment.id}-interrupted`,
          failureEntry: {
            type: "step",
            key: "workspace-failed",
            text: "Workspace setup interrupted",
            status: "failed",
            startedAt: now,
            metadata: { durationMs: 0 },
          },
        },
      );
    },
    { behavior: "immediate" },
  );
  for (const threadId of failedThreadIds) {
    const thread = await getThread(deps.db, threadId);
    if (thread && thread.deletedAt === null)
      await queueChildSetupFailureNotification(deps, thread);
  }
}

export async function interruptEnvironmentProvisioningForHost(
  deps: CommandResultSideEffectsDeps,
  args: InterruptEnvironmentProvisioningForHostArgs,
): Promise<void> {
  const environmentIds = await deps.db
    .select({ id: environments.id })
    .from(environments)
    .where(
      and(
        eq(environments.hostId, args.hostId),
        eq(environments.status, "provisioning"),
      ),
    )
    .all();
  for (const environment of environmentIds) {
    await interruptUnrecoverableEnvironmentProvisioning(deps, {
      environmentId: environment.id,
      reason: args.reason,
    });
  }
}

export async function resumeEnvironmentProvisioningForHost(
  deps: CommandResultSideEffectsDeps,
  args: { hostId: string },
): Promise<void> {
  const environmentIds = await deps.db
    .select({ id: environments.id })
    .from(environments)
    .where(
      and(
        eq(environments.hostId, args.hostId),
        eq(environments.status, "provisioning"),
      ),
    )
    .all();
  for (const environment of environmentIds) {
    await advanceEnvironmentProvisioning(deps, {
      environmentId: environment.id,
    });
  }
}

export async function runTrackedEnvironmentAttach(
  deps: CommandResultSideEffectsDeps,
  args: {
    hostId: string;
    command: EnvironmentProvisionRequest["command"];
    timeoutMs: number;
  },
): Promise<void> {
  const operation = await runTrackedOperation({
    kind: "attach",
    map: perDbRegistry(environmentOperations, deps.db),
    key: args.command.environmentId,
    run: async () => {
      await runLiveHostCommand(deps, args);
    },
  });
  await operation.done;
}

async function runEnvironmentProvisionCommand(
  deps: CommandResultSideEffectsDeps,
  args: StartTrackedEnvironmentProvisionCommandArgs,
): Promise<void> {
  if (args.request.command.setupScriptTimeoutMs !== null) {
    const environment = args.environment;
    const id = `environment:${environment.id}:${environment.environmentProviderInstanceKey}:setup`;
    const existing = await deps.db
      .select({ finishedAt: environmentHookOperations.finishedAt })
      .from(environmentHookOperations)
      .where(eq(environmentHookOperations.id, id))
      .get();
    if (existing !== undefined && existing.finishedAt === null) {
      await interruptUnrecoverableEnvironmentProvisioning(deps, {
        environmentId: environment.id,
        reason: `An earlier setup has an unknown outcome. Archive its threads, inspect the workspace, then run hyperfide environment cleanup ${environment.id} --recover.`,
      });
      return;
    }
    await deps.db
      .insert(environmentHookOperations)
      .values({
        id,
        operationId: id,
        hostId: environment.hostId,
        path: args.request.command.path,
        kind: "setup",
        startedAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: environmentHookOperations.id,
        set: { startedAt: Date.now(), finishedAt: null, error: null },
      })
      .run();
  }
  const execution = createLiveHostCommandExecution(args.environment.hostId);
  await runLiveHostCommand(deps, {
    command: args.request.command,
    execution,
    hostId: args.environment.hostId,
    preserveOnHostUnavailable: true,
    timeoutMs: LIVE_DAEMON_COMMAND_TIMEOUT_MS,
  }).catch((error) => {
    if (error instanceof Error && isHostUnavailableApiError(error)) {
      deps.logger.info(
        {
          commandType: args.request.command.type,
          environmentId: args.environment.id,
          executionId: execution.id,
          hostId: args.environment.hostId,
        },
        "Environment provisioning waiting for host reconnect",
      );
      return;
    }
    const expectedErrorFields =
      error instanceof Error
        ? expectedLiveHostCommandErrorLogFields(error)
        : null;
    if (expectedErrorFields !== null) {
      deps.logger.debug(
        {
          commandType: args.request.command.type,
          environmentId: args.environment.id,
          ...expectedErrorFields,
          executionId: execution.id,
          hostId: args.environment.hostId,
          initiatorThreadId: args.request.command.initiator?.threadId ?? null,
          provisioningId:
            args.request.command.initiator?.provisioningId ?? null,
        },
        "Live environment provisioning cancelled",
      );
      return;
    }
    deps.logger.warn(
      {
        commandType: args.request.command.type,
        err: error,
        environmentId: args.environment.id,
        executionId: execution.id,
        hostId: args.environment.hostId,
      },
      "Live environment provision command failed",
    );
  });
}

async function recoverEnvironmentProvisionRequest(
  deps: CommandResultSideEffectsDeps,
  environment: EnvironmentRow,
): Promise<EnvironmentProvisionRequest | null> {
  if (environment.path === null) return null;
  const owners = await deps.db
    .select({ id: threads.id })
    .from(threads)
    .where(
      and(
        eq(threads.environmentId, environment.id),
        eq(threads.status, "starting"),
        isNull(threads.archivedAt),
        isNull(threads.deletedAt),
      ),
    )
    .all();
  for (const owner of owners) {
    const context = await getThreadProvisionContext(deps.db, owner.id);
    if (context?.state.environmentId !== environment.id) continue;
    return {
      command: buildEnvironmentProvisionCommand({
        environmentId: environment.id,
        hostId: environment.hostId,
        initiator: {
          threadId: owner.id,
          provisioningId: context.state.provisioningId,
        },
        path: environment.path,
        setupScriptTimeoutMs: environment.providerOwnsPath
          ? ENVIRONMENT_HOOK_TIMEOUT_MS
          : null,
      }),
    };
  }
  return null;
}

const environmentAdvanceLocks = new WeakMap<
  object,
  Map<string, Promise<unknown>>
>();

export async function stopEnvironmentOperations(db: object): Promise<void> {
  for (;;) {
    const operations = [...(environmentOperations.get(db)?.values() ?? [])];
    const advances = [...(environmentAdvanceLocks.get(db)?.values() ?? [])];
    if (!operations.length && !advances.length) return;
    for (const operation of operations) operation.controller.abort();
    await Promise.allSettled([
      ...operations.map((operation) => operation.done),
      ...advances,
    ]);
  }
}

export async function advanceEnvironmentProvisioning(
  deps: CommandResultSideEffectsDeps,
  args: AdvanceEnvironmentProvisioningArgs,
): Promise<void> {
  if (!args.environmentId) return;
  let locks = environmentAdvanceLocks.get(deps.db);
  if (!locks) {
    locks = new Map();
    environmentAdvanceLocks.set(deps.db, locks);
  }
  const key = args.environmentId;
  const pending = (locks.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(() => advanceEnvironmentProvisioningOnce(deps, args));
  locks.set(key, pending);
  try {
    await pending;
  } finally {
    if (locks.get(key) === pending) locks.delete(key);
  }
}

async function advanceEnvironmentProvisioningOnce(
  deps: CommandResultSideEffectsDeps,
  args: AdvanceEnvironmentProvisioningArgs,
): Promise<void> {
  if (!args.environmentId) return;
  let environment = await getEnvironment(deps.db, args.environmentId);
  if (environment === null) return;
  const map = perDbRegistry(environmentOperations, deps.db);
  if (
    args.threadId !== undefined &&
    environment.ownerThreadId !== null &&
    environment.ownerThreadId !== args.threadId
  )
    await assertEnvironmentPathAvailable(deps, {
      ...environment,
      threadId: args.threadId,
    });
  if (
    args.removal ||
    (environment.teardownStatus !== null &&
      environment.teardownStatus !== "removed")
  ) {
    await removeEnvironment(deps, environment.id);
    return;
  }
  if (
    environment.status === "provisioning" &&
    (await listStopRequestedEnvironmentProvisionThreads(deps, environment.id))
      .length > 0 &&
    !(await listLiveEnvironmentThreads(deps, environment.id)).some(
      (thread) => thread.status === "starting",
    )
  ) {
    const row = environment;
    const cancel = async () =>
      runLiveHostCommand(deps, {
        command: { type: "environment.attach.cancel", environmentId: row.id },
        hostId: row.hostId,
        timeoutMs: LIVE_DAEMON_COMMAND_TIMEOUT_MS,
      })
        .then(() => {})
        .catch((error) =>
          deps.logger.warn(
            { environmentId: row.id, error },
            "Environment cancellation failed",
          ),
        );
    const active = map.get(row.id);
    if (active !== undefined) active.cancellation ??= cancel();
    else
      await runTrackedOperation({
        kind: "attach",
        map,
        key: row.id,
        run: cancel,
      });
    return;
  }
  if (environment.status === "destroyed") return;
  if (environment.status === "creating" && map.has(environment.id)) return;
  if (environment.status === "creating") {
    const owner =
      environment.ownerThreadId === null
        ? null
        : await getThread(deps.db, environment.ownerThreadId);
    const context =
      owner === null
        ? null
        : await getThreadProvisionContext(deps.db, owner.id);
    const record =
      args.creation?.record ??
      (environment.environmentProviderId === null
        ? undefined
        : getEnvironmentProvider(environment.environmentProviderId));
    if (record === undefined) return;
    const row = environment;
    const operation = await runTrackedOperation({
      kind: "create",
      map,
      key: row.id,
      run: async (signal) => {
        let creation: ProviderOperationContext | null;
        try {
          creation =
            args.creation?.context ??
            (owner !== null &&
            context?.request.environmentIntent.type === "provider"
              ? await resolveProviderOperationContext(
                  deps,
                  owner,
                  context.request.environmentIntent,
                  record,
                )
              : null);
        } catch (error) {
          await mutateProvisioning(deps, row, ["creating"], (current) => {
            current.status = "error";
            current.statusMessage = errorMessage(error);
          });
          if (row.ownerThreadId !== null)
            requestEnvironmentProvisioningRecheck(row.ownerThreadId);
          return;
        }
        if (creation === null) return;
        await runCreate(deps, record, row, creation, signal);
      },
    });
    void operation.done
      .then(async () => {
        const current =
          row.ownerThreadId === null
            ? null
            : await getPreparingEnvironment(deps.db, row.ownerThreadId);
        if (current !== null && current.status !== "creating")
          await advanceEnvironmentProvisioning(deps, {
            environmentId: current.id,
          });
      })
      .catch((error) =>
        deps.logger.warn(
          { environmentId: row.id, error },
          "Environment advancement failed",
        ),
      );
    return;
  }
  if (environment.status === "error") {
    if (
      environment.ownerThreadId !== null ||
      args.threadId === undefined ||
      (await getThread(deps.db, args.threadId))?.status !== "starting"
    )
      return;
    const outcome = await applyLoggedEnvironmentLifecycleEvent(deps, {
      environmentId: environment.id,
      event: { type: "provision.requested" },
    });
    if (!outcome.applied) return;
    await writeEnvironment(deps, environment.id, {
      attempt: environment.attempt + 1,
      statusMessage: "Retrying workspace setup",
    });
    environment = (await getEnvironment(deps.db, environment.id))!;
  }
  const threadId = environment.ownerThreadId ?? args.threadId;
  if (threadId !== undefined && threadId !== null) {
    const context = await getThreadProvisionContext(deps.db, threadId);
    if (context === null) return;
    const target = environment;
    const preparation =
      target.ownerThreadId === null
        ? await getPreparingEnvironment(deps.db, threadId)
        : target;
    const needsAttachment =
      target.ownerThreadId !== null ||
      preparation?.status === "provisioning" ||
      preparation?.status === "ready" ||
      context.state.environmentId !== target.id ||
      context.request.environmentIntent.type !== "reuse" ||
      context.request.environmentIntent.environmentId !== target.id ||
      (await getThread(deps.db, threadId))?.environmentId !== target.id;
    if (
      target.status === "ready" &&
      target.ownerThreadId !== null &&
      target.path !== null
    )
      await refreshAttachedEnvironmentBranch(deps, {
        environmentId: target.id,
        hostId: target.hostId,
        path: target.path,
      });
    await assertEnvironmentPathAvailable(deps, { ...target, threadId });
    if (needsAttachment) {
      await deps.db.transaction(
        async (tx) => {
          if (
            (await getThreadProvisionContext(tx, threadId))?.state
              .provisioningId !== context.state.provisioningId
          )
            return;
          await updateThread(tx, deps.hub, threadId, {
            environmentId: target.id,
          });
          await markProviderEnvironmentAttached(tx, threadId, target.id);
          context.request.environmentIntent = {
            type: "reuse",
            environmentId: target.id,
          };
          context.state.environmentId = target.id;
          await saveThreadProvisionContext({
            replace: false,
            db: tx,
            threadId,
            context,
          });
        },
        { behavior: "immediate" },
      );
      environment = await getEnvironment(deps.db, environment.id);
      if (environment === null || environment.ownerThreadId !== null) return;
    }
  }
  if (environment.status === "ready") {
    if (threadId != null && args.threadId === undefined)
      void advanceThreadProvisioning(deps, { threadId }).catch((error) =>
        deps.logger.warn(
          { threadId, error },
          "Thread provisioning advancement failed",
        ),
      );
    return;
  }
  if (
    environment.status !== "provisioning" ||
    map.has(environment.id) ||
    (await findHostDataDir(deps, environment.hostId)) === null
  )
    return;
  const request =
    args.request ??
    (await recoverEnvironmentProvisionRequest(deps, environment));
  if (request === null) {
    await interruptUnrecoverableEnvironmentProvisioning(deps, {
      environmentId: environment.id,
      reason:
        "Environment setup did not finish. Retry provisioning to continue.",
    });
    return;
  }
  const row = environment;
  await runTrackedOperation({
    kind: "attach",
    map,
    key: row.id,
    run: async () =>
      await runEnvironmentProvisionCommand(deps, { environment: row, request }),
  });
}

export async function forgetHostEnvironments(
  deps: Deps,
  hostId: string,
): Promise<void> {
  const map = perDbRegistry(environmentOperations, deps.db);
  const listRows = async () =>
    await deps.db
      .select({
        id: environments.id,
        path: environments.path,
        providerOwnsPath: environments.providerOwnsPath,
        status: environments.status,
        teardownStatus: environments.teardownStatus,
      })
      .from(environments)
      .where(eq(environments.hostId, hostId))
      .all();
  await Promise.all(
    (await listRows()).map((row) => map.get(row.id)?.done.catch(() => {})),
  );
  const pending = (await listRows()).filter(
    (row) => row.status !== "destroyed" || row.teardownStatus !== "removed",
  );
  await markHostEnvironmentsDestroyed(deps.db, deps.hub, hostId);
  const removedAt = Date.now();
  for (const row of pending) {
    emitPluginEnvironmentRemoved({
      environmentId: row.id,
      removedAt,
      hostId,
      path: row.path,
      providerOwnedPath: row.providerOwnsPath,
    });
  }
}

export async function sweepProviderEnvironment(
  deps: Deps,
  environmentId: string,
): Promise<void> {
  await advanceEnvironmentProvisioning(deps, { environmentId, removal: true });
}
