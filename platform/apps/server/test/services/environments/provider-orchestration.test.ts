import { createBbSdk } from "@hyperfide/sdk/core";
import { createHttpTransport } from "@hyperfide/sdk/node";
import { appendThreadProvisioningEvent } from "../../../src/services/threads/thread-events.js";
import { requestThreadStopForCurrentState } from "../../../src/services/threads/thread-lifecycle.js";
import {
  resolveThreadEnvironmentPlacement,
  prepareProviderEnvironment,
} from "../../../src/services/threads/thread-environment-placement.js";
import { withEnvironmentCleanupSlot } from "../../../src/services/environments/cleanup-concurrency.js";
import { reportEnvironmentHookProgress } from "../../../src/services/environments/environment-hooks.js";
import { registerHostRpcResponder } from "../../helpers/host-rpc.js";
import { registerTestHostRpcCapture } from "../../helpers/commands.js";
import { recordProvisionedEnvironmentWorkspace } from "@hyperfide/db/internal-environment-lifecycle";
import { createThreadFromRequest } from "../../../src/services/threads/thread-create.js";
import {
  encodeClientTurnRequestIdNumber,
  systemThreadProvisioningEventDataSchema,
} from "@hyperfide/domain";
import { requireThreadCommandEnvironment } from "../../../src/services/threads/thread-command-environment.js";
import { ensureThreadProvisionEnvironmentReady } from "../../../src/services/threads/thread-provisioning-environment.js";
import {
  saveThreadProvisionContext,
  createThreadStartup,
} from "../../../src/services/threads/thread-startup-store.js";
import { z } from "zod";
import type { BbPluginApi } from "@hyperfide/plugin-sdk";
import { createFakePluginHost } from "@hyperfide/plugin-sdk/testing";
import { handleUpdateEnvironmentDirectoryToolCall } from "../../../src/services/threads/thread-environment-directory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  listEvents,
  claimEnvironmentPath,
  createEnvironment,
  environments,
  environmentHookOperations,
  hostDaemonSessions,
  getEnvironment,
  getPreparingEnvironment,
  getThread,
  getProject,
  reserveEnvironment,
  updatePreparingEnvironment,
  threads,
  updateThread,
} from "@hyperfide/db";
import type { JsonValue } from "@hyperfide/domain";
import { makeHost } from "@hyperfide/test-helpers/domain-fixtures";
import type { PluginEnvironmentProviderDeclaration } from "@hyperfide/plugin-sdk";
import { validatePluginEnvironmentProviderDeclaration } from "@hyperfide/plugin-sdk/internal/host-policy";
import {
  markProviderEnvironmentAttached,
  cancelProviderEnvironmentCreation,
  sweepProviderEnvironment,
  sweepProviderLifecycles,
  type ProviderOperationContext,
} from "../../../src/services/environments/environment-engine.js";
import { toEnvironmentResponse } from "../../../src/services/environments/environment-response.js";
import { setPluginEnvironmentProviderBridge } from "../../../src/services/plugins/plugin-environment-provider-registry.js";
import {
  advanceProjectDeletion,
  beginProjectDeletion,
} from "../../../src/services/projects/project-deletion.js";
import {
  runPeriodicSweeps,
  runEnvironmentProvisioningSweep,
} from "../../../src/services/system/periodic-sweeps.js";
import { toThreadResponseFromThread } from "../../../src/services/threads/thread-runtime-display.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedTurnStarted,
} from "../../helpers/seed.js";
import {
  withTestHarness,
  type TestAppHarness,
} from "../../helpers/test-app.js";

async function setup(
  harness: TestAppHarness,
  overrides: Partial<PluginEnvironmentProviderDeclaration> = {},
) {
  const { host, session } = await seedHostSession(harness.deps, {
    id: "host_test",
  });
  const { project, source } = await seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: "/tmp/project",
  });
  const thread = await seedThread(harness.deps, {
    projectId: project.id,
    status: "starting",
  });
  const record = {
    pluginId: "test",
    provider: validatePluginEnvironmentProviderDeclaration({
      id: "test-provider",
      displayName: "Test",
      description: "Prepare a workspace for this thread.",
      icon: "Folder",
      create: async () => ({
        status: "created",
        path: `/tmp/${thread.id}`,
        ownsPath: true,
      }),
      remove: async () => ({ status: "removed" }),
      ...overrides,
    }),
  };
  setPluginEnvironmentProviderBridge({
    listEnvironmentProviders: () => [record],
    getEnvironmentProvider: (id) =>
      id === record.provider.id ? record : undefined,
    invokeProvider: async (_id, _label, run) => ({
      ok: true,
      value: await run(),
    }),
    decisionTimeoutMs: 10_000,
  });
  const context: ProviderOperationContext = {
    thread: await toThreadResponseFromThread(harness.deps, { thread }),
    project,
    host: makeHost({ id: host.id, name: host.name }),
    machine: { type: "existing", hostId: host.id },
    projectCheckout: null,
    gitRemote: null,
    inputs: null,
    suggestedBranchName: "bb/test",
    environment: null,
  };
  let lastEnvironmentId: string | null = null;
  const row = async () => {
    const attachedId = (await getThread(harness.db, thread.id))?.environmentId;
    const value =
      (await getPreparingEnvironment(harness.db, thread.id)) ??
      (attachedId
        ? await getEnvironment(harness.db, attachedId)
        : lastEnvironmentId === null
          ? null
          : await getEnvironment(harness.db, lastEnvironmentId));
    if (value === null) throw new Error("Missing preparing environment");
    lastEnvironmentId = value.id;
    return value;
  };
  const ask = async () =>
    await prepareProviderEnvironment(harness.deps, record, context);
  const settled = async () =>
    expect.poll(async () => (await row()).status).not.toBe("creating");
  const attach = async () => {
    const prepared = await row();
    if (prepared.hostId === null || prepared.path === null) {
      throw new Error("Environment is not ready");
    }
    const environment = (await getEnvironment(harness.db, prepared.id))!;
    await harness.db
      .update(environments)
      .set({ status: "ready" })
      .where(eq(environments.id, environment.id))
      .run();
    await markProviderEnvironmentAttached(
      harness.db,
      thread.id,
      environment.id,
    );
    await recordProvisionedEnvironmentWorkspace(
      harness.db,
      harness.hub,
      environment.id,
      {
        path: prepared.path,
        isGitRepo: false,
        isWorktree: false,
        branchName: null,
        defaultBranch: null,
      },
    );
    return environment.id;
  };
  return {
    ask,
    attach,
    context,
    host,
    session,
    record,
    row,
    settled,
    source,
    thread,
  };
}

async function saveProviderStartup(
  harness: TestAppHarness,
  fixture: Awaited<ReturnType<typeof setup>>,
) {
  const context = await createThreadStartup({
    clientRequestId: encodeClientTurnRequestIdNumber({ value: 1 }),
    environmentIntent: {
      type: "provider",
      environmentProviderId: fixture.record.provider.id,
      machine: fixture.context.machine,
      inputs: null,
      selectionResolved: true,
    },
    execution: {
      model: "gpt-5",
      serviceTier: "default",
      reasoningLevel: "medium",
      permissionMode: "accept-edits",
      source: "client/turn/requested",
    },
    fork: null,
    input: [],
    titleProvided: true,
    seedWithoutRun: false,
  });
  context.state.provisionEventSequence = await appendThreadProvisioningEvent(
    harness.deps,
    {
      threadId: fixture.thread.id,
      environmentId: null,
      provisioningId: context.state.provisioningId,
      status: "active",
      entries: [
        {
          type: "step",
          key: "workspace-started",
          text: "Preparing workspace",
          status: "started",
        },
      ],
    },
  );
  await saveThreadProvisionContext({
    db: harness.db,
    replace: true,
    threadId: fixture.thread.id,
    context,
  });
}

function pendingUntilAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener(
      "abort",
      () => reject(new Error("Environment creation aborted")),
      { once: true },
    );
  });
}

afterEach(() => {
  vi.useRealTimers();
  setPluginEnvironmentProviderBridge(undefined);
});

