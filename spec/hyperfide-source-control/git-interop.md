# Git remote interoperability

Status: proposed implementation contract. Product verification is UNRUN. The native requirements and pending tasks are in [spec.kvx](spec.kvx), requirements 9 and 10; acceptance and evidence rules are in [protocol.md](protocol.md). This document specifies the remote boundary without introducing Git objects, refs, packs, worktrees or subprocesses into native revision creation.

## 1. Existing implementation and transition boundary

At the authoring baseline, [integration/publication.ts](https://github.com/Sidiora-Labs/hyperfide/blob/2f7331ef2085f6f374adf2d1e2ee01405fecb72d/services/hyperfide/src/integration/publication.ts) persists publication intents and per-target locks, validates operation and branch generations, and reconciles uncertain remote results. [integration/github.ts](https://github.com/Sidiora-Labs/hyperfide/blob/2f7331ef2085f6f374adf2d1e2ee01405fecb72d/services/hyperfide/src/integration/github.ts) inspects GitHub protection, issues scoped credentials and retains credential cleanup evidence, but publishes from a local Git repository. [the platform publisher](https://github.com/Sidiora-Labs/hyperfide/blob/2f7331ef2085f6f374adf2d1e2ee01405fecb72d/platform/plugins/hyperfide-qualify/publication.ts) assembles full Git worktrees, squashes task commits and requires an absolute local bare remote. [the GitHub wave interface](https://github.com/Sidiora-Labs/hyperfide/blob/2f7331ef2085f6f374adf2d1e2ee01405fecb72d/platform/plugins/github/wave-publication.ts) creates a pull request after publication. These are inspected code seams, not evidence that the proposed native exporter or GitLab adapter exists.

The new implementation keeps authenticated authorization, exact intent binding, expected remote-head checks, uncertain-outcome reconciliation and historical receipts. It replaces the local source repository/worktree requirement with bounded traversal of native objects and generated Git object streams. The existing source-to-task proof chain migrates explicitly; a Git publication receipt does not become proof of native task qualification.

## 2. Projection identity and publication intent

A projection is a versioned, authorized mapping from one native repository into one remote Git repository. Project ownership and export scope do not define storage shards. An allowlisted projection contains:

| Field | Meaning |
|---|---|
| `projection_id`, `policy_version`, `policy_digest` | Stable identity and immutable policy version used to construct the exported history |
| `repository_id`, `root_mapping`, `path_policy_digest` | Native input and authorized source roots mapped into the remote namespace |
| `destination_id`, `provider`, `remote_repository_identity`, `target_ref` | Credential profile and exact destination, including stable provider repository identity |
| `git_object_format`, `history_policy`, `grouping_policy` | Explicit SHA-1/SHA-256 Git format, ancestry projection and commit grouping |
| `metadata_policy_digest`, `dependency_policy_digest` | Public authorship/message schema and treatment of dependencies outside the selected roots |

Names are proposed API fields. Credentials are references to the configured secret service and never projection metadata values. Changing path mappings, object format, ancestry treatment or commit metadata creates a new policy version. It never silently rewrites the existing published history.

An export intent pins the projection version, ordered native acceptance records, exact resulting source snapshot, grouping boundaries, expected previous export checkpoint, expected remote ref value, generated target Git object ID, authorization generation and idempotency identity. Grouping defaults to one public commit per accepted logical task/change, dispatched together at a configured wave boundary; checkpoints remain internal. A taskless accepted change has an explicit grouping identity. Other policies require a versioned projection choice, including the desired public provenance granularity.

Native IDs use `sha256:<64hex>`. Git IDs are namespaced as `git:sha1:<40hex>` or `git:sha256:<64hex>` and validated against the destination format. A native tree, a Git tree and a Git commit remain distinct types even if their digest strings have equal lengths.

## 3. Deterministic object construction

Export constructs blobs from exact file bytes, and Git trees from the projected paths, entry types, executable modes and child Git object IDs. Regular files and executable files map to modes 100644 and 100755; symlink target bytes map to mode 120000 without dereferencing the link. Gitlink mode 160000 requires an explicitly pinned external Git commit mapping and remains rejected until that capability is qualified. Device nodes, sockets, unsafe paths and unrepresentable native entry types fail with a path-specific diagnostic rather than disappearing.

The projection path policy uses the native canonical path representation. Legacy non-UTF-8 Git paths are preserved in import archives and reported; activation of an affected projection is rejected until a reversible, collision-free mapping is selected and qualified. Export must never replace undecodable bytes, normalize distinct paths into one, or follow symlinks while constructing source trees. Empty directories have no Git representation; their omission is recorded in the projection report, and a project requiring them must provide an explicit source placeholder policy.

Commit serialization pins tree ID, ordered parent IDs, author/committer names and addresses allowed by the public metadata schema, integer timestamps with timezone offsets, message bytes and encoding policy. Values derived at intent creation, such as a publication committer timestamp, are persisted once and reused on retry. Traversal order, retry time, worker identity and transient pack layout cannot change a generated commit ID. Native private task packets, session metadata, memory, credentials and conversation contents are outside the export schema; the public message and optional provenance trailer are explicit allowlisted fields.

The durable mapping key is `(organization, repository, projection_id, policy_version, native_revision_or_group_id, git_object_format)`. Its value records projected tree/commit IDs, parent mapping, metadata policy and the construction manifest digest. Native source history is not keyed by Git IDs. Mappings and accepted export checkpoints are retention roots.

### Filtered history, merges and tags

An ordinary revision whose projected tree is unchanged maps to its preceding visible projected commit, with `NO_VISIBLE_CHANGE` provenance; it does not emit an arbitrary empty commit. A merge with two or more distinct projected parent commits preserves their order and emits a merge commit under the default `PRESERVE_PROJECTED_MERGES` policy even when its tree matches its first parent. Duplicate projected parents collapse deterministically. A merge reduced to one distinct projected parent with no visible tree change maps to that parent. The mapping retains every original native parent and the reason for collapse so ancestry queries can distinguish native and projected history.

A projection may choose an explicit linear task-publication policy instead; that policy maps grouped native revisions to a linear public parent chain and never claims that the public Git graph reproduces native merge ancestry. The policy choice is fixed before initial publication.

Named releases/tags are optional export targets. An annotated tag pins target mapping, public tagger metadata, message bytes and signature policy. A filtered target resolves through its recorded projected mapping; an absent or ambiguous target fails rather than retargeting to current head. Native signatures do not become valid Git signatures. Original imported signed object bytes and verification observations remain historical records; newly generated commits/tags require new configured signing or an explicit unsigned policy. Tag replacement and deletion require separate authorized intents.

## 4. Bounded transport and state machine

Initial export can traverse the complete authorized projection, but keeps bounded pages, memory and spool segments; it does not create a full checkout or retain a full Git clone. Incremental export reuses native/Git mappings and fetches only objects required by the destination. A changed entry in a huge Git directory can require reconstructing that directory's Git tree: this compatibility cost has its own budget and cannot force native commits to adopt Git's tree representation.

The native store contains no Git packfiles. The adapter emits a transient Git pack stream because Git remote transport requires that format. The first implementation may emit ordinary non-delta objects to keep generation deterministic and memory bounded; pack encoding is independent of object identity. Optional delta encoding requires its own measured bound. Spool files are explicit operation artifacts with size, ownership and retention limits. No native repack cycle, full-history checkout or mandatory shared Git object directory is introduced.

The proposed states are:

`QUEUED -> PREPARING -> READY -> SENDING -> PUBLISHED`

with `BLOCKED_POLICY`, `REMOTE_DIVERGED`, `RETRYABLE` and `OUTCOME_UNKNOWN` observations. Native `ACCEPTED` is a separate fact and remains valid while a remote is unavailable. A remote destination cannot backpressure native revision creation except through an explicitly configured publication backlog/retention budget; it may delay a release that requires that destination's receipt.

1. Persist an intent and retention roots before generating or sending external objects. Read the current destination identity, capabilities and protection profile. Reject a changed repository identity or unauthorized target.
2. Validate exact native acceptance/evidence inputs and current export authorization, then finish the deterministic object construction manifest. Avoid a database transaction around storage downloads or transport.
3. Admit at most one unresolved mutation per destination/ref. Check expected old ref and generated ancestry; publish using the protocol's exact old/new/ref update precondition. Expected-old matching alone does not authorize non-fast-forward replacement.
4. Persist transport identity, credential lifetime and generation before sending. Credentials are least-scope, bounded-lifetime and unavailable to agent workspaces. Cancellation after dispatch requests reconciliation; it does not claim to retract an issued remote effect.
5. Verify the remote result and settle the durable receipt. Retain cleanup debt until credential revocation/expiry and operation cleanup are established. A crash after remote acceptance is reconciled from the same immutable intent.

A timeout or lost response enters `OUTCOME_UNKNOWN`. Observing the expected old head does not prove an already-issued push has stopped. The destination/ref remains fenced until transport and credential effects are settled. Observing the exact generated commit establishes an external source outcome only when bound to the admitted intent; observing a descendant requires a verified ancestry/publication chain and must not be reported as a fresh exact-head match. Unrelated changes enter `REMOTE_DIVERGED`. Recovery imports/proposes the external delta or creates an explicitly authorized repair intent; it never silently force-pushes or manufactures a successful receipt.

GitHub and GitLab implement one capability interface for identity, advertised object format, ref observation, protection evidence, send/readback, credential cleanup, and optional pull/merge request creation. Unsupported provider features are explicit capability failures. Existing GitHub code is a reusable seam, not evidence of GitLab support or provider plan entitlements. A pull/merge request URL is a collaboration artifact, separate from branch publication and protected-target acceptance.

## 5. Dependencies and public projections

Project export identifies the source roots and the closure of dependencies required to build or consume them. Each dependency is explicitly included from authorized roots, pinned as a public external dependency, or declared unavailable so publication fails the relevant project gate. The exporter cannot silently include another project's source to make a public build work. Shared code appearing in multiple exports is deduplicated internally but has projection-specific public path/history mappings.

Before publication, an export report identifies included/excluded roots, path remaps, external dependency pins, metadata fields and artifact digests. Native parent commits from excluded private projects are never attached to the public Git graph. The export role can read only the permitted source/history/projection inputs; content existence, cache keys or a native hash do not grant access to excluded objects. Garbage collection retains objects needed by active and uncertain export operations.

## 6. Incoming contributions

GitHub pull requests and GitLab merge requests are optional ingestion sources. An importer pins provider repository identity, ref/commit, object format, base mapping and observed contribution metadata. It streams and verifies selected objects into a quarantined import namespace without executing hooks, submodules, filters or repository code. It enforces byte, object-count, expansion and path limits and requires explicit policy for LFS payloads and gitlinks.

After validation, it creates a native change proposal with an immutable base, explicit path edits/deletions, contributor provenance and import receipt. Imported source is untrusted input; it undergoes the same scope authorization, qualification and acceptance as agent changes. Remote force-pushes produce another pinned proposal revision. They do not mutate an existing native revision or grant acceptance. Re-import is idempotent by provider identity, exact source commit and projection/base mapping.

## 7. Required future evidence

Task 5.1 implements object conversion, export intents and adapters; task 5.2 implements projection/import provenance. The future drivers must use real Git object parsing/protocol behavior for local contract cases, then actual disposable GitHub and GitLab destinations for hosted qualification. Cases include deterministic retries, filtered empty changes/merges, annotated tags, symlinks/modes, unsupported encodings/gitlinks, denied source, changed policies, remote divergence, response loss after acceptance, worker/gateway restart, expiring credentials, and large exports under enforced memory/disk limits. Local parser or transport cases do not establish live provider protection or throughput. All such evidence is UNRUN.
