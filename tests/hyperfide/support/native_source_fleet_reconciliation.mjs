import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function assertNativeReleaseReconciliation({
  f,
  resources,
  controlRoot,
  scope,
  sourceAssignment,
  invocation,
}) {
  const [
    { projectFleetCompletionCommands },
    { nextFleetCompletion, fleetCompletionNativeOperation },
    { runnerCanonical },
    { hash },
    { FoundationError },
  ] = await Promise.all([
    import(
      pathToFileURL(path.join(controlRoot, "preparation/fleet_completion.js"))
    ),
    import(pathToFileURL(path.join(controlRoot, "runner/fleet_completion.js"))),
    import(pathToFileURL(path.join(controlRoot, "runner/bridge.js"))),
    import(pathToFileURL(path.join(controlRoot, "transport/protocol.js"))),
    import(pathToFileURL(path.join(controlRoot, "policy/programme.js"))),
  ]);
  const rollback = new FoundationError(
    "RECONCILIATION_TEST_ROLLBACK",
    "Rollback declared reconciliation history",
  );
  let verified = false,
    failure;
  try {
    await resources.gateway.withPrimaryTransaction(
      { timeoutMs: 15000, maxRetries: 2 },
      async (tx) => {
        try {
          const insert = async (table, row) => {
            const fields = Object.keys(row);
            await tx.query(
              "INSERT INTO hyperfide." +
                table +
                "(" +
                fields.join(",") +
                ") VALUES(" +
                fields.map((_, n) => "$" + (n + 1)).join(",") +
                ")",
              Object.values(row),
            );
          };
          const assignment = (
            await tx.query(
              "SELECT * FROM hyperfide.source_fleet_assignments WHERE organisation_id=$1 AND run_id=$2 AND assignment_id=$3",
              [
                scope.organisation_id,
                scope.run_id,
                sourceAssignment.assignment_id,
              ],
            )
          ).rows[0];
          assert(
            assignment?.submission_id,
            "The regression requires an actual submitted native assignment",
          );
          const runner = (
            await tx.query(
              "SELECT * FROM hyperfide.runner_registry WHERE organisation_id=$1 AND run_id=$2 AND slot_id=$3 AND sandbox_id=$4",
              [
                scope.organisation_id,
                scope.run_id,
                assignment.slot_id,
                assignment.sandbox_id,
              ],
            )
          ).rows[0];
          assert(
            runner,
            "The regression requires the existing assigned runner",
          );
          const readiness = (
            await tx.query(
              "SELECT * FROM hyperfide.fleet_runtime_readiness WHERE organisation_id=$1 AND run_id=$2 AND runner_session_id=$3 AND readiness_digest=$4",
              [
                scope.organisation_id,
                scope.run_id,
                runner.session_id,
                runner.readiness_digest,
              ],
            )
          ).rows[0];
          assert(
            readiness,
            "The regression requires the registered installation",
          );
          const fixture = {
            kind: "DECLARED_RECONCILIATION_HISTORY",
            execution_qualification: false,
          };
          const publication = {
            ...readiness.publication,
            ...fixture,
            kind: "FLEET_MANIFEST_V1",
            source_backend: "native",
          };
          const readinessDigest = hash(runnerCanonical(publication));
          const install = (
            await tx.query(
              "SELECT * FROM hyperfide.fleet_environment_installs WHERE organisation_id=$1 AND run_id=$2 AND operation_id=$3",
              [
                scope.organisation_id,
                scope.run_id,
                readiness.install_operation_id,
              ],
            )
          ).rows[0];
          assert(install);
          const { created_at: _installCreated, ...installFields } = install;
          const installOperation = randomUUID();
          await insert("fleet_environment_installs", {
            ...installFields,
            operation_id: installOperation,
            environment_id: "reconciliation-" + randomUUID(),
          });
          const {
            id: _id,
            created_at: _created,
            ...readinessFields
          } = readiness;
          await insert("fleet_runtime_readiness", {
            ...readinessFields,
            id: randomUUID(),
            install_operation_id: installOperation,
            readiness_digest: readinessDigest,
            publication,
          });
          await tx.query(
            "UPDATE hyperfide.runner_registry SET readiness_digest=$3 WHERE organisation_id=$1 AND session_id=$2",
            [scope.organisation_id, runner.session_id, readinessDigest],
          );
          const launch = randomUUID(),
            start = randomUUID(),
            stop = randomUUID(),
            event = randomUUID(),
            admission = randomUUID(),
            executor = randomUUID();
          const quota = "reconciliation-" + randomUUID(),
            pair = generateKeyPairSync("ed25519"),
            pin = hash(runnerCanonical(fixture));
          await insert("identity_principals", {
            ...scope,
            credential_id: executor,
            actor_id: randomUUID(),
            role: "PROVISIONER",
            public_key_b64: pair.publicKey.export({ format: "jwk" }).x,
            deployment_epoch: invocation.principal.deployment_epoch,
            allowed_actions: ["provider.remote.execute-bound"],
            expires_at: "2099-01-01T00:00:00Z",
          });
          await insert("agent_admission_accounts", {
            ...scope,
            quota_key: quota,
            policy_digest: pin,
            max_concurrent: 1,
          });
          await insert("agent_admission_reservations", {
            ...scope,
            id: admission,
            quota_key: quota,
            session_id: assignment.worker_principal_id,
            payload_digest: pin,
            policy_digest: pin,
            state: "RELEASED",
          });
          await insert("outbox_events", {
            ...scope,
            id: event,
            aggregate_type: "fixture.reconciliation",
            aggregate_id: assignment.attempt_id,
            aggregate_version: 1,
            event_type: "instruction.start",
            payload: fixture,
          });
          await insert("scheduler_dispatches", {
            ...scope,
            id: start,
            request_id: start,
            task_id: assignment.task_id,
            attempt_id: assignment.attempt_id,
            attempt_generation: assignment.attempt_generation,
            authority_epoch: assignment.run_authority_epoch,
            sandbox_id: assignment.sandbox_id,
            slot_id: assignment.slot_id,
            sandbox_boot_generation: assignment.sandbox_boot_generation,
            payload_digest: pin,
            state: "COMPLETED",
            event_id: event,
          });
          await insert("native_launch_plans", {
            ...scope,
            command_id: start,
            launch_id: launch,
            agent_session_id: assignment.worker_principal_id,
            slot_id: assignment.slot_id,
            attempt_id: assignment.attempt_id,
            attempt_generation: assignment.attempt_generation,
            connector: "codex",
            connector_plan_digest: pin,
            admission_reservation_id: admission,
            reservation_attempt: 1,
            admission_policy_digest: pin,
            run_policy_digest: pin,
            qualification_receipt_digest: pin,
            packet_digest: pin,
            payload_digest: pin,
            plan: fixture,
          });
          const result = {
            ...fixture,
            command_id: start,
            launch_id: launch,
            request_digest: pin,
            native: {
              foreground_owner: true,
              terminal_observed: true,
              state: "EXITED",
              exit_code: 0,
            },
          };
          await insert("fleet_worker_launches", {
            ...scope,
            command_id: start,
            launch_id: launch,
            runner_session_id: runner.session_id,
            executor_credential_id: executor,
            authority_epoch: assignment.run_authority_epoch,
            request: fixture,
            request_digest: pin,
            state: "COMPLETED",
            result,
            result_digest: hash(runnerCanonical(result)),
            result_signature: sign(
              null,
              Buffer.from(runnerCanonical(result)),
              pair.privateKey,
            ).toString("base64url"),
            completed_at: new Date(),
          });
          const report = {
            ...fixture,
            outcome: "STOPPED",
            termination: "CONFIRMED",
            remaining_descendants: 0,
            cleanup_complete: true,
            cleanup_debt: [],
            credential_revocation: [],
            receipt_digest: pin,
          };
          await insert("runner_control_commands", {
            ...scope,
            command_id: stop,
            action: "runner.stop",
            launch_id: launch,
            slot_id: assignment.slot_id,
            sandbox_id: assignment.sandbox_id,
            boot_id: runner.boot_id,
            boot_generation: assignment.sandbox_boot_generation,
            attempt_id: assignment.attempt_id,
            attempt_generation: assignment.attempt_generation,
            authority_epoch: assignment.run_authority_epoch,
            fence_sequence: 1,
            policy: {
              grace_ms: 0,
              drain_deadline_ms: 1000,
              on_drain_deadline: "STOP",
            },
            required_outputs: JSON.stringify([]),
            request_digest: pin,
            issued_by_credential_id: invocation.principal.credential_id,
            state: "REPORTED",
            outcome: "STOPPED",
            termination: "CONFIRMED",
            cleanup_complete: true,
            report,
            report_digest: hash(runnerCanonical(report)),
            reported_at: new Date(),
          });
          await insert("runner_workspaces", {
            ...scope,
            sandbox_id: assignment.sandbox_id,
            boot_generation: assignment.sandbox_boot_generation,
            slot_id: assignment.slot_id,
            slot_generation: runner.slot_generation,
            state: "LEASED",
            launch_id: launch,
            registered_by_credential_id: runner.credential_id,
          });
          const target = {
            state_dir: runner.state_dir,
            launch_id: launch,
            attempt_id: assignment.attempt_id,
            attempt_generation: String(assignment.attempt_generation),
            sandbox_id: assignment.sandbox_id,
            boot_id: runner.boot_id,
            boot_generation: String(assignment.sandbox_boot_generation),
            command_id: stop,
          };
          const argv = [
            runner.runner_binary,
            "--component",
            "12.4",
            "--action",
            "runner.stop",
            "--request-base64",
            Buffer.from(JSON.stringify(target)).toString("base64url"),
          ];
          const stopOperation = randomUUID(),
            releaseOperation = fleetCompletionNativeOperation({
              kind: "FLEET_COMPLETION_NATIVE_V1",
              phase: "RELEASE",
              ...scope,
              launch_id: launch,
              command_id: stop,
            });
          const remote = {
            ...scope,
            session_id: runner.session_id,
            sandbox_id: assignment.sandbox_id,
            boot_generation: assignment.sandbox_boot_generation,
            request_digest: pin,
            runner_binding_evidence_digest: pin,
          };
          await insert("provider_remote_operations", {
            ...remote,
            id: stopOperation,
            state: "OBSERVED",
            operation: { ...fixture, parameters: { argv } },
            outcome: {
              status: "SUCCEEDED",
              result: {
                phase: "EXITED",
                exit_code: "0",
                termination_confirmed: true,
              },
            },
          });
          const unknown = {
            ...remote,
            id: releaseOperation,
            state: "UNKNOWN",
            operation: {
              ...fixture,
              kind: "execute",
              parameters: {
                argv: [
                  runner.runner_binary,
                  "--component",
                  "12.4",
                  "--action",
                  "runner.slot.release",
                ],
              },
            },
          };
          await insert("provider_remote_operations", unknown);
          const before = (
            await tx.query(
              "SELECT * FROM hyperfide.provider_remote_operations WHERE organisation_id=$1 AND id=$2",
              [scope.organisation_id, releaseOperation],
            )
          ).rows[0];
          const projected = await projectFleetCompletionCommands(
            tx,
            invocation,
            { after: null, limit: 100 },
          );
          const waiting = projected.waiting.find(
            (row) => row.launch_id === launch,
          );
          assert.deepEqual(waiting, {
            launch_id: launch,
            state: "NATIVE_RELEASE_RECONCILIATION_REQUIRED",
            native_operation_id: releaseOperation,
            native_operation_state: "UNKNOWN",
          });
          assert.equal(
            projected.commands.some((row) => row.input?.launch_id === launch),
            false,
            "Unknown release must not create a new effect",
          );
          assert.equal(
            await nextFleetCompletion(tx, {
              ...invocation.principal,
              credential_id: executor,
            }),
            null,
            "Automatic completion must not repeat the unknown release",
          );
          const after = (
            await tx.query(
              "SELECT * FROM hyperfide.provider_remote_operations WHERE organisation_id=$1 AND id=$2",
              [scope.organisation_id, releaseOperation],
            )
          ).rows[0];
          assert.deepEqual(
            after,
            before,
            "Projection must retain the original uncertain operation byte for byte",
          );
          verified = true;
          throw rollback;
        } catch (error) {
          if (error === rollback) throw error;
          failure = error;
          throw rollback;
        }
      },
    );
  } catch (error) {
    if (error.code !== rollback.code) throw error;
  }
  if (failure) throw failure;
  assert.equal(verified, true);
  return "native release uncertainty is exposed for reconciliation under the original operation, without reexecution; declared signed history and persisted UNKNOWN input only";
}