describe("core environment orchestration", () => {
  it("limits cleanup globally and per host, and releases slots after failures", async () =>
    await withTestHarness(async (harness) => {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const activeHosts = await new Set<string>();
      const started: string[] = [];
      let maximum = 0;
      const pending = ["a", "a", "b", "c", "d", "e"].map(async (hostId) =>
        withEnvironmentCleanupSlot(harness.db, hostId, async () => {
          expect(activeHosts.has(hostId)).toBe(false);
          activeHosts.add(hostId);
          started.push(hostId);
          maximum = Math.max(maximum, activeHosts.size);
          await gate;
          activeHosts.delete(hostId);
          if (hostId === "b") throw new Error("cleanup failed");
        }).catch((error: unknown) => {
          expect(error).toBeInstanceOf(Error);
          expect(String(error)).toContain("cleanup failed");
        }),
      );
      try {
        await expect.poll(() => started.length).toBe(4);
        expect(started).toEqual(["a", "b", "c", "d"]);
      } finally {
        release();
        await Promise.all(pending);
      }
      expect(started).toHaveLength(6);
      expect(maximum).toBe(4);
      expect(activeHosts.size).toBe(0);
    }));

  it("refuses a foreign path before setup and never hands it to cleanup", async () =>
    await withTestHarness(async (harness) => {
      const hooks = vi.fn(async () => {});
      const remove = vi.fn(async () => ({ status: "removed" as const }));
      const fixture = await setup(harness, {
        create: async () => ({
          status: "created",
          path: "/tmp/foreign/work",
          ownsPath: true,
        }),
        remove,
      });
      const foreign = await seedProjectWithSource(harness.deps, {
        hostId: fixture.host.id,
        path: "/tmp/foreign",
      });
      await createEnvironment(harness.db, harness.hub, {
        projectId: foreign.project.id,
        hostId: fixture.host.id,
        path: "/tmp/foreign",
        status: "ready",
        providerOwnsPath: true,
      });
      await registerTestHostRpcCapture(harness.deps, {
        hostId: fixture.host.id,
        sessionId: fixture.session.id,
        onEnvironmentHook: hooks,
      });
      await fixture.ask();
      await fixture.settled();
      expect(await fixture.row()).toMatchObject({
        status: "error",
      });
      await cancelProviderEnvironmentCreation(harness.deps, fixture.thread.id);
      expect(hooks).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      expect((await fixture.row()).teardownStatus).toBe("removed");
    }));

  it.each(["preparing environment", "attached environment"])(
    "preserves the original plugin owner of a %s",
    async (kind) =>
      await withTestHarness(async (harness) => {
        const fixture = await setup(harness, { policy: { retireGraceMs: 0 } });
        await fixture.ask();
        await fixture.settled();
        const environmentId =
          kind === "attached environment" ? await fixture.attach() : null;
        const create = vi.fn(fixture.record.provider.create);
        const remove = vi.fn(async () => ({ status: "removed" as const }));
        const replacement = {
          ...fixture.record,
          pluginId: "replacement",
          provider: { ...fixture.record.provider, create, remove },
        };
        setPluginEnvironmentProviderBridge({
          listEnvironmentProviders: () => [replacement],
          getEnvironmentProvider: () => replacement,
          invokeProvider: async (_id, _label, run) => ({
            ok: true,
            value: await run(),
          }),
          decisionTimeoutMs: 10_000,
        });
        if (environmentId === null) {
          expect(
            await prepareProviderEnvironment(
              harness.deps,
              replacement,
              fixture.context,
            ),
          ).toMatchObject({ action: "reject" });
          await expect(
            cancelProviderEnvironmentCreation(harness.deps, fixture.thread.id),
          ).rejects.toThrow();
        } else {
          await sweepProviderEnvironment(harness.deps, environmentId);
          expect(
            (await getEnvironment(harness.db, environmentId))?.teardownStatus,
          ).not.toBe("removed");
        }
        expect(create).not.toHaveBeenCalled();
        expect(remove).not.toHaveBeenCalled();
      }),
  );

  it("persists verbose progress without broadcasting configuration changes", async () =>
    await withTestHarness(async (harness) => {
      const fixture = await setup(harness, {
        create: async ({ report }) => {
          for (let i = 0; i < 50; i += 1) await report.log(`line ${i}\n`);
          return { status: "created", path: "/tmp/progress", ownsPath: false };
        },
      });
      const notify = vi.spyOn(harness.hub, "notifySystem");
      await fixture.ask();
      await fixture.settled();
      expect((await fixture.row()).pendingLog).toContain("line 49");
      expect(
        notify.mock.calls.some(([changes]) =>
          changes.includes("config-changed"),
        ),
      ).toBe(false);
      notify.mockRestore();
    }));

  it("claim then terminal create failure never runs teardown in the original checkout", async () =>
    await withTestHarness(async (harness) => {
      const hooks = vi.fn();
      const remove = vi.fn(async () => ({ status: "removed" as const }));
      const fixture = await setup(harness, {
        create: async (context) => {
          expect(await context.experimental_claimPath("/tmp/project")).toBe(
            true,
          );
          return {
            status: "failed",

            message: "checkout create failed",
          };
        },
        remove,
      });
      await registerTestHostRpcCapture(harness.deps, {
        hostId: fixture.host.id,
        sessionId: fixture.session.id,
        onEnvironmentHook: hooks,
      });
      await fixture.ask();
      await fixture.settled();
      expect((await fixture.row()).providerOwnsPath).toBe(false);
      await cancelProviderEnvironmentCreation(harness.deps, fixture.thread.id);
      expect(remove).toHaveBeenCalledOnce();
      expect(hooks).not.toHaveBeenCalled();
      expect((await fixture.row()).claimPath).toBeNull();
    }));

  it("finalizes a workspace path already claimed by the same launch", async () =>
    await withTestHarness(async (harness) => {
      const fixture = await setup(harness, {
        create: async (context) => {
          expect(await context.experimental_claimPath("/tmp/project")).toBe(
            true,
          );
          await context.report.log("Checkout prepared");
          return { status: "created", path: "/tmp/project", ownsPath: false };
        },
      });
      await fixture.ask();
      await fixture.settled();
      expect((await fixture.row()).path).toBe("/tmp/project");
      expect(["provisioning", "ready"]).toContain((await fixture.row()).status);
    }));

  it.each([true, false])(
    "runs teardown only for ownsPath=%s, in provider order",
    async (ownsPath) =>
      await withTestHarness(async (harness) => {
        const order: string[] = [];
        const fixture = await setup(harness, {
          policy: { retireGraceMs: 0 },
          create: async () => {
            order.push("create");
            return { status: "created", path: "/tmp/hooks", ownsPath };
          },
          remove: async () => {
            order.push("remove");
            return { status: "removed" };
          },
        });
        await registerTestHostRpcCapture(harness.deps, {
          hostId: fixture.host.id,
          sessionId: fixture.session.id,
          onEnvironmentHook: async (command) => {
            expect(command.timeoutMs).toBe(15 * 60 * 1000);
            expect(command.path).toBe("/tmp/hooks");
            order.push(command.kind);
          },
        });
        await fixture.ask();
        await fixture.settled();
        expect((await fixture.row()).status).toBe("provisioning");
        const environmentId = await fixture.attach();
        await sweepProviderEnvironment(harness.deps, environmentId);
        expect(
          (await getEnvironment(harness.db, environmentId))?.teardownStatus,
        ).toBe("removed");
        expect(order).toEqual(
          ownsPath ? ["create", "teardown", "remove"] : ["create", "remove"],
        );
      }),
  );

  it("reports teardown transport failure and still removes the environment", async () =>
    await withTestHarness(async (harness) => {
      const remove = vi.fn(async () => ({ status: "removed" as const }));
      const fixture = await setup(harness, {
        policy: { retireGraceMs: 0 },
        remove,
      });
      await registerTestHostRpcCapture(harness.deps, {
        hostId: fixture.host.id,
        sessionId: fixture.session.id,
        onEnvironmentHook: async (command) => {
          if (command.kind === "teardown")
            throw new Error("teardown unavailable");
        },
      });
      const warn = vi.fn();
      harness.deps.logger = { ...harness.deps.logger, warn };
      await fixture.ask();
      await fixture.settled();
      const environmentId = await fixture.attach();
      await sweepProviderEnvironment(harness.deps, environmentId);
      expect(remove).toHaveBeenCalledOnce();
      expect(
        (await getEnvironment(harness.db, environmentId))?.teardownStatus,
      ).toBe("removed");
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: "teardown unavailable" }),
        "Environment teardown hook failed; continuing removal",
      );
    }));

  it("forwards teardown hook output only from the hook host while the hook runs", async () =>
    await withTestHarness(async (harness) => {
      const fixture = await setup(harness, { policy: { retireGraceMs: 0 } });
      const teardownOperationIds: string[] = [];
      await registerTestHostRpcCapture(harness.deps, {
        hostId: fixture.host.id,
        sessionId: fixture.session.id,
        onEnvironmentHook: async (command) => {
          if (command.kind !== "teardown") return;
          teardownOperationIds.push(command.operationId);
          await reportEnvironmentHookProgress(harness.deps, "host_foreign", {
            type: "environment.hook.progress",
            operationId: command.operationId,
            entry: { type: "output", text: "foreign output", status: null },
          });
          await reportEnvironmentHookProgress(harness.deps, fixture.host.id, {
            type: "environment.hook.progress",
            operationId: command.operationId,
            entry: {
              type: "step",
              text: "Running teardown",
              status: "started",
            },
          });
          await reportEnvironmentHookProgress(harness.deps, fixture.host.id, {
            type: "environment.hook.progress",
            operationId: command.operationId,
            entry: { type: "output", text: "hook output", status: null },
          });
        },
      });
      const warn = vi.fn();
      harness.deps.logger = { ...harness.deps.logger, warn };
      await fixture.ask();
      await fixture.settled();
      const environmentId = await fixture.attach();
      await sweepProviderEnvironment(harness.deps, environmentId);
      expect(teardownOperationIds).toHaveLength(1);
      for (const operationId of teardownOperationIds) {
        await reportEnvironmentHookProgress(harness.deps, fixture.host.id, {
          type: "environment.hook.progress",
          operationId,
          entry: { type: "output", text: "late output", status: null },
        });
      }
      expect(
        warn.mock.calls.filter(
          ([, message]) => message === "Environment teardown hook",
        ),
      ).toEqual([
        [{ environmentId, text: "hook output\n" }, "Environment teardown hook"],
      ]);
    }));

  it.each(["new reuse", "reuse", "directory", "restored dispatch"])(
    "refuses %s admission while another environment preparation owns the checkout",
    async (admission) =>
      await withTestHarness(async (harness) => {
        const fixture = await setup(harness, {
          create: async (context) => {
            await context.experimental_claimPath("/tmp/project");
            return { status: "created", path: "/tmp/project", ownsPath: false };
          },
        });
        await fixture.ask();
        await fixture.settled();
        const target = (await getEnvironment(
          harness.db,
          (await fixture.row()).id,
        ))!;
        await harness.db
          .update(environments)
          .set({ status: "ready" })
          .where(eq(environments.id, target.id))
          .run();
        const current = await createEnvironment(harness.db, harness.hub, {
          projectId: fixture.context.project.id,
          hostId: fixture.host.id,
          path: "/tmp/other",
          status: "ready",
          providerOwnsPath: false,
        });
        const thread = await seedThread(harness.deps, {
          projectId: fixture.context.project.id,
          status: "starting",
          environmentId:
            admission === "restored dispatch" ? target.id : current.id,
        });
        const busy =
          "Cannot checkout branch while another thread is using this workspace";
        if (admission === "new reuse") {
          await expect(
            createThreadFromRequest(harness.deps, {
              environment: { type: "reuse", environmentId: target.id },
              input: [{ type: "text", text: "Start", mentions: [] }],
              origin: "app",
              projectId: fixture.context.project.id,
              providerId: "codex",
              model: "gpt-5",
              startedOnBehalfOf: null,
            }),
          ).rejects.toThrow(busy);
        } else if (admission === "directory") {
          await seedTurnStarted(harness.deps, {
            environmentId: current.id,
            providerThreadId: "provider_admission",
            sequence: 1,
            threadId: thread.id,
            turnId: "turn_admission",
          });
          const result = await handleUpdateEnvironmentDirectoryToolCall(
            harness.deps,
            {
              currentEnvironment: current,
              thread,
              turnId: "turn_admission",
              input: { path: target.path },
            },
          );
          expect(result).toMatchObject({
            success: false,
            contentItems: [{ type: "inputText", text: busy }],
          });
        } else if (admission === "restored dispatch") {
          await expect(
            requireThreadCommandEnvironment(harness.deps, { thread }),
          ).rejects.toThrow(busy);
          await expect(
            requireThreadCommandEnvironment(harness.deps, {
              thread: { ...fixture.thread, environmentId: target.id },
            }),
          ).resolves.toMatchObject({ id: target.id });
        } else {
          const context = await createThreadStartup({
            clientRequestId: encodeClientTurnRequestIdNumber({ value: 1 }),
            environmentIntent: { type: "reuse", environmentId: target.id },
            execution: {
              model: "gpt-5",
              serviceTier: "default",
              reasoningLevel: "medium",
              permissionMode: "accept-edits",
              source: "client/turn/requested",
            },
            fork: null,
            input: [],
            titleProvided: true,
            seedWithoutRun: false,
          });
          await saveThreadProvisionContext({
            db: harness.db,
            replace: true,
            threadId: thread.id,
            context,
          });
          await expect(
            ensureThreadProvisionEnvironmentReady(harness.deps, {
              thread,
              context,
            }),
          ).rejects.toThrow(busy);
        }
      }),
  );

  it("retains a failed claim through cleanup and releases it only after removal", async () =>
    await withTestHarness(async (harness) => {
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const fixture = await setup(harness, {
        create: async (context) => {
          await context.experimental_claimPath("/tmp/project");
          return {
            status: "failed",

            message: "provision failed",
          };
        },
        remove: async () => {
          await gate;
          return { status: "removed" };
        },
      });
      await fixture.ask();
      await fixture.settled();
      const competitor = await seedThread(harness.deps, {
        projectId: fixture.context.project.id,
        status: "starting",
      });
      const second = reserveEnvironment(harness.db, {
        ...(await fixture.row()),
        ownerThreadId: competitor.id,
        status: "creating" as const,
        path: null,
        claimPath: null,
      });
      let cleanup: Promise<void> | undefined;
      try {
        expect(
          await claimEnvironmentPath(harness.db, await second, "/tmp/project"),
        ).toBe(false);
        cleanup = cancelProviderEnvironmentCreation(
          harness.deps,
          fixture.thread.id,
        );
        expect(
          await claimEnvironmentPath(harness.db, await second, "/tmp/project"),
        ).toBe(false);
      } finally {
        release();
        await cleanup;
      }
      expect(
        await claimEnvironmentPath(harness.db, await second, "/tmp/project"),
      ).toBe(true);
    }));

  it("normalizes trailing slashes on claimed paths", async () =>
    await withTestHarness(async (harness) => {
      const fixture = await setup(harness, {
        create: async (context) => {
          await context.experimental_claimPath("/tmp/project/");
          return { status: "created", path: "/tmp/project/", ownsPath: false };
        },
      });
      await fixture.ask();
      await fixture.settled();
      const competitor = await seedThread(harness.deps, {
        projectId: fixture.context.project.id,
        status: "starting",
      });
      const second = reserveEnvironment(harness.db, {
        ...(await fixture.row()),
        ownerThreadId: competitor.id,
        status: "creating" as const,
        path: null,
        claimPath: null,
      });
      expect(
        await claimEnvironmentPath(harness.db, await second, "/tmp/project"),
      ).toBe(false);
      expect((await fixture.row()).path).toBe("/tmp/project");
    }));

  it("preserves the attached path for live checkout exclusion", async () =>
    await withTestHarness(async (harness) => {
      const fixture = await setup(harness, {
        id: "project-checkout",
        create: async (context) => {
          await context.experimental_claimPath("/tmp/project/");
          return { status: "created", path: "/tmp/project/", ownsPath: false };
        },
      });
      await fixture.ask();
      await fixture.settled();
      const environmentId = await fixture.attach();
      await updateThread(harness.db, harness.hub, fixture.thread.id, {
        environmentId,
      });
      await harness.db
        .update(threads)
        .set({ status: "active" })
        .where(eq(threads.id, fixture.thread.id))
        .run();
      expect((await getEnvironment(harness.db, environmentId))?.path).toBe(
        "/tmp/project",
      );
      const response = await harness.app.request(
        `/api/v1/environments?hostId=${fixture.host.id}&path=%2Ftmp%2Fproject`,
      );
      expect(response.status).toBe(200);
      expect(
        z
          .array(z.object({ id: z.string() }))
          .parse(await response.json())
          .map((row) => row.id),
      ).toContain(environmentId);
      const fake = await createFakePluginHost({
        pluginId: "environment-project-checkout",
        sdk: {
          environments: {
            list: async (filters) => {
              if (filters?.hostId === undefined || filters.path === undefined)
                throw new Error("Missing host/path filter");
              const response = await harness.app.request(
                `/api/v1/environments?${new URLSearchParams({ hostId: filters.hostId, path: filters.path })}`,
              );
              expect(response.status).toBe(200);
              return response.json();
            },
          },
          threads: {
            list: async (filters) => {
              if (filters?.environmentId === undefined)
                throw new Error("Missing environment filter");
              const response = await harness.app.request(
                `/api/v1/threads?${new URLSearchParams({ environmentId: filters.environmentId })}`,
              );
              expect(response.status).toBe(200);
              return response.json();
            },
          },
        },
      });
      const module = await z
        .object({
          default: z.custom<(bb: BbPluginApi) => Promise<void>>(
            (value) => typeof value === "function",
          ),
        })
        .parse(
          await import(
            new URL(
              "../../../../../plugins/environment-project-checkout/server.ts",
              import.meta.url,
            ).href
          ),
        );
      await module.default(fake.bb);
      const provider =
        await fake.harness.registrations.environmentProviders.get(
          "project-checkout",
        );
      if (provider?.validate === null || provider === undefined)
        throw new Error("Missing checkout provider");
      expect(
        await provider.validate({
          ...fixture.context,
          projectCheckout: {
            experimental_ownsPath: false,
            path: "/tmp/project",
          },
          inputs: { branch: { kind: "existing", name: "release" } },
        }),
      ).toEqual({
        action: "refuse",
        message:
          "Cannot checkout branch while another thread is using this workspace",
      });
    }));

  it("reserves a checkout before concurrent branch mutations until attachment", async () =>
    await withTestHarness(async (harness) => {
      const fixture = await setup(harness);
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const switched: string[] = [];
      const fake = await createFakePluginHost({
        pluginId: "environment-project-checkout",
        sdk: { environments: { list: () => [] }, threads: { list: () => [] } },
        experimental_callHostRpc: async ({ input }) => {
          const parsed = z
            .object({
              path: z.string(),
              branch: z.object({ name: z.string() }),
            })
            .parse(input);
          switched.push(parsed.branch.name);
          await gate;
          return {
            status: "attached",
            path: parsed.path,
            branchName: parsed.branch.name,
            mergeBaseBranch: null,
          };
        },
      });
      const module = await z
        .object({
          default: z.custom<(bb: BbPluginApi) => Promise<void>>(
            (value) => typeof value === "function",
          ),
        })
        .parse(
          await import(
            new URL(
              "../../../../../plugins/environment-project-checkout/server.ts",
              import.meta.url,
            ).href
          ),
        );
      await module.default(fake.bb);
      const provider =
        await fake.harness.registrations.environmentProviders.get(
          "project-checkout",
        );
      if (provider === undefined) throw new Error("Missing checkout provider");
      const record = { pluginId: "environment-project-checkout", provider };
      setPluginEnvironmentProviderBridge({
        listEnvironmentProviders: () => [record],
        getEnvironmentProvider: () => record,
        invokeProvider: async (_id, _label, run) => ({
          ok: true,
          value: await run(),
        }),
        decisionTimeoutMs: 10_000,
      });
      const second = seedThread(harness.deps, {
        projectId: fixture.context.project.id,
        status: "starting",
      });
      const context = {
        ...fixture.context,
        projectCheckout: { experimental_ownsPath: false, path: "/tmp/project" },
        inputs: { branch: { kind: "existing", name: "release" } },
      };
      try {
        await prepareProviderEnvironment(harness.deps, record, context);
        await prepareProviderEnvironment(harness.deps, record, {
          ...context,
          thread: await toThreadResponseFromThread(harness.deps, {
            thread: await second,
          }),
          inputs: { branch: { kind: "existing", name: "feature" } },
        });
        await expect
          .poll(
            async () =>
              (await getPreparingEnvironment(harness.db, (await second).id))
                ?.status,
          )
          .toBe("error");
        expect(
          (await getPreparingEnvironment(harness.db, (await second).id))
            ?.statusMessage,
        ).toContain("Workspace is being prepared by another thread");
        expect(switched).toEqual(["release"]);
        expect(await fixture.row()).toMatchObject({
          hostId: fixture.host.id,
          claimPath: "/tmp/project",
          status: "creating",
        });
      } finally {
        release();
        await fixture.settled();
      }
      expect((await fixture.row()).status).toBe("provisioning");
    }));

  it("reuses a same-project worktree before checkout validation", async () =>
    await withTestHarness(async (harness) => {
      const validate = vi.fn(() => ({
        action: "refuse" as const,
        message: "reuse that environment instead",
      }));
      const fixture = await setup(harness, {
        id: "project-checkout",
        validate,
      });
      await fixture.ask();
      await fixture.settled();
      const currentId = await fixture.attach();
      const current = (await getEnvironment(harness.db, currentId))!;
      await updateThread(harness.db, harness.hub, fixture.thread.id, {
        environmentId: currentId,
      });
      const target = await createEnvironment(harness.db, harness.hub, {
        projectId: fixture.context.project.id,
        hostId: fixture.host.id,
        path: "/tmp/same-project-worktree",
        status: "ready",
        providerOwnsPath: true,
        environmentProvider: {
          environmentProviderId: "git-worktree",
          instanceKey: "worktree",
          selection: (await fixture.row()).environmentProviderSelection!,
        },
      });
      await seedTurnStarted(harness.deps, {
        environmentId: currentId,
        providerThreadId: "provider_directory",
        sequence: 1,
        threadId: fixture.thread.id,
        turnId: "turn_directory",
      });
      const result = await handleUpdateEnvironmentDirectoryToolCall(
        harness.deps,
        {
          currentEnvironment: current,
          thread: { ...fixture.thread, environmentId: currentId },
          turnId: "turn_directory",
          input: { path: "/tmp/same-project-worktree" },
        },
      );
      expect(result.success).toBe(true);
      expect(validate).not.toHaveBeenCalled();
      expect(
        (await getThread(harness.db, fixture.thread.id))?.environmentId,
      ).toBe(target.id);
    }));

  it.each(["removal", "cancellation"])(
    "queues same-host %s cleanup and waits for the bounded batch",
    async (kind) =>
      await withTestHarness(async (harness) => {
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const calls: string[] = [];
        const fixture = await setup(harness, {
          policy: { retireGraceMs: 0 },
          remove: async ({ pathKey }) => {
            calls.push(pathKey);
            await gate;
            return { status: "removed" };
          },
        });
        await fixture.ask();
        await fixture.settled();
        const second = seedThread(harness.deps, {
          projectId: fixture.context.project.id,
          status: "starting",
        });
        await reserveEnvironment(harness.db, {
          ...(await fixture.row()),
          ownerThreadId: (await second).id,
          environmentProviderInstanceKey: (await second).id,
          path: "/tmp/second",
        });
        if (kind === "removal") {
          await fixture.attach();
          const env = (await getPreparingEnvironment(
            harness.db,
            (await second).id,
          ))!;
          await harness.db
            .update(environments)
            .set({ status: "ready" })
            .where(eq(environments.id, env.id))
            .run();
          await markProviderEnvironmentAttached(
            harness.db,
            (await second).id,
            env.id,
          );
        } else {
          for (const id of [fixture.thread.id, (await second).id]) {
            await updatePreparingEnvironment(harness.db, {
              ...(await getPreparingEnvironment(harness.db, id))!,
              status: "error",
              teardownStatus: "running",
              retireAt: Date.now(),
            });
          }
        }
        let enumerated = false;
        const sweep = sweepProviderLifecycles(harness.deps).then(() => {
          enumerated = true;
        });
        try {
          await expect.poll(() => calls.length).toBe(1);
          expect(enumerated).toBe(false);
        } finally {
          release();
          await sweep;
        }
        expect(calls.sort()).toEqual(
          [fixture.thread.id, (await second).id].sort(),
        );
        expect(enumerated).toBe(true);
      }),
  );

  it("runs one long create call and records the ready result", async () =>
    await withTestHarness(async (harness) => {
      const fixture = await setup(harness);
      expect(await fixture.ask()).toMatchObject({
        action: "wait",
        reason: "Preparing Test…",
      });
      await fixture.settled();
      expect(await fixture.ask()).toMatchObject({
        action: "ready",
        environment: { path: `/tmp/${fixture.thread.id}` },
      });
      const environmentId = await fixture.attach();
      expect(await fixture.row()).toMatchObject({
        id: environmentId,
      });
    }));

  it("re-runs a persisted creating attempt with the same path key", async () =>
    await withTestHarness(async (harness) => {
      const calls: Array<{ attempt: number; pathKey: string }> = [];
      const fixture = await setup(harness, {
        create: async (context) => {
          calls.push({ attempt: context.attempt, pathKey: context.pathKey });
          return {
            status: "created",
            path: `/tmp/${context.pathKey}`,
            ownsPath: true,
          };
        },
      });
      await reserveEnvironment(harness.db, {
        projectId: fixture.context.project.id,
        ownerThreadId: fixture.thread.id,
        environmentProviderId: fixture.record.provider.id,
        environmentProviderPluginId: fixture.record.pluginId,
        attempt: 7,
        status: "creating",
        environmentProviderInstanceKey: "durable-path-key",
        hostId: fixture.host.id,
        path: null,
        claimPath: null,
        providerOwnsPath: true,
        mergeBaseBranch: null,
        resource: null,
        statusMessage: "Preparing Test…",
        pendingLog: "",
        environmentProviderSelection: {
          machine: { type: "existing", hostId: fixture.host.id },
          inputs: null,
        },
        teardownStatus: null,
      });

      expect((await fixture.ask()).action).toBe("wait");
      await fixture.settled();
      expect(calls).toEqual([{ attempt: 7, pathKey: "durable-path-key" }]);
      expect(await fixture.row()).toMatchObject({
        attempt: 7,
        environmentProviderInstanceKey: "durable-path-key",
        status: "provisioning",
      });
    }));

  it("persists progress reported from inside create", async () =>
    await withTestHarness(async (harness) => {
      let release: () => void = () => {};
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      const fixture = await setup(harness, {
        create: async (context) => {
          await context.report.step("Cloning repository");
          await context.report.log("clone output");
          await waiting;
          return {
            status: "created",
            path: "/tmp/progress",
            ownsPath: true,
          };
        },
      });
      await saveProviderStartup(harness, fixture);
      await fixture.ask();
      await expect
        .poll(async () => await fixture.ask())
        .toMatchObject({ reason: "Cloning repository" });
      expect((await fixture.row()).pendingLog).toBe("");
      await fixture.ask();
      await expect
        .poll(async () =>
          (await listEvents(harness.db, { threadId: fixture.thread.id }))
            .filter((event) => event.type === "system/thread-provisioning")
            .flatMap(
              (event) =>
                systemThreadProvisioningEventDataSchema.parse(
                  JSON.parse(event.data),
                ).entries,
            )
            .filter(
              (entry) =>
                entry.type === "output" && entry.text === "clone output",
            ),
        )
        .toHaveLength(1);
      release();
      await fixture.settled();
    }));

  it("aborts create before removing everything under its path key", async () =>
    await withTestHarness(async (harness) => {
      const events: string[] = [];
      const fixture = await setup(harness, {
        create: async (context) => {
          events.push(`create:${context.pathKey}`);
          context.signal.addEventListener("abort", () => events.push("abort"));
          return pendingUntilAbort(context.signal);
        },
        remove: async (context) => {
          events.push(`remove:${context.pathKey}`);
          expect(context.environment).toBeNull();
          expect(context.path).toBeNull();
          return { status: "removed" };
        },
      });
      await fixture.ask();
      await expect.poll(() => events).toHaveLength(1);
      await cancelProviderEnvironmentCreation(harness.deps, fixture.thread.id);
      expect(events).toEqual([
        `create:${fixture.thread.id}`,
        "abort",
        `remove:${fixture.thread.id}`,
      ]);
      expect(await fixture.row()).toMatchObject({
        status: "destroyed",
        teardownStatus: "removed",
      });
    }));

  it("waits for an aborted create to stop before removing its path key", async () =>
    await withTestHarness(async (harness) => {
      const events: string[] = [];
      let release: () => void = () => {};
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      const fixture = await setup(harness, {
        create: async (context) => {
          events.push("create");
          context.signal.addEventListener("abort", () => events.push("abort"));
          await waiting;
          events.push("create-stopped");
          return {
            status: "created",
            path: `/tmp/${context.pathKey}`,
            ownsPath: true,
          };
        },
        remove: async () => {
          events.push("remove");
          return { status: "removed" };
        },
      });
      await fixture.ask();
      await expect.poll(() => events).toEqual(["create"]);
      const cancellation = cancelProviderEnvironmentCreation(
        harness.deps,
        fixture.thread.id,
      );
      await expect.poll(() => events).toEqual(["create", "abort"]);
      release();
      await cancellation;
      expect(events).toEqual(["create", "abort", "create-stopped", "remove"]);
    }));

  it("keeps failed creation terminal and retries explicitly on the same row", async () =>
    await withTestHarness(async (harness) => {
      const creates: string[] = [];
      const fixture = await setup(harness, {
        policy: { pathKeys: "per-attempt" },
        create: async (context) => {
          creates.push(context.pathKey);
          return { status: "failed", message: "offline" };
        },
      });
      await fixture.ask();
      await fixture.settled();
      const previousAttempt = await fixture.row();
      const id = await previousAttempt.id;
      for (let i = 0; i < 4; i++)
        expect(await fixture.ask()).toMatchObject({
          action: "reject",
          message: "offline",
        });
      expect(creates).toHaveLength(1);
      await cancelProviderEnvironmentCreation(harness.deps, fixture.thread.id);
      await fixture.ask();
      await fixture.settled();
      expect(
        await updatePreparingEnvironment(harness.db, {
          ...previousAttempt,
          status: "provisioning",
        }),
      ).toBe(false);
      expect(await fixture.row()).toMatchObject({
        id,
        attempt: 2,
        status: "error",
      });
      expect(creates).toEqual([
        `${fixture.thread.id}-1`,
        `${fixture.thread.id}-2`,
      ]);
    }));

  it("round-trips a private resource handle into remove", async () =>
    await withTestHarness(async (harness) => {
      const resources: JsonValue[] = [];
      const fixture = await setup(harness, {
        create: async () => ({
          status: "created",
          path: "/tmp/resource-test",
          ownsPath: true,
          resource: { secret: "private" },
        }),
        remove: async (context) => {
          resources.push(context.resource);
          return { status: "removed" };
        },
        policy: { retireGraceMs: 0 },
      });
      await fixture.ask();
      await fixture.settled();
      const environmentId = await fixture.attach();
      expect(
        JSON.stringify(
          await toEnvironmentResponse(
            harness.db,
            (await getEnvironment(harness.db, environmentId))!,
          ),
        ),
      ).not.toContain("private");
      await sweepProviderEnvironment(harness.deps, environmentId);
      expect(resources).toEqual([{ secret: "private" }]);
      expect(
        (await getEnvironment(harness.db, environmentId))?.resource,
      ).toBeNull();
    }));

  it("rejects a resource handle larger than 16 KiB", async () =>
    await withTestHarness(async (harness) => {
      const fixture = await setup(harness, {
        create: async () => ({
          status: "created",
          path: "/tmp/cap",
          ownsPath: true,
          resource: "x".repeat(16_385),
        }),
      });
      await fixture.ask();
      await fixture.settled();
      expect(await fixture.ask()).toMatchObject({
        action: "reject",
        message: expect.stringContaining("16 KiB"),
      });
    }));

  it("serializes overlapping remove sweeps", async () =>
    await withTestHarness(async (harness) => {
      let removes = 0;
      let release: () => void = () => {};
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      const fixture = await setup(harness, {
        policy: { retireGraceMs: 0 },
        remove: async () => {
          removes += 1;
          await waiting;
          return { status: "removed" };
        },
      });
      await fixture.ask();
      await fixture.settled();
      const environmentId = await fixture.attach();
      const first = sweepProviderEnvironment(harness.deps, environmentId);
      await expect.poll(() => removes).toBe(1);
      const second = sweepProviderEnvironment(harness.deps, environmentId);
      expect(removes).toBe(1);
      release();
      await Promise.all([first, second]);
      expect(removes).toBe(1);
    }));

  it("reserves a path until provider removal finishes", async () =>
    await withTestHarness(async (harness) => {
      let removes = 0;
      let release: () => void = () => {};
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      const path = await "/tmp/reserved-until-removed";
      const fixture = await setup(harness, {
        policy: { retireGraceMs: 0 },
        create: async () => ({
          status: "created",
          path,
          ownsPath: true,
        }),
        remove: async () => {
          removes += 1;
          await waiting;
          return { status: "removed" };
        },
      });
      await fixture.ask();
      await fixture.settled();
      const environmentId = await fixture.attach();
      const removal = sweepProviderEnvironment(harness.deps, environmentId);
      await expect.poll(() => removes).toBe(1);
      const competingThread = await seedThread(harness.deps, {
        projectId: fixture.context.project.id,
        status: "starting",
      });
      const context = {
        ...fixture.context,
        thread: await toThreadResponseFromThread(harness.deps, {
          thread: competingThread,
        }),
      };
      await prepareProviderEnvironment(harness.deps, fixture.record, context);
      try {
        await expect
          .poll(
            async () =>
              (await getPreparingEnvironment(harness.db, competingThread.id))
                ?.status,
          )
          .toBe("error");
        expect(
          (await getPreparingEnvironment(harness.db, competingThread.id))
            ?.statusMessage,
        ).toContain("cleanup is still pending");
      } finally {
        release();
        await removal;
      }
      await cancelProviderEnvironmentCreation(harness.deps, competingThread.id);
      await prepareProviderEnvironment(harness.deps, fixture.record, context);
      await expect
        .poll(
          async () =>
            (await getPreparingEnvironment(harness.db, competingThread.id))
              ?.status,
        )
        .toBe("provisioning");
    }));

  it.each(["timer", "explicit"] as const)(
    "retries failed removal through %s",
    async (retry) =>
      await withTestHarness(async (harness) => {
        vi.useFakeTimers({ toFake: ["Date"] });
        let removes = 0;
        const fixture = await setup(harness, {
          policy: { retireGraceMs: 0 },
          remove: async () => {
            removes += 1;
            return removes === 1
              ? { status: "failed", message: "busy" }
              : { status: "removed" };
          },
        });
        await fixture.ask();
        await fixture.settled();
        const environmentId = await fixture.attach();
        await sweepProviderEnvironment(harness.deps, environmentId);
        expect(await getEnvironment(harness.db, environmentId)).toMatchObject({
          teardownStatus: "failed",
          teardownMessage: "busy",
        });
        await sweepProviderEnvironment(harness.deps, environmentId);
        expect(removes).toBe(1);
        if (retry === "timer") {
          vi.setSystemTime(Date.now() + 60_001);
          await sweepProviderEnvironment(harness.deps, environmentId);
        } else {
          await harness.db
            .update(threads)
            .set({ environmentId, status: "idle" })
            .where(eq(threads.id, fixture.thread.id))
            .run();
          const retryRequest = () =>
            harness.app.request(
              `/api/v1/environments/${environmentId}/cleanup`,
              { method: "POST" },
            );
          expect((await retryRequest()).status).toBe(409);
          expect(removes).toBe(1);
          await harness.db
            .update(threads)
            .set({ archivedAt: Date.now() })
            .where(eq(threads.id, fixture.thread.id))
            .run();
          const sdk = createBbSdk({
            transport: createHttpTransport({
              baseUrl: "http://localhost",
              runtime: "node",
              fetch: async (input, init) =>
                harness.app.fetch(new Request(input, init)),
            }),
          });
          await expect(
            sdk.environments.experimental_cleanup({ environmentId }),
          ).resolves.toEqual({ ok: true });
          await expect
            .poll(
              async () =>
                (await getEnvironment(harness.db, environmentId))
                  ?.teardownStatus,
            )
            .toBe("removed");
          expect(removes).toBe(2);
          expect((await retryRequest()).status).toBe(200);
          expect(removes).toBe(2);
        }
        expect(await getEnvironment(harness.db, environmentId)).toMatchObject({
          status: "destroyed",
          teardownStatus: "removed",
        });
      }),
  );

  it("rejects cleanup of an unmanaged checkout", async () =>
    await withTestHarness(async (harness) => {
      const fixture = await setup(harness);
      const environment = await seedEnvironment(harness.deps, {
        hostId: fixture.host.id,
        projectId: fixture.thread.projectId,
      });
      const response = await harness.app.request(
        `/api/v1/environments/${environment.id}/cleanup`,
        { method: "POST" },
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        message: "Environment is not provider-managed",
      });
      expect((await getEnvironment(harness.db, environment.id))?.status).toBe(
        "ready",
      );
    }));

  it("rejects cleanup of a checkout attached by its provider without ownership", async () =>
    await withTestHarness(async (harness) => {
      const { host } = await seedHostSession(harness.deps);
      const path = await "/tmp/attached-checkout";
      const { project } = await seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path,
      });
      const fake = await createFakePluginHost({
        pluginId: "environment-project-checkout",
      });
      const module = await z
        .object({
          default: z.custom<(bb: BbPluginApi) => Promise<void>>(
            (value) => typeof value === "function",
          ),
        })
        .parse(
          await import(
            new URL(
              "../../../../../plugins/environment-project-checkout/server.ts",
              import.meta.url,
            ).href
          ),
        );
      await module.default(fake.bb);
      const provider =
        await fake.harness.registrations.environmentProviders.get(
          "project-checkout",
        );
      if (provider === undefined) throw new Error("Missing checkout provider");
      const record = { pluginId: "environment-project-checkout", provider };
      setPluginEnvironmentProviderBridge({
        listEnvironmentProviders: () => [record],
        getEnvironmentProvider: (id) =>
          id === provider.id ? record : undefined,
        invokeProvider: async (_id, _label, run) => ({
          ok: true,
          value: await run(),
        }),
        decisionTimeoutMs: 10_000,
      });
      const environment = await seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path,
        providerOwnsPath: false,
        environmentProviderId: provider.id,
        environmentProviderPluginId: record.pluginId,
      });
      const thread = await seedThread(harness.deps, {
        projectId: project.id,
        status: "idle",
        environmentId: environment.id,
      });
      await harness.db
        .update(threads)
        .set({ archivedAt: Date.now() })
        .where(eq(threads.id, thread.id))
        .run();
      expect(
        await toEnvironmentResponse(harness.db, environment),
      ).toMatchObject({
        managed: false,
        workspaceProvisionType: "unmanaged",
      });
      const response = await harness.app.request(
        `/api/v1/environments/${environment.id}/cleanup`,
        { method: "POST" },
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        message: "Environment is not provider-managed",
      });
      expect(await getEnvironment(harness.db, environment.id)).toMatchObject({
        path,
        status: "ready",
        retireAt: null,
        teardownStatus: null,
      });
      expect((await getThread(harness.db, thread.id))?.environmentId).toBe(
        environment.id,
      );
      expect(fake.harness.experimental_hostRpcCalls).toHaveLength(0);
    }));

  it("keeps retained environments until explicitly asked to clean up", async () =>
    await withTestHarness(async (harness) => {
      const fixture = await setup(harness, { policy: { retireGraceMs: null } });
      await fixture.ask();
      await fixture.settled();
      const environmentId = await fixture.attach();
      await sweepProviderEnvironment(harness.deps, environmentId);
      expect(await getEnvironment(harness.db, environmentId)).toMatchObject({
        retireAt: null,
        teardownStatus: null,
        status: "ready",
      });
      expect(
        (
          await harness.app.request(
            `/api/v1/environments/${environmentId}/cleanup`,
            { method: "POST" },
          )
        ).status,
      ).toBe(200);
      await expect
        .poll(
          async () =>
            (await getEnvironment(harness.db, environmentId))?.teardownStatus,
        )
        .toBe("removed");
      expect((await getEnvironment(harness.db, environmentId))?.status).toBe(
        "destroyed",
      );
    }));

  it("cancels retirement when a live thread returns", async () =>
    await withTestHarness(async (harness) => {
      const fixture = await setup(harness, {
        policy: { retireGraceMs: 60_000 },
      });
      await fixture.ask();
      await fixture.settled();
      const environmentId = await fixture.attach();
      await sweepProviderEnvironment(harness.deps, environmentId);
      expect(
        (await getEnvironment(harness.db, environmentId))?.retireAt,
      ).not.toBeNull();
      await updateThread(harness.db, harness.hub, fixture.thread.id, {
        environmentId,
      });
      await sweepProviderEnvironment(harness.deps, environmentId);
      expect(
        (await getEnvironment(harness.db, environmentId))?.retireAt,
      ).toBeNull();
    }));

  it("waits for an archived runtime to stop before remove", async () =>
    await withTestHarness(async (harness) => {
      let removes = 0;
      const fixture = await setup(harness, {
        policy: { retireGraceMs: 0 },
        remove: async () => {
          removes += 1;
          return { status: "removed" };
        },
      });
      await fixture.ask();
      await fixture.settled();
      const environmentId = await fixture.attach();
      await harness.db
        .update(threads)
        .set({
          environmentId,
          archivedAt: Date.now(),
          status: "stopping",
        })
        .where(eq(threads.id, fixture.thread.id))
        .run();
      await sweepProviderEnvironment(harness.deps, environmentId);
      expect(removes).toBe(0);
      await harness.db
        .update(threads)
        .set({ status: "idle" })
        .where(eq(threads.id, fixture.thread.id))
        .run();
      await sweepProviderEnvironment(harness.deps, environmentId);
      expect(removes).toBe(1);
    }));

  it("removes an expired environment through the periodic sweep", async () =>
    await withTestHarness(async (harness) => {
      const fixture = await setup(harness, { policy: { retireGraceMs: 0 } });
      await fixture.ask();
      await fixture.settled();
      const environmentId = await fixture.attach();
      await harness.db
        .update(threads)
        .set({ status: "idle" })
        .where(eq(threads.id, fixture.thread.id))
        .run();
      await runPeriodicSweeps({
        ...harness.deps,
        pluginSchedules: harness.pluginService,
        plugins: harness.pluginService,
      });
      expect(await getEnvironment(harness.db, environmentId)).toMatchObject({
        status: "destroyed",
        teardownStatus: "removed",
        teardownAttempt: 1,
      });
    }));

  it.each([
    { retireGraceMs: 0, ownsPath: true },
    { retireGraceMs: null, ownsPath: true },
    { retireGraceMs: null, ownsPath: false },
  ])(
    "allows provider source cleanup during project deletion with grace $retireGraceMs and ownsPath $ownsPath",
    async ({ retireGraceMs, ownsPath }) =>
      await withTestHarness(async (harness) => {
        let cleanupStatus = 0;
        const fixture = await setup(harness, {
          policy: { retireGraceMs },
          create: async () => ({
            status: "created",
            path: "/tmp/project-cleanup",
            ownsPath,
          }),
          remove: async (context) => {
            const projectId = await context.environment?.projectId;
            if (projectId === undefined) throw new Error("Missing project");
            const response = await harness.app.request(
              `/api/v1/projects/${projectId}/sources/${fixture.source.id}`,
              { method: "DELETE" },
            );
            cleanupStatus = response.status;
            return response.ok
              ? { status: "removed" }
              : { status: "failed", message: await response.text() };
          },
        });
        await fixture.ask();
        await fixture.settled();
        const environmentId = await fixture.attach();
        await harness.db
          .update(threads)
          .set({ status: "idle" })
          .where(eq(threads.id, fixture.thread.id))
          .run();
        await beginProjectDeletion(harness.deps, {
          projectId: fixture.context.project.id,
        });
        await advanceProjectDeletion(harness.deps, {
          projectId: fixture.context.project.id,
        });
        expect(
          cleanupStatus,
          JSON.stringify(await getEnvironment(harness.db, environmentId)),
        ).toBe(200);
        expect(await getEnvironment(harness.db, environmentId)).toBeNull();
        expect(
          await getProject(harness.db, fixture.context.project.id),
        ).toBeNull();
      }),
  );
});

