import {
  getProjectExecutionDefaults,
  upsertProjectExecutionDefaults,
} from "@hyperfide/db";
import { describe, expect, it } from "vitest";
import { createThreadFromRequest } from "../../../src/services/threads/thread-create.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadIdentity,
  seedTurnStarted,
} from "../../helpers/seed.js";
import { textInput } from "../../helpers/prompt-input.js";
import { withTestHarness } from "../../helpers/test-app.js";
import { installFakeGitWorktreeProvider } from "../../helpers/environment-provider.js";

describe("project execution defaults persistence", () => {
  it("does not overwrite project defaults when an app thread reuses an existing environment", async () => {
    await withTestHarness(async (harness) => {
      const { host } = await seedHostSession(harness.deps, {
        id: "host-reuse-defaults",
      });
      const { project } = await seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = await seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/reuse-defaults-environment",
      });

      await upsertProjectExecutionDefaults(harness.db, {
        projectId: project.id,
        providerId: "codex",
        model: "gpt-5-mini",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
      });

      await createThreadFromRequest(harness.deps, {
        origin: "app",
        startedOnBehalfOf: null,
        projectId: project.id,
        providerId: "codex",
        model: "gpt-5",
        reasoningLevel: "high",
        permissionMode: "accept-edits",
        serviceTier: "fast",
        input: textInput("Reuse one-off"),
        environment: { type: "reuse", environmentId: environment.id },
      });

      expect(
        await getProjectExecutionDefaults(harness.db, {
          projectId: project.id,
        }),
      ).toEqual({
        providerId: "codex",
        model: "gpt-5-mini",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
      });
    });
  });

  it("does overwrite project defaults for a regular app thread (non-reuse env)", async () => {
    await withTestHarness(async (harness) => {
      const { host } = await seedHostSession(harness.deps, {
        id: "host-non-reuse-defaults",
      });
      const { project } = await seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });

      await upsertProjectExecutionDefaults(harness.db, {
        projectId: project.id,
        providerId: "codex",
        model: "gpt-5-mini",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
      });

      await createThreadFromRequest(harness.deps, {
        origin: "app",
        startedOnBehalfOf: null,
        projectId: project.id,
        providerId: "codex",
        model: "gpt-5",
        reasoningLevel: "high",
        permissionMode: "accept-edits",
        serviceTier: "fast",
        input: textInput("Set new defaults"),
        environment: {
          type: "host",
          hostId: host.id,
          workspace: { type: "unmanaged", path: null },
        },
      });

      expect(
        await getProjectExecutionDefaults(harness.db, {
          projectId: project.id,
        }),
      ).toEqual({
        providerId: "codex",
        model: "gpt-5",
        reasoningLevel: "high",
        permissionMode: "accept-edits",
        serviceTier: "fast",
      });
    });
  });

  it("does not overwrite project defaults for a fork/side-chat child spawn", async () => {
    await withTestHarness(async (harness) => {
      installFakeGitWorktreeProvider();
      const { host } = await seedHostSession(harness.deps, {
        id: "host-origin-kind-defaults",
      });
      const { project } = await seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const parentEnvironment = await seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/origin-kind-defaults-source",
      });
      const parentThread = await seedThread(harness.deps, {
        projectId: project.id,
        environmentId: parentEnvironment.id,
      });
      await seedThreadIdentity(harness.deps, {
        threadId: parentThread.id,
        providerThreadId: "provider-origin-kind-defaults-source",
      });
      await seedTurnStarted(harness.deps, {
        threadId: parentThread.id,
        turnId: "turn-origin-kind-defaults-source",
        providerThreadId: "provider-origin-kind-defaults-source",
      });

      await upsertProjectExecutionDefaults(harness.db, {
        projectId: project.id,
        providerId: "codex",
        model: "gpt-5-mini",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
      });

      await createThreadFromRequest(harness.deps, {
        origin: "app",
        originKind: "fork",
        startedOnBehalfOf: null,
        parentThreadId: parentThread.id,
        projectId: project.id,
        providerId: "codex",
        model: "gpt-5",
        reasoningLevel: "high",
        permissionMode: "accept-edits",
        serviceTier: "fast",
        input: textInput("Quick question"),
        environment: {
          type: "host",
          hostId: host.id,
          workspace: { type: "unmanaged", path: null },
        },
      });

      expect(
        await getProjectExecutionDefaults(harness.db, {
          projectId: project.id,
        }),
      ).toEqual({
        providerId: "codex",
        model: "gpt-5-mini",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
      });
    });
  });
});
