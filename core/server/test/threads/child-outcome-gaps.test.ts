import {
  getQueuedThreadMessage,
  listEvents,
  listQueuedThreadMessages,
} from "@hyperfide/db";
import {
  threadScope,
  turnScope,
  turnRequestEventDataSchema,
} from "@hyperfide/domain";
import { groupHostDaemonEvents } from "@hyperfide/host-daemon-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { finalizeStoppedThread } from "../../src/services/threads/thread-lifecycle.js";
import { queueChildThreadTurnNotificationBestEffort } from "../../src/services/threads/child-thread-notifications.js";
import { interruptEnvironmentProvisioningForHost } from "../../src/services/environments/environment-engine.js";
import { failThreadProvisioning } from "../../src/services/threads/thread-provisioning-environment.js";
import { recordQueuedMessageDrainFailure } from "../../src/services/threads/queue-drain-failure.js";
import {
  seedQueuedMessage,
  seedEnvironment,
  seedEvent,
  seedHost,
  seedThread,
  seedThreadFixture,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import { textInput } from "../helpers/prompt-input.js";
import { internalAuthHeaders } from "../helpers/commands.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

async function seedParentAndChild(
  harness: TestAppHarness,
  childStatus: "active" | "starting" | "idle",
) {
  const {
    project,
    environment,
    session,
    thread: parent,
  } = await seedThreadFixture(harness);
  await seedThreadRuntimeState(harness.deps, {
    threadId: parent.id,
    environmentId: environment.id,
    providerThreadId: "parent-provider-thread",
  });
  const child = await seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    parentThreadId: parent.id,
    status: childStatus,
    title: "Worker child",
  });
  return { parent, child, environment, session };
}

async function parentSystemRequests(
  harness: TestAppHarness,
  parentThreadId: string,
) {
  return (await listEvents(harness.db, { threadId: parentThreadId }))
    .filter((row) => row.type === "client/turn/requested")
    .map((row) => turnRequestEventDataSchema.parse(JSON.parse(row.data)))
    .filter((data) => data.initiator === "system");
}

afterEach(() => vi.useRealTimers());