it("keeps one environment identity from provider creation through removal", async () => {
  await withTestHarness(async (harness) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = await setup(harness, {
      policy: { retireGraceMs: 0 },
      create: async (context) => {
        await gate;
        return {
          status: "created",
          path: `/tmp/${context.pathKey}`,
          ownsPath: true,
          resource: { checkpoint: "allocated" },
        };
      },
    });
    await fixture.ask();
    const reserved = (await fixture.row()).id;
    expect((await getEnvironment(harness.db, reserved))?.status).toBe(
      "creating",
    );
    release();
    await fixture.settled();
    expect((await fixture.row()).id).toBe(reserved);
    expect(await fixture.attach()).toBe(reserved);
    expect(
      await harness.db
        .select()
        .from(environments)
        .where(eq(environments.projectId, fixture.context.project.id))
        .all(),
    ).toHaveLength(1);
    await cancelProviderEnvironmentCreation(harness.deps, fixture.thread.id);
    expect((await getEnvironment(harness.db, reserved))?.resource).toEqual({
      checkpoint: "allocated",
    });
    await sweepProviderEnvironment(harness.deps, reserved);
    expect((await getEnvironment(harness.db, reserved))?.status).toBe(
      "destroyed",
    );
  });
});

it("shares one removal operation between cancellation and lifecycle sweeps", async () => {
  await withTestHarness(async (harness) => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const remove = vi.fn(async () => {
      await gate;
      return { status: "removed" as const };
    });
    const fixture = await setup(harness, { remove });
    await fixture.ask();
    await fixture.settled();
    const environmentId = (await fixture.row()).id;
    const cancellation = cancelProviderEnvironmentCreation(
      harness.deps,
      fixture.thread.id,
    );
    await expect.poll(() => remove.mock.calls.length).toBe(1);
    const sweep = sweepProviderEnvironment(harness.deps, environmentId);
    const all = sweepProviderLifecycles(harness.deps);
    try {
      expect((await fixture.row()).teardownStatus).toBe("running");
      expect(remove).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await Promise.all([cancellation, sweep, all]);
    }
    expect(remove).toHaveBeenCalledTimes(1);
    expect(await getEnvironment(harness.db, environmentId)).toMatchObject({
      status: "destroyed",
      teardownStatus: "removed",
    });
  });
});

