import { describe, expect, it } from "vitest";
import { createProjectSourceId } from "../../src/ids.js";
import { noopNotifier } from "../../src/notifier.js";
import { projectSources } from "../../src/schema.js";
import {
  countProjectSources,
  createProjectSource,
  getProjectSourceForProject,
  getProjectSourceByHost,
  listProjectSourcesByProjectIds,
  updateProjectSource,
  deleteProjectSource,
} from "../../src/data/project-sources.js";
import { createProject } from "../../src/data/projects.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createMigratedConnection } from "../../src/testing.js";

async function setup() {
  const db = await createMigratedConnection();
  const host = await upsertHost(db, noopNotifier, {
    name: "test-host",
  });
  const { project } = await createProject(db, noopNotifier, {
    name: "test-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/test" },
  });
  return { db, host, project };
}

describe("project-sources", () => {
  it("lists sources across project ids", async () => {
    const { db, host, project } = await setup();
    const host2 = await upsertHost(db, noopNotifier, {
      name: "project-host-2",
    });
    const host3 = await upsertHost(db, noopNotifier, {
      name: "project-host-3",
    });
    const { project: otherProject } = await createProject(db, noopNotifier, {
      name: "other-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/other-project",
      },
    });
    await createProjectSource(db, noopNotifier, {
      projectId: project.id,
      type: "local_path",
      hostId: host2.id,
      path: "/tmp/repo-a",
    });
    await createProjectSource(db, noopNotifier, {
      projectId: otherProject.id,
      type: "local_path",
      hostId: host3.id,
      path: "/tmp/repo-b",
    });

    expect(await listProjectSourcesByProjectIds(db, [project.id])).toHaveLength(
      2,
    );
    expect(
      await listProjectSourcesByProjectIds(db, [project.id, otherProject.id]),
    ).toHaveLength(4);
  });

  it("returns the default source and preserves it when adding more sources", async () => {
    const { db, project } = await setup();
    const secondaryHost = await upsertHost(db, noopNotifier, {
      name: "secondary-host",
    });
    const initialDefault = (
      await listProjectSourcesByProjectIds(db, [project.id])
    ).find((source) => source.isDefault);
    const source = await createProjectSource(db, noopNotifier, {
      projectId: project.id,
      type: "local_path",
      hostId: secondaryHost.id,
      path: "/tmp/secondary",
    });

    expect(source).toMatchObject({
      type: "local_path",
      path: "/tmp/secondary",
    });
    expect(
      (await listProjectSourcesByProjectIds(db, [project.id])).find(
        (source) => source.isDefault,
      )?.id,
    ).toBe(initialDefault!.id);
  });

  it("returns the source for a specific host", async () => {
    const { db, project } = await setup();
    const secondaryHost = await upsertHost(db, noopNotifier, {
      name: "test-host-2",
    });
    const secondarySource = await createProjectSource(db, noopNotifier, {
      projectId: project.id,
      type: "local_path",
      hostId: secondaryHost.id,
      path: "/tmp/code-2",
    });

    expect(
      (await getProjectSourceByHost(db, project.id, secondaryHost.id))?.id,
    ).toBe(secondarySource.id);
  });

  it("returns null when a host has no source", async () => {
    const { db, project } = await setup();
    const missingHost = await upsertHost(db, noopNotifier, {
      name: "missing-host",
    });

    expect(
      await getProjectSourceByHost(db, project.id, missingHost.id),
    ).toBeNull();
  });

  it("gets project sources by id, by project, and by count", async () => {
    const { db, project } = await setup();
    const secondaryHost = await upsertHost(db, noopNotifier, {
      name: "source-id-host",
    });
    const source = await createProjectSource(db, noopNotifier, {
      projectId: project.id,
      type: "local_path",
      hostId: secondaryHost.id,
      path: "/tmp/source-id",
    });

    expect(
      (
        await getProjectSourceForProject(db, {
          projectId: project.id,
          sourceId: source.id,
        })
      )?.id,
    ).toBe(source.id);
    expect(
      await getProjectSourceForProject(db, {
        projectId: "proj_other",
        sourceId: source.id,
      }),
    ).toBeNull();
    expect(await countProjectSources(db, { projectId: project.id })).toBe(2);
  });

  it("rejects duplicate sources for the same project and host", async () => {
    const { db, host, project } = await setup();

    await expect(
      (async () =>
        await createProjectSource(db, noopNotifier, {
          projectId: project.id,
          type: "local_path",
          hostId: host.id,
          path: "/tmp/duplicate",
        }))(),
    ).rejects.toThrow();
    expect(await listProjectSourcesByProjectIds(db, [project.id])).toHaveLength(
      1,
    );
  });

  it("enforces one default source per project at the database boundary", async () => {
    const { db, project } = await setup();
    const conflictHost = await upsertHost(db, noopNotifier, {
      name: "default-conflict-host",
    });
    const now = Date.now();

    await expect(
      (async () =>
        await db
          .insert(projectSources)
          .values({
            id: createProjectSourceId(),
            projectId: project.id,
            type: "local_path",
            hostId: conflictHost.id,
            path: "/tmp/default-conflict",
            isDefault: true,
            createdAt: now,
            updatedAt: now,
          })
          .run())(),
    ).rejects.toThrow();

    expect(
      (await listProjectSourcesByProjectIds(db, [project.id])).find(
        (source) => source.isDefault,
      )?.id,
    ).toBeTruthy();
  });

  it("updates a project source", async () => {
    const { db, project } = await setup();
    const updateHost = await upsertHost(db, noopNotifier, {
      name: "update-test-host",
    });
    const source = await createProjectSource(db, noopNotifier, {
      projectId: project.id,
      type: "local_path",
      hostId: updateHost.id,
      path: "/tmp/code",
    });

    const updated = await updateProjectSource(db, noopNotifier, source.id, {
      path: "/tmp/renamed",
    });
    if (!updated || updated.type !== "local_path") {
      throw new Error(
        `Expected local_path source, got ${updated?.type ?? "none"}`,
      );
    }
    expect(updated.path).toBe("/tmp/renamed");
  });

  it("deletes a project source", async () => {
    const { db, project } = await setup();
    const deleteHost = await upsertHost(db, noopNotifier, {
      name: "delete-test-host",
    });
    const source = await createProjectSource(db, noopNotifier, {
      projectId: project.id,
      type: "local_path",
      hostId: deleteHost.id,
      path: "/tmp/code",
    });

    expect(await deleteProjectSource(db, noopNotifier, source.id)).toBe(true);
    expect(await listProjectSourcesByProjectIds(db, [project.id])).toHaveLength(
      1,
    );
    expect(await deleteProjectSource(db, noopNotifier, source.id)).toBe(false);
  });

  it("promotes another source when deleting the default", async () => {
    const { db, project } = await setup();
    const host2 = await upsertHost(db, noopNotifier, {
      name: "test-host-2",
    });
    const second = await createProjectSource(db, noopNotifier, {
      projectId: project.id,
      type: "local_path",
      hostId: host2.id,
      path: "/tmp/code-2",
    });

    const initialDefault = (
      await listProjectSourcesByProjectIds(db, [project.id])
    ).find((source) => source.isDefault)!;
    expect(await deleteProjectSource(db, noopNotifier, initialDefault.id)).toBe(
      true,
    );
    expect(
      (await listProjectSourcesByProjectIds(db, [project.id])).find(
        (source) => source.isDefault,
      )?.id,
    ).toBe(second.id);
  });
});