describe("child outcomes without provider completion", () => {
  it("keeps a manual Stop silent when it synthesizes an open turn interruption", async () => {
    await withTestHarness(async (harness) => {
      const { parent, child, environment } = await seedParentAndChild(
        harness,
        "active",
      );
      await seedTurnStarted(harness.deps, {
        environmentId: environment.id,
        threadId: child.id,
        turnId: "child-turn",
      });

      vi.useFakeTimers();
      await finalizeStoppedThread(harness.deps, { threadId: child.id });
      await finalizeStoppedThread(harness.deps, { threadId: child.id });
      await vi.advanceTimersByTimeAsync(2_000);

      expect(await parentSystemRequests(harness, parent.id)).toHaveLength(0);
      expect(
        (await listEvents(harness.db, { threadId: child.id })).some(
          (event) =>
            event.type === "turn/completed" &&
            JSON.parse(event.data).status === "interrupted",
        ),
      ).toBe(true);
    });
  });

  it.each([
    { reason: "manual-stop", expectedNotices: 0 },
    { reason: "host-daemon-restarted", expectedNotices: 1 },
  ])(
    "sends $expectedNotices parent notices for a provider interruption after $reason",
    async ({ reason, expectedNotices }) => {
      await withTestHarness(async (harness) => {
        const { parent, child, environment, session } =
          await seedParentAndChild(harness, "active");
        await seedTurnStarted(harness.deps, {
          environmentId: environment.id,
          threadId: child.id,
          turnId: "child-turn",
        });
        await seedEvent(harness.deps, {
          threadId: child.id,
          environmentId: environment.id,
          providerThreadId: "provider-child-turn",
          sequence: 2,
          type: "system/thread/interrupted",
          scope: threadScope(),
          data: { reason },
        });

        vi.useFakeTimers();
        const response = await harness.app.request("/internal/session/events", {
          method: "POST",
          headers: await internalAuthHeaders(harness),
          body: JSON.stringify({
            sessionId: session.id,
            eventGroups: groupHostDaemonEvents([
              {
                threadId: child.id,
                event: {
                  type: "turn/completed",
                  threadId: child.id,
                  providerThreadId: "provider-child-turn",
                  scope: turnScope("child-turn"),
                  status: "interrupted",
                },
              },
            ]),
          }),
        });
        expect(response.status).toBe(200);
        await vi.advanceTimersByTimeAsync(2_000);
        if (expectedNotices === 1) {
          await vi.waitFor(async () =>
            expect(await parentSystemRequests(harness, parent.id)).toHaveLength(
              1,
            ),
          );
          expect(
            (await parentSystemRequests(harness, parent.id))[0]
              ?.systemMessageSubject,
          ).toMatchObject({
            outcomes: [
              {
                threadId: child.id,
                status: "interrupted",
                interruption: { reason: "host-daemon-restarted" },
              },
            ],
          });
        } else {
          expect(await parentSystemRequests(harness, parent.id)).toHaveLength(
            0,
          );
        }
      });
    },
  );

  it("keeps each interruption cause attached to its child in a batch", async () => {
    await withTestHarness(async (harness) => {
      const { parent, child } = await seedParentAndChild(harness, "idle");
      const sibling = await seedThread(harness.deps, {
        projectId: parent.projectId,
        environmentId: child.environmentId,
        parentThreadId: parent.id,
        status: "idle",
        title: "Sibling child",
      });

      vi.useFakeTimers();
      await queueChildThreadTurnNotificationBestEffort(harness.deps, {
        childThread: child,
        parentThreadId: parent.id,
        turnStatus: "interrupted",
        interruption: {
          reason: "host-daemon-restarted",
          cause: "host-connection-lost",
        },
      });
      await queueChildThreadTurnNotificationBestEffort(harness.deps, {
        childThread: child,
        parentThreadId: parent.id,
        turnStatus: "interrupted",
      });
      await queueChildThreadTurnNotificationBestEffort(harness.deps, {
        childThread: sibling,
        parentThreadId: parent.id,
        turnStatus: "interrupted",
        interruption: { reason: "host-daemon-restarted" },
      });
      await vi.advanceTimersByTimeAsync(2_000);

      await vi.waitFor(async () =>
        expect(await parentSystemRequests(harness, parent.id)).toHaveLength(1),
      );
      const [notice] = await parentSystemRequests(harness, parent.id);
      expect(notice?.systemMessageKind).toBe("child-outcome-batch");
      expect(notice?.systemMessageSubject).toEqual({
        kind: "thread-batch",
        count: 2,
        outcomes: [
          {
            threadId: child.id,
            status: "interrupted",
            interruption: {
              reason: "host-daemon-restarted",
              cause: "host-connection-lost",
            },
          },
          {
            threadId: sibling.id,
            status: "interrupted",
            interruption: { reason: "host-daemon-restarted" },
          },
        ],
      });
      expect(JSON.stringify(notice?.input)).toContain(
        `@thread:${child.id} was interrupted because its host connection was lost`,
      );
      expect(JSON.stringify(notice?.input)).toContain(
        `@thread:${sibling.id} was interrupted because its host daemon restarted`,
      );
    });
  });

  it("notifies the parent when setup fails before the child starts a turn", async () => {
    await withTestHarness(async (harness) => {
      const { parent, child, environment } = await seedParentAndChild(
        harness,
        "starting",
      );

      vi.useFakeTimers();
      await failThreadProvisioning(harness.deps, {
        thread: child,
        environmentId: environment.id,
        detail: "Workspace setup failed",
      });
      await vi.advanceTimersByTimeAsync(2_000);

      await vi.waitFor(async () =>
        expect(await parentSystemRequests(harness, parent.id)).toMatchObject([
          { systemMessageKind: "child-failed" },
        ]),
      );
      expect(
        JSON.stringify(
          (await parentSystemRequests(harness, parent.id))[0]?.input,
        ),
      ).toContain("failed during workspace setup before a turn began");
    });
  });

  it("notifies the parent when an environment fails during setup", async () => {
    await withTestHarness(async (harness) => {
      const { parent } = await seedParentAndChild(harness, "idle");
      const host = await seedHost(harness.deps);
      const environment = await seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: parent.projectId,
        status: "provisioning",
      });
      await seedThread(harness.deps, {
        projectId: parent.projectId,
        environmentId: environment.id,
        parentThreadId: parent.id,
        status: "starting",
      });

      vi.useFakeTimers();
      await interruptEnvironmentProvisioningForHost(harness.deps, {
        hostId: host.id,
        reason: "Host disconnected during setup",
      });
      await vi.advanceTimersByTimeAsync(2_000);

      await vi.waitFor(async () =>
        expect(await parentSystemRequests(harness, parent.id)).toMatchObject([
          { systemMessageKind: "child-failed" },
        ]),
      );
    });
  });

  it("notifies the parent only after a queued send exhausts retries", async () => {
    await withTestHarness(async (harness) => {
      const { parent, child } = await seedParentAndChild(harness, "idle");
      const row = await seedQueuedMessage(harness.deps, {
        threadId: child.id,
        content: textInput("Continue the child work"),
        waitingOn: { kind: "thread-busy" },
      });

      vi.useFakeTimers();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await recordQueuedMessageDrainFailure(harness.deps, {
          error: new Error("dispatch failed"),
          now: Date.now(),
          row,
          thread: child,
        });
      }
      expect(
        (await getQueuedThreadMessage(harness.db, row.id))?.nextAttemptAt,
      ).not.toBeNull();
      expect(await parentSystemRequests(harness, parent.id)).toHaveLength(0);

      await recordQueuedMessageDrainFailure(harness.deps, {
        error: new Error("dispatch failed"),
        now: Date.now(),
        row,
        thread: child,
      });
      await vi.advanceTimersByTimeAsync(2_000);

      expect(
        (await getQueuedThreadMessage(harness.db, row.id))?.nextAttemptAt,
      ).toBeNull();
      await vi.waitFor(async () =>
        expect(await parentSystemRequests(harness, parent.id)).toMatchObject([
          { systemMessageKind: "child-failed" },
        ]),
      );
      expect(
        JSON.stringify(
          (await parentSystemRequests(harness, parent.id))[0]?.input,
        ),
      ).toContain("could not send a queued message after retrying");
      expect(
        await listQueuedThreadMessages(harness.db, parent.id),
      ).toHaveLength(0);
    });
  });
});