it.each([false, true])(
  "recovers exhausted provider cleanup without an owned workspace (path absent=%s)",
  async (pathAbsent) => {
    await withTestHarness(async (harness) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const attempts: number[] = [];
      const fixture = await setup(harness, {
        create: async () => ({
          status: "created",
          path: "/tmp/cancel-retry",
          ownsPath: false,
          resource: { allocation: "retained" },
        }),
        remove: async ({ attempt, resource }) => {
          attempts.push(attempt);
          expect(resource).toEqual({ allocation: "retained" });
          return attempts.length <= 5
            ? { status: "failed", message: "temporarily unavailable" }
            : { status: "removed" };
        },
      });
      await fixture.ask();
      await fixture.settled();
      await expect(
        cancelProviderEnvironmentCreation(harness.deps, fixture.thread.id),
      ).rejects.toThrow("temporarily unavailable");
      const failed = await fixture.row();
      if (pathAbsent)
        await harness.db
          .update(environments)
          .set({ path: null })
          .where(eq(environments.id, failed.id))
          .run();
      expect(failed).toMatchObject({
        status: "error",
        teardownStatus: "failed",
        claimPath: "/tmp/cancel-retry",
        resource: { allocation: "retained" },
      });
      await sweepProviderLifecycles(harness.deps);
      expect(attempts).toEqual([1]);
      for (let attempt = 2; attempt <= 5; attempt++) {
        vi.setSystemTime((await fixture.row()).retireAt!);
        await sweepProviderLifecycles(harness.deps);
      }
      expect(attempts).toEqual([1, 2, 3, 4, 5]);
      expect((await fixture.row()).retireAt).toBeNull();
      await harness.db
        .update(threads)
        .set({ status: "idle", archivedAt: Date.now() })
        .where(eq(threads.id, fixture.thread.id))
        .run();
      const response = await harness.app.request(
        `/api/v1/environments/${failed.id}/cleanup?recover=true`,
        { method: "POST" },
      );
      expect(response.status).toBe(200);
      expect(attempts).toEqual([1, 2, 3, 4, 5, 1]);
      expect(
        await harness.db.select().from(environmentHookOperations).all(),
      ).toEqual([]);
      expect(await fixture.row()).toMatchObject({
        id: failed.id,
        status: "destroyed",
        teardownStatus: "removed",
        claimPath: null,
        resource: null,
      });
    });
  },
);

