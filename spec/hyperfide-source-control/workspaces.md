# Online workspaces and materialization

Status: proposed contract; implementation and behavioral qualification are UNRUN. [spec.kvx](spec.kvx) is the normative requirement and task ledger. This contract implements requirements 6, 8 and 13 alongside [protocol.md](protocol.md), [storage.md](storage.md) and [hyperfide-integration.md](hyperfide-integration.md).

## 1. Source baseline and replacement boundary

The current [slice provider](../../platform/plugins/environment-slices/provider.ts) runs the C snapshot commands, copies `.codegraph/objects` into each slice, checks out the complete base and prunes outside the manifest. Its publication path reconstructs a separate base tree and derives deletions from a file listing. The [environment registration](../../platform/plugins/environment-slices/server.ts) requires `projectCheckout`; [the RPC contract](../../platform/plugins/environment-slices/contract.ts) binds the environment to task/thread inputs and raw hexadecimal snapshot IDs. These are inspected source facts, not performance measurements.

The new provider uses repository and revision identities without a seed checkout. Object transfer, manifest lookup and revision creation use `/api/v1/source-control`; the C CLI remains a client facade. Existing snapshot IDs and slice contracts remain behind an explicit versioned adapter during migration. A native ID uses `sha256:<64hex>` over the storage contract's type-tagged canonical envelope and must never pass through a legacy raw64 validator by truncating its prefix.

No leader, manager, integrator, query service or host daemon requires a complete source tree or full history. Build and qualification jobs may explicitly request broader source access when their tools need it. Physical materialization is charged to that job, rather than hidden in environment admission.

## 2. Workspace descriptor

The service issues an immutable base descriptor plus a mutable workspace generation. A proposed v1 descriptor contains:

| Field | Meaning |
|---|---|
| `repository_id`, `base_revision_id`, `root_tree_id` | Stable repository and exact immutable source input |
| `workspace_id`, `workspace_generation`, `authority_epoch` | Server-fenced ownership and mutation identity |
| `principal_id`, optional `task_id`, `attempt_id`, `attempt_generation` | Authenticated caller and optional orchestration association |
| `mode` | `API_ONLY`, `SPARSE`, `VIRTUAL`, or `MATERIALIZED` |
| `scope_manifest_id`, `scope_generation` | Versioned authorized read and write scope, independent of which files are present |
| `closure_manifest_id` | Build and metadata dependencies, expansion reasons, resolver version and unresolved coverage |
| `filesystem_profile` | Supported path, type, mode and symlink semantics on the selected host |
| `budget_profile` | Cache, dirty bytes, concurrent downloads/uploads, open handles, local disk and materialization limits |
| `checkpoint_revision_id` | Last server-acknowledged durable revision, if any |

The API supports ordinary authenticated developers and automation with no task or thread. A task association never substitutes for source authorization. Local directory paths are host observations; they cannot grant source ownership. The descriptor contains no bucket administrator credential or long-lived unrestricted object URL.

Repository snapshots do not move underneath an agent. Advancing a base, rebasing an overlay or widening a scope is an explicit operation with its own expected generation and idempotency identity. Two agents may share a base and cached immutable objects while their write overlays remain isolated.

## 3. Access modes

| Mode | Admission behavior | Data fetched |
|---|---|---|
| `API_ONLY` | Creates no source directory | Requested source or metadata results only |
| `SPARSE` | Materializes selected paths and declared build/metadata closure | Missing objects for those paths only |
| `VIRTUAL` | Presents authorized paths and paginated directory metadata through a supported filesystem adapter | File content on open/read, with bounded prefetch |
| `MATERIALIZED` | Materializes an explicitly selected scope; the scope may be the full snapshot | All missing source objects within that selection, with no history clone |

A full selection carries a reason and estimated bytes/files before transfer. Insufficient budget or unsupported host semantics returns a typed refusal or explicit alternative proposal. It must not silently convert an ordinary scoped request into a full repository download. The caller may choose a materialized sparse fallback if virtualization is unavailable. Unsupported virtualization is visible in capability discovery and the workspace detail.

Admission and filesystem readiness have separate receipts. `OPEN` means that the descriptor exists; `READY` means the requested filesystem contract is available. A virtual workspace becoming ready does not imply its contents were downloaded. An API-only open never produces a successful physical-checkout metric.

## 4. Manifest resolution and dependency closure

Scope resolution traverses immutable tree nodes from the pinned root, with path/range filters and bounded pagination. Bucket `LIST`, global filesystem walks and enumeration of unrelated project roots are absent from this path. Tree manifests map exact UTF-8 names to typed content or subtree identities and mode information. Source names are not silently Unicode-normalized or case-folded. The service rejects ambiguous requested paths; a host with incompatible case or name semantics reports the specific incompatibility before exposing a partly renamed tree.

A task's declared write paths, authorized read paths and materialized paths are distinct sets. Read-only shared build inputs are included without granting mutation rights. The build-closure resolver records project manifests, lockfiles, generators, toolchain inputs and known cross-project edges that justified expansion. Missing dependency knowledge is reported as incomplete closure. It may trigger an authorized widening or broader qualification; a guessed closure cannot establish successful validation.

A widening request names an expected scope generation, requested paths and reason. The authority validates the new scope and returns a new manifest at the same base revision. Existing dirty files remain unchanged. Read authorization may be widened without widening write authority. A dependency discovered by a compiler does not itself grant access to a private project.

## 5. Bounded content cache and materializer

The host cache keys verified content by security domain, object type, format version and content identity. Identical hashes from separate unauthorized domains do not expose cache presence, timing, content or transferable read capabilities. The object service resolves authorized reads to direct downloads or a proxy; clients need not know the complete bucket namespace.

