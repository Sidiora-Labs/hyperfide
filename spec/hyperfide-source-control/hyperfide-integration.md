# Hyperfide integration and product surfaces

Status: proposed contract; all implementation and runtime qualification are UNRUN. This document supplies requirements 8 and 13 and task contracts 3.3, 4.2 and 4.3 in [spec.kvx](spec.kvx). [workspaces.md](workspaces.md) defines host behavior; [protocol.md](protocol.md) defines native source transactions.

## 1. Existing seams

| Inspected source | Current seam | Required evolution |
|---|---|---|
| [Slice environment](../../platform/plugins/environment-slices/server.ts) and [provider](../../platform/plugins/environment-slices/provider.ts) | Environment creation requires a project checkout; the provider copies local objects and checks out source before pruning | Native admission by source identity and versioned scope, using the host materializer |
| [Fleet worker](../../platform/apps/host-daemon/src/fleet-worker.ts) | Job/attempt identity, withdrawn-job cancellation and completion acknowledgment retry | Bind source workspace generations and immutable result receipts to the same execution identity |
| [Dispatch contracts](../../platform/plugins/hyperfide-dispatch/src/dispatcher/contracts.ts) | Runner results contain commit IDs; integration input contains a tip and Git bundle | Native revision/result identities and source manifests, with compatibility only at adapters |
| [Integration queue](../../platform/plugins/hyperfide-dispatch/src/integrate/queue.ts) | Fetches result bundles and prepares Git merge/worktree operations | Durable native candidate operations and source acceptance receipts |
| [Qualification adapter](../../platform/plugins/hyperfide-qualify/adapter.ts) and [receipts](../../platform/plugins/hyperfide-qualify/receipts.ts) | Detached Git worktree environments and 40-hex commit receipts | Native immutable source identities, exact materialization manifests and versioned receipts |
| [Graph RPC](../../platform/plugins/hyperfide-graph/contract.ts) and [host](../../platform/plugins/hyperfide-graph/host.ts) | Host/repository path requests execute the graph binary | Source-pinned remote requests; local CLI becomes an optional facade |
| [Published graph loader](../../services/hyperfide/src/graph/publication.ts) | Validates exact source set and graph coverage against published manifests | Preserve that evidence boundary while admitting native source IDs and reusable incremental extraction |

These observations locate implementation work. They do not establish deployment status, scalability or behavior of the proposed path. Existing Git environments remain separately identified during migration; the native environment must not silently fall back to them on an error.

## 2. Authority ownership

Hyperfide owns task assignment, attempt generations, execution budgets, qualification policy, review and dependency-release policy. Source control owns immutable revisions, authorized workspace mutations, valid source acceptance and export operation state. The source engine serves taskless callers as well as fleet agents. It has no second task scheduler and cannot mark a task done merely because a revision was accepted.

Source requests carry authenticated principal, repository, operation identity and optional task/attempt association. The source service validates an authority-issued capability or performs a current authority check according to its pinned policy. Workspace generation, source authority epoch and attempt generation are checked server-side for each mutation. A local plugin KV entry, thread state or client cancellation is never the write fence. An authority epoch change invalidates grants according to the recovery contract without rewriting historical revisions.

A workspace's read scope, write scope and execution limits are explicit. Shared build inputs may be readable and immutable without being writable. A manager receives source API access and can request candidate operations without a full checkout. Integration and review jobs materialize only what their declared tooling needs. Cross-project revisions retain one source transaction even when Hyperfide schedules affected project checks independently.

## 3. Task-to-source lifecycle

