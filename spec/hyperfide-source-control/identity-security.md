# Source identity, authorization and recovery boundaries

Status: proposed implementation contract; all security and recovery cases are UNRUN. Requirements 3 and 11 in [spec.kvx](spec.kvx) apply together with the storage lifecycle in [storage.md](storage.md).

## 1. Authority separation

Hyperfide owns task assignment, attempt generations, custody and qualification policy. Native source control owns the validity and durability of source mutations and accepted snapshots. Storage credentials confer no right to accept a task, and a native revision does not grant a worker fresh task authority. Existing authentication and primary-transaction seams are in [`transport/protocol.ts`](https://github.com/Sidiora-Labs/hyperfide/blob/2f7331ef2085f6f374adf2d1e2ee01405fecb72d/services/hyperfide/src/transport/protocol.ts), [`storage/transactions.ts`](https://github.com/Sidiora-Labs/hyperfide/blob/2f7331ef2085f6f374adf2d1e2ee01405fecb72d/services/hyperfide/src/storage/transactions.ts), and the snapshot/slice migrations listed in the storage chapter. Their current presence is a source baseline, not qualification of the proposed capability protocol.

Source-control capabilities are bound to an organization/security domain, repository, principal, action set, source/scope limits, expiry, policy version and authority epoch. Managed worker mutation capabilities also bind workspace, task attempt and attempt generation. A plain hash, source path, task label, environment variable, native model identity or client-supplied role is never a capability.

Basic source operations also support authorized human, automation and import principals without fabricated agent tasks. Each kind uses the same source protocol while carrying its own valid provenance. The server distinguishes a principal's authentication from its current authorization for an operation.

## 2. Action and credential boundaries

| Principal | Permitted responsibility | Excluded capability |
| --- | --- | --- |
| Agent workspace client | Read its authorized snapshot/scope, upload allowed content, checkpoint its current workspace and submit its revision | Bucket administration, unrestricted source/history access, acceptance or remote publication |
| Host materializer/cache | Retrieve authorized immutable objects and isolate writable overlays | Reuse a cache hit to bypass the requesting principal's authorization |
| Source query worker | Resolve authorized content, ancestry, diff, blame and graph-backed queries | Treat hidden ancestor/source content as public because the tip is visible |
| Object verifier | Validate bytes, type, length, children and storage receipt | Grant task ownership or mark qualification passed |
| Acceptance service | Validate current acceptance preconditions and exact evidence policy | Invent checker results or use stale ownership observations |
| Git adapter | Export/import an explicit project mapping and reconcile the identified remote | Publish unrelated source or private fleet metadata |
| Collector/recovery service | Execute current policy-scoped lifecycle intents against exact incarnations | Infer deletion permission from bucket age or a worker's request |

Runtime object access uses TLS and a trusted endpoint allowlist. Direct S3 grants are short-lived and constrained to identified objects or upload sessions. They are omitted from logs, task text, source manifests and durable public provenance. Credentials cannot be forwarded to arbitrary redirects or endpoints selected by repository content. Issued grants have a bounded residual validity after revocation; profile qualification documents that window. Read pins prevent collection during it, while authoritative mutation always rechecks current server-side fences.

Key and endpoint configuration belongs to operator/secret configuration through existing Hyperfide secret integration. Documentation uses reference names and schemas, never actual credential values, private account topology or conversation material. The implementation must qualify its selected S3 authentication mechanism and encryption/key availability; this document does not assume a particular cloud IAM entitlement.

## 3. Scope enforcement across all read paths

Authorization covers file content, tree listings, history, ancestry, diff, blame, symbols, search snippets, object existence, range reads, change descriptions, exports and event subscriptions. Access to a current subtree does not automatically grant access to its deleted or renamed historical content. Scope evaluation identifies the snapshot and policy version; a policy change invalidates derived grants according to the documented revocation window.

A query crossing a denied boundary returns a typed denied/partial result with an authorized coverage description, never a misleading complete answer. Pagination and cache keys preserve snapshot, security domain and authorization scope. Cross-domain content deduplication is disabled by default. Existence checks, upload dedup results and timing must not expose whether another security domain holds matching source.

A shared host cache stores immutable bytes by security domain and verified object identity, but every request still checks current authorization. Byte availability is separate from source visibility. Cache eviction cannot delete another workspace's dirty overlay or unacknowledged upload. Writable materialization must use copies or qualified copy-on-write mechanisms; hardlinking writable files to the shared immutable cache is forbidden.

Untrusted source includes symlinks, adversarial filenames, nested metadata, oversized descriptors, compression bombs and malformed tree ranges. Materialization resolves only paths allowed by the native format, applies explicit symlink policy and verifies files before marking a workspace ready. Escape through `..`, alternate separators, case collisions, unsupported Unicode, absolute symlink targets or extraction traversal produces a structured refusal. An unsupported client filesystem may use API-only access; it cannot silently rewrite names.

## 4. Generation fences, replay and revocation

Every managed mutation checks the current workspace owner/attempt generation and authority epoch on the authoritative path. A stale process may retain local edits or already acknowledged history, but it cannot alter a successor's workspace, submit a new accepted result, release a successor's pins or obtain fresh transfer grants. A retried previously committed operation returns its stored immutable result, with no new authority granted by that replay.

An idempotency binding includes principal/security scope, operation ID and request digest. Reusing an ID with different bytes or parameters is a conflict. Replaying a completed request after revocation may reveal only the result permitted by current read policy; it must not re-execute a mutation or bypass that policy. Client-clock expiry and cached role claims cannot extend a server-issued lease.

The catalog's physical incarnation fence is independent of task generation. A delayed DELETE can address only the obsolete object placement it was authorized to remove. Fresh re-upload uses a new placement; a late acknowledgment cannot reactivate an old one. Recovery and rebalancing advance their own routing/authority epochs and reconcile in-flight ownership before allowing new writes.

## 5. Integrity and supply of evidence

Canonical source identities bind type, format version and exact bytes. Verification rejects valid-looking headers with wrong payload length/digest, wrong object kind, noncanonical names, missing children or mixed security domains. S3 ETags and transport success are observations, not native content identities. A database row naming source is not enough without the required verified placement and child protection receipts.

Qualification evidence binds exact candidate/root/revision IDs, toolchain, scope, validation policy and provenance. The source-control engine checks those bindings and current acceptance preconditions; it does not infer semantic correctness from checksums, path disjointness, successful upload, worker exit or a model statement. A changed candidate requires new applicable evidence according to policy.

Private task conversation, memory, credential references and control-plane operation details are held outside exportable source metadata. The Git adapter uses an explicit allowlist schema for public author/message/provenance fields and an explicit source projection. A source export must never walk private metadata references merely because they share the same object backend.

## 6. Audit, recovery and deletion authority

Auditable records include principal identity, action, request digest, source identities, scope/policy version, attempt/custody generation where applicable, result, authority epoch and durable operation identity. They exclude object transfer secrets and unbounded source bodies. Access to audit data follows its own policy. Event replay preserves identity and committed outcomes; a retention gap requires resynchronization rather than guessing that an event never existed.

Collectors require a current retention policy and per-incarnation deletion intent. Protected roots include current and retained history, active workspaces, pending/submitted custody, qualification/release evidence, imports/exports, backup restore horizons and holds. Ordinary source API credentials cannot remove these protections. Backend lifecycle configuration must not independently expire live source; configuration drift becomes an operational fault.

Metadata backup and object retention are one recoverability contract. Restore advances the authority epoch, fences prior writers, verifies source closure and replays unresolved intent outcomes before opening mutation traffic. A restored old policy or credential snapshot cannot silently revive revoked authority. Destruction of noncurrent S3 versions and cryptographic key retirement have separate explicit procedures and evidence; deleting a current key alone is not a claim of complete erasure.

Required negative cases cover cross-domain object guessing, unauthorized ancestry/search/history, stale attempt mutation, revoked credentials with a warm cache, replay with a changed request digest, malicious tree/path objects, forged object receipts, root adoption racing collection, delayed deletion after re-upload, old-primary writes after failover and restore with a deliberately missing referenced object. Real backend and fault-injected component results are recorded separately. All remain UNRUN in this authoring pack.
