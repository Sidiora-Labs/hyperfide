import assert from "node:assert/strict";
import { createHash, randomUUID, sign } from "node:crypto";
import fs from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createNativeAcceptanceFixture } from "./native_source_acceptance_fixture.mjs";
import { installNativeFleetFixture } from "./native_source_fleet_install.mjs";
import { createNativeFleetAssignmentFixture } from "./native_source_fleet_assignment.mjs";
import { createNativeFleetPool } from "./native_source_fleet_pool.mjs";

const moduleRoot = process.env.SOURCE_CONTROL_MODULE_ROOT,
  controlRoot = path.dirname(moduleRoot);
const load = (name) =>
  import(pathToFileURL(path.join(controlRoot, name + ".js")));
const inputs = JSON.parse(
    await fs.readFile(process.env.NATIVE_SOURCE_FLEET_INPUT, "utf8"),
  ),
  i = inputs.ids;
const [
  { createResourceContainer },
  { AuthorityStore },
  { FileExternalAuthorityJournal },
  identityModule,
  protocol,
  { parseKvx },
  { registerProofPolicy },
  { SourceControlClient },
  { encodeFileDescriptor },
] = await Promise.all([
  load("storage/runtime"),
  load("storage/durability"),
  load("storage/authority_journal"),
  load("identity/enrollment"),
  load("transport/protocol"),
  load("spec/import"),
  load("spec/obligations"),
  import(
    pathToFileURL(
      path.join(process.env.SOURCE_CONTROL_SDK_MODULE_ROOT, "client.js"),
    )
  ),
  load("source_control/objects"),
]);
const signal = new AbortController().signal,
  resources = createResourceContainer({
    role: "control",
    env: process.env,
    signal,
  });
const journal = new FileExternalAuthorityJournal(
  process.env.HYPERFIDE_AUTHORITY_JOURNAL_DIR,
  async (value) => {
    const { lookupAuthorityActivation } = await load("storage/durability");
    return lookupAuthorityActivation(resources, value);
  },
);
const authority = new AuthorityStore(
  resources,
  process.env.HYPERFIDE_DEPLOYMENT_ID,
  journal,
);
const identity = await identityModule.createComponent({
  env: process.env,
  resources,
  signal,
  dependencies: {
    require(name, capability) {
      assert.equal(name, "4.4");
      assert.equal(capability, "storage.authority.v1");
      return authority;
    },
  },
});
const identityAuthority = identity.capabilities["identity.authority"];
const root = await fs.mkdtemp(path.join(os.tmpdir(), "hf-native-fleet-"));
const nativeScope = {
  organisation_id: i.organisation,
  repository_id: i.repository,
  security_domain_id: randomUUID(),
};
const f = await createNativeAcceptanceFixture({
  migrate: false,
  scope: nativeScope,
  serviceOptions: {
    transaction: (body) =>
      resources.gateway.withPrimaryTransaction(
        { timeoutMs: 15000, maxRetries: 2 },
        body,
      ),
  },
});
const stages = [];
const hash = (bytes) =>
  "sha256:" + createHash("sha256").update(bytes).digest("hex");
