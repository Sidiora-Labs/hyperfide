import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { internalAuthHeaders } from "../helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

describe("internal project attachment content", () => {
  it("returns attachment bytes to the daemon assigned to the thread environment", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = await seedHostSession(harness.deps, {
        id: "host-attachment-content",
      });
      const { project } = await seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = await seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = await seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });
      const attachmentPath = "network-tab.har";
      await mkdir(join(harness.config.dataDir, "attachments", project.id), {
        recursive: true,
      });
      await writeFile(
        join(harness.config.dataDir, "attachments", project.id, attachmentPath),
        "har-content",
      );

      const response = await harness.app.request(
        `/internal/session/project-attachment-content?sessionId=${session.id}&threadId=${thread.id}&projectId=${project.id}&path=${attachmentPath}`,
        {
          headers: await internalAuthHeaders(harness, { hostId: host.id }),
        },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(
        "application/octet-stream",
      );
      await expect(response.text()).resolves.toBe("har-content");
    });
  });

  it("rejects a daemon that is not assigned to the thread environment", async () => {
    await withTestHarness(async (harness) => {
      const hostA = await seedHostSession(harness.deps, {
        id: "host-attachment-content-a",
      });
      const hostB = await seedHostSession(harness.deps, {
        id: "host-attachment-content-b",
      });
      const { project } = await seedProjectWithSource(harness.deps, {
        hostId: hostA.host.id,
      });
      const environment = await seedEnvironment(harness.deps, {
        hostId: hostA.host.id,
        projectId: project.id,
      });
      const thread = await seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      const response = await harness.app.request(
        `/internal/session/project-attachment-content?sessionId=${hostB.session.id}&threadId=${thread.id}&projectId=${project.id}&path=network-tab.har`,
        {
          headers: await internalAuthHeaders(harness, {
            hostId: hostB.host.id,
          }),
        },
      );

      expect(response.status).toBe(403);
    });
  });

  it("rejects a project-scoped attachment token request for a mismatched project id", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = await seedHostSession(harness.deps, {
        id: "host-attachment-content-project-mismatch",
      });
      const { project: threadProject } = await seedProjectWithSource(
        harness.deps,
        {
          hostId: host.id,
        },
      );
      const environment = await seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: threadProject.id,
      });
      const thread = await seedThread(harness.deps, {
        projectId: threadProject.id,
        environmentId: environment.id,
      });

      const response = await harness.app.request(
        `/internal/session/project-attachment-content?sessionId=${session.id}&threadId=${thread.id}&projectId=proj_missing_attachment_content&path=network-tab.har`,
        {
          headers: await internalAuthHeaders(harness, { hostId: host.id }),
        },
      );

      expect(response.status).toBe(403);
    });
  });
});