it("skips environments blocked on a foreign plugin owner until that plugin provides them again", async () => {
  await withTestHarness(async (harness) => {
    const remove = vi.fn(async () => ({ status: "removed" as const }));
    const fixture = await setup(harness, {
      policy: { retireGraceMs: 60_000 },
      remove,
    });
    const blockedIds = await Promise.all(
      Array.from(
        { length: 200 },
        async (_, index) =>
          (
            await seedEnvironment(harness.deps, {
              hostId: fixture.host.id,
              projectId: fixture.context.project.id,
              path: `/tmp/blocked-${index}`,
              environmentProviderId: fixture.record.provider.id,
              environmentProviderPluginId: "previous-owner",
            })
          ).id,
      ),
    );
    await sweepProviderLifecycles(harness.deps);
    const blockedRows = async () =>
      await Promise.all(
        blockedIds.map(async (id) => await getEnvironment(harness.db, id)),
      );
    const blockedBefore = await blockedRows();
    expect(
      blockedBefore.every(
        (row) => row?.teardownStatus === "failed" && row.retireAt === null,
      ),
    ).toBe(true);

    const retryable = await seedEnvironment(harness.deps, {
      hostId: fixture.host.id,
      projectId: fixture.context.project.id,
      path: "/tmp/retryable",
      status: "error",
      environmentProviderId: fixture.record.provider.id,
      environmentProviderPluginId: fixture.record.pluginId,
    });
    await harness.db
      .update(environments)
      .set({
        teardownStatus: "failed",
        teardownMessage: "temporarily unavailable",
        teardownAttempt: 1,
        retireAt: Date.now() - 1,
      })
      .where(eq(environments.id, retryable.id))
      .run();
    const lookups = vi.fn();
    const bridge = (record: typeof fixture.record) => ({
      listEnvironmentProviders: () => [record],
      getEnvironmentProvider: (id: string) => {
        lookups(id);
        return id === record.provider.id ? record : undefined;
      },
      invokeProvider: async <T>(
        _id: string,
        _label: string,
        run: () => Promise<T>,
      ) => ({ ok: true as const, value: await run() }),
      decisionTimeoutMs: 10_000,
    });
    setPluginEnvironmentProviderBridge(bridge(fixture.record));

    await sweepProviderLifecycles(harness.deps);

    expect(remove).toHaveBeenCalledOnce();
    expect(
      (await getEnvironment(harness.db, retryable.id))?.teardownStatus,
    ).toBe("removed");
    expect(lookups.mock.calls.length).toBeLessThan(10);
    expect(await blockedRows()).toEqual(blockedBefore);

    setPluginEnvironmentProviderBridge(
      bridge({ ...fixture.record, pluginId: "previous-owner" }),
    );
    await sweepProviderLifecycles(harness.deps);

    expect((await blockedRows()).every((row) => row?.retireAt !== null)).toBe(
      true,
    );
    expect(remove).toHaveBeenCalledOnce();
  });
});