1. Dispatch pins the spec revision, task/attempt generation, exact base source revision, write scope, dependency/build-closure manifest, qualification policy version and environment profile. Worker images supply tools; their baked source is not authoritative for the assignment.
2. The host opens a native workspace through the source API. Its readiness receipt names the actual mode, scope and base revision. Hyperfide records that receipt before launching the worker. An API-only job skips filesystem provisioning.
3. The worker edits its overlay or uses source APIs. Durable checkpoints return immutable revision receipts. Heartbeats and telemetry may report local dirty progress, but checkpoint acknowledgment requires server-held content and revision metadata.
4. Submission first validates current compute ownership and transfers an exact revision set plus evidence references into coordinator-owned result custody. It records the source roots that retention must preserve. A repeated submission returns its original receipt. After this transfer, worker cleanup or lease expiry cannot discard the submitted source.
5. The integration coordinator requests a native merge/rebase candidate. Conflicts become structured path/content results for a repair task or an authorized decision flow. A model-generated resolution is a new revision requiring evidence. Disjoint paths are scheduling information, not semantic proof.
6. Qualification uses an independent environment at that exact candidate revision, toolchain and closure manifests. The native qualification adapter does not reconstruct Git merely to run checks. Invalid source IDs, stale evidence and incomplete required coverage are explicit refusals.
7. Acceptance checks the candidate, current integration-domain precondition and required evidence. It yields an immutable acceptance record. Hyperfide applies its dependency-release and task-completion policy from that result; acceptance alone does not close the task.
8. Remote publication follows an explicit export policy and its own authorization. Native acceptance is retained during a GitHub/GitLab outage. The product presents queued, ambiguous, diverged, failed and published export outcomes separately.

There is no transaction held open across an agent execution, object download, build or remote push. Durable requests and idempotent reconciliation connect those steps. The service does not claim exactly-once physical execution; it provides fenced authority and idempotent accepted outcomes.

## 4. Handoff, failure and disconnected behavior

Worker handoff revokes or supersedes the old attempt and workspace generations, then assigns a replacement from the latest acknowledged checkpoint. Pending unacknowledged local bytes may be recoverable from the original host, but must be labeled as unacknowledged and explicitly captured under current authority. The old worker may continue running physically; its later source mutations and result submissions are refused. Client-side abort is cleanup, not the security guarantee.

If the control plane becomes unreachable, already downloaded files may remain readable and local edits may continue within the host's declared operational policy. The client cannot acquire ownership, renew authority, create an acknowledged server revision or accept source while disconnected. Workspace detail reports the last acknowledged checkpoint and unavailable operations. On reconnection the host reconciles operation outcomes and generation validity before resuming mutation. The service never silently rebases dirty files onto a newer accepted snapshot.

Durable result custody must survive host cleanup, worker retries and compute lease expiry. Source-control retention receives roots from active workspaces, acknowledged checkpoints, submissions, candidates, acceptance records, export operations and release manifests; root removal uses the storage contract's transactional protocol. A task stop may stop further execution while retaining source and receipts needed for review. Explicit discard and retention expiry have different semantics from task cancellation.

## 5. Graph, context and qualification identity

A graph generation identifies repository, root tree/revision, optional immutable overlay revision, extractor version, schema version, resolver/build configuration and coverage manifest. Every context, search, reference and impact response returns those identities and freshness. Mutable local overlay observations receive a distinct overlay generation and cannot masquerade as a graph of the accepted source.

Extraction reuses immutable file facts keyed by content plus extraction configuration and language/build context. Path-dependent facts retain their path context; identical bytes in two projects do not imply identical resolved symbols. Resolution invalidates changed declarations, imports, generated inputs and affected consumers, including edges crossing project roots. A large interface change can legitimately require broad analysis. The cost contract avoids unconditional full-repository extraction for an unrelated local change; it does not promise that semantic impact is bounded by changed line count.

The graph API supports bounded pagination, source-filtered queries, cancellation and asynchronous operation handles without a local checkout. A source snapshot with missing graph coverage stays readable as source while impact analysis reports its limits. Qualification policy may require broader checks; stale graph data must not silently narrow a required check set. Published generations remain immutable, and partial staging cannot replace a complete generation. Source authorization applies to snippets, search hits, caller/callee edges, caches and derived artifacts.

