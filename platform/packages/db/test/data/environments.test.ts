import { eq } from "drizzle-orm";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { noopNotifier } from "../../src/notifier.js";
import type { DbNotifier } from "../../src/notifier.js";
import {
  createEnvironment,
  findProjectEnvironmentByHostPath,
  findProviderEnvironmentContainingPath,
  listRetiredLoadedEnvironmentIdsOnHost,
  markHostEnvironmentsDestroyed,
  recordEnvironmentCurrentBranch,
  recordProvisionedEnvironmentWorkspace,
  updateEnvironmentMetadata,
} from "../../src/data/environments.js";
import { environments } from "../../src/schema.js";
import { createProject } from "../../src/data/projects.js";
import { updateHost, upsertHost } from "../../src/data/hosts.js";
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

function createNotifierSpy(): DbNotifier {
  return {
    notifyThread: vi.fn(),
    notifyProject: vi.fn(),
    notifyEnvironment: vi.fn(),
    notifyHost: vi.fn(),
    notifySystem: vi.fn(),
  };
}

describe("environments", () => {
  it("notifies a host's environments only when its removal state changes", async () => {
    const { db, host, project } = await setup();
    const environment = await createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      path: "/tmp/removal-notify",
      providerOwnsPath: false,
      status: "ready",
    });
    const notifier = createNotifierSpy();

    await updateHost(db, notifier, host.id, { name: "Renamed" });
    expect(notifier.notifyEnvironment).not.toHaveBeenCalled();

    await updateHost(db, notifier, host.id, { phase: "removing" });
    await updateHost(db, notifier, host.id, { teardownStatus: "running" });
    await updateHost(db, notifier, host.id, { teardownStatus: "failed" });
    await updateHost(db, notifier, host.id, { destroyedAt: 1 });

    expect(vi.mocked(notifier.notifyEnvironment).mock.calls).toEqual([
      [environment.id, ["status-changed"]],
      [environment.id, ["status-changed"]],
      [environment.id, ["status-changed"]],
    ]);
  });

  it("marks every environment on a removed host as destroyed history", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    vi.setSystemTime(25_000);
    const { db, host, project } = await setup();
    const first = await createEnvironment(db, noopNotifier, {
      providerOwnsPath: true,
      projectId: project.id,
      hostId: host.id,
      path: "/tmp/removed-host-first",
      status: "ready",
    });
    const second = await createEnvironment(db, noopNotifier, {
      providerOwnsPath: false,
      projectId: project.id,
      hostId: host.id,
      path: "/tmp/removed-host-second",
      status: "error",
    });
    await db
      .update(environments)
      .set({
        resource: { provider: "state" },
        retireAt: 30_000,
        teardownMessage: "previous failure",
        teardownStatus: "failed",
      })
      .where(eq(environments.id, second.id))
      .run();
    const notifier = createNotifierSpy();

    const updated = await markHostEnvironmentsDestroyed(db, notifier, host.id);

    expect(updated.map((environment) => environment.id)).toEqual([
      first.id,
      second.id,
    ]);
    for (const environment of updated) {
      expect(environment).toMatchObject({
        path: null,
        resource: null,
        retireAt: null,
        status: "destroyed",
        teardownMessage: null,
        teardownStatus: "removed",
        updatedAt: 25_000,
      });
      expect(notifier.notifyEnvironment).toHaveBeenCalledWith(environment.id, [
        "metadata-changed",
        "status-changed",
      ]);
    }
  });

  it("keeps a path unique while provider teardown is pending", async () => {
    const { db, host, project } = await setup();
    const first = await createEnvironment(db, noopNotifier, {
      providerOwnsPath: true,
      projectId: project.id,
      hostId: host.id,
      path: "/tmp/teardown-path",
      status: "ready",
    });
    await db
      .update(environments)
      .set({ teardownStatus: "running" })
      .where(eq(environments.id, first.id))
      .run();

    await expect(
      (async () =>
        await createEnvironment(db, noopNotifier, {
          providerOwnsPath: true,
          projectId: project.id,
          hostId: host.id,
          path: "/tmp/teardown-path",
          status: "provisioning",
        }))(),
    ).rejects.toThrow(/unique/iu);
  });

  it("emits metadata-changed when merge base branch changes", async () => {
    const { db, host, project } = await setup();
    const environment = await createEnvironment(db, noopNotifier, {
      providerOwnsPath: false,
      projectId: project.id,
      hostId: host.id,
      status: "ready",
    });
    const notifier = createNotifierSpy();

    const updated = await updateEnvironmentMetadata(
      db,
      notifier,
      environment.id,
      {
        mergeBaseBranch: "release",
      },
    );

    expect(updated?.mergeBaseBranch).toBe("release");
    expect(notifier.notifyEnvironment).toHaveBeenCalledWith(environment.id, [
      "metadata-changed",
    ]);
  });

  it("emits metadata-changed when environment name changes", async () => {
    const { db, host, project } = await setup();
    const environment = await createEnvironment(db, noopNotifier, {
      providerOwnsPath: false,
      projectId: project.id,
      hostId: host.id,
      status: "ready",
    });
    const notifier = createNotifierSpy();

    const updated = await updateEnvironmentMetadata(
      db,
      notifier,
      environment.id,
      {
        name: "Review workspace",
      },
    );

    expect(updated?.name).toBe("Review workspace");
    expect(notifier.notifyEnvironment).toHaveBeenCalledWith(environment.id, [
      "metadata-changed",
    ]);
  });

  it("does not emit metadata-changed when merge base branch is unchanged", async () => {
    const { db, host, project } = await setup();
    const environment = await createEnvironment(db, noopNotifier, {
      providerOwnsPath: false,
      projectId: project.id,
      hostId: host.id,
      mergeBaseBranch: "main",
      status: "ready",
    });
    const notifier = createNotifierSpy();

    const updated = await updateEnvironmentMetadata(
      db,
      notifier,
      environment.id,
      {
        mergeBaseBranch: "main",
      },
    );

    expect(updated?.mergeBaseBranch).toBe("main");
    expect(notifier.notifyEnvironment).not.toHaveBeenCalled();
  });

  it("does not emit metadata-changed when environment name is unchanged", async () => {
    const { db, host, project } = await setup();
    const environment = await createEnvironment(db, noopNotifier, {
      providerOwnsPath: false,
      projectId: project.id,
      hostId: host.id,
      name: "Review workspace",
      status: "ready",
    });
    const notifier = createNotifierSpy();

    const updated = await updateEnvironmentMetadata(
      db,
      notifier,
      environment.id,
      {
        name: "Review workspace",
      },
    );

    expect(updated?.name).toBe("Review workspace");
    expect(notifier.notifyEnvironment).not.toHaveBeenCalled();
  });

  it("records provisioned workspace metadata without touching status", async () => {
    const { db, host, project } = await setup();
    const environment = await createEnvironment(db, noopNotifier, {
      providerOwnsPath: false,
      projectId: project.id,
      hostId: host.id,
      status: "provisioning",
    });
    const notifier = createNotifierSpy();

    const updated = await recordProvisionedEnvironmentWorkspace(
      db,
      notifier,
      environment.id,
      {
        path: "/tmp/project",
        isGitRepo: true,
        isWorktree: true,
        branchName: "hyperfide/test",
        defaultBranch: "main",
      },
    );

    expect(updated).toMatchObject({
      path: "/tmp/project",
      status: "provisioning",
      isGitRepo: true,
      isWorktree: true,
      branchName: "hyperfide/test",
      defaultBranch: "main",
    });
    expect(notifier.notifyEnvironment).toHaveBeenCalledWith(environment.id, [
      "metadata-changed",
    ]);
  });

  it("records the current branch observed for an environment", async () => {
    const { db, host, project } = await setup();
    const environment = await createEnvironment(db, noopNotifier, {
      providerOwnsPath: false,
      projectId: project.id,
      hostId: host.id,
      branchName: "hyperfide/old",
      defaultBranch: "main",
      status: "ready",
    });
    const notifier = createNotifierSpy();

    const updated = await recordEnvironmentCurrentBranch(
      db,
      notifier,
      environment.id,
      {
        branchName: "feature/current",
        defaultBranch: "trunk",
      },
    );

    expect(updated).toMatchObject({
      branchName: "feature/current",
      defaultBranch: "trunk",
      baseBranch: null,
      mergeBaseBranch: null,
    });
    expect(notifier.notifyEnvironment).toHaveBeenCalledWith(environment.id, [
      "metadata-changed",
    ]);
  });

  it("clears the current branch when a detached checkout is observed", async () => {
    const { db, host, project } = await setup();
    const environment = await createEnvironment(db, noopNotifier, {
      providerOwnsPath: false,
      projectId: project.id,
      hostId: host.id,
      branchName: "hyperfide/old",
      defaultBranch: "main",
      status: "ready",
    });
    const notifier = createNotifierSpy();

    const updated = await recordEnvironmentCurrentBranch(
      db,
      notifier,
      environment.id,
      {
        branchName: null,
      },
    );

    expect(updated).toMatchObject({
      branchName: null,
      defaultBranch: "main",
    });
    expect(notifier.notifyEnvironment).toHaveBeenCalledWith(environment.id, [
      "metadata-changed",
    ]);
  });

  it("lists loaded environments that no longer belong to the host as live records", async () => {
    const { db, host, project } = await setup();
    const otherHost = await upsertHost(db, noopNotifier, {
      name: "other-host",
    });
    const { project: otherProject } = await createProject(db, noopNotifier, {
      name: "other-project",
      source: {
        type: "local_path",
        hostId: otherHost.id,
        path: "/tmp/other",
      },
    });
    const retainedEnvironment = await createEnvironment(db, noopNotifier, {
      providerOwnsPath: false,
      projectId: project.id,
      hostId: host.id,
      status: "ready",
    });
    const destroyedEnvironment = await createEnvironment(db, noopNotifier, {
      providerOwnsPath: false,
      projectId: project.id,
      hostId: host.id,
      status: "destroyed",
    });
    const otherHostEnvironment = await createEnvironment(db, noopNotifier, {
      providerOwnsPath: false,
      projectId: otherProject.id,
      hostId: otherHost.id,
      status: "ready",
    });

    expect(
      await listRetiredLoadedEnvironmentIdsOnHost(db, {
        hostId: host.id,
        environmentIds: [
          retainedEnvironment.id,
          destroyedEnvironment.id,
          otherHostEnvironment.id,
          "env_missing",
        ],
      }),
    ).toEqual([
      destroyedEnvironment.id,
      otherHostEnvironment.id,
      "env_missing",
    ]);
  });
});

