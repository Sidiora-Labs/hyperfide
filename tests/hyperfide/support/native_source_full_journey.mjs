import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createServer } from "node:http";
const execute = promisify(execFile);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function runFullSourceJourney({
  f,
  root,
  inputs,
  accepted,
  qualified,
  submission,
  taskQualification,
  baseline,
  checkpointOne,
  checkpointTwo,
  replacement,
  selectedSubmission,
  replacementJourney,
}) {
  const assertions = [],
    steps = [];
  let stepRevision = baseline.revision_id,
    stepAssignment = submission.assignment_id;
  const providerFor = async (assignmentId) => {
    const result = (
      await f.pool.query(
        `SELECT p.provider,p.id AS pool_id,p.profile_id,p.account_key,p.environment_key,p.region,
    a.sandbox_id,a.sandbox_boot_generation::text AS boot_generation
    FROM hyperfide.source_fleet_assignments a
    JOIN hyperfide.sandboxes s ON s.organisation_id=a.organisation_id AND s.id=a.sandbox_id
    JOIN hyperfide.provider_pools p ON p.organisation_id=s.organisation_id AND p.id=s.pool_id
    WHERE a.organisation_id=$1 AND a.repository_id=$2 AND a.security_domain_id=$3 AND a.assignment_id=$4`,
        [...Object.values(f.scope), assignmentId],
      )
    ).rows[0];
    assert(
      result,
      "Every journey step must identify its actual assigned provider",
    );
    return result;
  };
  const proved = async (id, actual) => {
    assert.equal(actual, true, id);
    const revision = await f.client.revision(stepRevision),
      provider = await providerFor(stepAssignment);
    assertions.push({ id: "SCM-023." + id, expected: true, actual: true });
    steps.push({
      id: "SCM-023." + id,
      source: {
        scope: f.scope,
        revision_id: revision.revision_id,
        root_tree_id: revision.root_tree_id,
      },
      provider,
      assignment_id: stepAssignment,
    });
  };
  const scope = Object.values(f.scope),
    query = (sql, args = []) => f.pool.query(sql, [...scope, ...args]);
  const original = (
    await query(
      "SELECT * FROM hyperfide.source_fleet_assignments WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND assignment_id=$4",
      [submission.assignment_id],
    )
  ).rows[0];
  await proved(
    "assignment-workspace-binding",
    Boolean(
      original &&
      original.base_revision_id === baseline.revision_id &&
      original.workspace_id &&
      original.attempt_id,
    ),
  );
  const first = await f.client.revision(checkpointOne.revision_id),
    second = await f.client.revision(checkpointTwo.revision_id);
  stepRevision = second.revision_id;
  await proved(
    "durable-checkpoint-lineage",
    first.parent_revision_ids.includes(baseline.revision_id) &&
      second.parent_revision_ids.includes(first.revision_id),
  );
  const checkpoints = (
    await query(
      "SELECT result FROM hyperfide.source_workspace_checkpoints WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND workspace_id=$4",
      [original.workspace_id],
    )
  ).rows;
  await proved(
    "checkpoint-and-submission-distinct",
    checkpoints.length === 2 &&
      submission.revision_id === second.revision_id &&
      accepted.revision_id === second.revision_id,
  );
  const submissions = (
    await query(
      "SELECT * FROM hyperfide.source_fleet_submissions WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND assignment_id=$4",
      [original.assignment_id],
    )
  ).rows;
  await proved(
    "unknown-submission-reconciles-once",
    submissions.length === 1 &&
      submissions[0].revision_id === second.revision_id,
  );
  const replacements = (
    await query(
      "SELECT attempt_id,attempt_generation::text,workspace_id FROM hyperfide.source_fleet_assignments WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND task_id=$4 ORDER BY attempt_generation",
      [replacement.assignment.tasks[0].task_id],
    )
  ).rows;
  await proved(
    "replacement-keeps-prior-history",
    replacements.length === 2 &&
      replacements[0].attempt_id !== replacements[1].attempt_id &&
      replacements[0].workspace_id !== replacements[1].workspace_id &&
      BigInt(replacements[1].attempt_generation) >
        BigInt(replacements[0].attempt_generation),
  );
  const proof = (
    await query(
      "SELECT receipt FROM hyperfide.source_fleet_qualifications WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND qualification_id=$4",
      [taskQualification.qualification_id],
    )
  ).rows[0];
  await proved(
    "independent-qualification-before-task-release",
    Boolean(proof) &&
      accepted.qualification_id === qualified.qualification.qualification_id &&
      taskQualification.state === "QUALIFIED",
  );
  stepRevision = selectedSubmission.revision_id;
  stepAssignment = selectedSubmission.assignment_id;
  await proved(
    "dependent-consumes-accepted-source",
    selectedSubmission.revision_id !== accepted.revision_id &&
      (
        await f.client.revision(selectedSubmission.revision_id)
      ).parent_revision_ids.includes(accepted.revision_id),
  );
  stepRevision = replacementJourney.accepted.revision_id;
  stepAssignment = replacementJourney.submission.assignment_id;
  await proved(
    "forged-qualified-dependency-refused",
    replacementJourney.forged_dependency_refused === true,
  );
  await proved(
    "plain-sql-qualification-snapshot",
    replacementJourney.plain_sql_qualification_read === true,
  );
  await proved(
    "queue-preserves-qualified-dependencies",
    replacementJourney.queue_preserved_dependencies === true,
  );
  await proved(
    "replacement-reaches-qualified-acceptance",
    replacementJourney.taskQualification.state === "QUALIFIED" &&
      replacementJourney.accepted.revision_id ===
        replacementJourney.checkpoint.revision_id &&
      replacementJourney.submission.revision_id ===
        replacementJourney.accepted.revision_id &&
      replacementJourney.workspace_id === replacements[1].workspace_id,
  );
  const publicationAccepted = replacementJourney.accepted;
  // Each newly exported ancestor needs its own retained native acceptance.
  const pending = [publicationAccepted.revision_id],
    seen = new Set();
  while (pending.length) {
    const id = pending.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const revision = await f.client.revision(id);
    pending.push(...revision.parent_revision_ids);
    const retained = (
      await query(
        "SELECT acceptance_id FROM hyperfide.source_native_acceptances WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND revision_id=$4",
        [id],
      )
    ).rows[0];
    if (!retained) {
      const change = (
        await query(
          "SELECT change_id FROM hyperfide.source_change_revisions WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND revision_id=$4",
          [id],
        )
      ).rows[0];
      await f.accept(
        await f.createCandidate(
          { ...revision, change_id: change.change_id },
          { domain: await f.createDomain(revision) },
        ),
      );
    }
  }
  const config = path.join(root, "cli-source.json");
  await fs.writeFile(
    config,
    JSON.stringify({
      schema_version: 1,
      endpoint: inputs.origin + "/api/v1/source-control",
      scope: f.scope,
      credential_id: inputs.ids.operator,
      ca_file: inputs.ca,
      key_file: inputs.keys.operator,
    }),
    { mode: 0o600 },
  );
  const cli = async (args) => {
    const result = await execute(
      process.execPath,
      [
        path.join(f.ROOT, "apps/cli/dist/index.js"),
        "source",
        "--config",
        config,
        ...args,
      ],
      {
        cwd: root,
        env: process.env,
        timeout: 30000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    return JSON.parse(result.stdout.trim().split("\n").at(-1));
  };
  // The sparse workspace is an independent branch of the exact accepted source.
  const {
    NativeWorkspaceClient,
    NativeObjectCache,
    SourceWorkspaceJournal,
    SparseSourceMaterializer,
    NativeWorkspaceCheckpoint,
  } = await import(
    pathToFileURL(path.join(f.ROOT, "sdk/source-control/src/host/index.ts"))
  );
  const workspaceClient = new NativeWorkspaceClient(f.client, f.scope);
  let sparse = await workspaceClient.open({
    base_revision_id: publicationAccepted.revision_id,
    mode: "SPARSE",
    read_paths: ["main.txt"],
    write_paths: ["main.txt"],
  });
  const sparseRoot = path.join(root, "journey-sparse"),
    journal = new SourceWorkspaceJournal(path.join(root, "journey-journal"));
  const cache = new NativeObjectCache(path.join(root, "journey-cache"), {
    max_bytes: sparse.budgets.cache_bytes,
    max_entries: sparse.budgets.max_cache_entries,
    max_object_bytes: sparse.budgets.max_file_bytes,
  });
  const materializer = new SparseSourceMaterializer(
    workspaceClient,
    cache,
    journal,
    sparseRoot,
  );
  let sparseCheckpoint, sourceDiff;
  try {
    const ready = await materializer.materialize(sparse, ["main.txt"]);
    assert.equal(ready.state, "READY");
    assert.equal(ready.files, 1);
    assert.equal(ready.physically_materialized, true);
    assert.deepEqual(await fs.readdir(sparseRoot), ["main.txt"]);
    const priorFile = await f.client.lookup(
      publicationAccepted.root_tree_id,
      "main.txt",
    );
    const omittedBefore = await f.client.lookup(
      publicationAccepted.root_tree_id,
      "private.txt",
    );
    assert(omittedBefore.entry);
    const priorBytes = await f.service.objects.readFile(
      f.scope,
      priorFile.entry.object_id,
    );
    assert.deepEqual(
      await fs.readFile(path.join(sparseRoot, "main.txt")),
      priorBytes,
    );
    const edited = Buffer.from(
      priorBytes.toString("utf8") + "candidate: scoped sparse journey edit\n",
    );
    await fs.writeFile(path.join(sparseRoot, "main.txt"), edited);
    await journal.mark("main.txt");
    sparseCheckpoint = await new NativeWorkspaceCheckpoint(
      workspaceClient,
      journal,
      sparseRoot,
      materializer,
    ).checkpoint(sparse);
    sparse = sparseCheckpoint.workspace;
    stepRevision = sparseCheckpoint.revision_id;
    const sparseRevision = await f.client.revision(stepRevision),
      editedFile = await f.client.lookup(
        sparseRevision.root_tree_id,
        "main.txt",
      );
    assert.deepEqual(
      await f.service.objects.readFile(f.scope, editedFile.entry.object_id),
      edited,
    );
    assert.deepEqual(
      (await f.client.lookup(sparseRevision.root_tree_id, "private.txt")).entry,
      omittedBefore.entry,
    );
    assert.deepEqual(await fs.readdir(sparseRoot), ["main.txt"]);
    await proved(
      "sparse-edit-materializes-only-scope",
      sparseRevision.parent_revision_ids.includes(
        publicationAccepted.revision_id,
      ) && sparseRevision.root_tree_id !== publicationAccepted.root_tree_id,
    );
    const apiDiff = await f.client.call("source.queries.diff", {
      before_revision_id: publicationAccepted.revision_id,
      after_revision_id: stepRevision,
      limit: 50,
    });
    const cliDiff = await cli([
      "diff",
      publicationAccepted.revision_id,
      stepRevision,
    ]);
    assert.equal(cliDiff.ok, true);
    assert.deepEqual(cliDiff.result.entries, apiDiff.entries);
    for (const result of [apiDiff, cliDiff.result]) {
      assert.equal(result.before_revision_id, publicationAccepted.revision_id);
      assert.equal(result.after_revision_id, stepRevision);
      assert.equal(result.coverage.state, "COMPLETE");
      assert.equal(result.next_cursor, null);
      assert.deepEqual(result.entries, [
        {
          path: "main.txt",
          kind: "MODIFIED",
          before: priorFile.entry,
          after: editedFile.entry,
        },
      ]);
    }
    sourceDiff = {
      before: {
        revision_id: publicationAccepted.revision_id,
        root_tree_id: publicationAccepted.root_tree_id,
      },
      after: {
        revision_id: sparseRevision.revision_id,
        root_tree_id: sparseRevision.root_tree_id,
      },
      workspace_id: sparse.workspace_id,
      api: apiDiff,
      cli: cliDiff.result,
      edited_sha256: sha(edited),
    };
    await proved("source-diff-matches-checkpoint", true);
  } finally {
    await workspaceClient.close(sparse);
  }
  stepRevision = publicationAccepted.revision_id;
  const revisionRead = await cli(["revision", publicationAccepted.revision_id]);
  await proved(
    "signed-cli-revision-read",
    revisionRead.ok === true &&
      revisionRead.result.revision_id === publicationAccepted.revision_id &&
      revisionRead.result.root_tree_id === publicationAccepted.root_tree_id,
  );
  const history = await cli(["history", publicationAccepted.revision_id]);
  await proved(
    "signed-cli-history-without-checkout",
    history.ok === true &&
      history.result.entries.some(
        (item) => item.revision_id === publicationAccepted.revision_id,
      ) &&
      !(await fs.readdir(root)).includes(".git"),
  );
  const { runSourceProductBrowser } =
    await import("./native_source_product_browser.mjs");
  const browser = await runSourceProductBrowser(
    f,
    { client: f.client },
    {
      acceptanceId: publicationAccepted.acceptance_id,
      revisionId: publicationAccepted.revision_id,
      rootTreeId: publicationAccepted.root_tree_id,
      destinationId: "full-case",
      outputDirectory: "build/source-control/full-case/SCM-023/browser",
    },
  );
  await proved(
    "ui-shows-exact-fleet-accepted-source",
    browser.acceptance_id === publicationAccepted.acceptance_id &&
      browser.revision_id === publicationAccepted.revision_id &&
      browser.root_tree_id === publicationAccepted.root_tree_id,
  );
  await proved(
    "ui-conflict-resolution-preserves-source",
    browser.conflict.status === "PASS" &&
      browser.conflict.base_revision_id === publicationAccepted.revision_id,
  );
  await proved(
    "ui-desktop-tablet-mobile",
    browser.screenshots.length === 12 &&
      (
        await Promise.all(browser.screenshots.map((file) => fs.stat(file)))
      ).every((stat) => stat.size > 0),
  );
  const publication = await f.client.call("source.publications.read", {
    operation_id: browser.publication.operation_id,
  });
  await proved(
    "ui-publication-has-explicit-durable-status",
    publication.status === "PUBLISHED" &&
      publication.acceptance_id === publicationAccepted.acceptance_id &&
      publication.revision_id === publicationAccepted.revision_id,
  );
  const git = async (args) =>
    (
      await execute(
        "git",
        ["--git-dir=" + path.join(root, "publication.git"), ...args],
        { timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
      )
    ).stdout;
  const actualOid = (await git(["rev-parse", "refs/heads/main"])).trim(),
    nativeFile = await f.service.trees.lookup(
      f.scope,
      publicationAccepted.root_tree_id,
      "main.txt",
    ),
    nativeBytes = await f.service.objects.readFile(
      f.scope,
      nativeFile.object_id,
    );
  const publishedBytes = await git(["show", "refs/heads/main:main.txt"]),
    nativeRevision = await f.client.revision(publicationAccepted.revision_id);
  const author = {
    name: (await git(["show", "-s", "--format=%an", "refs/heads/main"])).trim(),
    email: (
      await git(["show", "-s", "--format=%ae", "refs/heads/main"])
    ).trim(),
  };
  assert.equal(author.name, nativeRevision.descriptor.provenance.author.name);
  assert.equal(author.email, nativeRevision.descriptor.provenance.author.email);
  await git(["fsck", "--full", "--strict"]);
  await proved(
    "independent-git-readback-matches-native",
    publication.git_oid === "git:sha1:" + actualOid &&
      Buffer.from(publishedBytes).equals(nativeBytes),
  );
  const output = path.join(f.ROOT, "build/source-control/full-case/SCM-023");
  await fs.mkdir(output, { recursive: true });
  const { captureNativeSource } =
    await import("../source-control/full_case/native_capture.mjs");
  const nativeCapture = await captureNativeSource({
    client: f.client,
    context: f.context,
    revisionId: publicationAccepted.revision_id,
    workspaceRoot: f.ROOT,
    outputDirectory: path.join(output, "native"),
    assertionIds: [
      ...assertions.map((row) => row.id),
      "SCM-023.genuine-native-source-capture",
    ],
    toolchain: [process.execPath],
  });
  await proved(
    "genuine-native-source-capture",
    nativeCapture.revision_id === publicationAccepted.revision_id &&
      nativeCapture.root_tree_id === publicationAccepted.root_tree_id,
  );
  const snapshot = (revision) => ({
    revision_id: revision.revision_id,
    root_tree_id: revision.root_tree_id,
  });
  const snapshots = {
    baseline: snapshot(baseline),
    checkpoint_one: snapshot(first),
    checkpoint_two: snapshot(second),
    selected_submission: snapshot(
      await f.client.revision(selectedSubmission.revision_id),
    ),
    accepted: snapshot(publicationAccepted),
    sparse_checkpoint: sourceDiff.after,
  };
  const evidence = {
    schema_version: 1,
    status: "PASS",
    case_id: "SCM-023",
    variant: "owned-api-cli-ui",
    execution_profile:
      "owned-postgresql-sigv4-local-signed-worker-and-local-git",
    owned_temporary_root: root,
    owned_endpoints: [
      inputs.origin,
      f.endpoint,
      f.backend.config.endpoint,
      inputs.source_backend_endpoint,
    ],
    source: {
      scope: f.scope,
      revision_id: publicationAccepted.revision_id,
      root_tree_id: publicationAccepted.root_tree_id,
    },
    assertions,
    steps,
    snapshots,
    selected_assignment: selectedSubmission.assignment_id,
    source_diff: sourceDiff,
    sparse_checkpoint: sparseCheckpoint,
    assignment: original.assignment_id,
    submission: submission.submission_id,
    qualification: replacementJourney.taskQualification.qualification_id,
    original_qualification: taskQualification.qualification_id,
    replacement: replacementJourney,
    acceptance: publicationAccepted.acceptance_id,
    publication,
    native_capture: nativeCapture,
    git_readback: {
      oid: actualOid,
      author,
      bytes: nativeBytes.length,
      sha256: sha(nativeBytes),
    },
    browser,
  };
  await fs.writeFile(
    path.join(output, "journey.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  return evidence;
}

// The release runner uses only the extracted runtime and an operator-pinned
// deployment copy. The original full fleet/browser campaign above stays separate.
async function releaseModules(runtime) {
  const load = (name) =>
    import(pathToFileURL(path.join(runtime, name + ".js")));
  const [{ SourceControlClient }, ...host] = await Promise.all([
    load("sdk/index"),
    ...["client", "cache", "journal", "materializer", "checkpoint"].map(
      (name) => load("host/" + name),
    ),
  ]);
  const require = createRequire(path.join(runtime, "services/package.json"));
  return {
    SourceControlClient,
    ...Object.assign({}, ...host),
    Pool: require("pg").Pool,
  };
}

function canonicalRelease(value) {
  if (Array.isArray(value)) return value.map(canonicalRelease);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalRelease(value[key])]),
    );
  return value;
}

async function releaseToken(filename) {
  assert(
    path.isAbsolute(filename),
    "Release token requires an absolute private path",
  );
  const stat = await fs.lstat(filename);
  assert(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      (stat.mode & 0o077) === 0 &&
      stat.uid === process.getuid(),
  );
  const token = (await fs.readFile(filename, "utf8")).trim();
  assert(token && !/[\r\n]/.test(token), "Current token required");
  return token;
}

async function releaseDatabase(profile, Pool) {
  assert.equal(profile.disposable_restore_drill, true);
  assert(
    /^hf_release_[a-z0-9_]+$/.test(profile.database_name),
    "A dedicated hf_release_ database is required",
  );
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    statement_timeout: 15000,
  });
  try {
    const identity = (
      await pool.query(
        "SELECT current_database() AS name,(pg_control_system()).system_identifier::text AS system_identifier,pg_is_in_recovery() AS recovery",
      )
    ).rows[0];
    assert.equal(identity.name, profile.database_name);
    assert.equal(identity.system_identifier, profile.system_identifier);
    assert.equal(identity.recovery, false);
    return pool;
  } catch (error) {
    await pool.end();
    throw error;
  }
}