it("prepares a previously removed path without inheriting completed teardown", async () => {
  await withTestHarness(async (harness) => {
    const remove = vi.fn(async () => ({ status: "removed" as const }));
    const fixture = await setup(harness, { remove });
    await fixture.ask();
    await fixture.settled();
    const environmentId = (await fixture.row()).id;
    await cancelProviderEnvironmentCreation(harness.deps, fixture.thread.id);
    await fixture.ask();
    await fixture.settled();
    expect(await fixture.row()).toMatchObject({
      attempt: 2,
      status: "provisioning",
      teardownStatus: null,
    });
    await cancelProviderEnvironmentCreation(harness.deps, fixture.thread.id);
    expect(remove).toHaveBeenCalledTimes(2);
    expect(
      (await getEnvironment(harness.db, environmentId))?.teardownStatus,
    ).toBe("removed");
    expect((await fixture.row()).teardownStatus).toBe("removed");
  });
});

it("keeps reserved environments provisioning while a provider creates their workspace", async () => {
  await withTestHarness(async (harness) => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = await setup(harness, {
      create: async () => {
        await gate;
        return {
          status: "created",
          path: "/tmp/swept-workspace",
          ownsPath: true,
        };
      },
    });
    await fixture.ask();
    try {
      await runEnvironmentProvisioningSweep(harness.deps);
      expect(await fixture.row()).toMatchObject({
        status: "creating",
      });
    } finally {
      release();
      await fixture.settled();
    }
    await runEnvironmentProvisioningSweep(harness.deps);
    expect(await fixture.row()).toMatchObject({
      status: "provisioning",
    });
  });
});

it("keeps a shared workspace ready when its preparing owner cancels before attachment", async () => {
  await withTestHarness(async (harness) => {
    const remove = vi.fn(async () => ({ status: "removed" as const }));
    const fixture = await setup(harness, {
      create: async () => ({
        status: "created",
        path: "/tmp/shared-ready",
        ownsPath: false,
      }),
      remove,
    });
    const shared = await createEnvironment(harness.db, harness.hub, {
      projectId: fixture.context.project.id,
      hostId: fixture.host.id,
      path: "/tmp/shared-ready",
      status: "ready",
      providerOwnsPath: false,
    });
    const existingThread = await seedThread(harness.deps, {
      projectId: fixture.context.project.id,
      environmentId: shared.id,
      status: "idle",
    });
    await fixture.ask();
    await expect
      .poll(
        async () =>
          (await getPreparingEnvironment(harness.db, fixture.thread.id))?.id,
      )
      .toBe(shared.id);
    expect(await getEnvironment(harness.db, shared.id)).toMatchObject({
      status: "ready",
      ownerThreadId: fixture.thread.id,
    });
    expect(
      (await getThread(harness.db, fixture.thread.id))?.environmentId,
    ).toBeNull();
    await saveProviderStartup(harness, fixture);
    await requestThreadStopForCurrentState(harness.deps, fixture.thread, null);
    await expect
      .poll(
        async () =>
          (await getEnvironment(harness.db, shared.id))?.ownerThreadId,
      )
      .toBeNull();
    await expect.poll(async () => await getEnvironment(harness.db, shared.id)).toMatchObject({
      status: "ready",
      claimPath: null,
      teardownStatus: null,
      retireAt: null,
    });
    expect(
      (await getThread(harness.db, existingThread.id))?.environmentId,
    ).toBe(shared.id);
    expect((await getThread(harness.db, fixture.thread.id))?.status).toBe(
      "idle",
    );
    const transcript = (
      await listEvents(harness.db, {
        threadId: fixture.thread.id,
      })
    ).filter((event) => event.type === "system/thread-provisioning");
    expect(
      systemThreadProvisioningEventDataSchema.parse(
        JSON.parse(transcript.at(-1)!.data),
      ).status,
    ).toBe("cancelled");
    expect(remove).not.toHaveBeenCalled();
  });
});

it("serializes concurrent branchless checkout attaches until the first thread is bound", async () =>
  await withTestHarness(async (harness) => {
    const fake = await createFakePluginHost({
      pluginId: "environment-project-checkout",
      experimental_callHostRpc: (call) => {
        if (call.method !== "attach") throw new Error("Unexpected host call");
        return {
          status: "attached",
          path: "/tmp/project",
          branchName: "main",
          mergeBaseBranch: null,
        };
      },
    });
    try {
      const module = await z
        .object({
          default: z.custom<(bb: BbPluginApi) => Promise<void>>(
            (value) => typeof value === "function",
          ),
        })
        .parse(
          await import(
            new URL(
              "../../../../../plugins/environment-project-checkout/server.ts",
              import.meta.url,
            ).href
          ),
        );
      await module.default(fake.bb);
      const provider =
        fake.harness.registrations.environmentProviders.get("project-checkout");
      if (!provider) throw new Error("Missing checkout provider");
      let claimAttempts = 0;
      let competingClaim = () => {};
      const competing = new Promise<void>((resolve) => {
        competingClaim = resolve;
      });
      const fixture = await setup(harness, {
        id: provider.id,
        create: (context) =>
          provider.create({
            ...context,
            experimental_claimPath: async (path) => {
              const claimed = await context.experimental_claimPath(path);
              if (++claimAttempts === 2) competingClaim();
              return claimed;
            },
          }),
        remove: provider.remove,
        requires: { projectCheckout: true },
      });
      fixture.context.projectCheckout = {
        path: "/tmp/project",
        experimental_ownsPath: false,
      };
      fixture.context.inputs = {};
      const existing = await createEnvironment(harness.db, harness.hub, {
        projectId: fixture.context.project.id,
        hostId: fixture.host.id,
        path: "/tmp/project",
        status: "ready",
        providerOwnsPath: false,
      });
      await fixture.ask();
      await fixture.settled();
      expect((await fixture.row()).id).toBe(existing.id);
      expect((await fixture.row()).claimPath).toBe("/tmp/project");
      const competitor = await seedThread(harness.deps, {
        projectId: fixture.context.project.id,
        status: "starting",
      });
      await prepareProviderEnvironment(harness.deps, fixture.record, {
        ...fixture.context,
        thread: await toThreadResponseFromThread(harness.deps, {
          thread: competitor,
        }),
      });
      await competing;
      await fixture.attach();
      await expect
        .poll(async () => {
          const row = await getPreparingEnvironment(harness.db, competitor.id);
          return { status: row?.status, message: row?.statusMessage };
        })
        .toMatchObject({ status: "ready" });
      const second = getPreparingEnvironment(harness.db, competitor.id);
      expect((await second)?.id).toBe(existing.id);
      await markProviderEnvironmentAttached(
        harness.db,
        competitor.id,
        existing.id,
      );
    } finally {
      await fake.harness.lifecycle.dispose();
    }
  }));