export async function createNativeSourceOutageGroup({ f }) {
  const { createServer, request: upstreamRequest } = await import("node:http");
  const { SourceControlClient } = await import(
    pathToFileURL(
      path.join(process.env.SOURCE_CONTROL_SDK_MODULE_ROOT, "client.js"),
    )
  );
  const upstream = new URL(f.endpoint),
    sockets = new Set();
  let server,
    port = 0,
    interrupt = false,
    action;
  const start = async () => {
    server = createServer((request, response) => {
      void (async () => {
        const chunks = [];
        for await (const bytes of request) chunks.push(bytes);
        const body = Buffer.concat(chunks),
          envelope = JSON.parse(body);
        const forwarded = upstreamRequest(
          upstream,
          { method: request.method, headers: request.headers },
          (received) => {
            if (interrupt && (!action || envelope.action === action)) {
              interrupt = false;
              received.resume();
              response.destroy();
              return;
            }
            response.writeHead(received.statusCode, received.headers);
            received.pipe(response);
            received.on("error", () => response.destroy());
          },
        );
        forwarded.on("error", () => response.destroy());
        forwarded.end(body);
      })().catch(() => response.destroy());
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    port = server.address().port;
  };
  const stop = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  };
  await start();
  return {
    client(name) {
      return new SourceControlClient({
        endpoint: `http://127.0.0.1:${port}${upstream.pathname}`,
        scope: f.scope,
        token: () => f.tokenFor(name),
        timeout_ms: 120000,
      });
    },
    arm(value) {
      action = value;
      interrupt = true;
    },
    async recover() {
      await stop();
      await f.restart();
      await start();
    },
    async during(operation) {
      action = undefined;
      interrupt = true;
      await assert.rejects(
        operation,
        (error) => error.code === "OUTCOME_UNKNOWN",
      );
      assert.equal(
        interrupt,
        false,
        "The real source service must have produced a response before its connection is interrupted",
      );
      await stop();
      await assert.rejects(
        operation,
        (error) => error.code === "OUTCOME_UNKNOWN",
      );
      await f.restart();
      await start();
    },
    close: stop,
  };
}

export async function assertNativeAuthorityOutage({
  operation,
  journalDirectory,
  deploymentId,
}) {
  const fs = await import("node:fs/promises");
  const head = path.join(journalDirectory, deploymentId + ".authority.json"),
    held = head + ".outage-" + randomUUID();
  const original = await fs.readFile(head);
  await fs.rename(head, held);
  try {
    await assert.rejects(
      operation,
      (error) => error.code === "EXTERNAL_AUTHORITY_UNAVAILABLE",
    );
  } finally {
    await fs.rename(held, head);
  }
  assert.deepEqual(
    await fs.readFile(head),
    original,
    "Authority restoration must retain the exact independent journal",
  );
}

export async function assertNativeManagerIntegration({
  f,
  root,
  managerClient,
  assignment,
  candidateInput,
  outages,
  journalDirectory,
  deploymentId,
}) {
  const fs = await import("node:fs/promises");
  const { IntegrationQueue } = await import(
    pathToFileURL(
      path.join(f.ROOT, "plugins/hyperfide-dispatch/src/integrate/queue.ts"),
    )
  );
  const {
    NativeWorkspaceClient,
    NativeObjectCache,
    SourceWorkspaceJournal,
    SparseSourceMaterializer,
  } = await import(
    pathToFileURL(path.join(f.ROOT, "sdk/source-control/src/host/index.ts"))
  );
  const workspaceClient = new NativeWorkspaceClient(managerClient, f.scope);
  const workspace = await workspaceClient.open({
    base_revision_id: assignment.revision_id,
    mode: "API_ONLY",
    read_paths: ["main.txt"],
    write_paths: [],
  });
  const managerRoot = path.join(root, "manager-source");
  const materializer = new SparseSourceMaterializer(
    workspaceClient,
    new NativeObjectCache(path.join(root, "manager-cache"), {
      max_bytes: workspace.budgets.cache_bytes,
      max_entries: workspace.budgets.max_cache_entries,
      max_object_bytes: workspace.budgets.max_file_bytes,
    }),
    new SourceWorkspaceJournal(path.join(root, "manager-journal")),
    managerRoot,
  );
  const readiness = {
    schema_version: 1,
    kind: "WORKSPACE_READINESS",
    scope: { ...f.scope },
    workspace_id: workspace.workspace_id,
    workspace_generation: workspace.workspace_generation,
    scope_generation: workspace.scope_generation,
    authority_epoch: workspace.authority_epoch,
    base_revision_id: assignment.revision_id,
    selected_paths: [],
    installed_entry_digest:
      "sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    closure_manifest_digest:
      "sha256:83d1942b14c7af2b33b306afda2544e0da815ebaad3885c5f427d9bb02c91690",
    closure_state: "INCOMPLETE",
  };
  assert.deepEqual(await materializer.materialize(workspace, []), {
    state: "READY",
    files: 0,
    bytes: 0,
    physically_materialized: false,
    receipt: {
      ...readiness,
      receipt_digest:
        "sha256:" +
        createHash("sha256").update(JSON.stringify(readiness)).digest("hex"),
    },
  });
  await assert.rejects(
    () => materializer.materialize(workspace, ["main.txt"]),
    (error) => error.code === "WORKSPACE_MODE",
  );
  const job = {
    backend: "native",
    id: randomUUID(),
    feature: "native-fleet",
    task: assignment.task_id,
    assignment,
    candidate: candidateInput,
    operations: {
      create: randomUUID(),
      qualify: randomUUID(),
      accept: randomUUID(),
    },
  };
  let published;
  const queue = new IntegrationQueue(managerRoot, "unused", {
    source: managerClient,
    asks: async () => [],
    evidence: async (candidate) => {
      published ??= await f.publishEvidence(candidate);
      assert.equal(published.execution.observed.exit_code, 0);
      const qualification = await managerClient.qualifyCandidate(
        {
          candidate_id: candidate.candidate_id,
          evidence_ids: [published.evidence.evidence_id],
        },
        {
          operation_id: job.operations.qualify,
          idempotency_key: job.operations.qualify,
        },
      );
      await assertNativeAuthorityOutage({
        journalDirectory,
        deploymentId,
        operation: () =>
          managerClient.acceptCandidate(
            {
              candidate_id: candidate.candidate_id,
              qualification_id: qualification.qualification_id,
            },
            {
              operation_id: job.operations.accept,
              idempotency_key: job.operations.accept,
            },
          ),
      });
      outages.arm("source.acceptance.accept");
      return [published.evidence.evidence_id];
    },
  });
  // Keep the same candidate and operation identities across an interrupted acceptance.
  const interrupted = await queue.enqueue(job);
  assert.equal(interrupted.status, "failed");
  assert.match(interrupted.reason, /Source request lost its response/);
  assert.equal(
    interrupted.acceptance,
    undefined,
    "A dropped acknowledgement cannot report acceptance",
  );
  await outages.recover();
  const recoveredQueue = new IntegrationQueue(managerRoot, "unused", {
    source: managerClient,
    asks: async () => [],
    evidence: async () => [published.evidence.evidence_id],
  });
  const merged = await recoveredQueue.enqueue(job);
  assert.equal(merged.status, "merged", merged.reason);
  assert(merged.acceptance);
  const replay = await new IntegrationQueue(managerRoot, "unused", {
    source: managerClient,
    asks: async () => [],
    evidence: async () => [published.evidence.evidence_id],
  }).enqueue(job);
  assert.equal(replay.status, "merged", replay.reason);
  assert.deepEqual(replay.acceptance, merged.acceptance);
  await assert.rejects(
    () => fs.stat(managerRoot),
    (error) => error.code === "ENOENT",
  );
  const principal = (await managerClient.candidate(candidateInput.candidate_id))
    .created_by_principal_id;
  const rows = (
    await f.pool.query(
      "SELECT mode FROM hyperfide.source_workspaces WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND principal_id=$4",
      [...Object.values(f.scope), principal],
    )
  ).rows;
  assert(rows.length > 0);
  assert(rows.every((row) => row.mode === "API_ONLY"));
  assert.equal(
    (
      await f.pool.query(
        "SELECT count(*)::int AS n FROM hyperfide.source_native_acceptances WHERE candidate_id=$1",
        [candidateInput.candidate_id],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (await managerClient.candidate(candidateInput.candidate_id))
      .created_by_principal_id,
    principal,
  );
  return {
    candidate: await managerClient.candidate(candidateInput.candidate_id),
    qualification: await managerClient.qualifyCandidate(
      {
        candidate_id: candidateInput.candidate_id,
        evidence_ids: [published.evidence.evidence_id],
      },
      {
        operation_id: job.operations.qualify,
        idempotency_key: job.operations.qualify,
      },
    ),
    accepted: merged.acceptance,
    published,
    workspace_id: workspace.workspace_id,
  };
}

export async function assertNativeDefaultPublication({
  f,
  root,
  accepted,
  qualified,
  submission,
  checkpointOne,
  checkpointTwo,
  baseline,
  managerIntegration,
  lifecycleEvidence,
}) {
  const fs = await import("node:fs/promises");
  const { execFile } = await import("node:child_process"),
    { promisify } = await import("node:util");
  const execute = promisify(execFile),
    scope = Object.values(f.scope);
  assert.equal(qualified.execution.observed.exit_code, 0);
  assert.equal(qualified.execution.receipt.execution.process_absent, true);
  assert.notEqual(
    qualified.execution.receipt_object_id,
    qualified.evidence.evidence_id,
  );
  assert.notEqual(checkpointOne.revision_id, checkpointTwo.revision_id);
  assert.equal(accepted.revision_id, checkpointTwo.revision_id);
  assert.equal(submission.revision_id, checkpointTwo.revision_id);
  assert.notEqual(submission.submission_id, accepted.acceptance_id);
  assert.equal(
    (
      await f.pool.query(
        "SELECT count(*)::int AS n FROM hyperfide.source_git_publications WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3",
        scope,
      )
    ).rows[0].n,
    0,
    "Acceptance must not imply publication",
  );
  const git = async (...args) =>
    (
      await execute(
        "git",
        ["--git-dir=" + path.join(root, "native-publication.git"), ...args],
        { timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
      )
    ).stdout;
  await assert.rejects(
    () => git("rev-parse", "refs/heads/main"),
    (error) => error.code === 128,
  );
  // Export checks every retained ancestor rather than treating a tip acceptance as ancestry proof.
  const pending = [accepted.revision_id],
    seen = new Set();
  while (pending.length) {
    const id = pending.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const revision = await f.client.revision(id);
    pending.push(...revision.parent_revision_ids);
    if (
      (
        await f.pool.query(
          "SELECT acceptance_id FROM hyperfide.source_native_acceptances WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND revision_id=$4",
          [...scope, id],
        )
      ).rowCount
    )
      continue;
    const change = (
      await f.pool.query(
        "SELECT change_id FROM hyperfide.source_change_revisions WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND revision_id=$4",
        [...scope, id],
      )
    ).rows[0];
    await f.accept(
      await f.createCandidate(
        { ...revision, change_id: change.change_id },
        { domain: await f.createDomain(revision) },
      ),
    );
  }
  const operation = randomUUID(),
    input = {
      acceptance_id: accepted.acceptance_id,
      destination_id: "native-default",
      target_ref: "refs/heads/main",
      expected_old_oid: null,
    };
  const queued = await f.client.createPublication(input, {
    operation_id: operation,
    idempotency_key: operation,
  });
  assert.equal(queued.status, "QUEUED");
  assert.notEqual(queued.operation_id, accepted.operation_id);
  await assert.rejects(
    () => git("rev-parse", "refs/heads/main"),
    (error) => error.code === 128,
  );
  const published = await f.client.resumePublication(operation);
  assert.equal(published.status, "PUBLISHED");
  assert.equal(published.acceptance_id, accepted.acceptance_id);
  assert.equal(published.revision_id, accepted.revision_id);
  assert.deepEqual(await f.client.publication(operation), published);
  assert.deepEqual(
    await f.client.createPublication(input, {
      operation_id: operation,
      idempotency_key: operation,
    }),
    published,
  );
  const oid = (await git("rev-parse", "refs/heads/main")).trim();
  assert.equal(published.git_oid, "git:sha1:" + oid);
  const bytes = await git("show", "refs/heads/main:main.txt");
  const entry = await f.service.trees.lookup(
    f.scope,
    accepted.root_tree_id,
    "main.txt",
  );
  assert.deepEqual(
    Buffer.from(bytes),
    await f.service.objects.readFile(f.scope, entry.object_id),
  );
  await git("fsck", "--full", "--strict");
  assert.equal(
    (
      await f.pool.query(
        "SELECT count(*)::int AS n FROM hyperfide.source_git_publications WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND operation_id=$4",
        [...scope, operation],
      )
    ).rows[0].n,
    1,
  );
  return {
    process: qualified.execution.receipt.command,
    object_upload: qualified.execution.receipt_object_id,
    checkpoints: [checkpointOne.revision_id, checkpointTwo.revision_id],
    submission_id: submission.submission_id,
    qualification_id: qualified.qualification.qualification_id,
    acceptance_id: accepted.acceptance_id,
    publication: published,
    git_readback: { oid, bytes: Buffer.byteLength(bytes) },
    manager_api_only_workspace_id: managerIntegration.workspace_id,
    lifecycle: lifecycleEvidence,
  };
}
