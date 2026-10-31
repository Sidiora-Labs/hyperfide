import Database from "better-sqlite3";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPluginArtifact,
  createPluginStateSnapshot,
  getInstalledPlugin,
  getPluginKvValue,
  listPluginArtifacts,
  listPluginStateSnapshots,
  setPluginKvValue,
  setPluginStateSnapshotStatus,
  upsertInstalledPlugin,
  type DbConnection,
} from "@hyperfide/db";
import { createMigratedConnection } from "@hyperfide/db/testing";
import { garbageCollectPluginArtifacts } from "../../../src/services/plugins/plugin-artifact-gc.js";
import {
  createPluginStateSnapshotOnDisk,
  readPluginSnapshotRegistration,
  restorePluginStateSnapshot,
} from "../../../src/services/plugins/plugin-state-snapshot.js";

describe("plugin activation snapshots and garbage collection", () => {
  let db: DbConnection;
  let dataDir: string;

  beforeEach(async () => {
    db = await createMigratedConnection();
    dataDir = await mkdtemp(join(tmpdir(), "hyperfide-plugin-snapshot-"));
  });

  afterEach(async () => {
    await db.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("replays a partially completed restore idempotently", async () => {
    const pluginDir = join(dataDir, "plugins", "snapshot-test");
    const databasePath = join(pluginDir, "data.db");
    const secretPath = join(pluginDir, "secrets", "token");
    await mkdir(join(pluginDir, "secrets"), { recursive: true });
    const pluginDb = await new Database(databasePath);
    pluginDb.exec("CREATE TABLE state (value TEXT NOT NULL)");
    await pluginDb.prepare("INSERT INTO state VALUES (?)").run("original");
    await pluginDb.close();
    await setPluginKvValue(
      db,
      "snapshot-test",
      "cursor",
      JSON.stringify("original"),
    );
    await writeFile(secretPath, "opaque-secret", { mode: 0o600 });
    await upsertInstalledPlugin(db, {
      id: "snapshot-test",
      source: `path:${pluginDir}`,
      provenance: { kind: "direct" },
      sourceIntent: { kind: "path", canonicalPath: pluginDir },
      exactResolution: { kind: "path" },
      updateState: {
        lastCheckAt: null,
        availableCompatibleVersion: null,
        newestIncompatibleVersion: null,
        statusDetail: null,
      },
      activeArtifactId: null,
      rootDir: pluginDir,
      version: "1.0.0",
      enabled: true,
      enabledFollowsDefault: false,
    });
    const previousRegistration = await getInstalledPlugin(db, "snapshot-test");
    if (previousRegistration === undefined) {
      throw new Error("missing snapshot-test registration");
    }
    const snapshot = await createPluginStateSnapshotOnDisk({
      db,
      dataDir,
      pluginId: "snapshot-test",
      fromArtifactId: "artifact-old",
      toArtifactId: "artifact-new",
      now: 100,
      retainedUntil: 200,
      previousRegistration,
    });

    const mutate = async () => {
      const changed = await new Database(databasePath);
      await changed.prepare("UPDATE state SET value = ?").run("changed");
      await changed.close();
      await setPluginKvValue(
        db,
        "snapshot-test",
        "cursor",
        JSON.stringify("changed"),
      );
      await writeFile(secretPath, "changed-secret");
    };
    await mutate();
    await restorePluginStateSnapshot({
      db,
      dataDir,
      snapshotId: snapshot.id,
      now: 110,
    });
    await mutate();
    await setPluginStateSnapshotStatus(db, snapshot.id, "restoring", 120);
    await restorePluginStateSnapshot({
      db,
      dataDir,
      snapshotId: snapshot.id,
      now: 130,
    });

    const restored = await new Database(databasePath, { readonly: true });
    expect(
      await restored.prepare("SELECT value FROM state").pluck().get(),
    ).toBe("original");
    await restored.close();
    expect(await getPluginKvValue(db, "snapshot-test", "cursor")).toBe(
      JSON.stringify("original"),
    );
    expect(await readFile(secretPath, "utf8")).toBe("opaque-secret");
  });

  it("reads a registration snapshotted before enabled-default tracking as an explicit choice", async () => {
    const pluginDir = join(dataDir, "plugins", "pre-default-tracking");
    await mkdir(pluginDir, { recursive: true });
    await upsertInstalledPlugin(db, {
      id: "pre-default-tracking",
      source: "npm:hyperfide-plugin-pre-default-tracking@1.0.0",
      provenance: { kind: "direct" },
      sourceIntent: {
        kind: "npm",
        packageName: "hyperfide-plugin-pre-default-tracking",
        registry: "https://registry.npmjs.org",
        requestedSpec: "1.0.0",
        specKind: "exact",
      },
      exactResolution: {
        kind: "npm",
        version: "1.0.0",
        integrity: "sha512-pre-default-tracking",
      },
      updateState: {
        lastCheckAt: null,
        availableCompatibleVersion: null,
        newestIncompatibleVersion: null,
        statusDetail: null,
      },
      activeArtifactId: null,
      rootDir: pluginDir,
      version: "1.0.0",
      enabled: false,
      enabledFollowsDefault: false,
    });
    const registration = await getInstalledPlugin(db, "pre-default-tracking");
    if (registration === undefined) throw new Error("missing registration");
    const snapshot = await createPluginStateSnapshotOnDisk({
      db,
      dataDir,
      pluginId: registration.id,
      fromArtifactId: null,
      toArtifactId: "candidate",
      now: 100,
      retainedUntil: 200,
      previousRegistration: registration,
    });
    if (snapshot.registrationPath === null) {
      throw new Error("missing snapshot registration path");
    }
    const { enabledFollowsDefault: _enabledFollowsDefault, ...preTracking } =
      registration;
    await writeFile(snapshot.registrationPath, JSON.stringify(preTracking));

    await expect(
      readPluginSnapshotRegistration({ db, snapshotId: snapshot.id }),
    ).resolves.toEqual({ ...preTracking, enabledFollowsDefault: false });
  });

  it("normalizes legacy marketplace registrations against migrated provenance", async () => {
    const pluginDir = join(dataDir, "plugins", "legacy-snapshot");
    await mkdir(pluginDir, { recursive: true });
    await upsertInstalledPlugin(db, {
      id: "legacy-snapshot",
      source: "npm:hyperfide-plugin-legacy@^1.0.0",
      provenance: {
        kind: "catalog",
        marketplace: "hyperfide-community",
        entryId: "legacy-entry",
      },
      sourceIntent: {
        kind: "npm",
        packageName: "hyperfide-plugin-legacy",
        registry: "https://registry.npmjs.org",
        requestedSpec: "^1.0.0",
        specKind: "range",
      },
      exactResolution: {
        kind: "npm",
        version: "1.2.0",
        integrity: "sha512-legacy",
      },
      updateState: {
        lastCheckAt: null,
        availableCompatibleVersion: null,
        newestIncompatibleVersion: null,
        statusDetail: null,
      },
      activeArtifactId: null,
      rootDir: pluginDir,
      version: "1.2.0",
      enabled: true,
      enabledFollowsDefault: false,
    });
    const registration = await getInstalledPlugin(db, "legacy-snapshot");
    if (registration === undefined) throw new Error("missing registration");
    const snapshot = await createPluginStateSnapshotOnDisk({
      db,
      dataDir,
      pluginId: registration.id,
      fromArtifactId: null,
      toArtifactId: "candidate",
      now: 100,
      retainedUntil: 200,
      previousRegistration: registration,
    });
    if (snapshot.registrationPath === null) {
      throw new Error("missing snapshot registration path");
    }
    const {
      catalogEntryId: _catalogEntryId,
      catalogMarketplaceName: _catalogMarketplaceName,
      ...legacyRegistration
    } = registration;
    const {
      catalogMarketplaceName: _preNamedMarketplace,
      ...preNamedMarketplaceRegistration
    } = registration;
    await writeFile(
      snapshot.registrationPath,
      JSON.stringify(preNamedMarketplaceRegistration),
    );
    await expect(
      readPluginSnapshotRegistration({ db, snapshotId: snapshot.id }),
    ).resolves.toMatchObject({
      provenance: "catalog",
      catalogEntryId: "legacy-entry",
      catalogMarketplaceName: null,
      sourceNpmRequestedSpec: "^1.0.0",
      npmResolvedVersion: "1.2.0",
    });

    await writeFile(
      snapshot.registrationPath,
      JSON.stringify({
        ...legacyRegistration,
        provenance: "marketplace",
        marketplaceId: "hyperfide-community",
        marketplaceEntryId: "legacy-entry",
      }),
    );
    await expect(
      readPluginSnapshotRegistration({ db, snapshotId: snapshot.id }),
    ).resolves.toMatchObject({
      provenance: "catalog",
      catalogEntryId: "legacy-entry",
      sourceNpmRequestedSpec: "^1.0.0",
      npmResolvedVersion: "1.2.0",
    });

    await writeFile(
      snapshot.registrationPath,
      JSON.stringify({
        ...legacyRegistration,
        provenance: "marketplace",
        marketplaceId: "third-party",
        marketplaceEntryId: "legacy-entry",
      }),
    );
    await expect(
      readPluginSnapshotRegistration({ db, snapshotId: snapshot.id }),
    ).resolves.toMatchObject({
      provenance: "direct",
      catalogEntryId: null,
      sourceNpmRequestedSpec: "^1.0.0",
      npmResolvedVersion: "1.2.0",
    });

    await db.$client
      .prepare(
        "UPDATE plugins SET provenance = 'direct', catalog_entry_id = NULL WHERE id = ?",
      )
      .run(registration.id);
    await writeFile(
      snapshot.registrationPath,
      JSON.stringify({
        ...legacyRegistration,
        provenance: "marketplace",
        marketplaceId: "hyperfide-community",
        marketplaceEntryId: "legacy-entry",
      }),
    );
    await expect(
      readPluginSnapshotRegistration({ db, snapshotId: snapshot.id }),
    ).resolves.toMatchObject({
      provenance: "direct",
      catalogEntryId: null,
      sourceNpmRequestedSpec: "^1.0.0",
      npmResolvedVersion: "1.2.0",
    });
  });

  it("keeps a shared checkout while a nested plugin still lives in it", async () => {
    const commit = "a".repeat(40);
    const checkout = join(
      dataDir,
      "plugins",
      "cache",
      "git",
      "host",
      "repo",
      commit,
    );
    const nestedPath = join(checkout, "plugins", "nested");
    await mkdir(nestedPath, { recursive: true });
    await writeFile(join(nestedPath, "sentinel"), "keep");
    const makeArtifact = async (id: string, pluginId: string, path: string) =>
      await createPluginArtifact(db, {
        id,
        pluginId,
        sourceKind: "git",
        npmResolvedVersion: null,
        gitResolvedCommit: commit,
        gitCheckoutRoot: checkout,
        path,
        integrity: null,
        contentHash: "hash",
        validationResult: "valid",
        validatedAt: 1,
      });
    await makeArtifact("root", "gc-root", checkout);
    await makeArtifact("nested", "gc-nested", nestedPath);
    await upsertInstalledPlugin(db, {
      id: "gc-nested",
      source: `git:https://example.test/repo.git@main`,
      provenance: { kind: "direct" },
      sourceIntent: {
        kind: "git",
        url: "https://example.test/repo.git",
        subdirectory: "plugins/nested",
        selector: { kind: "ref", ref: "main", refKind: "branch" },
      },
      exactResolution: { kind: "git", commit },
      updateState: {
        lastCheckAt: null,
        availableCompatibleVersion: null,
        newestIncompatibleVersion: null,
        statusDetail: null,
      },
      activeArtifactId: "nested",
      rootDir: nestedPath,
      version: "1.0.0",
      enabled: true,
      enabledFollowsDefault: false,
    });

    const warnings: string[] = [];
    await garbageCollectPluginArtifacts({
      db,
      dataDir,
      now: Date.now() + 1_000,
      retentionMs: 0,
      warn: (message) => warnings.push(message),
    });

    await stat(join(nestedPath, "sentinel"));
    expect(await listPluginArtifacts(db, "gc-root")).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  it("keeps a nested directory while a root plugin still owns it", async () => {
    const commit = "c".repeat(40);
    const checkout = join(
      dataDir,
      "plugins",
      "cache",
      "git",
      "host",
      "repo",
      commit,
    );
    const nestedPath = join(checkout, "plugins", "nested");
    await mkdir(nestedPath, { recursive: true });
    await writeFile(join(nestedPath, "sentinel"), "keep");
    const makeArtifact = async (id: string, pluginId: string, path: string) =>
      await createPluginArtifact(db, {
        id,
        pluginId,
        sourceKind: "git",
        npmResolvedVersion: null,
        gitResolvedCommit: commit,
        gitCheckoutRoot: checkout,
        path,
        integrity: null,
        contentHash: "hash",
        validationResult: "valid",
        validatedAt: 1,
      });
    await makeArtifact("active-root", "gc-active-root", checkout);
    await makeArtifact("nested-old", "gc-nested-old", nestedPath);
    await upsertInstalledPlugin(db, {
      id: "gc-active-root",
      source: "git:https://example.test/repo.git@main",
      provenance: { kind: "direct" },
      sourceIntent: {
        kind: "git",
        url: "https://example.test/repo.git",
        subdirectory: null,
        selector: { kind: "ref", ref: "main", refKind: "branch" },
      },
      exactResolution: { kind: "git", commit },
      updateState: {
        lastCheckAt: null,
        availableCompatibleVersion: null,
        newestIncompatibleVersion: null,
        statusDetail: null,
      },
      activeArtifactId: "active-root",
      rootDir: checkout,
      version: "1.0.0",
      enabled: true,
      enabledFollowsDefault: false,
    });

    const warnings: string[] = [];
    await garbageCollectPluginArtifacts({
      db,
      dataDir,
      now: Date.now() + 1_000,
      retentionMs: 0,
      warn: (message) => warnings.push(message),
    });

    await stat(join(nestedPath, "sentinel"));
    expect(await listPluginArtifacts(db, "gc-nested-old")).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  it("keeps a nested directory that carries the commit name", async () => {
    const commit = "d".repeat(40);
    const checkout = join(
      dataDir,
      "plugins",
      "cache",
      "git",
      "host",
      "repo",
      commit,
    );
    const nestedPath = join(checkout, "vendor", commit);
    await mkdir(nestedPath, { recursive: true });
    await writeFile(join(nestedPath, "sentinel"), "keep");
    const makeArtifact = async (id: string, pluginId: string, path: string) =>
      await createPluginArtifact(db, {
        id,
        pluginId,
        sourceKind: "git",
        npmResolvedVersion: null,
        gitResolvedCommit: commit,
        gitCheckoutRoot: checkout,
        path,
        integrity: null,
        contentHash: "hash",
        validationResult: "valid",
        validatedAt: 1,
      });
    await makeArtifact("collision-root", "gc-collision-root", checkout);
    await makeArtifact("collision-nested", "gc-collision-nested", nestedPath);
    await upsertInstalledPlugin(db, {
      id: "gc-collision-root",
      source: "git:https://example.test/repo.git@main",
      provenance: { kind: "direct" },
      sourceIntent: {
        kind: "git",
        url: "https://example.test/repo.git",
        subdirectory: null,
        selector: { kind: "ref", ref: "main", refKind: "branch" },
      },
      exactResolution: { kind: "git", commit },
      updateState: {
        lastCheckAt: null,
        availableCompatibleVersion: null,
        newestIncompatibleVersion: null,
        statusDetail: null,
      },
      activeArtifactId: "collision-root",
      rootDir: checkout,
      version: "1.0.0",
      enabled: true,
      enabledFollowsDefault: false,
    });

    const warnings: string[] = [];
    await garbageCollectPluginArtifacts({
      db,
      dataDir,
      now: Date.now() + 1_000,
      retentionMs: 0,
      warn: (message) => warnings.push(message),
    });

    await stat(join(nestedPath, "sentinel"));
    expect(await listPluginArtifacts(db, "gc-collision-nested")).toHaveLength(
      1,
    );
    expect(warnings).toEqual([]);
  });

  it("collects the shared checkout after its last nested plugin", async () => {
    const commit = "b".repeat(40);
    const checkout = join(
      dataDir,
      "plugins",
      "cache",
      "git",
      "host",
      "repo",
      commit,
    );
    const nestedPath = join(checkout, "plugins", "nested");
    await mkdir(nestedPath, { recursive: true });
    await writeFile(join(checkout, "repository-file"), "remove");
    await createPluginArtifact(db, {
      id: "last-nested",
      pluginId: "gc-last-nested",
      sourceKind: "git",
      npmResolvedVersion: null,
      gitResolvedCommit: commit,
      gitCheckoutRoot: checkout,
      path: nestedPath,
      integrity: null,
      contentHash: "hash",
      validationResult: "valid",
      validatedAt: 1,
    });

    const warnings: string[] = [];
    await garbageCollectPluginArtifacts({
      db,
      dataDir,
      now: Date.now() + 1_000,
      retentionMs: 0,
      warn: (message) => warnings.push(message),
    });

    await expect(stat(checkout)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await listPluginArtifacts(db, "gc-last-nested")).toHaveLength(0);
    expect(warnings).toEqual([]);
  });

  it("never removes active, snapshot-retained, or unmanaged artifact roots", async () => {
    const cacheRoot = join(dataDir, "plugins", "cache", "git", "source");
    const activePath = join(cacheRoot, "active");
    const retainedPath = join(cacheRoot, "retained");
    const localPath = join(dataDir, "user-plugin");
    await Promise.all(
      [activePath, retainedPath, localPath].map(async (path) => {
        await mkdir(path, { recursive: true });
        await writeFile(join(path, "sentinel"), "keep");
      }),
    );
    const makeArtifact = async (id: string, path: string, commit: string) =>
      await createPluginArtifact(db, {
        id,
        pluginId: "gc-test",
        sourceKind: "git",
        npmResolvedVersion: null,
        gitResolvedCommit: commit,
        gitCheckoutRoot: path,
        path,
        integrity: null,
        contentHash: "hash",
        validationResult: "valid",
        validatedAt: 1,
      });
    await makeArtifact("active", activePath, "active");
    await makeArtifact("retained", retainedPath, "retained");
    await makeArtifact("unmanaged", localPath, "user-plugin");
    await upsertInstalledPlugin(db, {
      id: "gc-test",
      source: "git:https://example.test/plugin.git@main",
      provenance: { kind: "direct" },
      sourceIntent: {
        kind: "git",
        url: "https://example.test/plugin.git",
        subdirectory: null,
        selector: { kind: "ref", ref: "main", refKind: "branch" },
      },
      exactResolution: { kind: "git", commit: "active" },
      updateState: {
        lastCheckAt: null,
        availableCompatibleVersion: null,
        newestIncompatibleVersion: null,
        statusDetail: null,
      },
      activeArtifactId: "active",
      rootDir: activePath,
      version: "1.0.0",
      enabled: true,
      enabledFollowsDefault: false,
    });
    const snapshotPath = join(
      dataDir,
      "plugins",
      "snapshots",
      "gc-test",
      "one",
    );
    await mkdir(snapshotPath, { recursive: true });
    await createPluginStateSnapshot(db, {
      id: "snapshot",
      pluginId: "gc-test",
      fromArtifactId: "retained",
      toArtifactId: "active",
      snapshotPath,
      databasePath: null,
      statePath: join(snapshotPath, "state.json"),
      secretsPath: null,
      registrationPath: null,
      status: "rollback-pending",
      rollbackCandidateVersion: "candidate",
      rollbackSourceFingerprint: "source",
      rollbackHyperfideVersion: "1.0.0",
      rollbackSdkVersion: "0.2.0",
      rollbackDetail: "failed",
      createdAt: 1,
      retainedUntil: 1,
      updatedAt: 1,
    });
    const warnings: string[] = [];
    await garbageCollectPluginArtifacts({
      db,
      dataDir,
      now: Date.now() + 1_000,
      retentionMs: 0,
      warn: (message) => warnings.push(message),
    });

    expect(await listPluginArtifacts(db, "gc-test")).toHaveLength(3);
    expect(await listPluginStateSnapshots(db, "gc-test")).toHaveLength(1);
    await Promise.all(
      [activePath, retainedPath, localPath].map((path) =>
        stat(join(path, "sentinel")),
      ),
    );
    expect(warnings).toEqual([
      expect.stringContaining("refusing to garbage collect unmanaged"),
    ]);
  });
});