async function currentReleaseCustody(pool, profile) {
  const source = profile.source,
    journey = profile.journey;
  const scope = [
    source.scope.organisation_id,
    source.scope.repository_id,
    source.scope.security_domain_id,
  ];
  const rows = (
    await pool.query(
      `SELECT s.authority,s.qualification_outcome,s.custody_id::text,
    s.custody_generation::text,s.current_qualification_id,q.qualification_id,
    q.custody_generation::text AS qualified_custody_generation,c.revoked_at,
    c.revision_id,c.root_tree_id,c.authority_epoch::text,d.policy_version,
    t.current_native_custody_id::text AS current_custody_id,
    c.owner_principal_id,a.worker_principal_id,q.candidate_id,q.candidate_qualification_id,
    q.receipt AS qualification_receipt,s.run_id,s.task_id,s.assignment_id,
    c.custody_generation::text AS retained_custody_generation,
    d.authority_epoch::text AS current_authority_epoch,r.authority_epoch::text AS repository_authority_epoch,
    d.enabled
    FROM hyperfide.source_fleet_submissions s
    JOIN hyperfide.source_native_custodies c USING(organisation_id,repository_id,security_domain_id,custody_id)
    JOIN hyperfide.source_fleet_qualifications q ON q.organisation_id=s.organisation_id
      AND q.repository_id=s.repository_id AND q.security_domain_id=s.security_domain_id
      AND q.custody_id=s.custody_id AND q.qualification_id=s.current_qualification_id
    JOIN hyperfide.source_fleet_assignments a ON a.organisation_id=s.organisation_id
      AND a.repository_id=s.repository_id AND a.security_domain_id=s.security_domain_id AND a.assignment_id=s.assignment_id
    JOIN hyperfide.tasks t ON t.organisation_id=s.organisation_id AND t.run_id=s.run_id AND t.id=s.task_id
    JOIN hyperfide.source_authority_domains d ON d.organisation_id=s.organisation_id
      AND d.repository_id=s.repository_id AND d.security_domain_id=s.security_domain_id
    JOIN hyperfide.source_repositories r ON r.organisation_id=s.organisation_id
      AND r.repository_id=s.repository_id AND r.security_domain_id=s.security_domain_id
    WHERE s.organisation_id=$1 AND s.repository_id=$2 AND s.security_domain_id=$3 AND s.custody_id=$4`,
      [...scope, journey.custody_id],
    )
  ).rows;
  assert.equal(rows.length, 1, "Current retained fleet custody must exist");
  const row = rows[0];
  assert.equal(row.authority, "ACTIVE");
  assert.equal(row.revoked_at, null);
  assert.equal(row.qualification_outcome, "PASS");
  assert.equal(row.current_custody_id, row.custody_id);
  assert.equal(row.current_qualification_id, row.qualification_id);
  assert.equal(row.custody_generation, row.qualified_custody_generation);
  assert.equal(row.custody_generation, row.retained_custody_generation);
  assert.equal(row.enabled, true);
  assert.equal(row.current_authority_epoch, source.authority_epoch);
  assert.equal(row.repository_authority_epoch, source.authority_epoch);
  assert.equal(row.qualification_receipt.state, "QUALIFIED");
  assert.notEqual(
    row.owner_principal_id,
    row.worker_principal_id,
    "Coordinator retains source independently of the worker",
  );
  for (const name of [
    "revision_id",
    "root_tree_id",
    "authority_epoch",
    "policy_version",
  ])
    assert.equal(row[name], source[name], "Stale release custody: " + name);
  return { ...row, scope: source.scope };
}