describe("existing-path provider selection", () => {
  it.each([true, false])(
    "reuses a recorded path without create and preserves ownership %s",
    async (ownsPath) =>
      await withTestHarness(async (harness) => {
        const create = vi.fn<PluginEnvironmentProviderDeclaration["create"]>();
        const remove = vi.fn<PluginEnvironmentProviderDeclaration["remove"]>(
          async () => ({ status: "removed" }),
        );
        const fixture = await setup(harness, {
          experimental_existingPath: () => "/tmp/existing/",
          create,
          remove,
          policy: { retireGraceMs: 0 },
        });
        const existing = await seedEnvironment(harness.deps, {
          projectId: fixture.context.project.id,
          hostId: fixture.host.id,
          path: "/tmp/existing",
          providerOwnsPath: ownsPath,
          environmentProviderId: fixture.record.provider.id,
          environmentProviderPluginId: "test",
          environmentProviderInstanceKey: "original-key",
          mergeBaseBranch: "release",
        });
        await harness.db
          .update(environments)
          .set({ resource: { original: true } })
          .where(eq(environments.id, existing.id))
          .run();
        const before = await getEnvironment(harness.db, existing.id);
        const placement = await resolveThreadEnvironmentPlacement(
          harness.deps,
          {
            projectId: fixture.context.project.id,
            requestedEnvironment: {
              type: "provider",
              environmentProviderId: fixture.record.provider.id,
              machine: { type: "existing", hostId: fixture.host.id },
              inputs: null,
            },
          },
        );
        expect(placement).toEqual({
          environmentId: existing.id,
          environmentIntent: { type: "reuse", environmentId: existing.id },
        });
        expect(create).not.toHaveBeenCalled();
        expect(await getEnvironment(harness.db, existing.id)).toEqual(before);
        await sweepProviderEnvironment(harness.deps, existing.id);
        expect(remove).toHaveBeenCalledWith(
          expect.objectContaining({
            path: "/tmp/existing",
            pathKey: "original-key",
            resource: { original: true },
          }),
        );
        expect(
          (await getEnvironment(harness.db, existing.id))?.teardownStatus,
        ).toBe("removed");
      }),
  );

  it("leaves an unrecorded path to provider creation", async () =>
    await withTestHarness(async (harness) => {
      const fixture = await setup(harness, {
        experimental_existingPath: () => "/tmp/unrecorded",
      });
      const placement = await resolveThreadEnvironmentPlacement(harness.deps, {
        projectId: fixture.context.project.id,
        requestedEnvironment: {
          type: "provider",
          environmentProviderId: fixture.record.provider.id,
          machine: { type: "existing", hostId: fixture.host.id },
          inputs: null,
        },
      });
      expect(placement.environmentId).toBeNull();
      expect(placement.environmentIntent.type).toBe("provider");
    }));

  it.each(["error", "cleanup", "foreign"])(
    "refuses an existing path in %s state",
    async (state) =>
      await withTestHarness(async (harness) => {
        const fixture = await setup(harness, {
          experimental_existingPath: () => "/tmp/existing",
        });
        const other =
          state === "foreign"
            ? (
                await seedProjectWithSource(harness.deps, {
                  hostId: fixture.host.id,
                  name: "Other",
                })
              ).project
            : fixture.context.project;
        const existing = await seedEnvironment(harness.deps, {
          projectId: other.id,
          hostId: fixture.host.id,
          path: "/tmp/existing",
          status: state === "error" ? "error" : "ready",
          providerOwnsPath: true,
        });
        if (state === "cleanup")
          await harness.db
            .update(environments)
            .set({ teardownStatus: "running" })
            .where(eq(environments.id, existing.id))
            .run();
        await expect(
          resolveThreadEnvironmentPlacement(harness.deps, {
            projectId: fixture.context.project.id,
            requestedEnvironment: {
              type: "provider",
              environmentProviderId: fixture.record.provider.id,
              machine: { type: "existing", hostId: fixture.host.id },
              inputs: null,
            },
          }),
        ).rejects.toThrow();
      }),
  );

  it("does not cancel an adopted checkout with a previous selection", async () =>
    await withTestHarness(async (harness) => {
      const remove = vi.fn<PluginEnvironmentProviderDeclaration["remove"]>(
        async () => ({ status: "removed" }),
      );
      const fixture = await setup(harness, {
        create: async () => ({
          status: "created",
          path: "/tmp/adoption-regression",
          ownsPath: false,
        }),
        remove,
        policy: { retireGraceMs: null },
      });
      const existing = await seedEnvironment(harness.deps, {
        projectId: fixture.context.project.id,
        hostId: fixture.host.id,
        path: "/tmp/adoption-regression",
        status: "ready",
        providerOwnsPath: false,
        environmentProviderId: fixture.record.provider.id,
        environmentProviderPluginId: "test",
        environmentProviderInstanceKey: "original-key",
      });
      await harness.db
        .update(environments)
        .set({
          environmentProviderSelection: {
            machine: fixture.context.machine,
            inputs: { branch: { kind: "new", baseBranch: "main" } },
          },
        })
        .where(eq(environments.id, existing.id))
        .run();
      await fixture.ask();
      await fixture.settled();
      expect((await fixture.row()).id).toBe(existing.id);
      const next = await fixture.ask();
      await sweepProviderEnvironment(harness.deps, existing.id);
      expect((await getEnvironment(harness.db, existing.id))?.status).toBe(
        "ready",
      );
      expect(next.action).toBe("ready");
      expect(remove).not.toHaveBeenCalled();
    }));

  it.each([null, 60_000])(
    "hands a taken-over environment to retirement policy %s when its thread cancels",
    async (retireGraceMs) =>
      await withTestHarness(async (harness) => {
        const remove = vi.fn<PluginEnvironmentProviderDeclaration["remove"]>(
          async () => ({ status: "removed" }),
        );
        const fixture = await setup(harness, {
          create: async () => ({
            status: "created",
            path: "/tmp/taken-over",
            ownsPath: false,
          }),
          remove,
          policy: { retireGraceMs },
        });
        const existing = await seedEnvironment(harness.deps, {
          projectId: fixture.context.project.id,
          hostId: fixture.host.id,
          path: "/tmp/taken-over",
          status: "ready",
          providerOwnsPath: false,
          environmentProviderId: fixture.record.provider.id,
          environmentProviderPluginId: "test",
          environmentProviderInstanceKey: "original-key",
        });
        await fixture.ask();
        await fixture.settled();
        expect((await fixture.row()).id).toBe(existing.id);
        await cancelProviderEnvironmentCreation(
          harness.deps,
          fixture.thread.id,
        );
        await sweepProviderEnvironment(harness.deps, existing.id);
        const current = await getEnvironment(harness.db, existing.id);
        expect(current).toMatchObject({
          status: "ready",
          ownerThreadId: null,
          claimPath: null,
          teardownStatus: null,
        });
        if (retireGraceMs === null) expect(current?.retireAt).toBeNull();
        else expect(current?.retireAt).toBeGreaterThan(Date.now());
        expect(remove).not.toHaveBeenCalled();
      }),
  );

  it("keeps a taken-over environment when creation finishes during cancellation", async () =>
    await withTestHarness(async (harness) => {
      const remove = vi.fn<PluginEnvironmentProviderDeclaration["remove"]>(
        async () => ({ status: "removed" }),
      );
      let finishCreate: () => void = () => undefined;
      const created = new Promise<void>((resolve) => {
        finishCreate = resolve;
      });
      const create = vi.fn<PluginEnvironmentProviderDeclaration["create"]>(
        async () => {
          await created;
          return {
            status: "created",
            path: "/tmp/cancelled-takeover",
            ownsPath: false,
          };
        },
      );
      const fixture = await setup(harness, {
        create,
        remove,
        policy: { retireGraceMs: null },
      });
      const existing = await seedEnvironment(harness.deps, {
        projectId: fixture.context.project.id,
        hostId: fixture.host.id,
        path: "/tmp/cancelled-takeover",
        status: "ready",
        providerOwnsPath: false,
        environmentProviderId: fixture.record.provider.id,
        environmentProviderPluginId: "test",
        environmentProviderInstanceKey: "original-key",
      });
      await fixture.ask();
      await expect.poll(() => create.mock.calls.length).toBe(1);
      const cancelled = cancelProviderEnvironmentCreation(
        harness.deps,
        fixture.thread.id,
      );
      finishCreate();
      await cancelled;
      expect(await getEnvironment(harness.db, existing.id)).toMatchObject({
        status: "ready",
        ownerThreadId: null,
        teardownStatus: null,
      });
      expect(remove).not.toHaveBeenCalled();
    }));

  it("retires a cancelled thread's own ready environment after the grace period", async () =>
    await withTestHarness(async (harness) => {
      const remove = vi.fn<PluginEnvironmentProviderDeclaration["remove"]>(
        async () => ({ status: "removed" }),
      );
      const fixture = await setup(harness, {
        remove,
        policy: { retireGraceMs: 60_000 },
      });
      await fixture.ask();
      await fixture.settled();
      const own = await fixture.row();
      await harness.db
        .update(environments)
        .set({ status: "ready" })
        .where(eq(environments.id, own.id))
        .run();
      await cancelProviderEnvironmentCreation(harness.deps, fixture.thread.id);
      const released = await getEnvironment(harness.db, own.id);
      expect(released).toMatchObject({
        status: "ready",
        ownerThreadId: null,
        teardownStatus: null,
      });
      expect(released?.retireAt).toBeGreaterThan(Date.now());
      expect(remove).not.toHaveBeenCalled();
      await harness.db
        .update(environments)
        .set({ retireAt: Date.now() - 1 })
        .where(eq(environments.id, own.id))
        .run();
      await sweepProviderEnvironment(harness.deps, own.id);
      expect((await getEnvironment(harness.db, own.id))?.status).toBe(
        "destroyed",
      );
      expect(remove).toHaveBeenCalledTimes(1);
    }));

  it("keeps the existing cleanup metadata when creation races with another attachment", async () =>
    await withTestHarness(async (harness) => {
      const remove = vi.fn<PluginEnvironmentProviderDeclaration["remove"]>(
        async () => ({ status: "removed" }),
      );
      const fixture = await setup(harness, {
        create: async () => ({
          status: "created",
          path: "/tmp/existing",
          ownsPath: false,
          resource: { adopted: true },
        }),
        remove,
        policy: { retireGraceMs: 0 },
      });
      const existing = await seedEnvironment(harness.deps, {
        projectId: fixture.context.project.id,
        hostId: fixture.host.id,
        path: "/tmp/existing",
        providerOwnsPath: true,
        environmentProviderId: fixture.record.provider.id,
        environmentProviderPluginId: "test",
        environmentProviderInstanceKey: "original-key",
        mergeBaseBranch: "release",
      });
      await harness.db
        .update(environments)
        .set({ resource: { original: true } })
        .where(eq(environments.id, existing.id))
        .run();
      await fixture.ask();
      await fixture.settled();
      expect(await fixture.row()).toMatchObject({
        id: existing.id,
        providerOwnsPath: true,
        resource: { original: true },
        mergeBaseBranch: "release",
        environmentProviderInstanceKey: "original-key",
        environmentProviderSelection: existing.environmentProviderSelection,
      });
      await fixture.attach();
      await sweepProviderEnvironment(harness.deps, existing.id);
      expect(remove).toHaveBeenCalledWith(
        expect.objectContaining({
          path: "/tmp/existing",
          pathKey: "original-key",
          resource: { original: true },
        }),
      );
    }));
});

