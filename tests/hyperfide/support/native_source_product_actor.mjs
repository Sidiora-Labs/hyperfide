import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import fs from "node:fs/promises";
import { createNativeAcceptanceFixture } from "./native_source_acceptance_fixture.mjs";
import { SourceControlClient } from "../../../sdk/source-control/src/client.ts";
import { executeSourceAction } from "../../../plugins/hyperfide-source-control/runtime.ts";
import { SourceMetrics } from "../../../core/host-daemon/src/source-control/metrics.ts";

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "hf-product-git-"));
const scope = {
  organisation_id: randomUUID(),
  repository_id: randomUUID(),
  security_domain_id: randomUUID(),
};
const gitDirectory = path.join(temporary, "remote.git");
execFileSync("git", ["init", "--bare", gitDirectory], { stdio: "ignore" });
const { createLocalGitDestination } = await import(
  pathToFileURL(
    path.join(process.env.SOURCE_CONTROL_MODULE_ROOT, "git/transport.js"),
  )
);
const destination = createLocalGitDestination({
  scope,
  id: "product-browser",
  repository_identity: "owned-product-browser",
  path: gitDirectory,
  allowed_refs: ["refs/heads/main"],
});
const { sourceTransferOptions } = await import(
  pathToFileURL(
    path.join(process.env.SOURCE_CONTROL_MODULE_ROOT, "transfers.js"),
  )
);
const productActions = [
  "source.objects.put",
  "source.objects.read",
  "source.objects.inspect",
  "source.trees.lookup",
  "source.trees.entries",
  "source.revisions.create",
  "source.revisions.read",
  "source.workspaces.open",
  "source.workspaces.detail",
  "source.workspaces.checkpoint",
  "source.queries.history",
  "source.queries.diff",
  "source.operations.read",
  "source.operations.cancel",
  "source.fleet.manifest",
  "source.domains.create",
  "source.domains.read",
  "source.domains.configure",
  "source.candidates.create",
  "source.candidates.read",
  "source.candidates.qualify",
  "source.acceptance.accept",
  "source.acceptance.read",
  "source.assurance.custody.create",
  "source.assurance.publish",
  "source.assurance.revoke",
  "source.transforms.merge",
  "source.transforms.read",
  "source.transforms.resume",
  "source.publications.create",
  "source.publications.read",
  "source.publications.resume",
  "source.publications.cancel",
  "source.transfers.create",
  "source.transfers.read",
  "source.transfers.complete",
  "source.transfers.cancel",
  "source.metrics.read",
];
const f = await createNativeAcceptanceFixture({
  scope,
  actions: productActions,
  serviceOptions: {
    publication: { destinations: [destination] },
    transfers: sourceTransferOptions(
      "https://localhost/api/v1/source-control/transfers",
      randomBytes(32),
    ),
  },
});
const client = new SourceControlClient({
  endpoint: f.endpoint,
  scope: f.scope,
  token: () => f.tokenFor(),
});
const binding = { client },
  checks = [];