async function acceptedReleaseRoots(pool, profile, client) {
  // Explicit ordering avoids relying on operator JSON key order for SQL scope.
  const args = [
    profile.source.scope.organisation_id,
    profile.source.scope.repository_id,
    profile.source.scope.security_domain_id,
  ];
  const roots = (
    await pool.query(
      `SELECT acceptance_id,revision_id,root_tree_id,candidate_id,qualification_id
    FROM hyperfide.source_native_acceptances WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3
    ORDER BY acceptance_id LIMIT 100001`,
      args,
    )
  ).rows;
  assert(
    roots.length > 0 && roots.length <= 100000,
    "Bounded accepted source inventory required",
  );
  assert(
    roots.some(
      (row) =>
        row.revision_id === profile.source.revision_id &&
        row.root_tree_id === profile.source.root_tree_id,
    ),
  );
  for (const root of roots) {
    const revision = await client.revision(root.revision_id);
    assert.equal(revision.root_tree_id, root.root_tree_id);
    const accepted = await client.acceptance(root.acceptance_id);
    for (const key of [
      "revision_id",
      "root_tree_id",
      "candidate_id",
      "qualification_id",
    ])
      assert.equal(accepted[key], root[key]);
  }
  return roots;
}

export async function runReleasedSourceJourney({
  runtime,
  profile,
  directory,
  client,
  pool,
  modules,
}) {
  const custody = await currentReleaseCustody(pool, profile);
  const roots = await acceptedReleaseRoots(pool, profile, client);
  const initial = await client.fleetAssignment(
    profile.journey.initial_assignment_id,
  );
  const replacement = await client.fleetAssignment(
    profile.journey.replacement_assignment_id,
  );
  assert.notEqual(initial.assignment_id, replacement.assignment_id);
  assert.equal(initial.task_id, replacement.task_id);
  assert.notEqual(initial.attempt_id, replacement.attempt_id);
  assert(
    BigInt(replacement.attempt_generation) > BigInt(initial.attempt_generation),
  );
  assert.equal(custody.assignment_id, replacement.assignment_id);
  const prior = await client.revision(
    profile.journey.prior_checkpoint_revision_id,
  );
  assert(prior.revision_id.startsWith("sha256:"));
  const submission = await client.fleetSubmission(custody.custody_id);
  assert.equal(submission.revision_id, profile.source.revision_id);
  assert.equal(submission.root_tree_id, profile.source.root_tree_id);
  const accepted = await client.acceptance(profile.journey.acceptance_id);
  assert.equal(accepted.candidate_id, custody.candidate_id);
  assert.equal(accepted.qualification_id, custody.candidate_qualification_id);
  assert.equal(accepted.revision_id, custody.revision_id);
  assert.equal(accepted.root_tree_id, custody.root_tree_id);
  const native = new modules.NativeWorkspaceClient(
    client,
    profile.source.scope,
  );
  const selected = profile.journey.edit_path;
  assert(typeof selected === "string" && selected.length > 0);
  const workspace = await native.open({
    base_revision_id: accepted.revision_id,
    mode: "SPARSE",
    read_paths: [selected],
    write_paths: [selected],
  });
  let current = workspace;
  let checkpoint;
  try {
    const files = path.join(directory, "sparse"),
      journal = new modules.SourceWorkspaceJournal(
        path.join(directory, "journal"),
      );
    const cache = new modules.NativeObjectCache(path.join(directory, "cache"), {
      max_bytes: workspace.budgets.cache_bytes,
      max_entries: workspace.budgets.max_cache_entries,
      max_object_bytes: workspace.budgets.max_file_bytes,
    });
    const materializer = new modules.SparseSourceMaterializer(
      native,
      cache,
      journal,
      files,
    );
    assert.equal(
      (await materializer.materialize(workspace, [selected])).state,
      "READY",
    );
    const filename = path.resolve(files, selected);
    assert(filename.startsWith(files + path.sep));
    const bytes = await fs.readFile(filename);
    const edited = Buffer.concat([
      bytes,
      Buffer.from("\nrelease restore drill\n"),
    ]);
    await fs.writeFile(filename, edited);
    await journal.mark(selected);
    checkpoint = await new modules.NativeWorkspaceCheckpoint(
      native,
      journal,
      files,
      materializer,
    ).checkpoint(workspace);
    current = checkpoint.workspace;
    const revision = await client.revision(checkpoint.revision_id);
    assert(revision.parent_revision_ids.includes(accepted.revision_id));
    assert.notEqual(revision.root_tree_id, accepted.root_tree_id);
    const observed = await native.detail(current.workspace_id);
    assert.equal(observed.checkpoint_revision_id, checkpoint.revision_id);
    const entry = await native.lookup(revision.root_tree_id, selected);
    assert.deepEqual(
      await materializer.readEntry(current, selected, entry),
      edited,
    );
    const diff = await client.call("source.queries.diff", {
      before_revision_id: accepted.revision_id,
      after_revision_id: checkpoint.revision_id,
      limit: 2,
    });
    assert.equal(diff.coverage.state, "COMPLETE");
    assert.equal(diff.next_cursor, null);
    assert.deepEqual(
      diff.entries.map((row) => [row.path, row.kind]),
      [[selected, "MODIFIED"]],
    );
  } finally {
    await native.close(current);
  }
  const recovery = JSON.parse(
    await fs.readFile(profile.recovery_profile.path, "utf8"),
  );
  const backupId = randomUUID();
  const backup = await client.call("source.backups.create", {
    backup_id: backupId,
    profile: recovery,
    expires_at: new Date(
      Date.now() + recovery.backup.maximum_age_seconds * 1000,
    ).toISOString(),
    max_revisions: 100000,
    max_objects: 1000000,
    max_bytes: 1073741824,
  });
  assert.equal(backup.backup_id, backupId);
  let verified;
  for (let batch = 0; batch < 1000000; batch++) {
    verified = await client.call("source.backups.verify", {
      backup_id: backupId,
      limit: 256,
    });
    if (verified.state === "READY") break;
    assert.equal(verified.state, "VERIFYING");
  }
  assert.equal(verified.state, "READY");
  return {
    schema_version: 1,
    status: "PASS",
    case_id: "SCM-023",
    scope: "released source running journey revalidation",
    runtime,
    source: profile.source,
    custody,
    accepted_roots: {
      count: roots.length,
      sha256: sha(JSON.stringify(canonicalRelease(roots))),
    },
    checkpoint,
    backup_id: backupId,
    assignment_ids: [initial.assignment_id, replacement.assignment_id],
  };
}