describe("worktree adoption cleanup", () => {
  it.each([true, false])(
    "retains the real worktree provider cleanup behavior for owned=%s",
    async (owned) =>
      await withTestHarness(async (harness) => {
        const fixture = await setup(harness);
        const fake = createFakePluginHost({
          pluginId: "environment-git-worktree",
          experimental_callHostRpc: async ({ method }) => {
            if (method !== "remove")
              throw new Error(`Unexpected host operation: ${method}`);
            return { status: "removed" };
          },
        });
        const module = await z
          .object({
            default: z.custom<(bb: BbPluginApi) => Promise<void>>(
              (value) => typeof value === "function",
            ),
          })
          .parse(
            await import(
              new URL(
                "../../../../../plugins/environment-git-worktree/server.ts",
                import.meta.url,
              ).href
            ),
          );
        await module.default(fake.bb);
        const provider =
          fake.harness.registrations.environmentProviders.get("git-worktree");
        if (provider === undefined)
          throw new Error("Missing worktree provider");
        const record = { pluginId: "environment-git-worktree", provider };
        setPluginEnvironmentProviderBridge({
          listEnvironmentProviders: () => [record],
          getEnvironmentProvider: (id) =>
            id === provider.id ? record : undefined,
          invokeProvider: async (_id, _label, run) => ({
            ok: true,
            value: await run(),
          }),
          decisionTimeoutMs: 10_000,
        });
        const existing = await seedEnvironment(harness.deps, {
          projectId: fixture.context.project.id,
          hostId: fixture.host.id,
          path: "/tmp/legacy-worktree",
          providerOwnsPath: owned,
          environmentProviderId: "git-worktree",
          environmentProviderPluginId: record.pluginId,
          environmentProviderInstanceKey: "original-key",
          mergeBaseBranch: "release",
        });
        await harness.db
          .update(environments)
          .set({
            resource: owned ? null : { adopted: true },
            retireAt: Date.now() - 1,
          })
          .where(eq(environments.id, existing.id))
          .run();
        const placement = await resolveThreadEnvironmentPlacement(
          harness.deps,
          {
            projectId: fixture.context.project.id,
            requestedEnvironment: {
              type: "provider",
              environmentProviderId: "git-worktree",
              machine: { type: "existing", hostId: fixture.host.id },
              inputs: { kind: "existing", path: existing.path },
            },
          },
        );
        expect(placement.environmentId).toBe(existing.id);
        expect(fake.harness.experimental_hostRpcCalls).toHaveLength(0);
        await sweepProviderEnvironment(harness.deps, existing.id);
        expect(
          (await getEnvironment(harness.db, existing.id))?.teardownStatus,
        ).toBe("removed");
        expect(fake.harness.experimental_hostRpcCalls).toHaveLength(
          owned ? 1 : 0,
        );
        if (owned)
          expect(fake.harness.experimental_hostRpcCalls[0]).toMatchObject({
            method: "remove",
            input: { path: existing.path, pathKey: "original-key" },
          });
      }),
  );
});

it.each([
  { persisted: false, attached: false },
  { persisted: true, attached: false },
  { persisted: false, attached: true },
  { persisted: true, attached: true },
])(
  "bounds ambiguous setup cleanup retries with %j",
  async ({ persisted, attached }) => {
    await withTestHarness(async (harness) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const remove = vi.fn(async () => ({ status: "removed" as const }));
      const fixture = await setup(harness, { remove });
      const cancel = vi.fn(async () => ({ status: "unknown" as const }));
      await registerTestHostRpcCapture(harness.deps, {
        hostId: fixture.host.id,
        sessionId: fixture.session.id,
        onEnvironmentHookCancel: cancel,
      });
      await fixture.ask();
      await fixture.settled();
      const row = await fixture.row();
      const hookId = `environment:${row.id}:${row.environmentProviderInstanceKey}:setup`;
      if (persisted)
        await harness.db
          .insert(environmentHookOperations)
          .values({
            id: hookId,
            operationId: hookId,
            hostId: fixture.host.id,
            path: row.path!,
            kind: "setup",
            startedAt: Date.now() - 60_000,
          })
          .run();
      if (attached) {
        await fixture.attach();
        await harness.db
          .update(environments)
          .set({ status: persisted ? "ready" : "error", retireAt: Date.now() })
          .where(eq(environments.id, row.id))
          .run();
        await harness.db
          .update(threads)
          .set({ status: "error", archivedAt: Date.now() })
          .where(eq(threads.id, fixture.thread.id))
          .run();
        await sweepProviderEnvironment(harness.deps, row.id);
      } else {
        await expect(
          cancelProviderEnvironmentCreation(harness.deps, fixture.thread.id),
        ).rejects.toThrow();
      }
      for (let attempt = 1; attempt <= 5; attempt++) {
        const failed = await fixture.row();
        expect(failed.teardownStatus).toBe("failed");
        expect(failed.teardownAttempt).toBe(attempt);
        expect(cancel).toHaveBeenCalledTimes(attempt);
        await sweepProviderLifecycles(harness.deps);
        expect(cancel).toHaveBeenCalledTimes(attempt);
        if (attempt < 5) {
          expect(failed.retireAt).toBe(
            Date.now() + 60_000 * 2 ** (attempt - 1),
          );
          vi.setSystemTime(failed.retireAt!);
          await sweepProviderLifecycles(harness.deps);
        }
      }
      expect(await fixture.row()).toMatchObject({
        retireAt: null,
        teardownMessage: expect.stringContaining("Needs recovery"),
      });
      vi.setSystemTime(Date.now() + 86_400_000);
      await sweepProviderLifecycles(harness.deps);
      expect(cancel).toHaveBeenCalledTimes(5);
      expect(remove).not.toHaveBeenCalled();
      if (persisted)
        expect(
          (
            await harness.db
              .select()
              .from(environmentHookOperations)
              .where(eq(environmentHookOperations.id, hookId))
              .get()
          )?.finishedAt,
        ).toBeNull();
      const response = await harness.app.request(
        `/api/v1/environments/${row.id}/cleanup`,
        { method: "POST" },
      );
      expect(response.status).toBe(409);
      expect(await response.text()).toContain("--recover");
    });
  },
);

it.each([false, true])(
  "recovers interrupted cleanup only after a clear process inspection (persisted hook=%s)",
  async (persisted) => {
    await withTestHarness(async (harness) => {
      const remove = vi.fn(async () => ({ status: "removed" as const }));
      const fixture = await setup(harness, { remove });
      await registerTestHostRpcCapture(harness.deps, {
        hostId: fixture.host.id,
        sessionId: fixture.session.id,
        onEnvironmentHookCancel: async () => ({ status: "unknown" }),
      });
      await fixture.ask();
      await fixture.settled();
      const row = await fixture.row();
      const hookId = `environment:${row.id}:${row.environmentProviderInstanceKey}:setup`;
      if (persisted)
        await harness.db
          .insert(environmentHookOperations)
          .values({
            id: hookId,
            operationId: hookId,
            hostId: fixture.host.id,
            path: row.path!,
            kind: "setup",
            startedAt: Date.now() - 60_000,
          })
          .run();
      await expect(
        cancelProviderEnvironmentCreation(harness.deps, fixture.thread.id),
      ).rejects.toThrow();
      await harness.db
        .update(threads)
        .set({ status: "idle", archivedAt: Date.now() })
        .where(eq(threads.id, fixture.thread.id))
        .run();
      const unsupported = await registerHostRpcResponder(harness, {
        hostId: fixture.host.id,
        sessionId: fixture.session.id,
        handle: async () => {
          throw new Error("Unsupported RPC reached old daemon");
        },
      });
      for (const protocolVersion of [246, 247, 248]) {
        await harness.db
          .update(hostDaemonSessions)
          .set({ protocolVersion })
          .where(eq(hostDaemonSessions.id, fixture.session.id))
          .run();
        const response = await harness.app.request(
          `/api/v1/environments/${row.id}/cleanup?recover=true`,
          { method: "POST" },
        );
        expect(response.status).toBe(409);
        expect(await response.text()).toContain("Update this machine");
        expect(unsupported.requests).toHaveLength(0);
        expect(
          harness.deps.hub.getDaemonSessionIdForHost(fixture.host.id),
        ).toBe(fixture.session.id);
        expect((await fixture.row()).teardownStatus).toBe("failed");
        expect(remove).not.toHaveBeenCalled();
        expect(
          (
            await harness.db
              .select()
              .from(environmentHookOperations)
              .where(eq(environmentHookOperations.id, hookId))
              .get()
          )?.finishedAt ?? null,
        ).toBeNull();
      }
      await harness.db
        .update(hostDaemonSessions)
        .set({ protocolVersion: fixture.session.protocolVersion })
        .where(eq(hostDaemonSessions.id, fixture.session.id))
        .run();
      for (const inspection of [
        { supported: true, active: false, pids: [123], unreadablePids: [] },
        { supported: true, active: false, pids: [], unreadablePids: [456] },
        { supported: true, active: true, pids: [], unreadablePids: [] },
        { supported: false, active: false, pids: [], unreadablePids: [] },
        { supported: true, active: false, pids: [], unreadablePids: [] },
      ]) {
        let teardownRan = false;
        await registerHostRpcResponder(harness, {
          hostId: fixture.host.id,
          sessionId: fixture.session.id,
          handle: async ({ command }) => {
            if (command.type === "environment.inspect_cleanup")
              return { ok: true, result: inspection };
            if (command.type === "environment.hook.run") {
              teardownRan = true;
              return { ok: true, result: {} };
            }
            throw new Error(`Unexpected RPC: ${command.type}`);
          },
        });
        const response = await harness.app.request(
          `/api/v1/environments/${row.id}/cleanup?recover=true`,
          { method: "POST" },
        );
        const clear =
          inspection.supported &&
          !inspection.active &&
          inspection.pids.length === 0 &&
          inspection.unreadablePids.length === 0;
        expect(response.status).toBe(clear ? 200 : 409);
        const hook = await harness.db
          .select()
          .from(environmentHookOperations)
          .where(eq(environmentHookOperations.id, hookId))
          .get();
        if (clear) {
          expect(hook?.finishedAt).toEqual(expect.any(Number));
          expect((await fixture.row()).teardownStatus).toBe("removed");
          expect(remove).toHaveBeenCalledOnce();
          expect(teardownRan).toBe(true);
        } else {
          expect(hook?.finishedAt ?? null).toBeNull();
          expect((await fixture.row()).teardownStatus).toBe("failed");
          expect(remove).not.toHaveBeenCalled();
        }
      }
    });
  },
);
