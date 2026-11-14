import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createNativeAcceptanceFixture } from "./native_source_acceptance_fixture.mjs";
const root = process.env.SOURCE_CONTROL_MODULE_ROOT,
  load = (name) => import(pathToFileURL(path.join(root, name + ".js")));
const [
  { createLocalGitImportSource },
  { SourceGitProjector },
  { createLocalGitDestination },
  { SOURCE_ACTIONS },
  { SourceGitImporter },
] = await Promise.all([
  load("git/import_transport"),
  load("git/projection"),
  load("git/transport"),
  load("contracts"),
  load("git/import"),
]);
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "hf-git-import-")),
  scope = {
    organisation_id: randomUUID(),
    repository_id: randomUUID(),
    security_domain_id: randomUUID(),
  },
  checks = [];
const environment = {
  PATH: "/usr/bin:/bin",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Original Author",
  GIT_AUTHOR_EMAIL: "original@example.invalid",
  GIT_COMMITTER_NAME: "Original Committer",
  GIT_COMMITTER_EMAIL: "committer@example.invalid",
  GIT_AUTHOR_DATE: "1700000000 +0230",
  GIT_COMMITTER_DATE: "1700000001 -0100",
};
function git(directory, args, input) {
  const result = spawnSync("git", ["--git-dir=" + directory, ...args], {
    input,
    env: environment,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr?.toString());
  return result.stdout;
}
const raw = (oid) => oid.slice(9),
  oid = (raw) => "git:sha1:" + raw;
const repoA = path.join(temporary, "a.git"),
  repoB = path.join(temporary, "b.git"),
  exportRepo = path.join(temporary, "export.git");
for (const directory of [repoA, repoB, exportRepo])
  git(directory, ["init", "--bare"]);
const blob = (repo, value) =>
  git(repo, ["hash-object", "-w", "--stdin"], Buffer.from(value))
    .toString()
    .trim();
const tree = (repo, entries) =>
  git(
    repo,
    ["mktree", "-z"],
    Buffer.from(entries.map((e) => e.join(" ") + "\0").join("")),
  )
    .toString()
    .trim();
const entry = (mode, type, id, name) => [mode, type, id + "\t" + name];
const commit = (repo, tree, parents, message) =>
  git(
    repo,
    ["commit-tree", tree, ...parents.flatMap((p) => ["-p", p])],
    message,
  )
    .toString()
    .trim();
let fixture;
try {
  const shared = blob(repoA, "shared bytes\n"),
    secret = blob(repoA, "excluded original\n"),
    secret2 = blob(repoA, "excluded changed\n"),
    left = blob(repoA, "left\n"),
    right = blob(repoA, "right\n"),
    link = blob(repoA, "shared.txt");
  const project = tree(repoA, [
    entry("100644", "blob", shared, "shared.txt"),
    entry("100755", "blob", shared, "run.sh"),
    entry("120000", "blob", link, "link"),
  ]);
  const roots = [secret, secret2].map((value) =>
    tree(repoA, [
      entry("040000", "tree", project, "project"),
      entry("100644", "blob", value, "secret.txt"),
    ]),
  );
  const first = commit(repoA, roots[0], [], "original first\n"),
    hidden = commit(repoA, roots[1], [first], "excluded change\n");
  const branchRoot = (value) =>
    tree(repoA, [
      entry(
        "040000",
        "tree",
        tree(repoA, [
          entry("100644", "blob", shared, "shared.txt"),
          entry("100644", "blob", value, "branch.txt"),
        ]),
        "project",
      ),
    ]);
  const l = commit(repoA, branchRoot(left), [hidden], "left branch\n"),
    r = commit(repoA, branchRoot(right), [first], "right branch\n");
  const mergedProject = tree(repoA, [
    entry("100644", "blob", shared, "shared.txt"),
    entry("100644", "blob", left, "left.txt"),
    entry("100644", "blob", right, "right.txt"),
  ]);
  const merged = commit(
    repoA,
    tree(repoA, [entry("040000", "tree", mergedProject, "project")]),
    [l, r],
    "ordered merge\n",
  );
  const tagPayload = Buffer.from(
    "object " +
      merged +
      "\ntype commit\ntag v1.0.0\ntagger Release Owner <release@example.invalid> 1700000002 +0000\n\nrelease message\n",
  );
  const tag = git(
    repoA,
    ["hash-object", "-w", "-t", "tag", "--stdin"],
    tagPayload,
  )
    .toString()
    .trim();
  const sharedB = blob(repoB, "shared bytes\n"),
    bRoot = tree(repoB, [entry("100644", "blob", sharedB, "shared.txt")]),
    bCommit = commit(repoB, bRoot, [], "second repository\n");
  const sources = [
    createLocalGitImportSource({
      id: "a",
      scope,
      repository_identity: "repository-A",
      path: repoA,
    }),
    createLocalGitImportSource({
      id: "b",
      scope,
      repository_identity: "repository-B",
      path: repoB,
    }),
  ];
  const policy = {
    schema_version: 1,
    policy_id: randomUUID(),
    version: 1,
    project_id: "project-a",
    repository_identity: "public-project-a",
    mappings: [{ source_path: "project", target_path: "projects/a" }],
    dependencies: [],
    no_visible_change: "COLLAPSE_TO_FIRST_PARENT",
    merge_parents: "ORDERED_UNIQUE",
    public_metadata: "NATIVE_PUBLIC_V1",
    signature_policy: "PRESERVE_OBSERVATION",
    tag_signing: "REJECT",
    object_format: "sha1",
  };
  const exportPolicy = {
    ...policy,
    policy_id: randomUUID(),
    mappings: [{ source_path: "projects/a", target_path: "" }],
    no_visible_change: "COLLAPSE_TO_FIRST_PARENT",
  };
  const destination = {
    ...createLocalGitDestination({
      scope,
      id: "project-a",
      repository_identity: "public-project-a",
      path: exportRepo,
      allowed_refs: ["refs/heads/main"],
    }),
    projection_policy: exportPolicy,
  };
  fixture = await createNativeAcceptanceFixture({
    scope,
    actions: SOURCE_ACTIONS.filter((action) =>
      /^source\.(objects|uploads|trees|revisions|operations|domains|candidates|acceptance|assurance|publications|imports|projections|contributions|metrics)\./.test(
        action,
      ),
    ),
    serviceOptions: {
      imports: { sources },
      publication: { destinations: [destination] },
    },
  });
  const { client, service, context, pool } = fixture,
    importer = service.imports;
  assert(importer, "Production source service registers imports");
  const base = await fixture.createRevision({
    text: "candidate: imported native base\n",
    parent_revision_ids: [],
    message: "native baseline",
  });
  const createPolicy = (value) =>
    client.call("source.projections.create", value, {
      operation_id: randomUUID(),
    });
  const retained = await createPolicy(policy);
  assert.equal(
    (
      await client.call("source.projections.read", {
        policy_id: policy.policy_id,
        version: 1,
      })
    ).policy_digest,
    retained.policy_digest,
  );
  await assert.rejects(
    () => createPolicy({ ...policy, no_visible_change: "KEEP" }),
    (e) => e.code === "PROJECTION_POLICY_CONFLICT",
  );
  const changedPolicy = await createPolicy({
    ...policy,
    version: 2,
    no_visible_change: "KEEP",
  });
  assert.notEqual(changedPolicy.policy_digest, retained.policy_digest);
  checks.push(
    "immutable versioned policies reject changed content and preserve independent policy versions",
  );
  const budget = {
    max_commits: 1,
    max_objects: 256,
    max_bytes: 8 * 1024 * 1024,
    max_file_bytes: 4 * 1024 * 1024,
    max_depth: 64,
    max_total_commits: 256,
  };
  const input = {
    import_id: randomUUID(),
    source_id: "a",
    tip_oid: oid(tag),
    base_revision_id: base.revision_id,
    policy_id: policy.policy_id,
    policy_version: 1,
    budget,
  };
  const create = (value) =>
      client.call("source.imports.create", value, {
        operation_id: randomUUID(),
      }),
    resume = (id) =>
      client.call(
        "source.imports.resume",
        { import_id: id },
        { operation_id: randomUUID() },
      );
  const start = await create(input);
  assert.equal(start.state, "IMPORTING");
  assert.deepEqual(await create(input), start);
  const changedImporter = new SourceGitImporter(
    service.metadata,
    service.objects,
    service.trees,
    [{ ...sources[0], repository_identity: "changed-provider-repository" }],
  );
  await assert.rejects(
    () => changedImporter.resume(context, input.import_id),
    (e) => e.code === "SOURCE_IMPORT_CHANGED",
  );
  await assert.rejects(
    () => create({ ...input, tip_oid: oid(first) }),
    (e) => e.code === "IDEMPOTENCY_CONFLICT",
  );
  let state = start,
    rounds = 0;
  while (state.state === "IMPORTING") {
    state = await resume(input.import_id);
    assert(++rounds < 20);
  }
  assert.equal(state.state, "COMPLETE");
  assert(rounds > 1);
  assert.equal(state.metrics.new_authored_commits, 0);
  assert.equal(state.metrics.imported_commits, 4);
  assert.equal(state.metrics.collapsed_commits, 1);
  assert.equal(state.metrics.historical_commits, 5);
  assert.equal(state.metrics.historical_revisions, 4);
  assert.equal(state.metrics.mapped_commits, 0);
  assert.equal(state.metrics.new_authored_revisions, 0);
  assert.deepEqual(await resume(input.import_id), state);
  const pages = [];
  let after;
  do {
    const page = await client.call("source.imports.mappings", {
      import_id: input.import_id,
      limit: 2,
      ...(after ? { after } : {}),
    });
    pages.push(...page.mappings);
    after = page.next_cursor;
  } while (after);
  assert.equal(pages.length, 5);
  assert.equal(
    pages.find((m) => m.git_oid === oid(hidden)).revision_id,
    pages.find((m) => m.git_oid === oid(first)).revision_id,
  );
  const mergeMap = pages.find((m) => m.git_oid === oid(merged));
  assert.deepEqual(mergeMap.ordered_parent_oids, [oid(l), oid(r)]);
  const native = await service.metadata.readRevision(
    context,
    state.revision_id,
  );
  assert.deepEqual(native.parent_revision_ids, [
    pages.find((m) => m.git_oid === oid(l)).revision_id,
    pages.find((m) => m.git_oid === oid(r)).revision_id,
  ]);
  const file = await service.trees.lookup(
    scope,
    native.root_tree_id,
    "projects/a/shared.txt",
  );
  assert.equal(
    (await service.objects.readFile(scope, file.object_id)).toString(),
    "shared bytes\n",
  );
  assert.equal(
    await service.trees.lookup(scope, native.root_tree_id, "secret.txt"),
    null,
  );
  checks.push(
    "resumed bounded Git history preserves ordered merge parents, filters excluded changes and records original-to-native mappings",
  );
  const firstNative = await service.metadata.readRevision(
    context,
    pages.find((m) => m.git_oid === oid(first)).revision_id,
  );
  assert.equal(
    (
      await service.trees.lookup(
        scope,
        firstNative.root_tree_id,
        "projects/a/run.sh",
      )
    ).mode,
    "100755",
  );
  const symbolic = await service.trees.lookup(
    scope,
    firstNative.root_tree_id,
    "projects/a/link",
  );
  assert.equal(symbolic.mode, "120000");
  assert.equal(
    (await service.objects.read(scope, symbolic.object_id)).payload.toString(),
    "shared.txt",
  );
  const archive = (
    await pool.query(
      "SELECT archive_object_id FROM hyperfide.source_git_import_objects WHERE import_id=$1 AND git_oid=$2",
      [input.import_id, oid(tag)],
    )
  ).rows[0];
  assert.deepEqual(
    await service.objects.readFile(scope, archive.archive_object_id),
    Buffer.concat([Buffer.from("tag " + tagPayload.length + "\0"), tagPayload]),
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM hyperfide.source_object_pins WHERE object_id=$1 AND owner_kind='HOLD' AND owner_id=$2",
        [
          archive.archive_object_id,
          "git-import:" + input.import_id + ":" + oid(tag),
        ],
      )
    ).rows[0].n,
    1,
  );
  checks.push(
    "executable modes, symlink bytes and exact original annotated tag archives survive import",
  );
  const projected = await importer.projectTag(
    context,
    input.import_id,
    oid(tag),
    {
      policy: exportPolicy,
      authorize_revision: async (revision) => {
        await service.metadata.readRevision(context, revision.revision_id);
      },
      authorize_path: async (p) => {
        assert.equal(p, "projects/a");
      },
    },
  );
  for (const object of [...projected.objects, projected.tag]) {
    const bytes = [];
    for await (const chunk of object.content()) bytes.push(chunk);
    assert.equal(
      git(
        exportRepo,
        ["hash-object", "-w", "-t", object.kind, "--stdin"],
        Buffer.concat(bytes),
      )
        .toString()
        .trim(),
      raw(object.oid),
    );
  }
  const tagRead = git(exportRepo, [
    "cat-file",
    "tag",
    raw(projected.tag_oid),
  ]).toString();
  assert(
    tagRead.includes(
      "tagger Release Owner <release@example.invalid> 1700000002 +0000\n\nrelease message\n",
    ),
  );
  assert(tagRead.startsWith("object " + raw(projected.head_oid) + "\n"));
  git(exportRepo, ["update-ref", "refs/tags/v1.0.0", raw(projected.tag_oid)]);
  git(exportRepo, ["fsck", "--full", "--strict"]);
  const tagRemote = path.join(temporary, "tag-remote.git");
  git(tagRemote, ["init", "--bare"]);
  const tagDestination = createLocalGitDestination({
    scope,
    id: "tags",
    repository_identity: "tags",
    path: tagRemote,
    allowed_refs: ["refs/tags/v1.0.0"],
  });
  const pushedTag = await tagDestination.transport.push({
    target_ref: "refs/tags/v1.0.0",
    expected_old_oid: null,
    new_oid: projected.tag_oid,
    objects: [...projected.objects, projected.tag],
  });
  assert.equal(pushedTag.outcome, "ACCEPTED");
  assert.equal(
    git(tagRemote, ["rev-parse", "refs/tags/v1.0.0"]).toString().trim(),
    raw(projected.tag_oid),
  );
  checks.push(
    "projected annotated tags preserve tagger time/message and point to the exact projected commit",
  );
  let acceptedHead;
  for (const revisionId of new Set([
    base.revision_id,
    ...pages.map((p) => p.revision_id),
  ])) {
    const revision = await service.metadata.readRevision(context, revisionId),
      change = (
        await pool.query(
          "SELECT change_id FROM hyperfide.source_change_revisions WHERE revision_id=$1",
          [revisionId],
        )
      ).rows[0];
    const candidate = await fixture.createCandidate(
      { ...revision, change_id: change.change_id },
      { domain: await fixture.createDomain(revision) },
    );
    const acceptance = await fixture.accept(candidate);
    if (revisionId === state.revision_id) acceptedHead = acceptance;
  }
  const publication = await client.call(
    "source.publications.create",
    {
      acceptance_id: acceptedHead.acceptance_id,
      destination_id: "project-a",
      target_ref: "refs/heads/main",
      expected_old_oid: null,
    },
    { operation_id: randomUUID() },
  );
  const published = await client.call(
    "source.publications.resume",
    { operation_id: publication.operation_id },
    { operation_id: randomUUID() },
  );
  assert.equal(published.status, "PUBLISHED");
  assert.equal(
    git(exportRepo, ["show", "refs/heads/main:shared.txt"]).toString(),
    "shared bytes\n",
  );
  assert.equal(
    git(exportRepo, ["ls-tree", "--name-only", "refs/heads/main"])
      .toString()
      .includes("projects"),
    false,
  );
  checks.push(
    "accepted imported history publishes through the configured project policy and real receive-pack transport",
  );
  const policyB = {
    ...policy,
    policy_id: randomUUID(),
    project_id: "project-b",
    mappings: [{ source_path: "", target_path: "projects/b" }],
  };
  await createPolicy(policyB);
  const bInput = {
    ...input,
    import_id: randomUUID(),
    source_id: "b",
    tip_oid: oid(bCommit),
    policy_id: policyB.policy_id,
  };
  await create(bInput);
  let bState;
  do {
    bState = await resume(bInput.import_id);
  } while (bState.state === "IMPORTING");
  assert.equal(bState.state, "COMPLETE");
  const bNative = await service.metadata.readRevision(
      context,
      bState.revision_id,
    ),
    bFile = await service.trees.lookup(
      scope,
      bNative.root_tree_id,
      "projects/b/shared.txt",
    );
  assert.equal(bFile.object_id, file.object_id);
  checks.push(
    "two independent Git repositories retain separate provenance while shared bytes deduplicate in the authorized native scope",
  );
  const emptyEmailCommit = git(
    repoA,
    ["hash-object", "-w", "-t", "commit", "--stdin"],
    Buffer.from(
      "tree " +
        roots[0] +
        "\nauthor Hyperfide <> 1700000000 +0000\ncommitter Hyperfide <> 1700000000 +0000\n\nNative empty-email provenance\n",
    ),
  )
    .toString()
    .trim();
  git(repoA, ["fsck", "--strict", emptyEmailCommit]);
  const emptyEmailInput = {
    ...input,
    import_id: randomUUID(),
    tip_oid: oid(emptyEmailCommit),
  };
  await create(emptyEmailInput);
  let emptyEmail;
  do {
    emptyEmail = await resume(emptyEmailInput.import_id);
  } while (emptyEmail.state === "IMPORTING");
  assert.equal(emptyEmail.state, "COMPLETE");
  assert.deepEqual(
    (await service.metadata.readRevision(context, emptyEmail.revision_id))
      .descriptor.provenance.author,
    { name: "Hyperfide", email: "" },
  );
  checks.push(
    "actual Git accepts empty-email identities and import preserves their exact native author provenance",
  );

  const contributionDomain = await fixture.createDomain(base);
  const candidateRequest = (domain) => ({
    domain_id: domain.domain_id,
    expected_generation: domain.generation,
    expected_revision_id: domain.revision_id,
    dependencies: [],
    inputs: {
      toolchain: fixture.check.executable_digest,
      configuration: fixture.sourceDigest(fixture.environment),
      graph: fixture.sourceDigest("import-graph-v1"),
      contract: fixture.sourceDigest("import-contract-v1"),
    },
    transformation_version: "git-import-candidate-v1",
  });
  const contribution = {
    ...input,
    import_id: randomUUID(),
    contribution_id: randomUUID(),
    provider: "github",
    provider_identity: "repository-A/pull/17",
    tip_oid: oid(l),
    candidate: candidateRequest(contributionDomain),
  };
  const intake = await importer.createContribution(context, contribution);
  assert.equal(intake.candidate_id, null);
  assert.equal(intake.acceptance, "NOT_GRANTED");
  let contributed;
  do {
    contributed = await resume(contribution.import_id);
  } while (contributed.state === "IMPORTING");
  assert.equal(contributed.state, "COMPLETE");
  const proposal = await client.call("source.contributions.read", {
    contribution_id: contribution.contribution_id,
  });
  assert.equal(proposal.state, "PROPOSED");
  assert.equal(proposal.acceptance, "NOT_GRANTED");
  assert.equal(proposal.candidate.revision_id, contributed.revision_id);
  assert.deepEqual(
    fixture.canonicalBytes(proposal.candidate.scope),
    fixture.canonicalBytes(scope),
  );
  assert.deepEqual(
    await client.call("source.candidates.read", {
      candidate_id: proposal.candidate_id,
    }),
    proposal.candidate,
  );
  assert.deepEqual(
    fixture.canonicalBytes(
      await importer.createContribution(context, contribution),
    ),
    fixture.canonicalBytes(proposal),
  );
  assert.deepEqual(
    await client.call("source.contributions.read", {
      contribution_id: contribution.contribution_id,
    }),
    proposal,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM hyperfide.source_native_candidates WHERE candidate_id=$1",
        [proposal.candidate_id],
      )
    ).rows[0].n,
    1,
  );
  const importedQualification = await fixture.qualify(proposal.candidate);
  const importedAcceptance = await fixture.accept(
    proposal.candidate,
    importedQualification,
  );
  assert.equal(importedAcceptance.revision_id, contributed.revision_id);
  const acceptedProposal = await client.call("source.contributions.read", {
    contribution_id: contribution.contribution_id,
  });
  assert.equal(acceptedProposal.acceptance, "GRANTED");
  assert.equal(
    acceptedProposal.acceptance_id,
    importedAcceptance.acceptance_id,
  );
  assert.equal(
    (await importer.createContribution(context, contribution)).candidate_id,
    proposal.candidate_id,
  );
  await assert.rejects(
    () =>
      importer.createContribution(context, {
        ...contribution,
        tip_oid: oid(r),
      }),
    (e) => e.code === "IDEMPOTENCY_CONFLICT",
  );
  const advanced = commit(
    repoA,
    branchRoot(blob(repoA, "changed contribution tip\n")),
    [l],
    "contribution advanced\n",
  );
  const advancedDomain = await client.call("source.domains.read", {
    domain_id: contributionDomain.domain_id,
  });
  const advancedInput = {
    ...contribution,
    import_id: randomUUID(),
    contribution_id: randomUUID(),
    tip_oid: oid(advanced),
    candidate: candidateRequest(advancedDomain),
  };
  await importer.createContribution(context, advancedInput);
  let advancedState;
  do {
    advancedState = await resume(advancedInput.import_id);
  } while (advancedState.state === "IMPORTING");
  assert.equal(advancedState.state, "COMPLETE");
  const advancedProposal = await client.call("source.contributions.read", {
    contribution_id: advancedInput.contribution_id,
  });
  assert.equal(advancedProposal.state, "PROPOSED");
  assert.notEqual(advancedProposal.candidate_id, proposal.candidate_id);
  assert.notEqual(advancedProposal.revision_id, proposal.revision_id);
  assert.equal(advancedProposal.provider_identity, proposal.provider_identity);
  assert.equal(advancedProposal.acceptance, "NOT_GRANTED");
  assert.equal(
    (
      await client.call("source.contributions.read", {
        contribution_id: contribution.contribution_id,
      })
    ).revision_id,
    proposal.revision_id,
  );
  assert.equal(
    (await service.metadata.readRevision(context, advancedProposal.revision_id))
      .parent_revision_ids[0],
    proposal.revision_id,
  );
  const completedDomain = await fixture.createDomain(base);
  const completedContribution = {
    ...contribution,
    ...emptyEmailInput,
    contribution_id: randomUUID(),
    provider: "gitlab",
    provider_identity: "repository-A/merge_requests/18",
    candidate: candidateRequest(completedDomain),
  };
  const completedProposal = await importer.createContribution(
    context,
    completedContribution,
  );
  assert.equal(completedProposal.state, "PROPOSED");
  assert.equal(completedProposal.candidate.revision_id, emptyEmail.revision_id);
  assert.equal(completedProposal.acceptance, "NOT_GRANTED");
  assert.deepEqual(
    fixture.canonicalBytes(
      await client.call("source.candidates.read", {
        candidate_id: completedProposal.candidate_id,
      }),
    ),
    fixture.canonicalBytes(completedProposal.candidate),
  );
  await assert.rejects(
    () =>
      importer.createContribution(context, {
        ...contribution,
        contribution_id: randomUUID(),
        candidate: { ...contribution.candidate, domain_id: randomUUID() },
      }),
    (e) => e.code === "NOT_FOUND",
  );
  checks.push(
    "pinned contribution intake creates immutable proposals and requires ordinary acceptance",
  );
  checks.push(
    "imported contributions create idempotent native candidates, qualify and accept with actual checker evidence, and changed provider tips create distinct immutable candidates and revisions",
  );

  const collapsedMerge = commit(
    repoA,
    roots[1],
    [first, hidden],
    "merge with excluded second side\n",
  );
  const mergeInput = {
    ...input,
    import_id: randomUUID(),
    tip_oid: oid(collapsedMerge),
  };
  await create(mergeInput);
  let mergeState;
  do {
    mergeState = await resume(mergeInput.import_id);
  } while (mergeState.state === "IMPORTING");
  assert.equal(mergeState.state, "COMPLETE");
  const collapsedMappings = (
    await client.call("source.imports.mappings", {
      import_id: mergeInput.import_id,
    })
  ).mappings;
  const collapsedMapping = collapsedMappings.find(
    (value) => value.git_oid === oid(collapsedMerge),
  );
  assert.deepEqual(collapsedMapping.ordered_parent_oids, [
    oid(first),
    oid(hidden),
  ]);
  assert.equal(collapsedMapping.disposition, "COLLAPSED");
  assert.equal(collapsedMapping.revision_id, firstNative.revision_id);
  assert.equal(mergeState.metrics.collapsed_commits, 2);
  assert.deepEqual(
    (await service.metadata.readRevision(context, mergeState.revision_id))
      .parent_revision_ids,
    [base.revision_id],
  );
  const keptInput = {
    ...mergeInput,
    import_id: randomUUID(),
    policy_version: 2,
  };
  await create(keptInput);
  let keptState;
  do {
    keptState = await resume(keptInput.import_id);
  } while (keptState.state === "IMPORTING");
  assert.equal(keptState.state, "COMPLETE");
  const keptMappings = (
    await client.call("source.imports.mappings", {
      import_id: keptInput.import_id,
    })
  ).mappings;
  const keptMerge = await service.metadata.readRevision(
    context,
    keptState.revision_id,
  );
  assert.equal(keptMerge.parent_revision_ids.length, 2);
  const collapsedProjection = await new SourceGitProjector(
    service.objects,
    service.trees,
    service.metadata,
  ).project(context, keptState.revision_id, {
    policy: exportPolicy,
    authorize_revision: async (revision) => {
      await service.metadata.readRevision(context, revision.revision_id);
    },
    authorize_path: async (selected) => assert.equal(selected, "projects/a"),
  });
  const projectedFirst = collapsedProjection.mappings.find(
    (value) =>
      value.native_kind === "revision" &&
      value.native_id ===
        keptMappings.find((value) => value.git_oid === oid(first)).revision_id,
  );
  assert.equal(collapsedProjection.head_oid, projectedFirst.git_oid);
  assert.equal(
    collapsedProjection.mappings.find(
      (value) => value.native_id === keptState.revision_id,
    ).disposition,
    "COLLAPSED",
  );
  const projectedFirstObject = collapsedProjection.objects.find(
      (value) => value.oid === collapsedProjection.head_oid,
    ),
    projectedChunks = [];
  for await (const chunk of projectedFirstObject.content())
    projectedChunks.push(chunk);
  assert.equal(
    Buffer.concat(projectedChunks)
      .toString()
      .split("\n")
      .filter((line) => line.startsWith("parent ")).length,
    1,
  );
  checks.push(
    "excluded merge sides collapse to one ordered native and projected parent without retaining a redundant merge commit",
  );

  const legacyInput = { ...input, import_id: randomUUID(), tip_oid: oid(l) };
  await create(legacyInput);
  const legacyMap = {
    schema_version: 1,
    mappings: [{ git_oid: oid(first), revision_id: firstNative.revision_id }],
  };
  await assert.rejects(
    () =>
      importer.importLegacyMap(context, legacyInput.import_id, {
        schema_version: 1,
        mappings: [{ git_oid: first, revision_id: firstNative.revision_id }],
      }),
    (e) => e.code === "INVALID_GIT_OBJECT",
  );
  await assert.rejects(
    () =>
      importer.importLegacyMap(context, legacyInput.import_id, {
        schema_version: 1,
        mappings: [{ git_oid: oid(first), revision_id: base.revision_id }],
      }),
    (e) => e.code === "LEGACY_MAPPING_MISMATCH",
  );
  await assert.rejects(
    () =>
      importer.importLegacyMap(context, legacyInput.import_id, {
        schema_version: 1,
        mappings: [
          { git_oid: oid(first), revision_id: "sha256:" + "f".repeat(64) },
        ],
      }),
    (e) => e.code === "NOT_FOUND",
  );
  await assert.rejects(
    () =>
      importer.importLegacyMap(context, legacyInput.import_id, {
        schema_version: 1,
        mappings: Array.from({ length: 257 }, () => legacyMap.mappings[0]),
      }),
    (e) => e.code === "INVALID_REQUEST",
  );
  assert.equal(
    (
      await client.call("source.imports.mappings", {
        import_id: legacyInput.import_id,
      })
    ).mappings.length,
    0,
  );
  const legacyReceipt = await importer.importLegacyMap(
    context,
    legacyInput.import_id,
    legacyMap,
  );
  assert.equal(legacyReceipt.inserted_commits, 1);
  assert.equal(
    (await importer.importLegacyMap(context, legacyInput.import_id, legacyMap))
      .inserted_commits,
    0,
  );
  assert.equal(
    (
      await client.call("source.imports.read", {
        import_id: legacyInput.import_id,
      })
    ).metrics.mapped_commits,
    1,
  );
  const restartedImporter = new SourceGitImporter(
    service.metadata,
    service.objects,
    service.trees,
    sources,
  );
  let legacyState,
    legacyRounds = 0;
  do {
    legacyState = await restartedImporter.resume(
      context,
      legacyInput.import_id,
    );
    assert(++legacyRounds < 10);
  } while (legacyState.state === "IMPORTING");
  assert.equal(legacyState.state, "COMPLETE");
  assert.equal(
    legacyState.revision_id,
    pages.find((value) => value.git_oid === oid(l)).revision_id,
  );
  const legacyMappings = (
    await client.call("source.imports.mappings", {
      import_id: legacyInput.import_id,
    })
  ).mappings;
  assert.equal(
    legacyMappings.find((value) => value.git_oid === oid(first)).disposition,
    "MAPPED",
  );
  assert.equal(
    legacyMappings.find((value) => value.git_oid === oid(first)).revision_id,
    firstNative.revision_id,
  );
  assert.equal(legacyState.metrics.imported_commits, 1);
  assert.equal(legacyState.metrics.historical_revisions, 1);
  assert.equal(legacyState.metrics.historical_commits, 3);
  assert.equal(legacyState.metrics.mapped_commits, 1);
  assert.equal(legacyState.metrics.new_authored_revisions, 0);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM hyperfide.source_git_import_objects WHERE import_id=$1 AND git_oid=$2",
        [legacyInput.import_id, oid(first)],
      )
    ).rows[0].n,
    0,
  );
  assert.deepEqual(
    await restartedImporter.resume(context, legacyInput.import_id),
    legacyState,
  );
  assert.equal(
    (
      await restartedImporter.importLegacyMap(
        context,
        legacyInput.import_id,
        legacyMap,
      )
    ).inserted_commits,
    0,
  );
  checks.push(
    "bounded legacy maps validate actual original/native tree pairs atomically, survive importer restart and resume without reimporting mapped commits",
  );
  const serverMetrics = await client.call("source.metrics.read", {
    max_rows: 256,
  });
  assert.equal(serverMetrics.families.imports.coverage, "COMPLETE");
  assert(
    serverMetrics.families.imports.ingestion.historical_commits >
      serverMetrics.families.imports.ingestion.historical_revisions,
  );
  assert.equal(serverMetrics.families.imports.ingestion.mapped_commits, 1);
  assert.equal(
    serverMetrics.families.imports.ingestion.new_authored_revisions,
    0,
  );
  assert.equal(
    serverMetrics.families.imports.states.COMPLETE,
    serverMetrics.families.imports.observed_rows,
  );
  checks.push(
    "import receipts and scoped server metrics distinguish historical ingestion, reused legacy mappings and new authored revisions",
  );
  const badRoot = tree(repoA, [entry("160000", "commit", first, "submodule")]),
    bad = commit(repoA, badRoot, [], "unsupported gitlink\n");
  const fullPolicy = {
    ...policy,
    policy_id: randomUUID(),
    mappings: [{ source_path: "", target_path: "bad" }],
  };
  await createPolicy(fullPolicy);
  const badInput = {
    ...input,
    import_id: randomUUID(),
    tip_oid: oid(bad),
    policy_id: fullPolicy.policy_id,
  };
  await create(badInput);
  const blocked = await resume(badInput.import_id);
  assert.equal(blocked.state, "BLOCKED");
  assert.equal(blocked.diagnostic.code, "GIT_ENTRY_UNSUPPORTED");
  assert.equal(blocked.revision_id, null);
  await assert.rejects(
    () => create({ ...input, import_id: randomUUID(), source_id: "/etc" }),
    (e) => e.code === "SOURCE_IMPORT_DENIED",
  );
  const privateProjection = new SourceGitProjector(
    service.objects,
    service.trees,
    service.metadata,
  );
  await assert.rejects(
    () =>
      privateProjection.project(context, state.revision_id, {
        policy: exportPolicy,
        authorize_revision: async () => {},
        authorize_path: async () => {
          throw new Error("path denied");
        },
      }),
    /path denied/,
  );
  const lfs = blob(
      repoA,
      "version https://git-lfs.github.com/spec/v1\noid sha256:" +
        "a".repeat(64) +
        "\nsize 3\n",
    ),
    caseBlob = blob(repoA, "case");
  const failures = [
    [
      commit(
        repoA,
        tree(repoA, [entry("100644", "blob", lfs, "payload")]),
        [],
        "lfs pointer\n",
      ),
      "GIT_LFS_UNSUPPORTED",
    ],
    [
      commit(
        repoA,
        tree(repoA, [
          entry("100644", "blob", caseBlob, "Case"),
          entry("100644", "blob", caseBlob, "case"),
        ]),
        [],
        "case collision\n",
      ),
      "GIT_TREE_INVALID",
    ],
    [
      git(
        repoA,
        ["hash-object", "-w", "-t", "tag", "--stdin"],
        Buffer.concat([
          tagPayload,
          Buffer.from("-----BEGIN PGP SIGNATURE-----\nunverified\n"),
        ]),
      )
        .toString()
        .trim(),
      "GIT_SIGNATURE_UNSUPPORTED",
    ],
  ];
  for (const [tip, code] of failures) {
    const failedInput = {
      ...input,
      import_id: randomUUID(),
      tip_oid: oid(tip),
      policy_id: fullPolicy.policy_id,
    };
    await create(failedInput);
    let failed;
    do {
      failed = await resume(failedInput.import_id);
    } while (failed.state === "IMPORTING");
    assert.equal(failed.state, "BLOCKED");
    assert.equal(failed.diagnostic.code, code);
  }
  const collisionPolicy = {
    ...fullPolicy,
    policy_id: randomUUID(),
    mappings: [{ source_path: "", target_path: "main.txt" }],
  };
  await createPolicy(collisionPolicy);
  await assert.rejects(
    () =>
      create({
        ...input,
        import_id: randomUUID(),
        policy_id: collisionPolicy.policy_id,
      }),
    (e) => e.code === "IMPORT_TARGET_COLLISION",
  );
  checks.push(
    "unsupported entries and unauthorized source/path access fail before a complete import or projection",
  );
  const receipt = {
    status: "PASS",
    checks,
    backend_requests: fixture.backend.requests.length,
    imported_commits: state.metrics.imported_commits,
    collapsed_commits: state.metrics.collapsed_commits,
    resume_rounds: rounds,
  };
  const output =
    process.env.HYPERFIDE_SOURCE_EVIDENCE_DIR ?? "build/source-control/5.2";
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(
    output + "/receipt.json",
    JSON.stringify(receipt, null, 2) + "\n",
  );
  console.log(JSON.stringify(receipt));
} finally {
  await fixture?.close();
  await fs.rm(temporary, { recursive: true, force: true });
}