async function releaseSnapshot({ runtime, profile, pool, client }) {
  const custody = await currentReleaseCustody(pool, profile);
  const accepted_roots = await acceptedReleaseRoots(pool, profile, client);
  const args = [
    profile.source.scope.organisation_id,
    profile.source.scope.repository_id,
    profile.source.scope.security_domain_id,
  ];
  const objects = (
    await pool.query(
      `SELECT to_jsonb(o) AS object,to_jsonb(p) AS placement
    FROM hyperfide.source_native_objects o JOIN hyperfide.source_object_placements p
    ON p.organisation_id=o.organisation_id AND p.repository_id=o.repository_id AND p.security_domain_id=o.security_domain_id
      AND p.object_id=o.object_id AND p.incarnation_id=o.current_incarnation
    WHERE o.organisation_id=$1 AND o.repository_id=$2 AND o.security_domain_id=$3 AND o.state='VERIFIED'
    ORDER BY o.object_id LIMIT 1000001`,
      args,
    )
  ).rows;
  assert(objects.length > 0 && objects.length <= 1000000);
  const { S3SourceObjectBackend, sourceS3Configuration } = await import(
    pathToFileURL(path.join(runtime, "services/dist/source_control/s3.js"))
  );
  const { decodeCanonicalEnvelope } = await import(
    pathToFileURL(
      path.join(runtime, "services/dist/source_control/contracts.js"),
    )
  );
  const backend = new S3SourceObjectBackend(sourceS3Configuration(process.env));
  for (const { object, placement } of objects) {
    assert.equal(placement.state, "VERIFIED");
    const read = await backend.read(
      placement.storage_key,
      Number(object.size_bytes),
    );
    assert.equal(read.state, "PRESENT");
    assert.equal(read.bytes.length, Number(object.size_bytes));
    assert.equal("sha256:" + sha(read.bytes), object.object_id);
    assert.equal(
      decodeCanonicalEnvelope(read.bytes, object.kind).kind,
      object.kind,
    );
  }
  const publication = await client.publication(
    profile.publication.operation_id,
  );
  assert.equal(publication.status, "PUBLISHED");
  const receiver = profile.publication.remote_git_directory,
    ref = profile.publication.target_ref;
  const git = async (...args) =>
    (
      await execute(
        path.join(runtime, "bin/git"),
        ["--git-dir=" + receiver, ...args],
        { timeout: 30000, maxBuffer: 16 * 1024 * 1024 },
      )
    ).stdout.trim();
  const remote_oid = await git("rev-parse", "--verify", ref),
    remote_reflog = await git("reflog", "show", "--format=%H", ref);
  assert.equal(publication.git_oid, "git:sha1:" + remote_oid);
  return canonicalRelease({
    schema_version: 1,
    source: profile.source,
    custody,
    accepted_roots: {
      count: accepted_roots.length,
      sha256: sha(JSON.stringify(canonicalRelease(accepted_roots))),
    },
    objects: {
      count: objects.length,
      sha256: sha(JSON.stringify(canonicalRelease(objects))),
    },
    publication,
    remote_oid,
    remote_reflog,
  });
}

