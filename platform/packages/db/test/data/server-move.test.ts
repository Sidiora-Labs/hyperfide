import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  countAppliedMigrations,
  createConnection,
  createPluginArtifact,
  createPluginStateSnapshot,
  getHost,
  listPathInstalledPluginSources,
  listPluginArtifacts,
  listPluginMarketplaces,
  listPluginStateSnapshots,
  markInstalledPluginRemoved,
  noopNotifier,
  rerootServerOwnedPluginPaths,
  swapServerHostRoles,
  updateHost,
  upsertHost,
  upsertInstalledPlugin,
  upsertPluginMarketplace,
  type DbConnection,
} from "../../src/index.js";
import type { UpsertInstalledPluginInput } from "../../src/data/plugins.js";
import { installedPlugins } from "../../src/schema.js";
import { createMigratedConnection } from "../../src/testing.js";

const SOURCE_ROOT = "/home/me/.bb";
const TARGET_ROOT = "/home/me/.bb-machines/old-server";

function pathPlugin(
  id: string,
  sourcePath: string,
  rootDir: string,
): UpsertInstalledPluginInput {
  return {
    id,
    source: `path:${sourcePath}`,
    provenance: { kind: "direct" },
    sourceIntent: { kind: "path", canonicalPath: sourcePath },
    exactResolution: { kind: "path" },
    updateState: {
      lastCheckAt: null,
      availableCompatibleVersion: null,
      newestIncompatibleVersion: null,
      statusDetail: null,
    },
    activeArtifactId: null,
    rootDir,
    version: "1.0.0",
    enabled: true,
    enabledFollowsDefault: false,
  };
}

async function seedPluginPaths(db: DbConnection): Promise<void> {
  await upsertInstalledPlugin(
    db,
    pathPlugin(
      "server-owned",
      `${SOURCE_ROOT}/plugins/local-copy`,
      `${SOURCE_ROOT}/plugins/local-copy`,
    ),
  );
  await upsertInstalledPlugin(
    db,
    pathPlugin(
      "sibling-prefix",
      "/home/me/.bb-machines/other/plugin",
      "/home/me/.bb-machines/other/plugin",
    ),
  );
  await upsertInstalledPlugin(
    db,
    pathPlugin("outside", "/home/me/code/plugin", "/home/me/code/plugin"),
  );
  await createPluginArtifact(db, {
    id: "artifact-git",
    pluginId: "server-owned",
    sourceKind: "git",
    npmResolvedVersion: null,
    gitResolvedCommit: "abc123",
    gitCheckoutRoot: `${SOURCE_ROOT}/plugins/cache/git/abc123`,
    path: `${SOURCE_ROOT}/plugins/cache/git/abc123/plugin`,
    integrity: null,
    contentHash: null,
    validationResult: "valid",
    validatedAt: 1,
  });
  await createPluginArtifact(db, {
    id: "artifact-outside",
    pluginId: "outside",
    sourceKind: "npm",
    npmResolvedVersion: "1.0.0",
    gitResolvedCommit: null,
    gitCheckoutRoot: null,
    path: "/var/cache/bb/artifact.tgz",
    integrity: "sha512-x",
    contentHash: null,
    validationResult: "valid",
    validatedAt: 1,
  });
  await createPluginStateSnapshot(db, {
    id: "snapshot-1",
    pluginId: "server-owned",
    fromArtifactId: null,
    toArtifactId: "artifact-git",
    snapshotPath: `${SOURCE_ROOT}/plugins/snapshots/server-owned/1`,
    databasePath: `${SOURCE_ROOT}/plugins/snapshots/server-owned/1/data.db`,
    statePath: `${SOURCE_ROOT}/plugins/snapshots/server-owned/1/host-state.json`,
    secretsPath: null,
    registrationPath: `${SOURCE_ROOT}/plugins/snapshots/server-owned/1/previous-registration.json`,
    status: "ready",
    rollbackCandidateVersion: null,
    rollbackSourceFingerprint: null,
    rollbackBbVersion: null,
    rollbackSdkVersion: null,
    rollbackDetail: null,
    createdAt: 1,
    retainedUntil: 2,
    updatedAt: 1,
  });
  for (const [name, sourceKind, manifestUrl] of [
    ["local-path", "path", `${SOURCE_ROOT}/marketplaces/local`],
    ["https-lookalike", "https", `${SOURCE_ROOT}/marketplaces/not-a-path`],
    ["bundled", "path", "/opt/bb-app/plugins"],
  ] as const) {
    await upsertPluginMarketplace(db, {
      name,
      sourceKind,
      manifestUrl,
      sourceGitRef: null,
      sourceGitSubdirectory: null,
      sourceGitCommit: null,
      manifestJson: "{}",
      statsJson: null,
      etag: null,
      lastModified: null,
      lastSuccessfulRefreshAt: null,
      lastAttemptedRefreshAt: null,
      lastError: null,
    });
  }
}

