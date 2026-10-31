# Native source-control migration and monorepo consolidation

Status: proposed migration contract; no migration, cutover or provider qualification has run. Requirements 9 and 10 and tasks 5.1 to 5.3 in [spec.kvx](spec.kvx) own implementation. The native source-control service is part of Hyperfide; its content, metadata, query and merge services remain independently scalable.

## 1. Existing source and scoped supersession

The current source contains several related but different mechanisms:

| Existing seam | Inspected responsibility | Migration treatment |
|---|---|---|
| [src/vcs.c](https://github.com/Sidiora-Labs/hyperfide/blob/2f7331ef2085f6f374adf2d1e2ee01405fecb72d/src/vcs.c) | Local SHA-256 objects, flat manifests, mutable HEAD, local history/stat cache | Preserve as a legacy import/read boundary; it does not become the distributed store by relocating its directory to S3 |
| [preparation/object_store.ts](https://github.com/Sidiora-Labs/hyperfide/blob/2f7331ef2085f6f374adf2d1e2ee01405fecb72d/services/hyperfide/src/preparation/object_store.ts) | Configured Git object sources, provider/region mirrors and submodule sources | Replace preparation references with native revision/scope identities after pilot qualification |
| [assurance/submission.ts](https://github.com/Sidiora-Labs/hyperfide/blob/2f7331ef2085f6f374adf2d1e2ee01405fecb72d/services/hyperfide/src/assurance/submission.ts) | Git commit ancestry verification and native checkpoint/snapshot binding in `source_snapshots` | Add an explicitly versioned native-source evidence schema; retain historical Git/checkpoint receipts with their original type |
| [environment-slices/provider.ts](https://github.com/Sidiora-Labs/hyperfide/blob/2f7331ef2085f6f374adf2d1e2ee01405fecb72d/platform/plugins/environment-slices/provider.ts) | Copies the local object directory, checks out then prunes source, publishes through supplied publication service | Adopt manifest-driven server materialization and native acceptance; do not copy all historical objects into each workspace |
| [integration/publication.ts](https://github.com/Sidiora-Labs/hyperfide/blob/2f7331ef2085f6f374adf2d1e2ee01405fecb72d/services/hyperfide/src/integration/publication.ts) | Git-target publication/custody and ambiguous-result reconciliation | Separate native acceptance from remote export while retaining currentness, authorization and reconciliation obligations |
| [migration/cutover.ts](https://github.com/Sidiora-Labs/hyperfide/blob/2f7331ef2085f6f374adf2d1e2ee01405fecb72d/services/hyperfide/src/migration/cutover.ts) and [parity.ts](https://github.com/Sidiora-Labs/hyperfide/blob/2f7331ef2085f6f374adf2d1e2ee01405fecb72d/services/hyperfide/src/migration/parity.ts) | Existing authority cutover and SQLite-history comparison | Reuse the fencing/parity design boundaries through a distinct source-store migration; existing authority schema checks do not certify native source migration |

On explicit activation of this feature's native-source mode, its requirements supersede only the affected product contracts: [hyperfide-v21](../hyperfide-v21/spec.kvx) decision D7/requirement 6.5's default Git object engine and local-only native snapshot authority, requirement 6.1's mandatory sparse Git worktree path, and [hyperfide-v22](../hyperfide-v22/spec.kvx) decision 6 and requirement 8.1 only insofar as they retain Git worktrees/publication mechanics. Existing qualification, task ownership and publication permission obligations continue through their versioned interfaces. Local graph, memory and legacy offline workflows outside the activated native-source mode are not globally redefined.

Historical specs and their evidence stay intact. Activation is an explicit repository/workflow configuration transition with a migration receipt, never an incidental consequence of writing this draft. The current active feature remains unchanged during authoring. A native source revision is authoritative only in a domain whose cutover receipt names the new source authority epoch.

## 2. Consolidation manifest

The initial target is one large monorepo containing many independently owned projects. Large existing projects are ordinary subtrees of that shared namespace. Storage partitions distribute objects and metadata within that repository; a project root, an imported repository, a bucket prefix or a tenant is not assumed to fit on one server.

A versioned consolidation manifest declares:

- Input repository identities, source type, Git object format or legacy snapshot format, reachable reference selection, immutable source tips and history retention policy.
- Stable target project identities, target path mappings, dependency/cross-project ownership changes and the resulting native repository identity.
- Handling of path collisions, case/Unicode collisions, prohibited paths, executable modes, symlinks, gitlinks/submodules, LFS payloads, signatures, tags and large objects.
- Import policy version, authorization domain, source and destination content digests, resumable batch checkpoints, verifier version and evidence locations.
- Future public projection mappings and the original repository/commit identities that external consumers need to resolve.

The manifest resolves overlapping target paths before ingestion. No last-writer-wins merge, case folding or path replacement is permitted. Inputs with non-UTF-8 or otherwise unsupported names remain archived and blocked from activation until an explicit reversible mapping or rejection policy is selected. Symlink targets are stored as source bytes and never traversed during import.

Submodules/gitlinks require a pinned decision: keep a typed external revision reference with a qualified resolver, or expand a specific external tree into a mapped project path with provenance. LFS pointers require their named payloads or a declared unresolved status that blocks affected checkout/qualification; the importer never silently treats an unavailable pointer payload as ordinary complete source. Native unsupported object/header features are recorded as explicit import exceptions.

## 3. History and provenance without mandatory clones

Import workers stream source objects or bounded batches from an authorized repository endpoint or supplied archive. Native output is content-addressed; duplicate file bytes may reuse storage within the permitted authorization domain. Deduplication is not proof that histories, authorship or project identities are equivalent.

For each input commit, retain `(source_repository_identity, git_object_format, source_commit_oid)` mapped to the native revision/tree, original parent order, tree digest, imported headers/provenance artifact and policy version. Legacy native snapshots use their explicit format and digest namespace. Imported authors, timestamps, messages and signatures are preserved as historical data without conferring current authorization or claiming that signatures survive reconstruction. Original signature validation observations identify the exact original bytes, verifier and time.

History import produces immutable native revisions and source maps, not fabricated agent attempts or newly authored commits. Metrics report imported historical revisions, newly authored revisions, accepted changes and remotely published Git commits separately. Stable source maps support old issue links, bisects, blame and audit references; APIs expose historical provenance with the same source-access policy as current code.

The importer traverses only selected reachable history with bounded memory, disk, pagination and checkpoint state. A full import may read all selected history over time; no worker needs a full checkout or full history on local disk. Failed batches leave discoverable staged objects protected by upload/import leases and are resumed idempotently. Partially imported roots are invisible to ordinary accepted-source readers until their completeness checks pass.

After per-project histories are available, an immutable consolidation revision composes target project subtrees. It retains each project's original ancestry through source maps and, where representable, explicit native parent edges. It never pretends independent repository histories originally shared a parent. Cross-project import manifests and parent fan-in are paginated/bounded so one consolidation record does not become an unbounded hot row.

## 4. Pilot and parity

A pilot reads the old source authority and writes only a quarantined native destination. The old source remains the sole source writer. Shadow reads compare the same pinned source trees, path entry types/modes, content digests, selected history ancestry, representative blame/diffs, source-access decisions and public projection output. Exhaustive tree/content parity is required for selected cutover roots; bounded samples of metadata supplement it but cannot establish complete content parity.

Pilot acceptance also exercises actual Hyperfide assignment, sparse materialization, immutable checkpoint, interrupted submission, qualification, native candidate acceptance and queued remote export. It must show that missing out-of-scope files are not inferred deletions, stale attempts cannot mutate adopted workspaces, the source ID in evidence matches the actual inputs, and post-merge validation binds the resulting candidate. Component tests do not substitute for this end-to-end path.

A rehearsal records source bytes, file counts, historical object counts, hot directories, import progress, transfer volume and reconciliation debt. Initial history ingestion and live agent traffic receive separate concurrency and I/O budgets. A bulk migration cannot consume lease/acceptance service capacity or force ordinary client operations to walk imported history. Provider/account settings, bucket topology and exact production SLOs remain deployment inputs to qualify.

## 5. Single-writer cutover protocol

The proposed domain state machine is `LEGACY_ACTIVE -> SHADOW_IMPORT -> QUIESCING -> PARITY_VERIFIED -> NATIVE_ACTIVE`, with explicit `ABORTED` and `RECOVERY_REQUIRED` states. Every transition is an idempotent metadata operation carrying operation identity, expected state/generation, source and target epochs, and immutable input manifest digest.

1. Inventory all legacy writers: agent workspaces, local snapshot commands, integration managers, publication gateways, scheduled jobs, CI and humans with direct source write access. Record a controllable admission boundary and physical source destination for each. An unknown writer blocks cutover.
2. Stop new legacy assignments/source mutations and drain or explicitly transfer active work. Reconcile uncertain remote pushes and in-flight submissions. Checkpoint dirty work under its original source format and preserve its custody; do not discard it because a task worker exited.
3. Establish the final immutable legacy high-water source tips after the writer fence is effective. Import the delta, bind the complete consolidation manifest, run parity and verify every selected reachable source object is available under the destination durability policy.
4. Commit a cutover receipt naming the fenced legacy authority, native repository/snapshot, import/source-map digests, checks and new authority epoch. Change assignment, query, graph/evidence and publication routes through one source-authority selector. No data copy or external provider call runs inside this short transaction.
5. Start new native work only after the new authority epoch is readable and old writer probes fail. In-flight legacy attempts are rejected or converted through an explicit immutable import proposal with current authority; credentials, a surviving process or an old task label cannot bypass the fence.
6. Reconcile events, workspaces, source maps, indexes, retention roots and export checkpoints. Keep legacy stores read-only for the declared recovery window. Retire them only after their evidence references and rollback obligations have a qualified retained destination.

A transaction cannot atomically reconfigure all existing external clients. Therefore activation requires independently verified fencing of old write endpoints before opening the new one. If isolation cannot be established, the state remains `QUIESCING`/`RECOVERY_REQUIRED`; it never enables both authoritative writers. Graph or UI observations cannot override the source-authority epoch.

## 6. Recovery and rollback

Before any native writes have been acknowledged, a failed cutover can return to the final fenced legacy snapshot only after proving that native assignment/mutation admissions are closed and no new source or external publication effects occurred. The receipt records that proof and reopens exactly one writer epoch.

After acknowledged native writes, recovery is a new forward-reconciliation procedure. Freeze affected admissions, retain all new revisions/checkpoints/acceptance and remote-export receipts, reconcile uncertain effects, then either repair the native authority or export/map all acknowledged changes into a qualified successor source store. Only after parity and writer fencing can a new authority epoch open. Pointing clients to an older writable Git/local store would lose acknowledged work and is prohibited.

Backup restoration introduces a new non-reused authority epoch and reconciles storage object availability, import maps, task/custody references and external remote effects before mutation admission. Historical signed or published identities remain immutable even if the current store is repaired. Cleanup records retention debt and cannot delete source required by active workspaces, pending imports/exports, uncertain outcomes or evidence retention policy.

## 7. Implementation packages and evidence

Task 5.1 provides the Git exporter and remote outcome protocol. Task 5.2 provides import, projection policy and provenance. Task 5.3 implements inventory, consolidation, parity, pilot, cutover and writable recovery, adapting the existing Hyperfide seams above. Tasks 6.1 to 6.3 exercise failure/recovery and production-shaped operation before the release tasks can claim qualification.

The future migration driver must run real source conversion and service transactions with at least two repositories containing shared content, independent history, merge commits, renamed paths, typed file modes, conflicting target mappings and legacy checkpoint references. It must demonstrate interrupted/resumed imports, rejection of unsupported encodings/LFS/gitlinks, complete content parity, writer fencing, crash at each cutover boundary, preservation of dirty work and safe recovery after an acknowledged native revision. Real object-store and hosted GitHub/GitLab campaigns are separate evidence classes. The document, task declarations and a structural authoring check establish none of those runtime outcomes; they remain UNRUN.