export async function probeReleasedAmbiguousPublication({
  runtime,
  profile,
  client,
  modules,
  endpoint,
}) {
  const config = profile.publication;
  assert(
    path.isAbsolute(config.remote_git_directory),
    "Independent receiver Git readback is required",
  );
  const git = async (...args) =>
    (
      await execute(
        path.join(runtime, "bin/git"),
        ["--git-dir=" + config.remote_git_directory, ...args],
        { timeout: 30000, maxBuffer: 16 * 1024 * 1024 },
      )
    ).stdout.trim();
  assert(
    ["true", "always"].includes(
      await git("config", "--get", "core.logAllRefUpdates"),
    ),
    "Receiver reflog must already be enabled",
  );
  assert(/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9/_.-]*$/.test(config.target_ref));
  const ref = config.target_ref;
  const oldRows = await git("for-each-ref", "--format=%(objectname)", ref);
  const before = oldRows ? await git("reflog", "show", "--format=%H", ref) : "";
  const expectedOld = oldRows ? "git:sha1:" + oldRows : null;
  const publication = await client.createPublication(
    {
      acceptance_id: profile.journey.acceptance_id,
      destination_id: config.destination_id,
      target_ref: ref,
      expected_old_oid: expectedOld,
    },
    { operation_id: config.operation_id, idempotency_key: config.operation_id },
  );
  assert.equal(publication.operation_id, config.operation_id);
  assert.equal(publication.status, "QUEUED");
  let drops = 0;
  // Forward the real request to the packaged service, consume its actual response,
  // then sever the client connection. No result or remote effect is fabricated.
  const proxy = createServer(async (request, response) => {
    try {
      const parts = [];
      let size = 0;
      for await (const part of request) {
        size += part.length;
        assert(size <= 1048576);
        parts.push(part);
      }
      const body = Buffer.concat(parts),
        envelope = JSON.parse(body);
      assert.equal(envelope.action, "source.publications.resume");
      assert.equal(envelope.input.operation_id, config.operation_id);
      const remote = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: request.headers.authorization,
        },
        body,
        signal: AbortSignal.timeout(300000),
      });
      assert.equal(remote.status, 200);
      const actual = JSON.parse(await remote.text());
      assert.equal(actual.result.status, "PUBLISHED");
      assert.equal(actual.result.operation_id, config.operation_id);
      drops++;
      response.destroy();
    } catch (error) {
      response.destroy(error);
    }
  });
  await new Promise((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", resolve);
  });
  try {
    const losing = new modules.SourceControlClient({
      endpoint: "http://127.0.0.1:" + proxy.address().port,
      scope: profile.source.scope,
      token: () => releaseToken(profile.journey.token_file),
      timeout_ms: 300000,
    });
    await assert.rejects(
      losing.resumePublication(config.operation_id),
      (error) => error.code === "OUTCOME_UNKNOWN",
    );
    assert.equal(
      drops,
      1,
      "The actual publication response must have been dropped",
    );
  } finally {
    await new Promise((resolve) => proxy.close(resolve));
  }
  const resumed = await client.resumePublication(config.operation_id);
  const replay = await client.resumePublication(config.operation_id);
  assert.deepEqual(replay, resumed);
  assert.equal(resumed.status, "PUBLISHED");
  assert.equal(
    (await client.publication(config.operation_id)).git_oid,
    resumed.git_oid,
  );
  const observed = await git("rev-parse", "--verify", ref);
  assert.equal(resumed.git_oid, "git:sha1:" + observed);
  assert.notEqual(observed, oldRows);
  const after = await git("reflog", "show", "--format=%H", ref);
  assert.deepEqual(
    after.split("\n"),
    [observed, ...(before ? before.split("\n") : [])],
    "Independent receiver reflog must contain exactly one ref update",
  );
  await git("fsck", "--full", "--strict");
  const gitTree = await git("show", "-s", "--format=%T", observed);
  assert(/^[0-9a-f]{40}$/.test(gitTree));
  const native = new modules.NativeWorkspaceClient(
    client,
    profile.source.scope,
  );
  const selected = profile.journey.edit_path;
  const sourceFile = await native.lookup(profile.source.root_tree_id, selected);
  assert(sourceFile && sourceFile.kind === "file");
  const file = JSON.parse(
    (await native.readObject(sourceFile.object_id)).payload.toString("utf8"),
  );
  const gitBytes = (
    await execute(
      path.join(runtime, "bin/git"),
      [
        "--git-dir=" + config.remote_git_directory,
        "show",
        observed + ":" + selected,
      ],
      { encoding: "buffer", timeout: 30000, maxBuffer: 64 * 1024 * 1024 },
    )
  ).stdout;
  assert.equal(String(gitBytes.length), file[1]);
  assert.equal("sha256:" + sha(gitBytes), file[2]);
  return {
    schema_version: 1,
    status: "PASS",
    operation_id: config.operation_id,
    source: profile.source,
    dropped_response: true,
    resume_replayed: true,
    remote_ref_updates: 1,
    old_oid: oldRows || null,
    oid: observed,
    git_tree: gitTree,
    reflog_before: before,
    reflog_after: after,
  };
}

