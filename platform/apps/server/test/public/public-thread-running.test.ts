import { archiveThread } from "@hyperfide/db";
import { threadRunningResponseSchema } from "@hyperfide/server-contract";
import { describe, expect, it } from "vitest";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

async function running(harness: TestAppHarness) {
  const response = await harness.app.request("/api/v1/threads/running");
  expect(response.status).toBe(200);
  return threadRunningResponseSchema.parse(await readJson(response));
}

describe("GET /threads/running", () => {
  it("returns every occupying thread as an id and the host it occupies", async () => {
    await withTestHarness(async (harness) => {
      const { host } = await seedHostSession(harness.deps, {
        id: "host-thread-running",
      });
      const { project } = await seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-running-source",
      });
      const environment = await seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/thread-running-source",
      });
      const root = await seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        status: "active",
      });
      const child = await seedThread(harness.deps, {
        environmentId: environment.id,
        parentThreadId: root.id,
        projectId: project.id,
        status: "active",
      });
      const spawned = await seedThread(harness.deps, {
        environmentId: environment.id,
        originPluginId: "workflows",
        projectId: project.id,
        status: "active",
      });
      // Admitted but not yet provisioned: on no host, still occupying.
      const unplaced = await seedThread(harness.deps, {
        environmentId: null,
        projectId: project.id,
        status: "starting",
      });
      // Neither of these occupies anything.
      await seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        status: "idle",
      });
      const archived = await seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        status: "active",
      });
      await archiveThread(harness.db, harness.deps.hub, archived.id);

      const rows = await running(harness);
      // A child and a plugin-spawned thread occupy slots like any other, so
      // the route reports them.
      expect(new Set(rows.map((row) => row.id))).toEqual(
        new Set([root.id, child.id, spawned.id, unplaced.id]),
      );
      const byId = new Map(rows.map((row) => [row.id, row]));
      expect(byId.get(root.id)).toEqual({ id: root.id, hostId: host.id });
      expect(byId.get(unplaced.id)?.hostId).toBeNull();
    });
  });
});
