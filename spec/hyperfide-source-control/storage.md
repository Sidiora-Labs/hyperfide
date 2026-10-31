# Native source storage and durability

Status: proposed implementation contract. Runtime, AWS S3, recovery and scale cases are UNRUN. Requirements 2, 3 and 11 in [spec.kvx](spec.kvx) are normative; this chapter supplies their storage protocol. Exact wire fixtures are frozen by task 0.1 before the object service is implemented.

## 1. Existing seams and the change in responsibility

The inspected checkout contains three distinct storage mechanisms. Their existence does not establish the proposed service's behaviour.

| Source | Inspected behaviour | Required adaptation |
| --- | --- | --- |
| [`src/vcs.c`](https://github.com/Sidiora-Labs/hyperfide/blob/2f7331ef2085f6f374adf2d1e2ee01405fecb72d/src/vcs.c) | Local SHA-256 objects under `.codegraph/objects`, a flat sorted path manifest, workspace traversal with a stat cache, and a mutable local HEAD. The distributed descriptor marks this store non-authoritative. | Retain compatible local reading/import where required; online source authority moves to typed native revisions and bounded persistent trees. A flat manifest and whole-workspace traversal cannot be the normal server commit path. |
| [`preparation/object_store.ts`](https://github.com/Sidiora-Labs/hyperfide/blob/2f7331ef2085f6f374adf2d1e2ee01405fecb72d/services/hyperfide/src/preparation/object_store.ts) | Provider/region selection currently resolves a bare Git store or mirror and compares advertised refs. GitHub is excluded as a workspace source. | Replace online source selection with native content endpoints and scoped object-transfer grants. Provider placement remains useful; Git refs and bare mirrors remain migration inputs. |
| [`artifacts/objects.ts`](https://github.com/Sidiora-Labs/hyperfide/blob/2f7331ef2085f6f374adf2d1e2ee01405fecb72d/services/hyperfide/src/artifacts/objects.ts) | The S3 artifact adapter uses conditional PUT, verifies retrieved digest and length, exposes ambiguous outcomes, and limits individual artifact payloads and manifests. | Reuse reviewed transport patterns after qualification. Source objects require their own namespace, type/schema limits, graph references and lifecycle. Existing artifact size limits do not become source file limits. |
| [`0710-source-snapshots.sql`](https://github.com/Sidiora-Labs/hyperfide/blob/2f7331ef2085f6f374adf2d1e2ee01405fecb72d/services/hyperfide/migrations/0710-source-snapshots.sql), [`0045-workspace-slices.sql`](https://github.com/Sidiora-Labs/hyperfide/blob/2f7331ef2085f6f374adf2d1e2ee01405fecb72d/services/hyperfide/migrations/0045-workspace-slices.sql) | Snapshot records bind attempts, Git tree identities, slice/checkpoint digests and immutable receipts. | Add native ID columns and an explicit import mapping. Existing Git OIDs must never be reinterpreted as native object IDs. |

The proposed implementation lives under `core/control-plane/src/source_control/`. PostgreSQL is the initial metadata backend proposal, behind object/transaction interfaces. Object bytes live in S3; no metadata replica or worker requires every byte or the complete history in memory. Physical partitioning and routing must work within one repository. Project roots are logical scopes, not mandatory storage shards. Migration sequence numbers are allocated against the actual migration catalog during implementation preflight.

## 2. Immutable objects and canonical identity

An object is addressed by `sha256:<64 lowercase hexadecimal digits>`. Its digest covers a type-separated, versioned canonical envelope. The proposed v1 envelope is ASCII `hyperfide-source-control`, NUL, ASCII `v1`, NUL, kind, NUL, canonical decimal payload length, NUL, then payload bytes. The supported kind set is closed and versioned. Object identity is independent of S3 key spelling, upload time, compression, encryption, backend version ID and ETag.

Blob payloads are exact bytes. Metadata payloads use a specified tuple encoding with fixed field positions, UTF-8 strings, decimal strings for large integers and canonical JSON array serialization. Task 0.1 must supply cross-language golden bytes for escaping, Unicode, empty values, integers, type separation and invalid input; a generic serializer's object-property order is insufficient. No floating-point number, duplicate map key, lone surrogate, unknown field or alternate numeric spelling is accepted. A future codec creates a new version; it never changes the meaning of an existing digest.

| Kind | Logical contents | References |
| --- | --- | --- |
| `blob` | Exact small/ordinary file bytes | None |
| `chunk` | A bounded range of a large file | None |
| `file` | Encoding version, logical byte length, whole-file payload digest and ordered chunk IDs/lengths, or a blob ID | Content children |
| `tree-leaf` | Directory-prefix discriminator and sorted name/type/mode/object-ID entries | File, symlink-content or child directory root |
| `tree-index` | Radix prefix and sorted non-overlapping child ranges | Tree nodes |
| `manifest` | Immutable selection of source roots/scopes and declared metadata | Source roots |
| `revision` | Canonical source root, ordered parents and public provenance fields defined by the protocol contract | Tree and parent revision objects |

Stable change IDs and authorization identities are scoped metadata identities, not content hashes. Large mutable indexes and runtime status do not go inside a source object. Public source provenance and private fleet context have separate schemas and references.

Native paths are repository-relative UTF-8 sequences. The format rejects NUL, absolute paths, empty components, `.` and `..`; it preserves exact permitted bytes and never silently folds case or normalizes Unicode. Directory comparison uses unsigned UTF-8 byte order. The importer records unsupported names rather than silently renaming historical files. A client whose filesystem cannot represent a valid native path reports a typed incompatibility or uses API access. Executability, file kind and symlink target are explicit; timestamps, UID and host inode numbers are not source identity. Symlink resolution policy belongs to the materializer and must not permit path escape.

The ordinary commit path accepts only bounded objects. Proposed initial tree-node bounds are 256 entries and 256 KiB encoded bytes, both enforced before persistence and benchmarked. The large-file chunk threshold/size are versioned format parameters selected in task 0.1 from representative source and binary fixtures; deployment settings cannot reinterpret old file descriptors. The file descriptor supports exact reassembly and range queries, including zero-byte files and a final short chunk.

## 3. Persistent trees and partitioning

A directory is a deterministic radix map over its entry-name bytes. Leaves split at a specified bound and carry enough prefix information to reconstruct one canonical representation; indexes have non-overlapping ranges. The complete split/merge algorithm and empty-root encoding are golden-vector contracts. Updating a few entries rewrites the affected radix paths and ancestors, sharing unchanged subtrees. An enormous single directory must not become one enormous object.

Metadata owners route objects by security domain, kind and digest prefix through a versioned routing map. A project or repository ID is never the sole physical partition key. Rebalancing copies and verifies immutable bytes, transfers the catalog owner through a fenced routing generation, and preserves IDs. Clients follow bounded trusted routing redirects or refresh the map; workers do not enumerate all partitions on ordinary requests.

Each accepted tree is verified inductively. The service checks the changed nodes' canonical encoding, bounds, paths and direct child readiness receipts. An unchanged child root already has a verified transitive closure. This avoids rewalking all files at each revision. A corruption audit may traverse broader retained roots as a separately admitted, resumable maintenance operation. Traversal/query workers carry time, byte, node and memory budgets and return continuation handles instead of silently truncating answers.

## 4. Physical S3 layout and access

Proposed keys are `source/v1/<security-domain>/<kind>/<digest-prefix>/<digest>/<incarnation>`. The digest identifies logical content; `incarnation` identifies a physical placement generation and is not part of the content identity. It prevents an old delayed deletion from deleting a newly uploaded incarnation of the same content. A catalog maps each logical ID to its verified placement and lifecycle generation. Hash-prefix width is a deployment routing choice with measured distribution, not an assumed throughput guarantee.

Deduplication is confined to an explicit security domain. A hash is an identity and integrity check, not a read capability. Clients cannot issue unrestricted bucket LIST or guess arbitrary object keys. An authenticated API issues short-lived grants for identified objects or upload sessions, or streams through a gateway. Direct transfer grants bind domain, object/key generation, method, size/checksum bounds and expiry; durable credentials stay with trusted services.

Normal reads and workspace population resolve a pinned tree or manifest. They never discover repository membership by bucket listing. Caches and regional mirrors verify content against the native identity and track placement availability separately from immutable source identity. An unavailable replica cannot be called current merely because it has a root name. Reads either use a verified available placement or return a typed unavailable result.

AWS documents strong consistency for object reads/writes and atomicity per key, but no cross-key transaction: [S3 consistency model](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html). Conditional create prevents blind overwrite: [conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html). S3-compatible endpoints require their own protocol qualification; a matching HTTP shape is insufficient. Concurrent transfer and range reads are supported as bounded optimizations: [performance guidelines](https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance-guidelines.html). These statements do not establish fleet throughput, regional replication latency or cost.

## 5. Upload and publication protocol

1. `BeginUpload` authenticates scope, reserves byte/request budget and creates an idempotent session with a service-clock expiry. The session names expected type, digest, length, security domain and operation identity. It pins its prospective content and new tree nodes against collection.
2. The uploader writes to a fresh physical incarnation using conditional creation. Large payloads use a tracked multipart upload. Parts do not make an object readable; completion and validation do. Retries observe and verify an existing matching object rather than replacing it. Conflicting bytes at an expected identity are an integrity failure.
3. The verifier streams the canonical envelope, length and digest. A backend ETag, successful HEAD or client-supplied digest alone does not prove native content. A lost PUT/completion response leaves an `UNKNOWN` upload outcome until reconciliation; it must not be advertised as failed-and-safe-to-overwrite.
4. The catalog marks the placement `VERIFIED`, with format/type validation and direct-child protection receipts where applicable. That state is distinct from a revision becoming authoritative. If the selected durability policy requires another region or store, verification waits for that explicitly defined acknowledgment as well.
5. The revision service uses short metadata transactions to validate the current attempt/custody where applicable, the idempotency binding, root readiness and durable pin receipts, then records the immutable revision and committed outgoing event intent. Upload/network/merge/build work never occurs inside that transaction. A retry with the same operation and request digest returns its stored result; a different digest is rejected.
6. Only that committed result acknowledges a native checkpoint/revision. The acknowledgment states the durability profile. Native acceptance and remote Git publication remain additional states. A client retains pending local writes until acknowledgment or explicit abandonment; cache eviction cannot discard them.

A client killed after upload but before metadata commit leaves protected orphan objects, not a partial revision. A server killed after metadata commit but before response returns the recorded result on retry. Failure to verify one child prevents root publication. The metadata API never exposes a snapshot whose closure contains unverified or collected objects.

## 6. Reference safety and garbage collection

Reference ownership is explicit. Each newly verified parent object holds durable pins for its direct child incarnations. The catalog records roots for acknowledged revisions/history, active workspaces, submitted custody, candidates, qualification evidence, export/import operations, retention policy, backups and explicit holds. Parent readiness requires all direct-child protection receipts, so transitive closure safety follows inductively without a fresh whole-tree walk.

Within one metadata owner, publishers/read-grant issuers and collectors synchronize through an object lifecycle generation with short per-object transactions. A publisher obtains a pin only while the target incarnation is referenceable; collection atomically stops new pins before physical deletion. An indexed pin/reference ledger is authoritative. Cached reference counts are hints until validated under the lifecycle fence.

Across metadata owners, child-pin reservations are durable idempotent operations keyed by parent construction identity and child position. A parent becomes referenceable only after every reservation is acknowledged. Reservations remain protective if the parent outcome is unknown. Reconciliation adopts or releases them using persisted parent outcome; age alone cannot release a reservation whose parent may have committed. No cross-shard network call runs while a local SQL transaction is open.

| Lifecycle state | May accept new references? | Collector action |
| --- | --- | --- |
| `UPLOADING` | Upload session only | Reconcile outcome and active lease before abandonment |
| `VERIFIED` | Yes, under current generation | Consider only when no roots, incoming parent pins, read pins or holds remain |
| `QUARANTINED` | No; explicit atomic rescue allowed only before deletion is authorized | Wait grace interval, recheck pin ledger and holds |
| `DELETE_PENDING` | No | Reconcile deletion of the exact physical incarnation |
| `ABSENT` | No | Release outgoing child pins, retain tombstone/reconciliation record |

A collector first persists a deletion intent and generation, then calls S3 outside the transaction, then observes the exact physical incarnation. A lost response remains cleanup debt. Outgoing child pins are released only after parent absence is reconciled, preventing premature child collection. Re-upload after deletion uses a fresh incarnation. A stale collector cannot address that new key.

A reference arriving during quarantine either wins the rescue transaction before `DELETE_PENDING` or fails with a retryable reclaimed-object result and uploads/pins a new incarnation. A reference cannot merely clear a cached tombstone. Short-lived read/export grants hold a pin for their validity interval plus a bounded delivery margin. Lease renewals and pin release use service time and idempotent identities. Backup retention roots protect the catalog restore horizon, including object versions needed by an older metadata backup.

Collection is incremental, partitioned, resumable and independently budgeted. It does not require bucket-wide listing, global tracing or Git repacking on the foreground path. Conservative leaks are visible debt; missing referenced source is a failed invariant. Administrative or automatic S3 lifecycle deletion may affect only classes proven outside retained source roots, multipart debris and explicitly disposable derived artifacts. Bucket versioning is an additional recovery facility, not a substitute for reference safety or a claim that bytes have been erased.

## 7. Durability, replicas and restore

The deployment profile declares the acknowledged metadata failure domain, object-placement requirement, backup retention, RPO and RTO. Those values are required deployment inputs and qualification targets, not inferred from S3 marketing or a metadata connection string. The minimum protocol guarantee is that ordinary worker/API restarts do not lose acknowledged source; broader infrastructure loss is bounded by the selected, tested profile.

Metadata failover fences the old writer before a new authority accepts mutations and advances an authority epoch. Catalog, pins, revision results and event intents recover together. Read replicas may serve immutable queries after the required readiness barrier, but cannot issue source ownership or acceptance. Cross-region object replication is observed explicitly and does not silently upgrade a single-region acknowledgment.

A backup consists of a consistent metadata checkpoint, routing/codec/policy versions, retained source roots and verified availability of their object closures. Restore loads metadata into a new authority epoch, verifies roots against preserved placements, reconciles incomplete upload/deletion/export intents, and reauthorizes transfer grants before writes resume. If some retained object is missing, affected roots report unavailable and restoration fails its completeness gate. Cache contents and a copied worker disk are not backups.

Task 6.1 must kill processes at each protocol boundary, exercise primary fencing, restore metadata to a prior checkpoint, reconcile S3 version/delete state and demonstrate that newer accepted writes are either present or explicitly reconciled according to the profile. Security and destructive-operation authority are specified in [identity-security.md](identity-security.md). Every such case remains UNRUN until executed against the recorded backend and deployment profile.

## 8. Resource and operational accounting

Separate queues account for upload bytes, source object requests, metadata operations, tree traversal, merge CPU, download bandwidth, verification and garbage collection. A large submission cannot occupy all foreground mutation capacity. Each result records touched object count, changed logical bytes, uploaded bytes, reused bytes, S3 request counts, routing retries and required reference reservations. Metrics expose hot prefixes and metadata fan-in within a repository without revealing unauthorized path names.

Small-file request fan-out, metadata pin contention, whole-file versus chunked binary reuse and hot-directory updates are measurement cases. Derived archives may be offered only as disposable, bounded export accelerators with their own identity and retention; they never become required native storage packs or require repository-wide repacking. No latency, cost saving or scale claim is established by this chapter.