describe("child parent-notification policy", () => {
  it.each([
    { status: "completed", notifiedPolicies: ["auto"] },
    { status: "failed", notifiedPolicies: ["auto", "stuck"] },
  ] as const)(
    "notifies the parent of a $status turn only for $notifiedPolicies children",
    async ({ status, notifiedPolicies }) => {
      await withTestHarness(async (harness) => {
        const {
          project,
          environment,
          session,
          thread: parent,
        } = await seedThreadFixture(harness);
        await seedThreadRuntimeState(harness.deps, {
          threadId: parent.id,
          environmentId: environment.id,
          providerThreadId: "parent-provider-thread",
        });
        const policies = ["auto", "stuck", "off"] as const;
        const children = await Promise.all(
          policies.map(async (parentNotifications) => {
            const child = await seedThread(harness.deps, {
              projectId: project.id,
              environmentId: environment.id,
              parentThreadId: parent.id,
              parentNotifications,
              status: "active",
              title: `${parentNotifications} child`,
            });
            await seedTurnStarted(harness.deps, {
              environmentId: environment.id,
              threadId: child.id,
              turnId: `${parentNotifications}-turn`,
            });
            return { child, parentNotifications };
          }),
        );

        vi.useFakeTimers();
        const response = await harness.app.request("/internal/session/events", {
          method: "POST",
          headers: await internalAuthHeaders(harness),
          body: JSON.stringify({
            sessionId: session.id,
            eventGroups: groupHostDaemonEvents(
              children.map(({ child, parentNotifications }) => ({
                threadId: child.id,
                event: {
                  type: "turn/completed",
                  threadId: child.id,
                  providerThreadId: `provider-${parentNotifications}`,
                  scope: turnScope(`${parentNotifications}-turn`),
                  status,
                },
              })),
            ),
          }),
        });
        expect(response.status).toBe(200);
        await vi.advanceTimersByTimeAsync(2_000);

        const expectedThreadIds = children
          .filter(({ parentNotifications }) =>
            notifiedPolicies.some((policy) => policy === parentNotifications),
          )
          .map(({ child }) => child.id);
        await vi.waitFor(async () =>
          expect(await parentSystemRequests(harness, parent.id)).toHaveLength(
            1,
          ),
        );
        const outcomes = (await parentSystemRequests(harness, parent.id))[0]
          ?.systemMessageSubject;
        expect(outcomes).toMatchObject({
          outcomes: expectedThreadIds.map((threadId) => ({ threadId, status })),
        });
      });
    },
  );
});