async function releaseMain(mode, filename) {
  const config = JSON.parse(await fs.readFile(filename, "utf8"));
  const { runtime, profile, directory, endpoint } = config;
  const modules = await releaseModules(runtime);
  const pool = await releaseDatabase(profile, modules.Pool);
  try {
    if (mode === "current") {
      await fs.writeFile(
        path.join(directory, "current.json"),
        JSON.stringify(await currentReleaseCustody(pool, profile)),
        { mode: 0o600 },
      );
      return;
    }
    if (mode === "preflight") {
      const others = (
        await pool.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'",
        )
      ).rows[0].n;
      assert.equal(
        others,
        0,
        "An isolated drill database without other clients is required",
      );
      await currentReleaseCustody(pool, profile);
      return;
    }
    assert(["journey", "publication", "before", "after"].includes(mode));
    const client = new modules.SourceControlClient({
      endpoint,
      scope: profile.source.scope,
      token: () => releaseToken(profile.journey.token_file),
      timeout_ms: 300000,
    });
    const args = { ...config, modules, pool, client };
    const report =
      mode === "journey"
        ? await runReleasedSourceJourney(args)
        : mode === "publication"
          ? await probeReleasedAmbiguousPublication(args)
          : await releaseSnapshot(args);
    await fs.writeFile(
      path.join(directory, mode + ".json"),
      JSON.stringify(report, null, 2) + "\n",
      { mode: 0o600 },
    );
  } finally {
    await pool.end();
  }
}

if (process.argv[2] === "--release") {
  try {
    await releaseMain(process.argv[3], process.argv[4]);
  } catch (error) {
    process.stderr.write(
      JSON.stringify({ status: "BLOCKED", diagnostic: error.message }) + "\n",
    );
    process.exitCode = 2;
  }
}