Task 3.3 extends existing graph publication/source-set checks through a versioned native source adapter. It preserves raw Git provenance for imported history, while refusing to coerce native IDs into Git hashes or use a repository path as the immutable identity.

## 6. CLI, SDK and UI journeys

The public CLI remains under `hyperfide`; proposed source verbs and flags are frozen in the API contract before implementation. A shared client package supplies the C facade bridge, TypeScript SDK, host adapters and API automation with the same authentication, idempotency, pagination, cancellation and typed errors. Native read/query operations work with repository and revision identifiers and no current working directory inside a checkout. Git is invoked only by explicit compatibility adapters.

The app and CLI expose the following journeys:

| Journey | Required user-visible result |
|---|---|
| Open workspace | Select project/task or source revision, scope and mode; see readiness, download estimate, cache state and any incomplete closure |
| Save durable checkpoint | See upload progress followed by a durable revision receipt; local dirty state remains distinguishable |
| Submit and integrate | Inspect change summary, dependencies, conflicts, qualification status and accepted source revision |
| Resume or transfer | See the last durable checkpoint, current owner/attempt and recoverable local-only state |
| Publish externally | Choose an allowed export destination and view independent native acceptance and remote publication state |
| Inspect source/context | Navigate history, blame, diff and graph results at a named revision without opening a workspace |

Human-facing screens use existing page headers, forms, status components and navigation conventions. Primary controls use human-readable project, task and revision summaries. Raw hashes remain available through copy/detail controls, not as a mandatory manual input workflow. Permission failures and conflicts identify the affected operation and recovery action without exposing unauthorized paths. Large directory/diff/history views are paginated and do not transfer a complete repository manifest to render a page.

A UI success toast cannot substitute for the durable server receipt. Tests cover reconnect/resume and duplicate actions, along with desktop, tablet and mobile geometry for the affected journeys. Runtime and browser checks belong to implementation qualification; this document does not claim those journeys already exist.

## 7. Observability and budgets

Source telemetry includes operation admission, queue time, service time, source objects/bytes read and written, dedup reuse, request retries, conflict/acceptance retries, cache bytes/hit ratio/evictions, dirty bytes, materialized files/bytes, graph extraction/reuse/debt, checkpoint acknowledgment latency and remote publication lag. Logical opens, virtual mounts, sparse materializations and explicit full materializations are distinct counters.

Metrics use bounded labels such as operation class, mode, status and storage partition. Per-object hashes, file paths and workspace IDs belong in access-controlled traces or diagnostic records rather than unbounded metric dimensions. Evidence records preserve exact identities; aggregate dashboards need not disclose private source names. Host budgets protect dirty data and retain capacity for authority heartbeats and cancellation under download or indexing pressure. A refusal names its actual limiting budget and includes a retry policy.

The operator view distinguishes repository size, active workspaces, dirty/uploading workspaces, accepted revision arrival rate, history ingestion, query load, object bandwidth and physical materialization. Author counts and imported commit totals are never substituted for concurrent agent counts. No performance number in this draft is a measured provider guarantee; proposed qualification profiles live in [verification.md](verification.md).

## 8. Proposed implementation ownership

Task 2.2 adds the host materializer, immutable cache and watcher journal. Task 3.2 adds a pinned virtual adapter and explicit fallback capability. Task 3.3 extends native source identity through graph ingestion/publication and context APIs. Task 4.2 connects fleet dispatch, workspace capability, submission custody and native qualification. Task 4.3 ships the shared SDK, CLI facade and app journeys. New host modules are proposed under `core/host-daemon/src/source-control/`, client modules under `sdk/source-control/src/`, and source service adapters under `core/control-plane/src/source_control/`; existing environment/graph/dispatch/qualify files are adapted rather than duplicated as competing authority implementations.