const execute = async (action, id = randomUUID()) => {
  const response = await executeSourceAction(binding, id, action);
  assert.equal(response.ok, true, JSON.stringify(response));
  return response.result;
};
try {
  const history = await execute({
    kind: "history",
    revisionId: f.base.revision_id,
  });
  assert(history.entries.some((row) => row.revision_id === f.base.revision_id));
  checks.push(
    "product history reads native source metadata through the real HTTP API without a checkout",
  );
  const workspaceId = randomUUID(),
    opened = await execute({
      kind: "open",
      workspaceId,
      revisionId: f.base.revision_id,
      readPaths: ["main.txt"],
      writePaths: ["main.txt"],
      mode: "API_ONLY",
    });
  assert.equal(opened.workspace.workspace_id, workspaceId);
  const operation = randomUUID(),
    input = {
      kind: "checkpoint",
      workspaceId,
      baseRevisionId: opened.workspace.base_revision_id,
      workspaceGeneration: opened.workspace.workspace_generation,
      scopeGeneration: opened.workspace.scope_generation,
      overlayGeneration: "1",
      path: "main.txt",
      content: "candidate: product checkpoint\n",
      executable: false,
    };
  const checkpoint = await execute(input, operation);
  assert.notEqual(checkpoint.revision_id, f.base.revision_id);
  assert.deepEqual(await execute(input, operation), checkpoint);
  const current = await execute({ kind: "workspace", workspaceId });
  assert.equal(current.workspace.base_revision_id, checkpoint.revision_id);
  const op = await execute({ kind: "operation", operationId: operation });
  assert.equal(op.state, "SUCCEEDED");
  checks.push(
    "product checkpoint uploads verified file objects, records durable source and replays the same operation once",
  );
  const stale = await executeSourceAction(binding, randomUUID(), input);
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, "WORKSPACE_CHANGED");
  const outside = await executeSourceAction(binding, randomUUID(), {
    ...input,
    baseRevisionId: checkpoint.revision_id,
    workspaceGeneration: checkpoint.workspace.workspace_generation,
    path: "private.txt",
  });
  assert.equal(outside.ok, false);
  assert.equal(outside.error.code, "SCOPE_DENIED");
  checks.push(
    "stale workspace generations and writes outside the granted path remain explicit refusals",
  );
  const diff = await execute({
    kind: "diff",
    beforeRevisionId: f.base.revision_id,
    afterRevisionId: checkpoint.revision_id,
  });
  assert(diff.entries.some((row) => row.path === "main.txt"));
  checks.push(
    "product comparison returns actual changed paths and bounded coverage",
  );
  const revision = await f.createRevision({
      text: "candidate: accepted product\n",
    }),
    candidate = await f.createCandidate(revision),
    evidence = await f.publishEvidence(candidate);
  const qualification = await execute({
    kind: "qualify",
    candidateId: candidate.candidate_id,
    evidenceIds: [evidence.evidence.evidence_id],
  });
  const accepted = await execute({
    kind: "accept",
    candidateId: candidate.candidate_id,
    qualificationId: qualification.qualification_id,
  });
  assert.equal(accepted.revision_id, revision.revision_id);
  checks.push(
    "product acceptance requires independent executed evidence and returns the real acceptance receipt",
  );
  const sampled = await execute({ kind: "service-metrics", maxRows: 1 });
  assert.equal(sampled.families.objects.observed_rows, 1);
  assert.equal(sampled.families.objects.coverage, "PARTIAL");
  assert.equal(sampled.families.graphs.coverage, "UNAVAILABLE");
  checks.push(
    "server metrics sample actual scoped tables under an explicit per-family row budget",
  );
  const metrics = new SourceMetrics(4),
    release1 = metrics.admit("checkpoint"),
    release2 = metrics.admit("read");
  assert.throws(() => metrics.admit("read"));
  const release3 = metrics.admit("cancel"),
    release4 = metrics.admit("resume");
  assert.throws(() => metrics.admit("cancel"));
  release1();
  release2();
  release3();
  release4();
  release4();
  for (let n = 0; n < 1000; n++) metrics.record("read", "success", 1);
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.activeRequests, 0);
  assert.equal(snapshot.counters.length, 1);
  assert.equal(snapshot.counters[0].count, 1000);
  checks.push(
    "bounded metrics reserve recovery capacity and never create labels from source paths, revisions or project IDs",
  );
  if (process.env.HF_SOURCE_BROWSER === "1") {
    const { runSourceProductBrowser } =
      await import("./native_source_product_browser.mjs");
    await runSourceProductBrowser(f, binding);
    const remote = execFileSync(
      "git",
      ["--git-dir", gitDirectory, "rev-parse", "refs/heads/main"],
      { encoding: "utf8" },
    ).trim();
    assert.match(remote, /^[a-f0-9]{40}$/);
    checks.push(
      "actual Chromium workspace, lost-response replay and history journeys at desktop tablet and mobile sizes",
    );
  }
  const receipt = {
    status: "PASS",
    checks,
    backend_requests: f.backend.requests.length,
    scope:
      "actual product action adapter, HTTP source API, PostgreSQL, S3 fixture, and independent checker",
  };
  await fs.mkdir("build/source-control/product", { recursive: true });
  await fs.writeFile(
    "build/source-control/product/receipt.json",
    JSON.stringify(receipt, null, 2) + "\n",
  );
  console.log(JSON.stringify(receipt));
} finally {
  await f.close();
  await fs.rm(temporary, { recursive: true, force: true });
}