async function pluginPaths(db: DbConnection) {
  return (
    await db
      .select({
        id: installedPlugins.id,
        rootDir: installedPlugins.rootDir,
        sourcePath: installedPlugins.sourcePath,
      })
      .from(installedPlugins)
      .all()
  ).sort((left, right) => left.id.localeCompare(right.id));
}

describe("server move data helpers", () => {
  let db: DbConnection;

  beforeEach(async () => {
    db = await createMigratedConnection();
  });

  afterEach(async () => await db.close());

  it("re-roots only server-owned plugin paths under the source data dir", async () => {
    await seedPluginPaths(db);

    const result = await rerootServerOwnedPluginPaths(db, {
      fromRoot: SOURCE_ROOT,
      toRoot: TARGET_ROOT,
    });

    expect(result).toEqual({
      plugins: 2,
      pluginArtifacts: 2,
      pluginStateSnapshots: 4,
      pluginMarketplaces: 1,
    });
    expect(await pluginPaths(db)).toEqual([
      {
        id: "outside",
        rootDir: "/home/me/code/plugin",
        sourcePath: "/home/me/code/plugin",
      },
      {
        id: "server-owned",
        rootDir: `${TARGET_ROOT}/plugins/local-copy`,
        sourcePath: `${TARGET_ROOT}/plugins/local-copy`,
      },
      {
        id: "sibling-prefix",
        rootDir: "/home/me/.bb-machines/other/plugin",
        sourcePath: "/home/me/.bb-machines/other/plugin",
      },
    ]);
    expect(
      (await listPluginArtifacts(db, "server-owned")).map((artifact) => ({
        path: artifact.path,
        gitCheckoutRoot: artifact.gitCheckoutRoot,
      })),
    ).toEqual([
      {
        path: `${TARGET_ROOT}/plugins/cache/git/abc123/plugin`,
        gitCheckoutRoot: `${TARGET_ROOT}/plugins/cache/git/abc123`,
      },
    ]);
    expect((await listPluginArtifacts(db, "outside"))[0]?.path).toBe(
      "/var/cache/bb/artifact.tgz",
    );
    expect(
      (await listPluginStateSnapshots(db, "server-owned"))[0],
    ).toMatchObject({
      snapshotPath: `${TARGET_ROOT}/plugins/snapshots/server-owned/1`,
      databasePath: `${TARGET_ROOT}/plugins/snapshots/server-owned/1/data.db`,
      statePath: `${TARGET_ROOT}/plugins/snapshots/server-owned/1/host-state.json`,
      secretsPath: null,
      registrationPath: `${TARGET_ROOT}/plugins/snapshots/server-owned/1/previous-registration.json`,
    });
    expect(
      Object.fromEntries(
        (await listPluginMarketplaces(db)).map((row) => [
          row.name,
          row.manifestUrl,
        ]),
      ),
    ).toMatchObject({
      "local-path": `${TARGET_ROOT}/marketplaces/local`,
      "https-lookalike": `${SOURCE_ROOT}/marketplaces/not-a-path`,
      bundled: "/opt/bb-app/plugins",
    });

    expect(
      await rerootServerOwnedPluginPaths(db, {
        fromRoot: SOURCE_ROOT,
        toRoot: TARGET_ROOT,
      }),
    ).toEqual({
      plugins: 0,
      pluginArtifacts: 0,
      pluginStateSnapshots: 0,
      pluginMarketplaces: 0,
    });
  });

  it("stays idempotent when the target root is nested inside the source root", async () => {
    const nestedTarget = `${SOURCE_ROOT}/imported`;
    await upsertInstalledPlugin(
      db,
      pathPlugin(
        "server-owned",
        `${SOURCE_ROOT}/plugins/local-copy`,
        `${SOURCE_ROOT}/plugins/local-copy`,
      ),
    );

    await rerootServerOwnedPluginPaths(db, {
      fromRoot: SOURCE_ROOT,
      toRoot: nestedTarget,
    });
    await rerootServerOwnedPluginPaths(db, {
      fromRoot: SOURCE_ROOT,
      toRoot: nestedTarget,
    });

    expect(await pluginPaths(db)).toEqual([
      {
        id: "server-owned",
        rootDir: `${nestedTarget}/plugins/local-copy`,
        sourcePath: `${nestedTarget}/plugins/local-copy`,
      },
    ]);
  });

  it("swaps host roles once and leaves provider-managed targets alone", async () => {
    const now = 5_000;
    await upsertHost(db, noopNotifier, { id: "old-server", name: "Laptop" });
    await upsertHost(db, noopNotifier, { id: "target", name: "Desktop" });
    await upsertHost(db, noopNotifier, { id: "cloud", name: "Cloud VM" });
    await updateHost(db, noopNotifier, "target", {
      machineProviderId: "manual",
      resource: { version: 1, hostId: "target" },
    });
    await updateHost(db, noopNotifier, "cloud", {
      machineProviderId: "digitalocean",
      resource: { dropletId: 1 },
    });

    expect(
      await swapServerHostRoles(db, {
        targetHostId: "target",
        sourceServerHostId: "old-server",
        now,
      }),
    ).toEqual({
      targetHostBecameServer: true,
      sourceServerHostBecameManual: true,
    });
    expect(await getHost(db, "target")).toMatchObject({
      machineProviderId: null,
      resource: null,
    });
    expect(await getHost(db, "old-server")).toMatchObject({
      machineProviderId: "manual",
      resource: { version: 1, hostId: "old-server" },
      updatedAt: now,
    });
    expect(
      await swapServerHostRoles(db, {
        targetHostId: "target",
        sourceServerHostId: "old-server",
        now,
      }),
    ).toEqual({
      targetHostBecameServer: false,
      sourceServerHostBecameManual: false,
    });

    expect(
      await swapServerHostRoles(db, {
        targetHostId: "cloud",
        sourceServerHostId: null,
        now,
      }),
    ).toEqual({
      targetHostBecameServer: false,
      sourceServerHostBecameManual: false,
    });
    expect(await getHost(db, "cloud")).toMatchObject({
      machineProviderId: "digitalocean",
      resource: { dropletId: 1 },
    });
  });

  it("counts applied migrations only on migrated databases", async () => {
    expect(await countAppliedMigrations(db)).toBeGreaterThan(0);
    const fresh = await createConnection(":memory:");
    try {
      expect(await countAppliedMigrations(fresh)).toBe(0);
    } finally {
      await fresh.close();
    }
  });

  it("lists path-installed plugin sources that are still installed", async () => {
    await seedPluginPaths(db);
    await markInstalledPluginRemoved(db, "sibling-prefix");

    expect(
      (await listPathInstalledPluginSources(db)).sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
    ).toEqual([
      { id: "outside", sourcePath: "/home/me/code/plugin" },
      { id: "server-owned", sourcePath: `${SOURCE_ROOT}/plugins/local-copy` },
    ]);
  });
});