const digest = f.sourceDigest;
const insert = async (table, record) => {
  const columns = Object.keys(record);
  await f.pool.query(
    "INSERT INTO hyperfide." +
      table +
      "(" +
      columns.join(",") +
      ") VALUES(" +
      columns.map((_, index) => "$" + (index + 1)).join(",") +
      ")",
    Object.values(record),
  );
};
const scope = { organisation_id: i.organisation, run_id: i.run };
const request = async (
  key,
  component,
  action,
  input,
  operation = randomUUID(),
) => {
  const payload = Buffer.from(
    JSON.stringify({
      run_id: i.run,
      component,
      action,
      input,
      expected_version: null,
      authority: null,
    }),
  );
  const body = Buffer.from(
    JSON.stringify({
      protocol_version: 1,
      operation_id: operation,
      idempotency_key: operation,
      payload_digest: hash(payload),
      correlation_id: operation,
      causation_id: null,
      payload_b64: payload.toString("base64url"),
    }),
  );
  const proof = {
    id: i[key],
    time: String(Math.floor(Date.now() / 1000)),
    nonce: randomUUID(),
  };
  const signature = sign(
    null,
    protocol.signingBytes(inputs.origin, "/v1/invoke", proof, body),
    await fs.readFile(inputs.keys[key]),
  ).toString("base64url");
  return {
    body,
    headers: {
      "Content-Type": "application/json",
      "HF-Credential-Id": proof.id,
      "HF-Request-Time": proof.time,
      "HF-Request-Nonce": proof.nonce,
      "HF-Request-Signature": signature,
    },
  };
};
const sourceInvocation = async (
  key,
  action,
  input,
  operation = randomUUID(),
) => {
  const value = {
    protocol_version: 1,
    scope: f.scope,
    operation_id: operation,
    idempotency_key: operation,
    action,
    input,
  };
  const signed = await request(key, "source-control", action, value, operation);
  const invocation = await identityAuthority.authenticate(
    signed.body,
    Object.entries(signed.headers).flat(),
    signal,
  );
  return { value, invocation };
};
const sourceCall = async (key, action, input, operation = randomUUID()) => {
  const { value, invocation } = await sourceInvocation(
    key,
    action,
    input,
    operation,
  );
  return f.service.api.invoke(action, value, invocation);
};
const controlCall = async (key, component, action, input) => {
  const signed = await request(key, component, action, input);
  const ca = await fs.readFile(inputs.ca);
  const response = await new Promise((resolve, reject) => {
    const req = https.request(
      inputs.origin + "/v1/invoke",
      { method: "POST", ca, headers: signed.headers },
      (res) => {
        const buffers = [];
        res.on("data", (part) => buffers.push(part));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            body: JSON.parse(Buffer.concat(buffers)),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(signed.body);
  });
  if (!response.body.ok) {
    const error = new Error(response.body.error.message);
    Object.assign(error, response.body.error);
    throw error;
  }
  return response.body.result;
};
try {
  console.error("native-fleet: fixture ready");
  const grantedActions = [
    ...new Set([
      ...f.service.api.actions.filter(
        (action) =>
          action === "source.capabilities" ||
          /^source\.(objects|uploads|trees|revisions|changes|operations|queries|workspaces|subscriptions|transforms|domains|candidates|acceptance|assurance|publications|fleet)\./.test(
            action,
          ),
      ),
      "source.capabilities.manage",
    ]),
  ];
  assert(
    grantedActions.length <= 64,
    "Fleet fixture grants only its bounded source lifecycle actions",
  );
  for (const name of ["leader", "manager"])
    await insert("source_capabilities", {
      ...f.scope,
      id: randomUUID(),
      principal_id: i[name],
      credential_id: i[name],
      principal_kind: "automation",
      authority_epoch: "1",
      policy_version: f.sourcePolicy,
      actions: grantedActions,
      path_prefixes: [""],
      expires_at: new Date(Date.now() + 1200000).toISOString(),
    });
  const mainFile = await f.service.objects.putFile(
    f.scope,
    Buffer.from("candidate: assigned baseline\n"),
  );
  const rootTree = await f.service.trees.fromEntries(f.scope, [
    {
      name: "main.txt",
      kind: "file",
      mode: "100644",
      object_id: mainFile.object_id,
    },
  ]);
  const baseline = await f.createRevision({
    root_tree_id: rootTree.root_tree_id,
    parent_revision_ids: [],
  });
  const nativePool = await createNativeFleetPool({
    f,
    ids: i,
    revision: baseline,
    capacity: inputs.capacity,
    resources,
    controlRoot,
  });
  Object.assign(i, nativePool.ids);
  const boundRun = await sourceCall("leader", "source.fleet.bind-run", {
    run_id: i.run,
    revision_id: baseline.revision_id,
    leader_generation: "1",
  });
  assert.equal(boundRun.revision_id, baseline.revision_id);
  const installed = await installNativeFleetFixture(f, {
    root,
    controlRoot,
    revision: baseline,
    fleet: i,
  });
  stages.push(installed.stage);
  const specification = randomUUID(),
    run = (
      await f.pool.query(
        "SELECT spec_generation::text,state_version::text FROM hyperfide.runs WHERE organisation_id=$1 AND id=$2",
        [i.organisation, i.run],
      )
    ).rows[0];
  const generation = String(BigInt(run.spec_generation) + 1n),
    rubric = digest("native-fleet-executable-rubric");
  const acceptedCheck = {
    id: f.check.id,
    argv: f.check.argv,
    executable_digest: f.check.executable_digest,
    timeout_ms: 30000,
    required_artifacts: f.check.required_artifacts,
    input_keys: [
      "source",
      "dependency",
      "toolchain",
      "configuration",
      "graph",
      "contract",
    ],
  };
  const render = (value) => JSON.stringify(value);
  let source =
    '[req.4]\nac_2 = "Native worker source remains attributable through coordinator qualification."\n[acceptance.native-fleet]\nreqs = ["4.2"]\nchecks = ' +
    render([f.check.id]) +
    "\n[proof]\nrubric_digest = " +
    render(rubric) +
    "\n[proof.check." +
    f.check.id +
    "]\n";
  for (const [key, value] of Object.entries(acceptedCheck))
    if (key !== "id") source += key + " = " + render(value) + "\n";
  source +=
    '[task.native-first]\nwave = 1\nreqs = ["4.2"]\nacceptance_ids = ["native-fleet"]\ntouches = ["main.txt"]\nrequires = []\n';
  const parsed = parseKvx(source),
    document = {
      schema_version: 1,
      revision_digest: digest(source),
      source_digest: hash(Buffer.from(source)),
      repositories: [
        {
          repository_id: i.repository,
          source_object_id: baseline.revision_id,
          integration_ref: null,
        },
      ],
      allowed_actions: inputs.actions,
      closure_policy: {
        required_evidence: [],
        required_review_roles: [],
        publication: "AFTER_QUALIFICATION",
      },
      provenance: null,
      parsed,
      runtime_wave_offset: 0,
    };
  await insert("spec_revisions", {
    organisation_id: i.organisation,
    project_id: i.project,
    id: specification,
    source_digest: document.source_digest,
    source_content: source,
    document,
    schema_version: 1,
    revision_digest: document.revision_digest,
  });
  await insert("run_spec_revisions", {
    ...scope,
    spec_generation: generation,
    spec_revision_id: specification,
  });
  await f.pool.query(
    "UPDATE hyperfide.runs SET spec_generation=$3,spec_revision_id=$4,state_version=state_version+1 WHERE organisation_id=$1 AND id=$2",
    [i.organisation, i.run, generation, specification],
  );
  const tasks = {};
  const registerTask = async (
    name,
    {
      profile = nativePool.profile,
      packageId = i.package,
      sourceRevision = baseline.revision_id,
      feature = "alpha",
    } = {},
  ) => {
    const task = randomUUID(),
      slot = randomUUID(),
      criteria = digest("native-fleet-" + name);
    tasks[name] = { task, slot, criteria };
    const definition = {
      ...inputs.definition,
      section: parsed.sections.find(
        (section) => section.name === "task.native-" + name,
      ),
      purpose: "Native source " + name,
      touches: ["main.txt"],
      environment_profile_id: profile,
      feature_key: feature,
    };
    await insert("tasks", {
      ...scope,
      id: task,
      task_key: feature + ".native-" + name,
      feature_package_id: packageId,
      spec_revision_id: specification,
      spec_generation: generation,
      criteria_digest: criteria,
      definition,
      wave: 1,
    });
    const policy = {
      schema_version: 1,
      criteria_digest: criteria,
      spec_revision_id: specification,
      spec_generation: generation,
      repository_id: i.repository,
      source_object_id: sourceRevision,
      rubric_digest: rubric,
      checks: [acceptedCheck],
      clauses: [
        {
          id: "4.2",
          mode: "EXECUTABLE",
          acceptance_ids: ["native-fleet"],
          checks: [f.check.id],
        },
      ],
      inputs: Object.fromEntries(
        [
          "source",
          "dependency",
          "toolchain",
          "configuration",
          "graph",
          "contract",
        ].map((key) => [key, digest("accepted-native-" + key)]),
      ),
      contract_digests: [],
    };
    const state = (
      await f.pool.query(
        "SELECT state_version::text FROM hyperfide.runs WHERE organisation_id=$1 AND id=$2",
        [i.organisation, i.run],
      )
    ).rows[0].state_version;
    tasks[name].registry = await resources.gateway.withPrimaryTransaction(
      { timeoutMs: 15000 },
      (tx) =>
        registerProofPolicy(tx, scope, {
          run_id: i.run,
          task_id: task,
          spec_revision_id: specification,
          spec_generation: generation,
          state_version: state,
          policy,
        }),
    );
    return tasks[name];
  };
  await registerTask("first");
  const assignments = await createNativeFleetAssignmentFixture({
    f,
    ids: i,
    controlCall,
    installed,
    specification,
    tasks,
    capacity: nativePool.capacity,
  });
  const participant = await assignments.assign(tasks.first.task, 0);
  const worker = {
    principal_id: participant.assignment.worker_id,
    credential_id: randomUUID(),
    kind: "worker",
  };
  f.roles.worker = worker;
  await insert("source_principal_credentials", {
    ...f.scope,
    credential_id: worker.credential_id,
    principal_id: worker.principal_id,
    principal_kind: "worker",
    credential_version: 1,
    issuer: f.trust.issuer,
    audience: f.trust.audience,
    signing_key_id: "fixture-source-key",
    expires_at: new Date(Date.now() + 1200000).toISOString(),
  });
  const assignmentInput = {
    ...participant.native_source_setup.input,
    worker_credential_id: worker.credential_id,
  };
  const assignmentOperation = randomUUID();
  const assigned = await sourceCall(
    "manager",
    "source.fleet.assign",
    assignmentInput,
    assignmentOperation,
  );
  worker.capability_id = assigned.capability_id;
  assert.equal(assigned.workspace.workspace_generation, "1");
  assert.equal(assigned.base_revision_id, baseline.revision_id);
  const pinRows = async () =>
    (
      await f.pool.query(
        `SELECT p.object_id,p.position,p.incarnation_id,p.expires_at>clock_timestamp() AS live,
      p.expires_at>=c.expires_at AS covers_capability
      FROM hyperfide.source_object_pins p JOIN hyperfide.source_capabilities c
      ON c.organisation_id=p.organisation_id AND c.repository_id=p.repository_id AND c.security_domain_id=p.security_domain_id AND c.id=$5
      WHERE p.organisation_id=$1 AND p.repository_id=$2 AND p.security_domain_id=$3
      AND p.owner_kind='WORKSPACE' AND p.owner_id=$4 ORDER BY p.position`,
        [
          ...Object.values(f.scope),
          assigned.workspace_id,
          assigned.capability_id,
        ],
      )
    ).rows;
  const assertBasePin = (rows) => {
    const base = rows.filter((row) => row.position === 0);
    assert.equal(
      base.length,
      1,
      "Assigned workspace needs exactly one base retention pin",
    );
    assert.equal(base[0].object_id, assigned.root_tree_id);
    assert.equal(base[0].live, true);
    assert.equal(
      base[0].covers_capability,
      true,
      "Retention must cover the assigned capability lifetime",
    );
    assert(
      base[0].incarnation_id,
      "Retention must bind the verified object incarnation",
    );
  };
  const before = await pinRows();
  assert.equal(before.length, 1);
  assertBasePin(before);
  assert.deepEqual(
    await sourceCall(
      "manager",
      "source.fleet.assign",
      assignmentInput,
      assignmentOperation,
    ),
    assigned,
  );
  assert.deepEqual(
    await pinRows(),
    before,
    "Assignment replay must not duplicate or replace retention",
  );
  const client = new SourceControlClient({
    endpoint: f.endpoint,
    scope: f.scope,
    token: () => f.tokenFor("worker"),
    timeout_ms: 120000,
  });
  const options = () => ({
    authority: assigned.authority,
    operation_id: randomUUID(),
  });
  const bytes = Buffer.from("candidate: assigned participant checkpoint\n");
  const blob = await client.call(
    "source.objects.put",
    { kind: "blob", payload_base64: bytes.toString("base64") },
    options(),
  );
  const file = await client.call(
    "source.objects.put",
    {
      kind: "file",
      payload_base64: encodeFileDescriptor({
        size_bytes: String(bytes.length),
        content_digest: hash(bytes),
        content: { kind: "blob", object_id: blob.object_id },
      }).toString("base64"),
    },
    options(),
  );
  const checkpointOptions = options();
  const checkpoint = await client.call(
    "source.workspaces.checkpoint",
    {
      operation_id: checkpointOptions.operation_id,
      workspace_id: assigned.workspace_id,
      expected_workspace_generation: assigned.workspace.workspace_generation,
      expected_scope_generation: assigned.workspace.scope_generation,
      base_revision_id: assigned.base_revision_id,
      overlay_generation: assigned.workspace.workspace_generation,
      changes: [
        {
          path: "main.txt",
          operation: "put",
          kind: "file",
          mode: "100644",
          object_id: file.object_id,
        },
      ],
    },
    checkpointOptions,
  );
  const next = String(BigInt(assigned.workspace.workspace_generation) + 1n);
  assert.equal(checkpoint.workspace.workspace_generation, next);
  assert.equal(checkpoint.receipt.workspace_generation, next);
  assert.equal(checkpoint.workspace.workspace_id, assigned.workspace_id);
  assert.notEqual(checkpoint.revision_id, baseline.revision_id);
  const revision = await f.client.revision(checkpoint.revision_id);
  assert.deepEqual(revision.parent_revision_ids, [baseline.revision_id]);
  const entry = await f.service.trees.lookup(
    f.scope,
    checkpoint.workspace.root_tree_id,
    "main.txt",
  );
  assert.deepEqual(
    await f.service.objects.readFile(f.scope, entry.object_id),
    bytes,
  );
  const after = await pinRows();
  assertBasePin(after);
  assert.equal(after.length, 2);
  const checkpointPins = after.filter((row) => row.position === 1);
  assert.equal(checkpointPins.length, 1);
  assert.equal(checkpointPins[0].object_id, checkpoint.workspace.root_tree_id);
  assert.equal(checkpointPins[0].live, true);
  assert.equal(checkpointPins[0].covers_capability, true);
  console.log(
    JSON.stringify({
      test: "assigned_workspace_retention",
      status: "PASS",
      workspace_generation: next,
      live_base_pins: after.filter((row) => row.position === 0 && row.live)
        .length,
    }),
  );
} finally {
  for (const stage of stages)
    await fs.rm(stage, { recursive: true, force: true });
  await fs.rm(root, { recursive: true, force: true });
  await f.close();
  await resources.close();
}
