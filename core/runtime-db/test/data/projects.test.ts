import { describe, expect, it } from "vitest";
import { PERSONAL_PROJECT_ID } from "@hyperfide/domain";
import { noopNotifier } from "../../src/notifier.js";
import { projects } from "../../src/schema.js";
import {
  createProject,
  ensurePersonalProject,
  findOrCreateProjectByLocalPathSource,
  getProject,
  listPublicProjects,
  markProjectDeleted,
  reorderProject,
  setProjectGitRemoteUrlIfMissing,
} from "../../src/data/projects.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createMigratedConnection } from "../../src/testing.js";

async function setup() {
  const db = await createMigratedConnection();
  const host = await upsertHost(db, noopNotifier, {
    name: "projects-host",
  });
  return { db, host };
}

describe("projects", () => {
  it("returns the existing project when the same host path is added again", async () => {
    const { db, host } = await setup();
    const first = await findOrCreateProjectByLocalPathSource(db, noopNotifier, {
      name: "first-name",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/same-project",
      },
    });

    const repeated = await findOrCreateProjectByLocalPathSource(
      db,
      noopNotifier,
      {
        name: "second-name",
        source: {
          type: "local_path",
          hostId: host.id,
          path: "/tmp/same-project",
        },
      },
    );

    expect(repeated).toEqual(first);
    expect(await listPublicProjects(db)).toEqual([first.project]);
  });

  it("allows the same path on different hosts", async () => {
    const { db, host } = await setup();
    const otherHost = await upsertHost(db, noopNotifier, {
      name: "other-projects-host",
    });

    const first = await findOrCreateProjectByLocalPathSource(db, noopNotifier, {
      name: "first-host-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/shared-path",
      },
    });
    const second = await findOrCreateProjectByLocalPathSource(
      db,
      noopNotifier,
      {
        name: "second-host-project",
        source: {
          type: "local_path",
          hostId: otherHost.id,
          path: "/tmp/shared-path",
        },
      },
    );

    expect(second.project.id).not.toBe(first.project.id);
    expect(await listPublicProjects(db)).toHaveLength(2);
  });

  it("sets a git remote anchor only while it is missing", async () => {
    const { db, host } = await setup();
    const { project } = await createProject(db, noopNotifier, {
      name: "anchored-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/anchored-project",
      },
    });

    expect(project.gitRemoteUrl).toBeNull();
    expect(
      (
        await setProjectGitRemoteUrlIfMissing(
          db,
          noopNotifier,
          project.id,
          "ssh://git.example.test/first.git",
        )
      )?.gitRemoteUrl,
    ).toBe("ssh://git.example.test/first.git");
    expect(
      await setProjectGitRemoteUrlIfMissing(
        db,
        noopNotifier,
        project.id,
        "ssh://git.example.test/second.git",
      ),
    ).toBeNull();
    expect((await getProject(db, project.id))?.gitRemoteUrl).toBe(
      "ssh://git.example.test/first.git",
    );
  });

  it("ensures the singleton personal project idempotently", async () => {
    const { db } = await setup();

    const first = await ensurePersonalProject(db);
    const second = await ensurePersonalProject(db);

    expect(first.id).toBe(PERSONAL_PROJECT_ID);
    expect(second.id).toBe(PERSONAL_PROJECT_ID);
    expect(
      (await db.select().from(projects).all()).filter(
        (project) => project.kind === "personal",
      ),
    ).toEqual([expect.objectContaining({ id: PERSONAL_PROJECT_ID })]);
  });

  it("excludes deleted projects from public listings", async () => {
    const { db, host } = await setup();
    const { project: visibleProject } = await createProject(db, noopNotifier, {
      name: "visible-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/visible-project",
      },
    });
    const { project: deletingProject } = await createProject(db, noopNotifier, {
      name: "deleting-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/deleting-project",
      },
    });

    await markProjectDeleted(db, noopNotifier, {
      projectId: deletingProject.id,
    });

    const allProjectIds = (await db.select().from(projects).all()).map(
      (project) => project.id,
    );
    expect(allProjectIds).toHaveLength(3);
    expect(allProjectIds).toEqual(
      expect.arrayContaining([
        PERSONAL_PROJECT_ID,
        visibleProject.id,
        deletingProject.id,
      ]),
    );
    expect((await listPublicProjects(db)).map((project) => project.id)).toEqual(
      [visibleProject.id],
    );
  });

  it("reorders public projects by neighboring projects", async () => {
    const { db, host } = await setup();
    const { project: firstProject } = await createProject(db, noopNotifier, {
      name: "first-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/first-project",
      },
    });
    const { project: secondProject } = await createProject(db, noopNotifier, {
      name: "second-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/second-project",
      },
    });
    const { project: thirdProject } = await createProject(db, noopNotifier, {
      name: "third-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/third-project",
      },
    });

    const result = await reorderProject({
      db,
      notifier: noopNotifier,
      projectId: thirdProject.id,
      previousProjectId: firstProject.id,
      nextProjectId: secondProject.id,
    });

    expect(result.kind).toBe("reordered");
    expect((await listPublicProjects(db)).map((project) => project.id)).toEqual(
      [firstProject.id, thirdProject.id, secondProject.id],
    );
  });

  it("returns unchanged when project order already matches neighboring projects", async () => {
    const { db, host } = await setup();
    const { project: firstProject } = await createProject(db, noopNotifier, {
      name: "first-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/first-project",
      },
    });
    const { project: secondProject } = await createProject(db, noopNotifier, {
      name: "second-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/second-project",
      },
    });
    const { project: thirdProject } = await createProject(db, noopNotifier, {
      name: "third-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/third-project",
      },
    });

    const result = await reorderProject({
      db,
      notifier: noopNotifier,
      projectId: secondProject.id,
      previousProjectId: firstProject.id,
      nextProjectId: thirdProject.id,
    });

    expect(result.kind).toBe("unchanged");
    if (result.kind !== "unchanged") {
      throw new Error(`Expected unchanged reorder, received ${result.kind}`);
    }
    expect(result.projects.map((project) => project.id)).toEqual([
      firstProject.id,
      secondProject.id,
      thirdProject.id,
    ]);
  });

  it("returns not_found when reordering a missing project", async () => {
    const { db } = await setup();

    expect(
      (
        await reorderProject({
          db,
          notifier: noopNotifier,
          projectId: "proj_missing",
          previousProjectId: null,
          nextProjectId: null,
        })
      ).kind,
    ).toBe("not_found");
  });

  it("rejects project reorder neighbors that are in reverse order", async () => {
    const { db, host } = await setup();
    const { project: firstProject } = await createProject(db, noopNotifier, {
      name: "first-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/first-project",
      },
    });
    const { project: secondProject } = await createProject(db, noopNotifier, {
      name: "second-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/second-project",
      },
    });
    const { project: thirdProject } = await createProject(db, noopNotifier, {
      name: "third-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/third-project",
      },
    });

    expect(
      (
        await reorderProject({
          db,
          notifier: noopNotifier,
          projectId: thirdProject.id,
          previousProjectId: secondProject.id,
          nextProjectId: firstProject.id,
        })
      ).kind,
    ).toBe("invalid_neighbor_order");
    expect((await listPublicProjects(db)).map((project) => project.id)).toEqual(
      [firstProject.id, secondProject.id, thirdProject.id],
    );
  });

  it("appends new projects after existing project order", async () => {
    const { db, host } = await setup();
    const { project: firstProject } = await createProject(db, noopNotifier, {
      name: "first-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/first-project",
      },
    });
    const { project: secondProject } = await createProject(db, noopNotifier, {
      name: "second-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/second-project",
      },
    });

    await reorderProject({
      db,
      notifier: noopNotifier,
      projectId: secondProject.id,
      previousProjectId: null,
      nextProjectId: firstProject.id,
    });

    const { project: thirdProject } = await createProject(db, noopNotifier, {
      name: "third-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/third-project",
      },
    });

    expect((await listPublicProjects(db)).map((project) => project.id)).toEqual(
      [secondProject.id, firstProject.id, thirdProject.id],
    );
  });

  it("rejects stale project reorder neighbors", async () => {
    const { db, host } = await setup();
    const { project: visibleProject } = await createProject(db, noopNotifier, {
      name: "visible-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/visible-project",
      },
    });
    const { project: deletingProject } = await createProject(db, noopNotifier, {
      name: "deleting-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/deleting-project",
      },
    });
    await markProjectDeleted(db, noopNotifier, {
      projectId: deletingProject.id,
    });

    expect(
      (
        await reorderProject({
          db,
          notifier: noopNotifier,
          projectId: visibleProject.id,
          previousProjectId: deletingProject.id,
          nextProjectId: null,
        })
      ).kind,
    ).toBe("stale_neighbor");
  });
});
