import { createThread, getThread } from "@hyperfide/db";
import { threadScope } from "@hyperfide/domain";
import { groupHostDaemonEvents } from "@hyperfide/host-daemon-contract";
import { describe, expect, it } from "vitest";
import {
  createTestDaemonEventEnvelope,
  internalAuthHeaders,
} from "../helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

describe("internal event envelope threadId regression", () => {
  it("uses the validated envelope threadId for side effects instead of the nested event threadId", async () => {
    await withTestHarness(async (harness) => {
      const hostA = await seedHostSession(harness.deps, {
        id: "host-envelope-a",
      });
      const hostB = await seedHostSession(harness.deps, {
        id: "host-envelope-b",
      });
      const { project: projectA } = await seedProjectWithSource(harness.deps, {
        hostId: hostA.host.id,
      });
      const { project: projectB } = await seedProjectWithSource(harness.deps, {
        hostId: hostB.host.id,
      });
      const environmentA = await seedEnvironment(harness.deps, {
        hostId: hostA.host.id,
        projectId: projectA.id,
      });
      const environmentB = await seedEnvironment(harness.deps, {
        hostId: hostB.host.id,
        projectId: projectB.id,
      });
      const threadA = await seedThread(harness.deps, {
        projectId: projectA.id,
        environmentId: environmentA.id,
        title: "Owned thread",
        titleFallback: "Owned thread",
      });
      const threadB = await seedThread(harness.deps, {
        projectId: projectB.id,
        environmentId: environmentB.id,
        title: "Foreign thread",
        titleFallback: "Foreign thread",
      });

      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: await internalAuthHeaders(harness, { hostId: hostA.host.id }),
        body: JSON.stringify({
          sessionId: hostA.session.id,
          eventGroups: groupHostDaemonEvents([
            createTestDaemonEventEnvelope({
              threadId: threadA.id,
              event: {
                type: "thread/name/updated",
                threadId: threadB.id,
                providerThreadId: "provider-envelope",
                scope: threadScope(),
                threadName: "hacked",
              },
            }),
          ]),
        }),
      });

      expect(response.status).toBe(200);
      expect((await getThread(harness.db, threadA.id))?.title).toBe(
        "Owned thread",
      );
      expect((await getThread(harness.db, threadB.id))?.title).toBe(
        "Foreign thread",
      );
    });
  });

  it("does not apply provider names to thread titles", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = await seedHostSession(harness.deps, {
        id: "host-fork-provider-title",
      });
      const { project } = await seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = await seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = await createThread(harness.db, harness.hub, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "codex",
        title: null,
        titleFallback: "Summarize the work",
        status: "active",
      });

      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: await internalAuthHeaders(harness, { hostId: host.id }),
        body: JSON.stringify({
          sessionId: session.id,
          eventGroups: groupHostDaemonEvents([
            createTestDaemonEventEnvelope({
              threadId: thread.id,
              event: {
                type: "thread/name/updated",
                threadId: thread.id,
                providerThreadId: "provider-thread",
                scope: threadScope(),
                threadName: "Provider supplied name",
              },
            }),
          ]),
        }),
      });

      expect(response.status).toBe(200);
      expect((await getThread(harness.db, thread.id))?.title).toBeNull();
      expect((await getThread(harness.db, thread.id))?.titleFallback).toBe(
        "Summarize the work",
      );
    });
  });

  it("uses a title the agent itself set when the thread has none, and keeps an existing title", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = await seedHostSession(harness.deps, {
        id: "host-agent-title",
      });
      const { project } = await seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = await seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const untitled = await createThread(harness.db, harness.hub, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "acp-opencode",
        title: null,
        titleFallback: "fix it",
        status: "active",
      });
      const titled = await seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        title: "Chosen by the user",
        titleFallback: "Chosen by the user",
      });

      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: await internalAuthHeaders(harness, { hostId: host.id }),
        body: JSON.stringify({
          sessionId: session.id,
          eventGroups: groupHostDaemonEvents(
            [untitled.id, titled.id].map((threadId) =>
              createTestDaemonEventEnvelope({
                threadId,
                event: {
                  type: "thread/name/updated",
                  threadId,
                  providerThreadId: `provider-${threadId}`,
                  scope: threadScope(),
                  threadName: "  Fix the   login redirect ",
                  source: "agent",
                },
              }),
            ),
          ),
        }),
      });

      expect(response.status).toBe(200);
      expect((await getThread(harness.db, untitled.id))?.title).toBe(
        "Fix the login redirect",
      );
      expect((await getThread(harness.db, titled.id))?.title).toBe(
        "Chosen by the user",
      );
    });
  });
});