describe("environment path claims", () => {
  async function seedClaim(
    args: Awaited<ReturnType<typeof setup>>,
    input: {
      environmentProviderId: string;
      path: string;
      providerOwnsPath: boolean;
    },
  ) {
    return await createEnvironment(args.db, noopNotifier, {
      projectId: args.project.id,
      hostId: args.host.id,
      path: input.path,
      status: "ready",
      providerOwnsPath: input.providerOwnsPath,
      environmentProvider: {
        environmentProviderId: input.environmentProviderId,
        instanceKey: null,
        selection: {
          machine: { type: "existing", hostId: args.host.id },
          inputs: null,
        },
      },
    });
  }

  it("claims a path only for a provider that owns the directory", async () => {
    const fixture = await setup();
    await seedClaim(fixture, {
      environmentProviderId: "project-checkout",
      path: "/tmp/attached",
      providerOwnsPath: false,
    });
    const owned = await seedClaim(fixture, {
      environmentProviderId: "git-worktree",
      path: "/tmp/owned",
      providerOwnsPath: true,
    });

    expect(
      await findProviderEnvironmentContainingPath(fixture.db, "/tmp/attached"),
    ).toBeNull();
    expect(
      await findProviderEnvironmentContainingPath(
        fixture.db,
        "/tmp/attached/pkg",
      ),
    ).toBeNull();
    expect(
      (
        await findProviderEnvironmentContainingPath(
          fixture.db,
          "/tmp/owned/pkg",
        )
      )?.id,
    ).toBe(owned.id);
  });

  it("matches a Windows path without regard to case", async () => {
    const fixture = await setup();
    const owned = await seedClaim(fixture, {
      environmentProviderId: "git-worktree",
      path: "C:\\src\\Owned",
      providerOwnsPath: true,
    });

    expect(
      (
        await findProviderEnvironmentContainingPath(
          fixture.db,
          "C:\\src\\owned",
        )
      )?.id,
    ).toBe(owned.id);
    expect(
      (
        await findProviderEnvironmentContainingPath(
          fixture.db,
          "C:\\SRC\\owned\\packages\\app",
        )
      )?.id,
    ).toBe(owned.id);
    expect(
      await findProviderEnvironmentContainingPath(
        fixture.db,
        "C:\\src\\owned-other",
      ),
    ).toBeNull();
    expect(
      (
        await findProjectEnvironmentByHostPath(
          fixture.db,
          fixture.project.id,
          fixture.host.id,
          "C:\\SRC\\OWNED",
        )
      )?.id,
    ).toBe(owned.id);
  });

  it("keeps POSIX path lookups case-sensitive", async () => {
    const fixture = await setup();
    await seedClaim(fixture, {
      environmentProviderId: "git-worktree",
      path: "/tmp/Owned",
      providerOwnsPath: true,
    });

    expect(
      await findProjectEnvironmentByHostPath(
        fixture.db,
        fixture.project.id,
        fixture.host.id,
        "/tmp/owned",
      ),
    ).toBeNull();
    expect(
      await findProviderEnvironmentContainingPath(fixture.db, "/tmp/owned/pkg"),
    ).toBeNull();
  });

  it("matches a Windows path with non-ASCII letters without regard to case", async () => {
    const fixture = await setup();
    const owned = await seedClaim(fixture, {
      environmentProviderId: "git-worktree",
      path: "C:\\src\\Équipe",
      providerOwnsPath: true,
    });

    expect(
      (
        await findProjectEnvironmentByHostPath(
          fixture.db,
          fixture.project.id,
          fixture.host.id,
          "C:\\src\\équipe",
        )
      )?.id,
    ).toBe(owned.id);
    expect(
      (
        await findProviderEnvironmentContainingPath(
          fixture.db,
          "c:\\SRC\\ÉQUIPE\\packages",
        )
      )?.id,
    ).toBe(owned.id);
    expect(
      await findProviderEnvironmentContainingPath(
        fixture.db,
        "C:\\src\\equipe",
      ),
    ).toBeNull();
  });

  it("treats underscores and percent signs in an owned path literally", async () => {
    const fixture = await setup();
    const windowsOwned = await seedClaim(fixture, {
      environmentProviderId: "git-worktree",
      path: "C:\\repos\\foo_bar%",
      providerOwnsPath: true,
    });
    const posixOwned = await seedClaim(fixture, {
      environmentProviderId: "git-worktree",
      path: "/repos/foo_bar%",
      providerOwnsPath: true,
    });

    expect(
      await findProviderEnvironmentContainingPath(
        fixture.db,
        "C:\\repos\\fooXbarYZ\\child",
      ),
    ).toBeNull();
    expect(
      (
        await findProviderEnvironmentContainingPath(
          fixture.db,
          "C:\\repos\\foo_bar%\\child",
        )
      )?.id,
    ).toBe(windowsOwned.id);
    expect(
      await findProviderEnvironmentContainingPath(
        fixture.db,
        "/repos/fooXbarYZ/child",
      ),
    ).toBeNull();
    expect(
      (
        await findProviderEnvironmentContainingPath(
          fixture.db,
          "/repos/foo_bar%/child",
        )
      )?.id,
    ).toBe(posixOwned.id);
  });
});