The host downloads only missing objects, using connection reuse, bounded concurrency, cancellation and a fair queue. Each transfer writes a private temporary file, verifies the canonical object's length and digest, then atomically admits a complete immutable entry. Partial downloads never appear as cache hits. A resumed range transfer revalidates its object identity. S3 ETags are not treated as source content hashes.

Writable source uses private copies or supported copy-on-write clones. Mutable hardlinks into the shared cache are forbidden. A cache hit must never allow one process to modify another agent's source through an alias. Cache limits cover bytes and entries; eviction considers active pins. Clean downloaded content is evictable. Dirty data, pending upload journals and live write handles have a separate budget and cannot be discarded to satisfy the clean-cache limit. Host cache loss causes refetch of acknowledged data, never loss of the service's acknowledged revision.

The materializer records installed paths against the manifest. Recreating the same clean scope at the same revision is idempotent. It stages changes to a live workspace before replacement and never overwrites dirty files because a prefetch or scope expansion completed. File operations use descriptor-relative safe paths, reject traversal, and prevent symlink-parent races from escaping the workspace root.

## 6. File semantics

Native tree entries preserve regular-file bytes, executable state and symlink target bytes. A symlink is recorded as a symlink; snapshotting does not follow it and upload files outside the scope. Host creation checks parent traversal. A profile may refuse external or unsupported symlinks explicitly without rewriting them into different source. Filesystem modification time, owner UID and local inode number are host metadata, not source identity.

Unsupported special files, sockets and device nodes produce explicit diagnostics. The client does not silently skip them if the user requested they be tracked. Filesystem profiles and import adapters define whether a requested attribute is representable; mode/type transitions are explicit source mutations.

Absence has three meanings: outside the scope, authorized but not hydrated, or explicitly deleted. Only the third is a delete operation. Narrowing scope and evicting clean content do not change source. Rename may be encoded as remove plus add while retaining content identity; rename similarity is a derived query, not mandatory commit-time global search.

## 7. Change tracking and durable checkpoints

Filesystem watcher notifications are hints. A client keeps a bounded durable dirty-path journal, tracks atomic-save rename patterns, and validates dirty content at checkpoint. Watch overflow, daemon restart or an uncertain event sequence marks the affected materialized scope as needing reconciliation. Reconciliation scans that scope or its affected subtrees against its installed manifest; it never assumes watcher silence means cleanliness and never scans the entire monorepo merely because the workspace is sparse.

A checkpoint captures a stable overlay generation. The host drains relevant writes or stages a consistent set of file bytes and directory operations; a file changing while it is read is retried or reported unstable. It submits explicit `put`, `remove` and type/mode changes with expected base identities. The server validates workspace/attempt generations, permissions and referenced object durability before committing the revision and its receipt. Watch sequence, overlay digest and captured scope generation appear in the checkpoint request. Writes after the captured generation belong to the next checkpoint.

The client labels progress precisely: `LOCAL_DIRTY`, `UPLOADING`, `DURABLE`, `SUBMITTED`, `ACCEPTED` and separate remote-export states. A successful object upload is not a durable revision acknowledgment. An unchanged retry of an acknowledged checkpoint returns the same revision and receipt; a reused operation ID with a different digest is refused. A network interruption may leave dirty local files available, but no offline commit, lease renewal or acceptance authority is implied. Reconnection first resolves ambiguous checkpoint outcomes before retrying or replacing a workspace.

## 8. Virtual filesystem behavior

The initial supported virtual adapter and kernel/userspace requirements are pinned in the implementation profile; this draft does not claim that a mount driver already exists. The virtual namespace supports bounded paginated `readdir`, lookup, read, `stat`, executable state, symlink inspection, atomic-save patterns, rename, truncate and deletion semantics needed by declared tools. Reads resolve through the workspace's pinned tree plus overlay. Concurrent upstream acceptance cannot change an open file's base bytes.

Cancellation, timeouts, object unavailability and authorization expiry map to stable I/O errors with diagnostic context. A missing network object never becomes a zero-length successful read. Memory mapping, executable loading, file locking and build-tool watchers receive explicit compatibility cases. Hydration tasks coalesce per object within a security domain, bound outstanding work and do not hold a metadata transaction while waiting for S3. Host/daemon restart reconciles open mount state and overlay journals before declaring readiness. A stale mount cannot submit under a new workspace generation.

## 9. Qualification obligations

Task 2.2 owns materialization and cache behavior; task 3.2 owns the virtual adapter. Their future cases cover scope absence versus deletion, two writable workspaces sharing cached content, executable and symlink round trips, hostile path/type transitions, case collisions, canceled transfers, corrupted objects, watcher overflow, concurrent saves, lost checkpoint acknowledgments, cache pressure and restart. Task 4.2 proves attempt fencing and handoff with the real source service. Admission load, physical materialization and large-build downloads remain distinct cases in [verification.md](verification.md). A mocked mount, fixture object server or successful directory listing cannot certify the real virtual or S3 path.

## Sandbox bootstrap and environment installation

The [sandbox contracts](sandbox-contracts.md) apply to every fleet sandbox. `.neron` configures its source provider and scope; `package.kvx` declares the needed environment. The installer uses source APIs to materialize the pinned subset or establish the selected virtual view, then prepares locked dependencies/configuration and validates selected interfaces. Its readiness receipt binds the source workspace generation to the installed environment generation; neither receipt substitutes for task assignment or acceptance evidence. Shared immutable caches remain separate from isolated worker writes. The earlier fleet prerequisite uses an explicit existing-source adapter; native source adoption changes that adapter through a qualified transition.
