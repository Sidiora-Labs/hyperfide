import type {
  CommandDispatchOptions,
  CommandOf,
} from "../command-dispatch-support.js";
import { ExpectedCommandDispatchError } from "../command-dispatch-support.js";
import {
  LifecycleScriptTerminationUnverifiedError,
  runSetupScript,
  runTeardownScript,
} from "../environment-lifecycle-script.js";

import { inspectWorkspaceProcesses } from "../workspace-processes.js";

interface HookOutcome {
  active: boolean;
  terminationUnverified: boolean;
}

interface HookOperation {
  controller: AbortController;
  done: Promise<Record<string, never>>;
  outcome: HookOutcome;
  path: string;
  kind: "setup" | "teardown";
  expiry: ReturnType<typeof setTimeout> | null;
}
const ENVIRONMENT_HOOK_REGISTRY_TTL_MS = 5 * 60 * 1000;
const operations = new WeakMap<
  object,
  Map<string, HookOperation | "cancelled">
>();

function controllers(
  options: CommandDispatchOptions,
): Map<string, HookOperation | "cancelled"> {
  let active = operations.get(options.runtimeManager);
  if (active === undefined) {
    active = new Map();
    operations.set(options.runtimeManager, active);
  }
  return active;
}

function scheduleOperationExpiry(
  options: CommandDispatchOptions,
  operationId: string,
  operation: HookOperation,
): void {
  operation.expiry = setTimeout(() => {
    const active = operations.get(options.runtimeManager);
    if (active?.get(operationId) === operation) {
      active.delete(operationId);
    }
  }, ENVIRONMENT_HOOK_REGISTRY_TTL_MS);
  operation.expiry.unref?.();
}

export async function runEnvironmentHook(
  command: CommandOf<"environment.hook.run">,
  options: CommandDispatchOptions,
): Promise<Record<string, never>> {
  const active = controllers(options);
  const existing = active.get(command.operationId);
  if (existing === "cancelled")
    throw new ExpectedCommandDispatchError(
      "command_failed",
      "Environment hook cancelled before dispatch",
    );
  if (existing !== undefined) {
    if (existing.path !== command.path || existing.kind !== command.kind)
      throw new Error("Environment hook identity mismatch");
    return existing.done;
  }
  if (command.resumeOnly)
    throw new Error("Environment hook outcome is unknown after daemon restart");
  const controller = new AbortController();
  const outcome: HookOutcome = { terminationUnverified: false, active: true };
  const done = Promise.resolve().then(
    async (): Promise<Record<string, never>> => {
      const run = command.kind === "setup" ? runSetupScript : runTeardownScript;
      try {
        await run({
          workspacePath: command.path,
          contributedEnv: command.contributedEnv,
          env: { ...process.env, ...options.runtimeManager.getShellEnv() },
          timeoutMs: command.timeoutMs,
          shellPath: options.runtimeManager.getShellEnv().PATH,
          signal: controller.signal,
          onProgress: (entry) =>
            options.emitEnvironmentHookProgress?.({
              type: "environment.hook.progress",
              operationId: command.operationId,
              entry: {
                type: entry.type,
                text: entry.text,
                status: entry.status ?? null,
              },
            }),
        });
      } catch (error) {
        if (error instanceof LifecycleScriptTerminationUnverifiedError) {
          outcome.terminationUnverified = true;
        }
        throw new Error(error instanceof Error ? error.message : String(error));
      } finally {
        outcome.active = false;
      }
      return {};
    },
  );
  const operation: HookOperation = {
    controller,
    done,
    outcome,
    path: command.path,
    kind: command.kind,
    expiry: null,
  };
  active.set(command.operationId, operation);
  void done.then(
    () => scheduleOperationExpiry(options, command.operationId, operation),
    () => scheduleOperationExpiry(options, command.operationId, operation),
  );
  return done;
}

export async function cancelEnvironmentHook(
  command: CommandOf<"environment.hook.cancel">,
  options: CommandDispatchOptions,
): Promise<{ status: "unknown" | "terminated" }> {
  const active = controllers(options);
  const operation = active.get(command.operationId);
  if (operation === undefined || operation === "cancelled") {
    active.set(command.operationId, "cancelled");
    const timeout = setTimeout(() => {
      if (active.get(command.operationId) === "cancelled") {
        active.delete(command.operationId);
      }
    }, ENVIRONMENT_HOOK_REGISTRY_TTL_MS);
    timeout.unref?.();
    return { status: "unknown" };
  }
  operation.controller.abort();
  await operation.done.catch(() => undefined);
  return {
    status: operation.outcome.terminationUnverified ? "unknown" : "terminated",
  };
}

export async function inspectEnvironmentCleanup(
  command: CommandOf<"environment.inspect_cleanup">,
  options: CommandDispatchOptions,
) {
  const inspection = await inspectWorkspaceProcesses(command.path);
  const active =
    options.runtimeManager.hasPendingEnvironmentProvision(
      command.environmentId,
    ) ||
    [...controllers(options).values()].some(
      (operation) =>
        operation !== "cancelled" &&
        operation.path === command.path &&
        operation.outcome.active,
    );
  return { ...inspection, active };
}
