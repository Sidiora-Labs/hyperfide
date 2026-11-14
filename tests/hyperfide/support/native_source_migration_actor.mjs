import assert from "node:assert/strict";
import { createPublicKey, randomUUID } from "node:crypto";
import { fork, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "../../../core/control-plane/node_modules/pg/lib/index.js";
import { createNativeAcceptanceFixture } from "./native_source_acceptance_fixture.mjs";
const moduleRoot = process.env.SOURCE_CONTROL_MODULE_ROOT,
  load = (name) => import(pathToFileURL(path.join(moduleRoot, name + ".js")));
const [
  { createLocalGitImportSource },
  { sourceMigrationControls, SourceMigrationService },
  { compareNativeMigration },
  { SourceControlClient },
  { createLocalGitDestination },
] = await Promise.all([
  load("git/import_transport"),
  load("migration/cutover"),
  load("migration/parity"),
  import(
    pathToFileURL(
      path.join(process.env.SOURCE_CONTROL_SDK_MODULE_ROOT, "client.js"),
    )
  ),
  load("git/transport"),
]);
async function migrationChild() {
  const config = await new Promise((resolve) =>
    process.once("message", resolve),
  );
  const [
    { createSourceService },
    { S3SourceObjectBackend },
    { startSourceHttp },
    { SOURCE_API_PATH },
  ] = await Promise.all([
    load("registration"),
    load("s3"),
    load("http"),
    load("contracts"),
  ]);
  const pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: 16,
    }),
    controller = new AbortController();
  const notify = (message) =>
    new Promise((resolve, reject) =>
      process.send(message, (error) => (error ? reject(error) : resolve())),
    );
  const transaction = async (body) => {
    const tx = await pool.connect();
    let committed = false;
    try {
      await tx.query("BEGIN");
      await tx.query(
        "SELECT set_config('statement_timeout','10000',true),set_config('lock_timeout','10000',true)",
      );
      const value = await body(tx);
      const saved = (
        await tx.query(
          "SELECT result FROM hyperfide.source_cutover_operations WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND operation_id=$4",
          [...Object.values(config.scope), config.input.operation_id],
        )
      ).rows[0];
      const stop = async (boundary) => {
        if (config.boundary === boundary && saved) {
          await notify({ boundary, result: saved.result });
          await new Promise(() => {});
        }
      };
      await stop("before-" + config.action + "-commit");
      await tx.query("COMMIT");
      committed = true;
      await stop(
        config.action === "recover"
          ? "after-recover"
          : "after-" + config.action + "-commit",
      );
      return value;
    } catch (error) {
      if (!committed) await tx.query("ROLLBACK");
      throw error;
    } finally {
      tx.release();
    }
  };
  const sources = config.sources.map((source) =>
    createLocalGitImportSource({ ...source, scope: config.scope }),
  );
  const service = createSourceService({
    pool,
    backend: new S3SourceObjectBackend(config.backend),
    cursorKey: Buffer.from(config.cursorKey, "hex"),
    transaction,
    workspaceBudgets: {
      cache_bytes: 16777216,
      max_cache_entries: 1024,
      max_file_bytes: 8388608,
      materialized_bytes: 33554432,
      dirty_bytes: 8388608,
    },
    imports: { sources },
    migration: sourceMigrationControls(config.migrationEnv),
  });
  const trust = {
    ...config.trust,
    keys: { "fixture-source-key": createPublicKey(config.publicKey) },
  };
  const server = await startSourceHttp({
    api: service.api,
    trust,
    host: "127.0.0.1",
    port: 0,
    allowLoopbackHTTP: true,
    signal: controller.signal,
  });
  try {
    const client = new SourceControlClient({
      endpoint: server.address + SOURCE_API_PATH,
      scope: config.scope,
      token: () => config.token,
      timeout_ms: 120000,
    });
    const input = { ...config.input };
    delete input.operation_id;
    const result = await client.call(
      "source.migration." + config.action,
      input,
      {
        operation_id: config.input.operation_id,
        idempotency_key: config.input.operation_id,
      },
    );
    await notify({ result });
  } finally {
    await server.close();
    controller.abort();
    await pool.end();
    process.disconnect();
  }
}
if (process.argv.includes("--migration-child")) {
  await migrationChild();
} else {
  const temporary = await fs.mkdtemp(
      path.join(os.tmpdir(), "hf-native-cutover-"),
    ),
    scope = {
      organisation_id: randomUUID(),
      repository_id: randomUUID(),
      security_domain_id: randomUUID(),
    },
    checks = [];
  const gitEnv = {
    PATH: "/usr/bin:/bin",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Migration Author",
    GIT_AUTHOR_EMAIL: "migration@example.invalid",
    GIT_COMMITTER_NAME: "Migration Author",
    GIT_COMMITTER_EMAIL: "migration@example.invalid",
    GIT_AUTHOR_DATE: "1700000000 +0000",
    GIT_COMMITTER_DATE: "1700000000 +0000",
  };
  const git = (directory, args, input) => {
    const result = spawnSync("git", ["--git-dir=" + directory, ...args], {
      input,
      env: gitEnv,
      maxBuffer: 8 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stderr?.toString());
    return result.stdout.toString().trim();
  };
  const command = (binary, args) => {
    const result = spawnSync(binary, args, { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  let fixture,
    mounted = false;
  try {
    const legacy = path.join(temporary, "legacy"),
      data = path.join(legacy, "data"),
      secondLegacy = path.join(temporary, "legacy-b"),
      secondData = path.join(secondLegacy, "data");
    await fs.mkdir(data, { recursive: true });
    await fs.mkdir(secondData, { recursive: true });
    const sources = [],
      tips = [];
    for (const id of ["a", "b"]) {
      const directory = path.join(id === "a" ? data : secondData, id + ".git");
      git(directory, ["init", "--bare"]);
      const blob = git(
          directory,
          ["hash-object", "-w", "--stdin"],
          "project " + id + "\n",
        ),
        tree = git(
          directory,
          ["mktree"],
          "100644 blob " + blob + "\tmain.txt\n",
        ),
        tip = git(directory, ["commit-tree", tree], "history " + id + "\n");
      git(directory, ["update-ref", "refs/heads/main", tip]);
      tips.push("git:sha1:" + tip);
      sources.push(
        createLocalGitImportSource({
          id,
          scope,
          repository_identity: "legacy-" + id,
          path: directory,
        }),
      );
    }
    await fs.mkdir(path.join(legacy, ".hyperfide"), { mode: 0o700 });
    await fs.mkdir(path.join(secondLegacy, ".hyperfide"), { mode: 0o700 });
    await fs.writeFile(path.join(data, "source.txt"), "legacy source\n");
    const deployment = randomUUID(),
      writer = "owned-cutover-legacy",
      legacyProfile = path.join(temporary, "legacy.json"),
      migrationProfile = path.join(temporary, "migration.json"),
      secondProfile = path.join(temporary, "legacy-b.json"),
      secondWriter = "owned-cutover-legacy-b";
    await fs.writeFile(
      legacyProfile,
      JSON.stringify({
        schema_version: 1,
        deployment_id: deployment,
        source_epoch: null,
        workspace_root: legacy,
        data_roots: ["data"],
        legacy_writer_id: writer,
        expected_pid_namespace: await fs.readlink("/proc/self/ns/pid"),
        expected_mount_namespace: await fs.readlink("/proc/self/ns/mnt"),
      }),
      { mode: 0o600 },
    );
    await fs.writeFile(
      secondProfile,
      JSON.stringify({
        ...JSON.parse(await fs.readFile(legacyProfile, "utf8")),
        workspace_root: secondLegacy,
        legacy_writer_id: secondWriter,
      }),
      { mode: 0o600 },
    );
    await fs.writeFile(
      migrationProfile,
      JSON.stringify({
        deployment_id: deployment,
        legacy_source_epoch: null,
        writer_id: writer,
        writer_profiles: [
          { writer_id: secondWriter, legacy_writer_config_file: secondProfile },
        ],
      }),
      { mode: 0o600 },
    );
    const migrationEnv = {
        HF_SOURCE_MIGRATION_CONFIG: migrationProfile,
        HF_LEGACY_WRITER_CONFIG_FILE: legacyProfile,
      },
      controls = sourceMigrationControls(migrationEnv);
    const actions = [
      "source.graph.build",
      "source.objects.put",
      "source.objects.read",
      "source.revisions.create",
      "source.revisions.read",
      "source.operations.read",
      "source.domains.create",
      "source.workspaces.open",
      "source.workspaces.close",
      "source.workspaces.detail",
      "source.projections.create",
      "source.projections.read",
      "source.imports.create",
      "source.imports.read",
      "source.imports.resume",
      "source.imports.mappings",
      "source.migration.prepare",
      "source.migration.read",
      "source.migration.consolidate",
      "source.migration.parity",
      "source.migration.quiesce",
      "source.migration.activate",
      "source.migration.abort",
      "source.migration.recover",
      "source.migration.stage",
      "source.migration.refresh",
      "source.candidates.create",
      "source.candidates.read",
      "source.candidates.qualify",
      "source.assurance.custody.create",
      "source.assurance.publish",
      "source.acceptance.accept",
      "source.acceptance.read",
      "source.publications.create",
      "source.publications.cancel",
      "source.publications.resume",
      "source.publications.read",
      "source.domains.read",
      "source.assurance.revoke",
    ];
    const publicRepo = path.join(temporary, "public.git");
    git(publicRepo, ["init", "--bare"]);
    const destination = createLocalGitDestination({
      scope,
      id: "pilot",
      repository_identity: "pilot",
      path: publicRepo,
      allowed_refs: ["refs/heads/main"],
    });
    fixture = await createNativeAcceptanceFixture({
      scope,
      actions,
      serviceOptions: {
        imports: { sources },
        migration: controls,
        publication: { destinations: [destination] },
      },
    });
    const { service, client, pool, context } = fixture,
      send = (actor, action, input) => {
        const operation_id = input.operation_id ?? randomUUID(),
          payload = { ...input };
        delete payload.operation_id;
        return actor.call(action, payload, {
          operation_id,
          idempotency_key: operation_id,
        });
      },
      call = (action, input) => send(client, action, input),
      base = await fixture.createRevision({
        text: "candidate: base\n",
        parent_revision_ids: [],
      });
    const crashBoundaries = JSON.parse(
        process.env.HYPERFIDE_MIGRATION_CRASH_BOUNDARIES,
      ),
      exercised = [];
    const runMigrationProcess = async (action, input, boundary = null) => {
      const child = fork(
        fileURLToPath(import.meta.url),
        ["--migration-child"],
        { stdio: ["ignore", "pipe", "pipe", "ipc"] },
      );
      let output = "",
        message;
      child.stdout.on("data", (bytes) => {
        output += bytes;
      });
      child.stderr.on("data", (bytes) => {
        output += bytes;
      });
      const closed = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      const received = new Promise((resolve, reject) => {
        child.on("message", (value) => {
          message = value;
          if (boundary) {
            assert.equal(value.boundary, boundary);
            child.kill("SIGKILL");
          }
          resolve(value);
        });
        child.once("exit", () => {
          if (!message)
            reject(
              new Error(
                "Migration child exited without boundary/result: " + output,
              ),
            );
        });
      });
      const watchdog = setTimeout(() => child.kill("SIGKILL"), 120000);
      try {
        child.send({
          action,
          input,
          boundary,
          scope,
          backend: fixture.backend.config,
          cursorKey: "11".repeat(32),
          sources: sources.map((source) => ({
            id: source.id,
            repository_identity: "legacy-" + source.id,
            path: source.readable_path,
          })),
          migrationEnv,
          trust: {
            issuer: fixture.trust.issuer,
            audience: fixture.trust.audience,
            max_ttl_seconds: fixture.trust.max_ttl_seconds,
          },
          publicKey: fixture.trust.keys["fixture-source-key"].export({
            type: "spki",
            format: "pem",
          }),
          token: fixture.tokenFor(),
        });
        const observed = await received,
          exit = await closed;
        if (boundary) {
          assert(crashBoundaries.includes(boundary));
          assert.equal(exit.signal, "SIGKILL", output);
          exercised.push(boundary);
        } else {
          assert.equal(exit.code, 0, output);
          assert.equal(exit.signal, null);
        }
        return observed.result;
      } finally {
        clearTimeout(watchdog);
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      }
    };
    const operationCount = async (operation) =>
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM hyperfide.source_cutover_operations WHERE operation_id=$1",
          [operation],
        )
      ).rows[0].n;
    const singleAuthority = async (epoch, route) => {
      const state = (
        await pool.query(
          "SELECT r.authority_epoch::text AS repository,a.authority_epoch::text AS domain,c.active_epoch::text,c.route,c.legacy_isolation FROM hyperfide.source_repositories r JOIN hyperfide.source_authority_domains a USING(organisation_id,repository_id,security_domain_id) JOIN hyperfide.source_native_cutovers c USING(organisation_id,repository_id,security_domain_id) WHERE r.organisation_id=$1 AND r.repository_id=$2 AND r.security_domain_id=$3 AND c.migration_id=$4",
          [...Object.values(scope), manifest.migration_id],
        )
      ).rows[0];
      assert.equal(state.repository, epoch);
      assert.equal(state.domain, epoch);
      assert.equal(state.active_epoch, epoch);
      assert.equal(state.route, route);
      if (state.legacy_isolation) {
        assert.deepEqual(
          state.legacy_isolation
            .map((receipt) => receipt.isolated_writer)
            .sort(),
          [writer, secondWriter].sort(),
        );
        assert(
          state.legacy_isolation.every(
            (receipt) =>
              receipt.admission_disabled &&
              receipt.writable_fds === 0 &&
              receipt.writable_shared_mappings === 0,
          ),
        );
      }
      if (route === "NATIVE") {
        await assert.rejects(
          () =>
            fs.writeFile(path.join(data, "source.txt"), "stale legacy writer"),
          (error) => error.code === "EROFS",
        );
        await assert.rejects(
          () =>
            fs.writeFile(
              path.join(secondData, "forbidden"),
              "stale second writer",
            ),
          (error) => error.code === "EROFS",
        );
      }
    };
    const { ingestNativeGraph } = await load("../graph/native"),
      graphId = randomUUID();
    const graph = await ingestNativeGraph(service.metadata, context, {
      build_id: graphId,
      request_digest: fixture.sourceDigest({
        revision_id: base.revision_id,
        root_tree_id: base.root_tree_id,
      }),
      revision_id: base.revision_id,
      root_tree_id: base.root_tree_id,
      identity: {
        schema_version: 1,
        source_kind: "NATIVE",
        scope,
        revision_id: base.revision_id,
        root_tree_id: base.root_tree_id,
        overlay: null,
      },
      paths: ["main.txt"],
    });
    assert.equal(graph.state, "BUILDING");
    const graphBefore = (
      await pool.query(
        "SELECT to_jsonb(g) AS binding FROM hyperfide.source_graph_builds g WHERE build_id=$1",
        [graphId],
      )
    ).rows[0].binding;
    const projects = [];
    for (let n = 0; n < 2; n++) {
      const policy = {
        schema_version: 1,
        policy_id: randomUUID(),
        version: 1,
        project_id: "project-" + n,
        repository_identity: "project-" + n,
        mappings: [{ source_path: "", target_path: "projects/" + n }],
        dependencies: [],
        no_visible_change: "KEEP",
        merge_parents: "ORDERED_UNIQUE",
        public_metadata: "NATIVE_PUBLIC_V1",
        signature_policy: "REJECT",
        tag_signing: "REJECT",
        object_format: "sha1",
      };
      await call("source.projections.create", policy);
      const input = {
        import_id: randomUUID(),
        source_id: sources[n].id,
        tip_oid: tips[n],
        base_revision_id: base.revision_id,
        policy_id: policy.policy_id,
        policy_version: 1,
        budget: {
          max_commits: 8,
          max_objects: 128,
          max_bytes: 1048576,
          max_file_bytes: 1048576,
          max_depth: 32,
          max_total_commits: 32,
        },
      };
      await call("source.imports.create", input);
      const imported = await call("source.imports.resume", {
        import_id: input.import_id,
      });
      assert.equal(imported.state, "COMPLETE");
      projects.push({
        project_id: policy.project_id,
        import_id: input.import_id,
        source_id: sources[n].id,
        source_ref: "refs/heads/main",
        tip_oid: tips[n],
        target_path: "projects/" + n,
      });
    }
    const manifest = {
      schema_version: 1,
      migration_id: randomUUID(),
      base_revision_id: base.revision_id,
      projects,
      legacy_writer_ids: [writer, secondWriter],
      legacy_source_epoch: null,
      provenance: {
        author: {
          name: "Native Migration",
          email: "migration@example.invalid",
        },
        message: "Consolidated projects",
        timestamp: "2026-11-03T00:00:00.000Z",
      },
      workflow_transition: {
        source_mode: "native",
        supersedes: [
          "hyperfide-v21:source-engine-local-only",
          "hyperfide-v22:git-worktree-source",
        ],
      },
    };
    const basePilot = await fixture.accept(
      await fixture.createCandidate(base, {
        domain: await fixture.createDomain(base),
      }),
    );
    for (const project of projects) {
      const imported = await call("source.imports.read", {
          import_id: project.import_id,
        }),
        revision = await service.metadata.readRevision(
          context,
          imported.revision_id,
        ),
        change = (
          await pool.query(
            "SELECT change_id FROM hyperfide.source_change_revisions WHERE revision_id=$1",
            [revision.revision_id],
          )
        ).rows[0];
      await fixture.accept(
        await fixture.createCandidate(
          { ...revision, change_id: change.change_id },
          { domain: await fixture.createDomain(revision) },
        ),
      );
    }
    const staged = await call("source.migration.stage", manifest);
    let pilotDomain = await fixture.createDomain(staged),
      candidate = await fixture.createCandidate(staged, {
        domain: pilotDomain,
      }),
      acceptedPilot = await fixture.accept(candidate);
    const historicRows = (
      await pool.query(
        "SELECT acceptance_id,receipt FROM hyperfide.source_native_acceptances WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 ORDER BY acceptance_id",
        Object.values(scope),
      )
    ).rows;

    const queued = await client.call(
      "source.publications.create",
      {
        acceptance_id: acceptedPilot.acceptance_id,
        destination_id: "pilot",
        target_ref: "refs/heads/main",
        expected_old_oid: null,
      },
      { operation_id: randomUUID() },
    );
    assert.equal(queued.status, "QUEUED");
    checks.push(
      "consolidated native pilot passes an independent checker, acceptance and durable queued export before cutover",
    );
    const dirtyDirectory = path.join(temporary, "dirty-workspace");
    command("git", [
      "clone",
      "--no-hardlinks",
      "--branch",
      "main",
      path.join(data, "a.git"),
      dirtyDirectory,
    ]);
    const dirtyBytes = Buffer.from("project a final delta\n");
    await fs.writeFile(path.join(dirtyDirectory, "main.txt"), dirtyBytes);
    const dirtyStatus = spawnSync(
      "git",
      ["-C", dirtyDirectory, "status", "--porcelain"],
      { encoding: "utf8", env: gitEnv },
    );
    assert.equal(dirtyStatus.status, 0);
    assert.equal(dirtyStatus.stdout.trim(), "M main.txt");
    const dirtyWorkspace = randomUUID();
    const importedBefore = await call("source.imports.read", {
      import_id: projects[0].import_id,
    });
    await call("source.workspaces.open", {
      workspace_id: dirtyWorkspace,
      base_revision_id: importedBefore.revision_id,
      mode: "MATERIALIZED",
      read_paths: ["projects/0"],
      write_paths: ["projects/0/main.txt"],
    });
    const workspaceId = randomUUID();
    await call("source.workspaces.open", {
      workspace_id: workspaceId,
      base_revision_id: base.revision_id,
      mode: "API_ONLY",
      read_paths: [""],
      write_paths: [""],
    });
    const abandoned = { ...manifest, migration_id: randomUUID() };
    let aborted = await call("source.migration.prepare", abandoned);
    await assert.rejects(
      () =>
        call("source.migration.abort", {
          migration_id: abandoned.migration_id,
          operation_id: randomUUID(),
          expected_generation: aborted.generation,
        }),
      (e) => e.code === "MIGRATION_NOT_DRAINED",
    );
    const pendingInventory = (
      await call("source.migration.read", {
        migration_id: abandoned.migration_id,
      })
    ).inventory;
    assert.equal(pendingInventory.unresolved_publications, 1);
    assert.equal(
      pendingInventory.external_publication_effects[0].operation_id,
      queued.operation_id,
    );
    assert.equal(
      pendingInventory.external_publication_effects[0].destination_id,
      "pilot",
    );
    await service.workspaces.close(context, {
      workspace_id: workspaceId,
      expected_workspace_generation: "1",
      operation_id: randomUUID(),
    });
    await client.call(
      "source.publications.cancel",
      { operation_id: queued.operation_id },
      { operation_id: randomUUID() },
    );
    aborted = await call("source.migration.consolidate", {
      migration_id: abandoned.migration_id,
      operation_id: randomUUID(),
      expected_generation: aborted.generation,
    });
    aborted = await call("source.migration.parity", {
      migration_id: abandoned.migration_id,
      operation_id: randomUUID(),
      expected_generation: aborted.generation,
    });
    const inventory = (
      await call("source.migration.read", {
        migration_id: abandoned.migration_id,
      })
    ).inventory;
    assert.deepEqual(inventory.legacy_writer_ids, [writer, secondWriter]);
    assert.deepEqual(inventory.installed_schema.source.versions, [1]);
    assert.deepEqual(inventory.installed_schema.evidence.versions, [1]);
    assert.equal(inventory.selected_history.length, 2);
    assert(
      inventory.selected_history.every(
        (project) => project.commits === 1 && project.revisions === 1,
      ),
    );
    assert.deepEqual(inventory.workspaces[0].dirty_paths, [
      "projects/0/main.txt",
    ]);
    assert.equal(inventory.workspaces[0].principal_id, context.principal_id);
    assert(inventory.workspaces[0].custody_holders.length > 0);
    await assert.rejects(
      () =>
        call("source.migration.quiesce", {
          migration_id: abandoned.migration_id,
          operation_id: randomUUID(),
          expected_generation: aborted.generation,
        }),
      (error) => error.code === "MIGRATION_NOT_DRAINED",
    );
    assert.deepEqual(
      await fs.readFile(path.join(dirtyDirectory, "main.txt")),
      dirtyBytes,
    );
    await service.workspaces.close(context, {
      workspace_id: dirtyWorkspace,
      expected_workspace_generation: "1",
      operation_id: randomUUID(),
    });

    aborted = await call("source.migration.abort", {
      migration_id: abandoned.migration_id,
      operation_id: randomUUID(),
      expected_generation: aborted.generation,
    });
    assert.equal(aborted.state, "ABORTED");
    await fs.writeFile(
      path.join(data, "source.txt"),
      "legacy remains writable after pre-activation abort\n",
    );
    checks.push(
      "open work blocks abort; after explicit closure abort retains legacy writer access and preserves imported history",
    );
    let migration = await call("source.migration.prepare", manifest);
    assert.equal(migration.route, "LEGACY");
    assert.deepEqual(
      await call("source.migration.prepare", manifest),
      migration,
    );
    await assert.rejects(
      () =>
        call("source.migration.prepare", {
          ...manifest,
          migration_id: randomUUID(),
          projects: [
            projects[0],
            { ...projects[1], target_path: projects[0].target_path },
          ],
        }),
      (e) => e.code === "INVALID_CONSOLIDATION",
    );
    await assert.rejects(
      () => fixture.createRevision("forbidden shadow write"),
      (e) => e.code === "NATIVE_WRITER_FENCED",
    );
    checks.push(
      "versioned consolidation rejects colliding project roots and closes ordinary native writer admission during shadowing",
    );
    const operation = randomUUID(),
      consolidateInput = {
        migration_id: manifest.migration_id,
        operation_id: operation,
        expected_generation: migration.generation,
      };
    migration = await call("source.migration.consolidate", consolidateInput);
    assert.deepEqual(
      await call("source.migration.consolidate", consolidateInput),
      migration,
    );
    assert.equal(migration.revision_id, staged.revision_id);
    let consolidated = await service.metadata.readRevision(
      context,
      migration.revision_id,
    );
    for (let n = 0; n < 2; n++) {
      const file = await service.trees.lookup(
        scope,
        consolidated.root_tree_id,
        "projects/" + n + "/main.txt",
      );
      assert.equal(
        (await service.objects.readFile(scope, file.object_id)).toString(),
        "project " + sources[n].id + "\n",
      );
    }
    await assert.rejects(
      () =>
        compareNativeMigration(
          service.metadata,
          service.objects,
          service.trees,
          sources,
          context,
          manifest,
          base.revision_id,
        ),
      (e) => e.code === "PARITY_NATIVE_TREE",
    );
    migration = await call("source.migration.parity", {
      migration_id: manifest.migration_id,
      operation_id: randomUUID(),
      expected_generation: migration.generation,
    });
    assert.equal(migration.parity.state, "MATCHED");
    assert.equal(migration.parity.projects.length, 2);
    assert.match(migration.parity.access_digest, /^sha256:[a-f0-9]{64}$/);
    assert.match(migration.parity.evidence_digest, /^sha256:[a-f0-9]{64}$/);
    assert(
      migration.parity.projects.every(
        (project) => project.retained_evidence > 0,
      ),
    );
    const restrictedId = randomUUID();
    await pool.query(
      `INSERT INTO hyperfide.source_capabilities(organisation_id,repository_id,security_domain_id,id,principal_id,credential_id,principal_kind,authority_epoch,policy_version,actions,path_prefixes,expires_at) VALUES($1,$2,$3,$4,$5,$6,'automation',1,$7,$8,ARRAY['projects/0'],clock_timestamp()+interval '10 minutes')`,
      [
        ...Object.values(scope),
        restrictedId,
        context.principal_id,
        fixture.roles.author.credential_id,
        fixture.sourcePolicy,
        actions,
      ],
    );
    const [{ authorizeSource }, { verifySourcePrincipalToken }] =
      await Promise.all([load("capabilities"), load("authentication")]);
    const restricted = await service.metadata.transaction((tx) =>
      authorizeSource(tx, {
        principal: verifySourcePrincipalToken(
          fixture.tokenFor("author", restrictedId),
          fixture.trust,
          scope,
        ),
        scope,
        action: "source.migration.parity",
        paths: ["projects/0"],
        mutation: false,
      }),
    );
    await assert.rejects(
      () =>
        compareNativeMigration(
          service.metadata,
          service.objects,
          service.trees,
          sources,
          restricted,
          manifest,
          consolidated.revision_id,
        ),
      (error) => error.code === "PARITY_ACCESS_MISMATCH",
    );
    for (const args of [
      ["add", "main.txt"],
      ["commit", "-m", "Checkpoint dirty migration workspace"],
      ["push", "origin", "HEAD:refs/heads/main"],
    ]) {
      const result = spawnSync("git", ["-C", dirtyDirectory, ...args], {
        encoding: "utf8",
        env: gitEnv,
      });
      assert.equal(result.status, 0, result.stderr);
    }
    const changedTip = git(path.join(data, "a.git"), [
      "rev-parse",
      "refs/heads/main",
    ]);
    checks.push(
      "two actual Git histories consolidate with complete content/type/mode and ancestry parity against independently read source objects",
    );
    assert.equal(
      (await service.metadata.readRevision(context, base.revision_id))
        .revision_id,
      base.revision_id,
    );
    const missingWriter = new SourceMigrationService(
      service.metadata,
      service.objects,
      service.trees,
      sources,
      { ...controls, writers: [] },
    );
    await assert.rejects(
      () =>
        missingWriter.quiesce(context, {
          migration_id: manifest.migration_id,
          operation_id: randomUUID(),
          expected_generation: migration.generation,
        }),
      (error) => error.code === "MIGRATION_WRITER_COVERAGE",
    );
    const wrongStorage = new SourceMigrationService(
      service.metadata,
      service.objects,
      service.trees,
      sources,
      { ...controls, source_roots: [temporary + "/unrelated"] },
    );
    await assert.rejects(
      () =>
        wrongStorage.quiesce(context, {
          migration_id: manifest.migration_id,
          operation_id: randomUUID(),
          expected_generation: migration.generation,
        }),
      (e) => e.code === "MIGRATION_WRITER_COVERAGE",
    );
    const wrongCoverage = new SourceMigrationService(
      service.metadata,
      service.objects,
      service.trees,
      sources,
      { ...controls, writer_id: "unknown-writer" },
    );
    await assert.rejects(
      () =>
        wrongCoverage.quiesce(context, {
          migration_id: manifest.migration_id,
          operation_id: randomUUID(),
          expected_generation: migration.generation,
        }),
      (e) => e.code === "MIGRATION_WRITER_COVERAGE",
    );
    checks.push(
      "legacy isolation must cover both every declared writer and the actual Git object storage roots",
    );
    await assert.rejects(
      () =>
        call("source.migration.quiesce", {
          migration_id: manifest.migration_id,
          operation_id: randomUUID(),
          expected_generation: migration.generation,
        }),
      (e) => e.code === "LEGACY_STORAGE_WRITABLE",
    );
    command("mount", ["--bind", data, data]);
    command("mount", ["-o", "remount,bind,ro", data]);
    command("mount", ["--bind", secondData, secondData]);
    command("mount", ["-o", "remount,bind,ro", secondData]);
    mounted = true;
    await assert.rejects(
      () =>
        call("source.migration.quiesce", {
          migration_id: manifest.migration_id,
          operation_id: randomUUID(),
          expected_generation: migration.generation,
        }),
      (e) => e.code === "MIGRATION_SOURCE_CHANGED",
    );
    const originalPilot = acceptedPilot;
    const originalRequest = (
      await pool.query(
        "SELECT request FROM hyperfide.source_git_imports WHERE import_id=$1",
        [projects[0].import_id],
      )
    ).rows[0].request;
    const finalImport = {
      ...originalRequest,
      import_id: randomUUID(),
      tip_oid: "git:sha1:" + changedTip,
    };
    await call("source.imports.create", finalImport);
    assert.equal(
      (
        await call("source.imports.resume", {
          import_id: finalImport.import_id,
        })
      ).state,
      "COMPLETE",
    );
    const finalManifest = {
      ...manifest,
      projects: [
        {
          ...projects[0],
          import_id: finalImport.import_id,
          tip_oid: finalImport.tip_oid,
        },
        projects[1],
      ],
    };
    const refreshInput = {
      migration_id: manifest.migration_id,
      operation_id: randomUUID(),
      expected_generation: migration.generation,
      manifest: finalManifest,
    };
    await assert.rejects(
      () =>
        call("source.migration.refresh", {
          ...refreshInput,
          operation_id: randomUUID(),
          manifest: {
            ...finalManifest,
            projects: [
              { ...finalManifest.projects[0], target_path: "other" },
              projects[1],
            ],
          },
        }),
      (e) => e.code === "MIGRATION_REFRESH_SCOPE",
    );
    migration = await call("source.migration.refresh", refreshInput);
    assert.deepEqual(
      await call("source.migration.refresh", refreshInput),
      migration,
    );
    assert.equal(migration.route, "CLOSED");
    assert.equal(migration.pilot_acceptance_id, null);
    const archived = (
      await pool.query(
        "SELECT manifest_digest,previous_manifest_digest FROM hyperfide.source_cutover_manifests WHERE migration_id=$1 ORDER BY generation",
        [manifest.migration_id],
      )
    ).rows;
    assert.equal(archived.length, 2);
    assert.equal(
      archived[1].previous_manifest_digest,
      archived[0].manifest_digest,
    );
    assert.notEqual(archived[0].manifest_digest, archived[1].manifest_digest);
    await assert.rejects(
      () =>
        pool.query(
          "UPDATE hyperfide.source_cutover_manifests SET manifest_digest=$1 WHERE migration_id=$2",
          ["invalid", manifest.migration_id],
        ),
      /immutable/,
    );
    consolidated = await service.metadata.readRevision(
      context,
      migration.revision_id,
    );
    const finalEntry = await service.trees.lookup(
      scope,
      consolidated.root_tree_id,
      "projects/0/main.txt",
    );
    assert.equal(
      (await service.objects.readFile(scope, finalEntry.object_id)).toString(),
      "project a final delta\n",
    );
    for (const mapping of (
      await call("source.imports.mappings", {
        import_id: finalImport.import_id,
      })
    ).mappings) {
      const revision = await service.metadata.readRevision(
          context,
          mapping.revision_id,
        ),
        change = (
          await pool.query(
            "SELECT change_id FROM hyperfide.source_change_revisions WHERE revision_id=$1",
            [revision.revision_id],
          )
        ).rows[0];
      await fixture.accept(
        await fixture.createCandidate(
          { ...revision, change_id: change.change_id },
          { domain: await fixture.createDomain(revision) },
        ),
      );
    }
    pilotDomain = await fixture.createDomain(consolidated);
    candidate = await fixture.createCandidate(
      { ...consolidated, change_id: refreshInput.operation_id },
      { domain: pilotDomain },
    );
    acceptedPilot = await fixture.accept(candidate);
    migration = await call("source.migration.parity", {
      migration_id: manifest.migration_id,
      operation_id: randomUUID(),
      expected_generation: migration.generation,
    });
    checks.push(
      "a fenced final delta imports changed Git bytes and ancestry, preserves immutable manifest generations, and requires fresh exact native pilot acceptance",
    );
    let denied = false;
    try {
      await fs.writeFile(path.join(data, "source.txt"), "forbidden");
    } catch (e) {
      denied = e.code === "EROFS";
    }
    assert(denied, "Kernel must reject a stale legacy write");
    const quiesceInput = {
      migration_id: manifest.migration_id,
      operation_id: randomUUID(),
      expected_generation: migration.generation,
    };
    const beforeQuiesce = await runMigrationProcess(
      "quiesce",
      quiesceInput,
      "before-quiesce-commit",
    );
    assert.equal(await operationCount(quiesceInput.operation_id), 0);
    await singleAuthority("1", "CLOSED");
    migration = await runMigrationProcess(
      "quiesce",
      quiesceInput,
      "after-quiesce-commit",
    );
    assert.deepEqual(migration, beforeQuiesce);
    assert.equal(await operationCount(quiesceInput.operation_id), 1);
    await singleAuthority("1", "CLOSED");
    assert.deepEqual(
      await runMigrationProcess("quiesce", quiesceInput),
      migration,
    );
    assert.equal(await operationCount(quiesceInput.operation_id), 1);
    assert.equal(migration.route, "CLOSED");
    checks.push(
      "writable legacy storage and stale final tips are refused; kernel readonly isolation closes stale legacy writes",
    );
    await assert.rejects(
      () =>
        call("source.migration.activate", {
          migration_id: manifest.migration_id,
          operation_id: randomUUID(),
          expected_generation: migration.generation,
          acceptance_id: originalPilot.acceptance_id,
        }),
      (e) => e.code === "MIGRATION_PILOT_MISMATCH",
    );
    const activation = {
      migration_id: manifest.migration_id,
      operation_id: randomUUID(),
      expected_generation: migration.generation,
      acceptance_id: acceptedPilot.acceptance_id,
    };
    const beforeActivate = await runMigrationProcess(
      "activate",
      activation,
      "before-activate-commit",
    );
    assert.equal(await operationCount(activation.operation_id), 0);
    await singleAuthority("1", "CLOSED");
    const reader = await pool.connect();
    let activated;
    try {
      await reader.query("BEGIN");
      await reader.query(
        "SELECT authority_epoch FROM hyperfide.source_authority_domains WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 FOR SHARE",
        Object.values(scope),
      );
      activated = runMigrationProcess(
        "activate",
        activation,
        "after-activate-commit",
      );
      activated.catch(() => {});
      let waiting = false;
      for (let attempt = 0; attempt < 300; attempt++) {
        waiting = (
          await pool.query(
            "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%source_authority_domains%') AS waiting",
          )
        ).rows[0].waiting;
        if (waiting) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert(
        waiting,
        "Activation must contend with the actual authenticated reader lock",
      );
      await reader.query(
        "SELECT authority_epoch FROM hyperfide.source_repositories WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 FOR SHARE",
        Object.values(scope),
      );
      await reader.query("COMMIT");
      try {
        migration = await activated;
      } catch (error) {
        console.error("migration activation SQL code: " + error.code);
        throw error;
      }
    } finally {
      await reader.query("ROLLBACK").catch(() => {});
      reader.release();
    }
    assert.deepEqual(migration, beforeActivate);
    assert.equal(await operationCount(activation.operation_id), 1);
    await singleAuthority("2", "NATIVE");
    assert.equal(migration.route, "NATIVE");
    assert.equal(migration.authority_epoch, "2");
    const epochs = (
      await pool.query(
        "SELECT r.authority_epoch::text AS repository,a.authority_epoch::text AS domain FROM hyperfide.source_repositories r JOIN hyperfide.source_authority_domains a USING(organisation_id,repository_id,security_domain_id) WHERE r.organisation_id=$1 AND r.repository_id=$2 AND r.security_domain_id=$3",
        Object.values(scope),
      )
    ).rows[0];
    assert.deepEqual(epochs, { repository: "2", domain: "2" });
    await assert.rejects(
      () => client.revision(consolidated.revision_id),
      (e) => e.code === "SCOPE_DENIED" || e.code === "STALE_AUTHORITY",
    );
    const fresh = async (epoch, role = "author") => {
      const id = randomUUID(),
        principal = fixture.roles[role];
      await pool.query(
        `INSERT INTO hyperfide.source_capabilities(organisation_id,repository_id,security_domain_id,id,principal_id,credential_id,principal_kind,authority_epoch,policy_version,actions,path_prefixes,expires_at) VALUES($1,$2,$3,$4,$5,$6,'automation',$7,$8,$9,ARRAY[''],clock_timestamp()+interval '10 minutes')`,
        [
          ...Object.values(scope),
          id,
          principal.principal_id,
          principal.credential_id,
          epoch,
          fixture.sourcePolicy,
          actions,
        ],
      );
      principal.capability_id = id;
      return new SourceControlClient({
        endpoint: fixture.endpoint,
        scope,
        token: () => fixture.tokenFor(role, id),
      });
    };
    let current = await fresh("2");
    assert.deepEqual(
      await runMigrationProcess("activate", activation),
      migration,
    );
    assert.equal(await operationCount(activation.operation_id), 1);
    const reopenedId = randomUUID(),
      reopened = await send(current, "source.workspaces.open", {
        workspace_id: reopenedId,
        base_revision_id: (
          await send(current, "source.imports.read", {
            import_id: finalImport.import_id,
          })
        ).revision_id,
        mode: "MATERIALIZED",
        read_paths: ["projects/0"],
        write_paths: ["projects/0/main.txt"],
      });
    assert.equal(reopened.workspace.authority_epoch, "2");
    const preservedFile = await service.trees.lookup(
      scope,
      reopened.workspace.root_tree_id,
      "projects/0/main.txt",
    );
    assert.deepEqual(
      await service.objects.readFile(scope, preservedFile.object_id),
      dirtyBytes,
    );
    assert.deepEqual(
      await fs.readFile(path.join(dirtyDirectory, "main.txt")),
      dirtyBytes,
    );
    await send(current, "source.workspaces.close", {
      workspace_id: reopenedId,
      expected_workspace_generation: "1",
    });
    checks.push(
      "dirty legacy workspace blocks quiesce, checkpoints through real Git history and reopens under the new native epoch with identical bytes",
    );
    await fresh("2", "checker");
    assert.equal(
      (await send(current, "source.migration.activate", activation)).route,
      "NATIVE",
    );
    const mutationId = randomUUID(),
      written = await current.createRevision(
        {
          change_id: mutationId,
          root_tree_id: consolidated.root_tree_id,
          parent_revision_ids: [consolidated.revision_id],
          predecessor_revision_ids: [],
          provenance: {
            author: { name: "Native Worker", email: "worker@example.invalid" },
            message: "acknowledged native work",
            timestamp: "2026-11-03T01:00:00.000Z",
          },
        },
        { operation_id: mutationId, idempotency_key: mutationId },
      );
    assert(
      migration.adoption.source_bindings.some(
        (binding) =>
          binding.kind === "graph" &&
          binding.binding_id === graphId &&
          binding.from_epoch === "1" &&
          binding.to_epoch === "2",
      ),
    );
    assert(
      migration.adoption.source_bindings.some(
        (binding) =>
          binding.kind === "qualification" &&
          binding.from_epoch === "1" &&
          binding.to_epoch === "2",
      ),
    );
    assert.deepEqual(
      (
        await pool.query(
          "SELECT to_jsonb(g) AS binding FROM hyperfide.source_graph_builds g WHERE build_id=$1",
          [graphId],
        )
      ).rows[0].binding,
      graphBefore,
    );
    const qualificationsBefore = (
      await pool.query(
        "SELECT qualification_id,result FROM hyperfide.source_candidate_qualifications WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 ORDER BY qualification_id",
        Object.values(scope),
      )
    ).rows;
    const nextDomainId = migration.adoption.domain_map.find(
      (item) => item.from === pilotDomain.domain_id,
    ).to;
    const nextDomain = await current.call("source.domains.read", {
      domain_id: nextDomainId,
    });
    assert.equal(nextDomain.authority_epoch, "2");
    assert.deepEqual(
      await current.acceptance(acceptedPilot.acceptance_id),
      acceptedPilot,
    );
    const acceptedNext = await fixture.accept(
      await fixture.createCandidate(written, { domain: nextDomain }),
    );
    const publication = await current.createPublication(
      {
        acceptance_id: acceptedNext.acceptance_id,
        destination_id: "pilot",
        target_ref: "refs/heads/main",
        expected_old_oid: null,
      },
      { operation_id: randomUUID() },
    );
    const published = await current.resumePublication(publication.operation_id);
    assert.equal(published.status, "PUBLISHED");
    assert.equal(
      git(publicRepo, ["show", "refs/heads/main:main.txt"]),
      "candidate: base",
    );
    checks.push(
      "fresh authority receives new policy/domain identities and can qualify, accept and publish while historical acceptance receipts remain unchanged",
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM hyperfide.source_cutover_acknowledgements WHERE migration_id=$1",
          [manifest.migration_id],
        )
      ).rows[0].n,
      1,
    );
    await assert.rejects(
      () =>
        send(current, "source.migration.abort", {
          migration_id: manifest.migration_id,
          operation_id: randomUUID(),
          expected_generation: migration.generation,
        }),
      (e) => e.code === "MIGRATION_ROLLBACK_DENIED",
    );
    const recoverInput = {
        migration_id: manifest.migration_id,
        operation_id: randomUUID(),
        expected_generation: migration.generation,
      },
      recovered = await runMigrationProcess(
        "recover",
        recoverInput,
        "after-recover",
      );
    assert.equal(await operationCount(recoverInput.operation_id), 1);
    await singleAuthority("3", "NATIVE");
    assert.equal(recovered.authority_epoch, "3");
    current = await fresh("3");
    assert.deepEqual(
      await runMigrationProcess("recover", recoverInput),
      recovered,
    );
    assert.equal(await operationCount(recoverInput.operation_id), 1);
    await fresh("3", "checker");
    assert.equal(
      (await current.revision(written.revision_id)).revision_id,
      written.revision_id,
    );
    assert.equal(
      (
        await current.call("source.migration.read", {
          migration_id: manifest.migration_id,
        })
      ).inventory.acknowledged_revisions,
      1,
    );
    for (const previous of migration.adoption.source_bindings) {
      const next = recovered.adoption.source_bindings.find(
        (binding) =>
          binding.kind === previous.kind &&
          binding.binding_id === previous.binding_id,
      );
      assert(next);
      assert.equal(next.from_epoch, "2");
      assert.equal(next.to_epoch, "3");
      assert.equal(next.binding_digest, previous.binding_digest);
      assert.match(next.predecessor_digest, /^sha256:[a-f0-9]{64}$/);
    }
    const recorded = (
      await pool.query(
        "SELECT record FROM hyperfide.source_audit WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND record->>'kind'='SOURCE_EPOCH_BINDING'",
        Object.values(scope),
      )
    ).rows;
    assert.equal(
      recorded.length,
      migration.adoption.source_bindings.length +
        recovered.adoption.source_bindings.length,
    );
    assert.deepEqual(
      (
        await pool.query(
          "SELECT qualification_id,result FROM hyperfide.source_candidate_qualifications WHERE qualification_id=ANY($1::text[]) ORDER BY qualification_id",
          [qualificationsBefore.map((row) => row.qualification_id)],
        )
      ).rows,
      qualificationsBefore,
    );
    checks.push(
      "graph and qualification source bindings receive immutable per-binding old/new epoch versions while original records remain identical",
    );
    const recoveredDomainId = recovered.adoption.domain_map.find(
        (item) => item.from === nextDomainId,
      ).to,
      recoveredDomain = await current.call("source.domains.read", {
        domain_id: recoveredDomainId,
      });
    const laterId = randomUUID(),
      later = await current.createRevision(
        {
          change_id: laterId,
          root_tree_id: consolidated.root_tree_id,
          parent_revision_ids: [written.revision_id],
          predecessor_revision_ids: [],
          provenance: {
            author: {
              name: "Recovered Worker",
              email: "worker@example.invalid",
            },
            message: "after recovery",
            timestamp: "2026-11-03T02:00:00.000Z",
          },
        },
        { operation_id: laterId, idempotency_key: laterId },
      );
    const acceptedLater = await fixture.accept(
      await fixture.createCandidate(later, { domain: recoveredDomain }),
    );
    const laterPublication = await current.createPublication(
      {
        acceptance_id: acceptedLater.acceptance_id,
        destination_id: "pilot",
        target_ref: "refs/heads/main",
        expected_old_oid: published.git_oid,
      },
      { operation_id: randomUUID() },
    );
    assert.equal(
      (await current.resumePublication(laterPublication.operation_id)).status,
      "PUBLISHED",
    );
    const preserved = (
      await pool.query(
        "SELECT acceptance_id,receipt FROM hyperfide.source_native_acceptances WHERE acceptance_id=ANY($1::text[]) ORDER BY acceptance_id",
        [historicRows.map((row) => row.acceptance_id)],
      )
    ).rows;
    assert.deepEqual(preserved, historicRows);
    assert.deepEqual(
      await current.acceptance(acceptedPilot.acceptance_id),
      acceptedPilot,
    );
    const oldEvidence = (
      await pool.query(
        "SELECT evidence_id FROM hyperfide.source_native_assurance_evidence WHERE candidate_id=$1",
        [candidate.candidate_id],
      )
    ).rows[0].evidence_id;
    await fixture.checkerClient.call(
      "source.assurance.revoke",
      { evidence_id: oldEvidence },
      { operation_id: randomUUID() },
    );
    await assert.rejects(
      () =>
        current.createPublication(
          {
            acceptance_id: acceptedPilot.acceptance_id,
            destination_id: "pilot",
            target_ref: "refs/heads/main",
            expected_old_oid: null,
          },
          { operation_id: randomUUID() },
        ),
      (e) => e.code === "EVIDENCE_BINDING_MISMATCH",
    );
    checks.push(
      "a second epoch adoption preserves immutable history, supports new qualified publication and still rejects explicitly revoked historical evidence",
    );

    checks.push(
      "atomic dual-epoch activation fences old credentials and forward recovery preserves acknowledged native revisions while refusing rollback",
    );
    assert.deepEqual(exercised, crashBoundaries);
    const receipt = {
      status: "PASS",
      deployment_migration: "UNRUN",
      crash_boundaries: exercised,
      checks,
      backend_requests: fixture.backend.requests.length,
      kernel_legacy_write_denied: denied,
      authority_epoch: recovered.authority_epoch,
      acknowledged_revision: written.revision_id,
    };
    const output =
      process.env.HYPERFIDE_SOURCE_EVIDENCE_DIR ?? "build/source-control/5.3";
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(
      output + "/receipt.json",
      JSON.stringify(receipt, null, 2) + "\n",
    );
    console.log(JSON.stringify(receipt));
  } finally {
    await fixture?.close();
    if (mounted) {
      command("umount", [path.join(temporary, "legacy/data")]);
      command("umount", [path.join(temporary, "legacy-b/data")]);
    }
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
