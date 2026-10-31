# Source-control protocol and acceptance

Status: proposed contract. The interfaces, schema additions and cases in this document are implementation work. All product qualification is **UNRUN**. The native requirements and task states live in [spec.kvx](spec.kvx); object formats and availability rules live in [storage.md](storage.md).

## 1. Boundary and existing implementation seams

Hyperfide owns task assignment, attempt generations, submission custody, qualification policy and wave closure. The source-control subsystem owns immutable source history, access to source, workspace mutation preconditions and atomic source acceptance. It accepts an explicit Hyperfide authority binding for managed work; API clients that are not executing tasks can operate with an appropriate repository capability. Creating a revision never requires inventing a task or updating task status.

The proposed implementation extends `core/control-plane/src/source_control/` behind a versioned API. This directory is a planned implementation location, not an existing service. The existing C front door and platform clients consume the same protocol rather than maintaining a second local repository authority.

Source-inspected integration points at the repository baseline are:

| Existing source | Observed behavior | Required adaptation |
|---|---|---|
| [transport/protocol.ts](https://github.com/Sidiora-Labs/hyperfide/blob/2f7331ef2085f6f374adf2d1e2ee01405fecb72d/services/hyperfide/src/transport/protocol.ts) | Defines authenticated principals, operation and idempotency identities, payload digests, strict JSON decoding, generations and invocation guards. | Reuse the authenticated transport semantics; introduce explicit repository/source capabilities without requiring source-only callers to join a fleet run. |
| [events/outbox.ts](https://github.com/Sidiora-Labs/hyperfide/blob/2f7331ef2085f6f374adf2d1e2ee01405fecb72d/services/hyperfide/src/events/outbox.ts) and [events/inbox.ts](https://github.com/Sidiora-Labs/hyperfide/blob/2f7331ef2085f6f374adf2d1e2ee01405fecb72d/services/hyperfide/src/events/inbox.ts) | Provide transactional delivery records, scoped events, aggregate versions, deduplication and bootstrap/replay operations. | Adapt these contracts to independently partitioned source aggregates. Preserve pending delivery discovery; avoid taking an unrelated run-wide lock for ordinary revision creation. |
| [integration/queue.ts](https://github.com/Sidiora-Labs/hyperfide/blob/2f7331ef2085f6f374adf2d1e2ee01405fecb72d/services/hyperfide/src/integration/queue.ts) | Uses a Git-backed internal trunk, touch-disjoint batch planning, three-way folding and requalification. | Replace the native source path with object-level candidates and scoped acceptance. Keep Git operations inside the remote compatibility adapter. |
| [integration/candidates.ts](https://github.com/Sidiora-Labs/hyperfide/blob/2f7331ef2085f6f374adf2d1e2ee01405fecb72d/services/hyperfide/src/integration/candidates.ts) | Constructs exact candidates and records gate inputs; current candidate construction invokes Git and creates bundles. | Preserve immutable input and receipt binding while removing native Git object and bundle assumptions. |
| [assurance/submission.ts](https://github.com/Sidiora-Labs/hyperfide/blob/2f7331ef2085f6f374adf2d1e2ee01405fecb72d/services/hyperfide/src/assurance/submission.ts) and [assurance/validity.ts](https://github.com/Sidiora-Labs/hyperfide/blob/2f7331ef2085f6f374adf2d1e2ee01405fecb72d/services/hyperfide/src/assurance/validity.ts) | Validate invocation, task/custody state and input manifests; invalidation preserves historical receipts. | Extend source identities and verify current custody at acceptance without transferring task-completion authority to the SCM. |
| [environment-slices/provider.ts](https://github.com/Sidiora-Labs/hyperfide/blob/2f7331ef2085f6f374adf2d1e2ee01405fecb72d/platform/plugins/environment-slices/provider.ts) | Maintains a base snapshot and later snapshots, and sends paths/deletions through a publication interface. | Submit a pinned native patch manifest with explicit deletions and scope, rather than treating the visible sparse tree as a replacement for the repository. |

These observations establish adaptation points. They do not certify the existing paths under this feature's concurrency, S3 or durability requirements. The earlier [source-tracking requirements](../hyperfide-v21/spec.kvx) and [platform requirements](../hyperfide-v22/spec.kvx) are historical inputs; this feature's migration contract must explicitly replace their Git-backed authority assumptions for enrolled repositories.

## 2. Identity and immutable history

The protocol distinguishes the following identities. Content identities use `sha256:<64 lowercase hex digits>` over the type-tagged, versioned canonical envelope defined in the storage contract. Tree paths preserve exact valid UTF-8 bytes. Deduplication and availability are scoped to an authorized storage/security domain. Task `0.1` freezes the remaining UUID, path and envelope details; an alias can never be supplied where an immutable object identity is required.

| Identity | Meaning |
|---|---|
| `organisation_id`, `repository_id` | Authorization and logical namespace. Physical partitions can change without changing these identities. |
| `change_id` | Stable scoped identity for a logical proposal. Several concurrent revisions may belong to it. |
| `revision_id` | Content identity of one immutable revision descriptor, including its tree and ordered parents. |
| `root_tree_id` | Content identity of a complete logical tree, with no implication that a complete checkout exists. |
| `workspace_id`, `workspace_generation` | Server-held workspace and current mutation ownership generation. |
| `operation_id`, `idempotency_key` | Durable operation lookup and retry identity. Their scope includes principal, repository and action. |
| `integration_domain_id`, `acceptance_generation` | An explicitly configured acceptance ordering scope and its current generation. |
| `candidate_id`, `input_manifest_digest` | Exact integration candidate and all policy-relevant inputs to its qualification. |

A revision descriptor contains a schema/algorithm version, repository identity, root tree, ordered parents, author provenance, message metadata and a versioned provenance extension. Its predecessor relationship within a change is explicit and distinct from source ancestry: rebasing a revision changes its source parents but retains the logical `change_id`. Required task/custody metadata is a separate authenticated binding, so private orchestration records need not enter an exported source object.

Revision registration inserts an immutable membership record `(repository_id, change_id, revision_id, predecessor_revision_ids)`. Creating concurrent successors of one predecessor is allowed and exposes divergence. A mutable convenience view of the preferred revision is optional and uses its own expected-version update; it cannot hide siblings or serialize all commits. Arbitrary later revision timestamps do not resolve divergence.

Parents must be existing authorized revisions or explicitly staged parents in a topologically ordered import. Parent existence and immutable registration make newly created cycles impossible; the importer separately validates its staging graph before admission. Requested parents cannot be inferred from the latest branch, latest task result or an unpinned dependency.

Binary content, executable modes, symlink entries and text encoding are explicit object properties. The protocol never rewrites arbitrary bytes as UTF-8 or normalizes source paths silently. Supported path encodings and platform materialization limitations must be negotiated under the storage/workspace contracts.

## 3. Versioned online API

The proposed HTTP namespace is `/api/v1/source-control`. Paths below are a contract proposal to be frozen with the typed SDK in task `0.1`; they are not currently shipped endpoints. Protocol discovery reports supported schema versions, object algorithms, operation kinds, server limits and optional capabilities. Unsupported semantics fail explicitly rather than falling back to Git or a local authoritative database.

Every operation carries an authenticated repository scope. Mutations also carry an operation identity, idempotency key, canonical payload digest, applicable expected versions, and workspace/attempt authority when required. Large content uses upload sessions; mutation requests contain bounded manifests or manifest object references, rather than base64 copies of an entire repository.

| Operation family | Proposed operations | Required inputs/result semantics |
|---|---|---|
| Content and trees | `objects:prepare-upload`, `uploads/{id}:complete`, `objects/{id}`, `trees/{id}/entries` | Authorized content reads, upload capabilities and paginated entries pinned to immutable identities. Availability is independent from mere upload initiation. |
| Revisions and changes | `revisions:create`, `revisions/{id}`, `changes/{id}/revisions` | Explicit base/parents, patch or verified root, provenance, stable change association and durable registration receipt. |
| History | `queries:ancestry`, `queries:merge-bases`, `queries:history`, `queries:blame` | Exact revision inputs, deterministic ordering and bounded result pages or an operation handle. No working copy required. |
| Differences | `queries:diff`, `queries:line-map` | Exact before/after identities, path scope, binary/rename behavior, truncation/coverage and resumable output. |
| Transformations | `operations:merge`, `operations:rebase`, `operations:revert` | Pinned revisions, algorithm/version and explicit options; a revision result or structured conflicts. |
| Workspaces | `workspaces:create`, `workspaces/{id}:checkpoint`, `workspaces/{id}:widen`, `workspaces/{id}:close` | Pinned base and scope, authority generation, retained local-write boundary and explicit scope changes. |
| Acceptance | `candidates:create`, `candidates/{id}:attach-evidence`, `acceptances:create` | Exact contributor manifest, expected domain state, current policy/custody evidence and accepted receipt. |
| Operations and events | `operations/{id}`, `operations/{id}:cancel`, `subscriptions:create`, `subscriptions/{id}:poll`, `subscriptions/{id}:ack` | Reconciliation of ambiguous results, cooperative cancellation and durable authorized replay. |

Read responses identify their immutable source inputs, authorization scope, coverage and any index generation. A source index can return `INDEX_PENDING` or an explicit partial response; it cannot label stale facts as current. Missing history visibility produces `HISTORY_REDACTED`, `UNAVAILABLE` or a contract-defined partial result rather than a fabricated ancestor or blame attribution.

Pagination tokens are opaque authenticated values binding scope, query digest, pinned snapshot/index generation, ordering and continuation position. Changing the query while reusing its token is rejected. Keyset pagination and directory-node bounds avoid scanning every earlier entry for each later page. Cross-partition results state their consistency model and use a fixed manifest or watermark vector; they never accidentally combine several meanings of latest.

Metadata queries support batching and multi-get to avoid network-per-symbol or network-per-ancestor behavior. Batched reads preserve individual authorization and errors. Heavy blame, ancestry walks and broad diffs use fair, independently admitted workers with byte/visit/time budgets, cancellation and durable continuation. Query cost depends on requested result and ancestry scope, so a whole-history query is explicitly broader than a one-file diff.

## 4. Mutation admission, durability and retry

Native revision creation has no repository-wide lock, shared branch update, global revision number or monorepo enumeration. The implementation can use scoped database constraints, per-operation coordination and object availability guards. This is a repository-lock-free product contract, not a claim that every underlying database algorithm is formally lock-free.

The create flow is:

1. Authenticate identity and source capability; validate schema, bounded manifest, explicit parents, scope and current workspace/attempt generation. Resolve the idempotency identity before performing an external effect.
2. Prepare missing immutable content/tree uploads and acquire the retention pins required by the storage contract. No metadata transaction remains open during a client upload or an S3 network request.
3. Verify each newly referenced object's digest, length, type and accepted availability receipt. Validate new tree-node closure against already verified retained children. Reusing a previously verified immutable subtree does not trigger a full-repository reachability walk.
4. Construct only changed tree paths and the revision descriptor on admitted server workers. A patch contains explicit add/replace/remove operations and expected base entry identities. Duplicate paths, conflicting operations, unauthorized paths and ambiguous ancestor-directory edits are rejected before mutation registration.
5. In one short authoritative metadata transaction, recheck mutable admission conditions and storage pins, register the immutable revision/membership/bindings, establish retention roots, persist its result and enqueue source events. A race with garbage collection must be resolved through the storage availability protocol, not a check-then-use HEAD request. References bind live physical object incarnations, and publication either atomically rescues an eligible quarantined incarnation or rejects/retries it. A delete already in flight cannot target a later incarnation of the same content.
6. Return a receipt containing the immutable revision/root, operation identity, committed result digest, durability profile and causal read token. The acknowledgement means source is recoverable under that profile; it says nothing about qualification or acceptance into trunk.

Sparse omissions have no mutation meaning. A client deleting a file must name the path, expected base identity and explicit removal. A patch created from an old base still records valid immutable history when authorized; it cannot silently advance the authoritative domain. Updating an existing workspace reference or preferred-change view requires its expected version and may independently conflict.

Idempotency is enforced by a uniqueness key covering organization, repository, authenticated principal scope, operation kind and idempotency key. The stored canonical request digest includes all semantic inputs and excludes transport retries, trace headers and renewable authorization tokens. Reusing a key with a changed request fails `IDEMPOTENCY_CONFLICT`. Concurrent identical retries join the existing operation or return its stored result; they do not create a second revision membership, acceptance or event obligation.

An operation moves through `ADMITTED -> RUNNING -> SUCCEEDED | CONFLICTED | FAILED | CANCELLED`, with `OUTCOME_UNKNOWN` as an explicit reconciliation condition. Only the server writes terminal state. A lost response is resolved through the operation/result record. A completed authorized result remains readable after the original compute lease expires if the caller retains read permission; this does not renew the lease or authorize a new write. An old attempt cannot restart an incomplete mutation after reassignment.

Cancellation is cooperative. Before registration it can stop further work and leave unreferenced uploads for storage cleanup. Once a revision or acceptance is committed, cancellation returns the committed result and an explicit too-late disposition; undoing it requires a new operation. Request timeouts are bounded observations, not proof of rollback.

Errors include a stable machine code, correlation/operation identity, whether the outcome is known, retry classification and any safe continuation. Distinct conditions include `STALE_AUTHORITY`, `EXPECTED_STATE_CHANGED`, `OBJECT_NOT_AVAILABLE`, `SCOPE_DENIED`, `IDEMPOTENCY_CONFLICT`, `HISTORY_REDACTED`, `LIMIT_EXCEEDED`, `INDEX_PENDING`, `CONFLICTED`, `RESNAPSHOT_REQUIRED` and `OUTCOME_UNKNOWN`. Unauthorized responses must not reveal hidden object existence or content hashes.

## 5. Durable events and causal reads

Revision creation, acceptance, invalidation and workspace authority changes insert an outbox obligation in the same transaction as their authoritative state. Notifications wake consumers; they are not the only record of work.

An initial PostgreSQL implementation uses durable per-consumer delivery records and per-aggregate versions, following the existing outbox/inbox contract without a run-wide source lock. Dispatchers claim committed pending deliveries through short leases and acknowledge by event identity. They discover pending records independently of insertion sequence. For example, an uncommitted event assigned sequence 41 must still be delivered after event 42 commits and is delivered. A `WHERE sequence > last_seen` scan alone is forbidden.

Source aggregates include a change, workspace, operation or acceptance domain. Aggregate version updates serialize only that aggregate where required. Ordinary independent revisions do not increment a shared repository counter. A consumer applies a state transition and its inbox deduplication record transactionally; duplicates return the prior effect. Out-of-order aggregate events wait or report a gap. Consumers needing a coherent repository view obtain an immutable manifest through bootstrap; they do not reconstruct one by assuming unrelated events were globally ordered.

A subscription cursor binds consumer identity, authorized scope, subscription epoch and a durable delivery checkpoint. It is not a bare database sequence. Initial bootstrap atomically establishes the snapshot reference and replay boundary, then buffers/delivers subsequent committed events. Cross-partition bootstrap uses an explicit manifest and checkpoint vector. Partition movement or deployment restoration changes the relevant epoch; continuation requires server reconciliation or an explicit resnapshot.

Retention is bounded and visible. An expired cursor returns `RESNAPSHOT_REQUIRED` with an authorized bootstrap path; the server never silently advances it past missing events. Slow consumers consume quotas and produce observable retention debt. Source content retention and delivery retention are separate policies: keeping an event does not imply its referenced bytes can be fetched without a retained source root.

After a successful mutation, its causal read token routes a dependent query to a sufficiently current metadata replica or the authoritative writer. Immutable object availability uses the committed storage receipt and region profile. The system must not acknowledge a revision whose manifest is visible before its required content is fetchable under that profile. Failover epochs prevent replaying a token as proof against an unrelated restored database.

## 6. Server-side merge, rebase and revert

Transformation inputs pin every revision and the merge algorithm/version. They never operate against an implicit moving latest view or mutate source history in place. Workers read immutable objects through storage APIs and construct new objects without a complete checkout or local history clone.

Three-way merge first compares tree-node identities and descends only where differences require it. Identical subtrees are reused. Path-level cases include add/add, modify/modify, modify/delete, directory/file, mode, symlink and binary conflicts. Rename/copy detection is an explicit bounded option; exceeding its budget reports unknown/unperformed detection instead of asserting no rename. Several merge bases require an explicit deterministic strategy recorded in the result, including the constructed virtual base if used.

Text merging is deterministic for a declared algorithm and encoding. A clean text merge establishes a source result, not behavioral compatibility. Units, authorization, protocol and cross-file interactions remain qualification obligations. Graph-derived overlap and declared touched/read paths are scheduling signals. A read set becomes a reusable-proof boundary only when a separately qualified capture mechanism establishes its completeness.

An unresolved conflict is a typed artifact containing base/left/right object identities, path operations, bounded diagnostic ranges, algorithm version and continuation identity. Large/binary sides are authorized references rather than inline unbounded payloads. A conflicted candidate can be retained for work, but cannot be accepted. A human or model resolution submits a new revision; it never overwrites the conflicting revision or inherits its previous validation automatically.

Rebase reapplies an explicit revision or ordered revision stack onto a pinned new base and records predecessor mappings. Descendants remain unchanged unless included in the request. Updating a dependency to a successor revision is explicit; matching `change_id` alone cannot substitute a newer dependency. Partial stack results and conflicts remain durable and resumable under an operation handle.

Revert computes the inverse of an identified revision's patch against a specified parent/mainline and applies it to a pinned target. Reverting a merge requires an explicit mainline parent. The result is a new revision subject to conflicts, dependency impact and ordinary qualification. It does not delete accepted history or automatically roll back remote releases and schema/data changes.

Transformation cost is measured as changed bytes, visited tree nodes, necessary history and conflict scope. A one-file update in a huge directory must not require rewriting the directory's entire mapping. A deliberately broad refactor can legitimately touch a broad part of the monorepo. Cancellation, quotas and resumable work protect other tenants and acceptance traffic from those operations.

## 7. Candidate qualification and atomic acceptance

The default proposed monorepo policy exposes one accepted trunk through an integration domain. Independent project domains can be explicitly configured, but must not be introduced silently as hidden branches. An immutable manifest can select compatible revisions from several domains; atomically selecting them does not imply their prior independent histories were globally ordered.

An acceptance domain is a deliberate coordination point. Its compact row holds the current accepted revision/root, generation and policy epoch. A single trunk requires ordering competing accepted updates. Horizontal source storage and candidate processing do not remove that requirement. Candidate assembly, object upload, graph analysis, qualification, review and remote publication all execute outside the short acceptance transaction.

Candidate preparation binds:

- Repository/domain and expected accepted revision/generation.
- Ordered contributor revisions and pinned explicit dependencies.
- Result revision/root and transformation algorithm/version.
- Task/spec/criteria and policy digests where Hyperfide-managed work applies.
- Custody, ownership/revocation generations, source scope and retention roots.
- Dependency, toolchain, configuration, graph coverage and contract input digests.
- Required check/reviewer identities and their exact applicability rules.

The candidate is immutable. Each receipt binds the full input manifest digest, source tree/revision, checker/executor identity, environment/toolchain, policy, outcome and artifact digests. Merely attaching a receipt ID, a passing exit code, a worker declaration or a matching source path is insufficient. Receipt signature/provenance and current policy/custody applicability are checked by the owning assurance authority.

Acceptance runs one bounded primary metadata transaction: authenticate acceptance capability; look up idempotency; verify current custody/revocation and qualification applicability; compare the domain's expected generation and accepted root; verify candidate content is retained and available; append the immutable acceptance record; advance the compact domain row with compare-and-swap; establish required roots; record result and outbox obligations. A rejected transaction changes neither domain head nor task state. If the source metadata service is separately deployed, this requires a versioned assurance grant plus a revocation/epoch protocol that is linearized with acceptance; a stale cached signed grant alone cannot close the race. The initial implementation should keep this disposition check in the same authoritative transaction domain until a split-authority protocol is qualified.

When another candidate advances the domain, acceptance returns `EXPECTED_STATE_CHANGED`. Existing receipts remain historical. The scheduler constructs a new candidate and either reruns affected checks or invokes a qualified applicability verifier using complete declared inputs and the current policy. Disjoint files by themselves do not authorize evidence reuse. Unknown dependency coverage broadens validation. Test execution is never performed while holding the domain row lock.

Speculative batches are bounded by contributor count, bytes, affected dependencies and validation budget. Each batch candidate names an ordered contributor set. Failure isolation can build and qualify smaller candidates, but their receipts must bind those new candidates; the original passing/failed receipt cannot be reassigned. Fairness, per-scope budgets and bounded retry counts prevent a hot component or repeatedly invalidated change from starving unrelated proposals. Serialization/retry overhead is a measured part of single-trunk capacity.

Successful acceptance returns the exact contributor set, accepted revision/root, prior state, new domain generation and durable receipt. Hyperfide consumes that receipt to evaluate task dependencies and completion. Source acceptance itself never marks a task `done`, waives independent review or authorizes Git publication. Remote export can lag while native work continues; remote failure never rolls back source acceptance implicitly.

## 8. Failure and concurrency obligations

| Interleaving | Required observable result |
|---|---|
| Two clients create unrelated revisions concurrently | Both can register without a shared repository-head update. |
| Two clients revise one logical change | Both revisions remain addressable; divergence is visible. |
| Identical operation submitted concurrently | One durable semantic effect and replay of its receipt. |
| Idempotency key reused for another body | Deterministic conflict without partial source acceptance. |
| Client response lost after metadata commit | Operation lookup returns the committed revision/acceptance. |
| Old worker submits after reassignment | New mutation is fenced; authorized read of its earlier receipt can still succeed. |
| Upload finishes but metadata registration fails | No visible revision; uploads remain pinned only for their bounded staging lifetime. |
| Garbage collector races reference registration | Registration pins available objects or fails/retries; no dangling acknowledged revision. |
| Two qualified candidates share expected trunk | At most one advances that generation; the other receives changed-state diagnostics. |
| Policy, custody or a contributor is revoked during qualification | Acceptance rechecks current disposition and rejects stale applicability. |
| Event transaction A starts before B but commits later | Both committed events remain discoverable without sequence-based loss. |
| Query replica lags a successful commit | Causal read waits within bounds or routes to a sufficiently current writer. |
| Metadata writer unavailable or partitioned | No new authoritative registration/acceptance; existing authorized cached reads are explicitly limited observations. |
| Merge worker crashes halfway through a stack | Persisted operation resumes/reconciles; original revisions remain unchanged. |

The future drivers named by tasks `1.2`, `2.1`, `3.1` and `4.1` exercise these interleavings through real transactional metadata and object services. In-process contract tests do not establish S3 behavior, failover guarantees, fleet capacity or semantic correctness of arbitrary merged programs. Those remain independent qualification campaigns in [verification.md](verification.md).
