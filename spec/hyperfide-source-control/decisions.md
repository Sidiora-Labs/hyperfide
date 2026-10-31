# Decisions and unresolved qualifications

Status: product design, not implementation evidence. Requirements and task statuses are in [spec.kvx](spec.kvx).

## Fixed product constraints

| ID | Constraint | Consequence |
|---|---|---|
| D01 | Always-online clients and server-authoritative source | No offline claim/commit authority and no mandatory clone. |
| D02 | Native subsystem inside Hyperfide | Existing task and qualification authority is reused through explicit contracts. |
| D03 | Server/client asymmetry | History, ancestry, blame, commit construction, merge and rebase execute server-side. |
| D04 | Complete programmatic access | Metadata and source operations do not require a working copy. |
| D05 | One growing monorepo containing multiple very large projects | Horizontal scaling must operate within a repository and project. |
| D06 | S3-backed immutable source objects | Native storage is content-addressed with no Git pack/repack lifecycle. |
| D07 | Optional sparse, virtual and materialized source access | No infrastructure requires a full checkout; explicit client full materialization is supported. |
| D08 | Incremental revision creation without repository-wide locks | Independent revisions do not move a global ref. Shared acceptance has a separately specified ordering point. |
| D09 | Remote-only Git compatibility | GitHub/GitLab import/export adapters may stream transient Git packs; native clients need no Git installation. |
| D10 | Exact-source qualification and distinct lifecycle states | Saved, submitted, qualified, accepted and remotely published have different receipts. |
| D11 | Stable provenance across consolidation | Original repository and Git identities remain mapped and queryable after monorepo ingestion. |

## Proposed implementation choices

| ID | Proposal | Evidence needed before treating it as settled |
|---|---|---|
| P01 | TypeScript source service and host integration using existing product seams; C CLI as façade | Profiling of object processing, API throughput, host filesystem behavior and cancellation. A new low-level runtime is not assumed. |
| P02 | PostgreSQL initial metadata authority with routed partitions | Within-repository partition splits, failure fencing, hot-key limits, and measured single-trunk ordering throughput. |
| P03 | Versioned SHA-256 type-tagged canonical object IDs and bounded radix trees | Cross-implementation canonical vectors, huge-directory behavior, path compatibility, hash agility and migration. |
| P04 | Native path names use exact validated UTF-8 bytes | Explicit rejection or reversible conversion for Git histories with non-UTF-8 names; collisions cannot be silently normalized. |
| P05 | Authorization-domain-scoped deduplication and shared host caches | Cross-domain probing, cache revocation, object-grant expiry, and isolation checks. |
| P06 | Qualification targets in verification.md | Recorded workload dimensions, real backend runs, cost/latency evidence and live fleet journeys. No provider quota or entitlement is implied. |
| P07 | Single accepted trunk per repository for initial rollout, optional named channels | Bounded acceptance transaction and contention results; no promise of unlimited throughput through one ordered trunk. |
| P08 | Per-task Git export grouped by the existing wave publication policy | Exact projection/parent mapping and native/publication separation, including tasks that cross project export boundaries. |

## Decisions required during implementation

Deployment regions, S3 account/bucket configuration, credential references, metadata HA topology, source residency, exact recovery objectives, retention periods, cache quotas, supported filesystem/OS profiles, and external remote protection policies are deployment inputs. None is guessed from repository contents.

Schema and source formats are versioned before persistent writes. Numeric migration filenames in task touches are proposals; implementation must allocate free versions and update its task scope before creating migrations. Compatibility and evidence adapters are mandatory if an existing identity changes shape.

The first campaign freezes its workload and service objectives before measurement. A failing result cannot be turned into a pass by weakening the same campaign's limits after execution. Proposed SLOs can be revised in a new recorded profile with the original result retained.

## Relationship to earlier specifications

| Earlier contract | New contract for migrated native-source repositories |
|---|---|
| hyperfide req4: Git owns source objects | Native S3 objects and revision metadata own source; Git becomes a projection. |
| hyperfide-v21 req6 / D7: Git object model default and offline local snapshot store | Versioned native objects are authoritative online; existing snapshots are imported or remain explicitly legacy. |
| hyperfide-v22 req6: result Git branches and merge collection | Native revisions, custody and accepted-source receipts drive result collection. |
| hyperfide-v22 req8: initial slice provider with Git publication | Native workspace adapter consumes server snapshots, retaining remote export through a separate adapter. |
| workflow hierarchy: full manager worktrees and branch-based roles | Source scopes and integration APIs replace mandatory full manager checkouts after explicit workflow migration. Role authority remains with Hyperfide. |
| workflow local-first graph/source assumptions | Online source is mandatory in native mode; local non-authoritative caches and legacy modes remain explicitly identified. |

These replacements are scoped to this feature's migration. This draft does not edit historical specifications, change active feature selection, or claim earlier tasks failed their original contracts.

## Repository-layout prerequisite

D12: organize existing source by category before native source-control implementation, with SDKs under `sdk/`, core packages under `core/`, and explicit application/plugin/contract/library/tool categories. Preserve package units, public identities and runtime behavior. [repository-layout.json](repository-layout.json) defines the proposed mapping. Tasks 0.3–0.9 precede the final fleet prerequisite 0.10–0.14, which gates native task 0.1. Package-manager/toolchain consolidation remains outside the path-only work.

D13: the Primary and Wave Managers on one supervisory box own adaptive orchestration. The engine validates contracts and durably executes admitted actions. Model unavailability does not activate an implicit deterministic planner. See [fleet orchestration](fleet-orchestration.md).

D14: `package.kvx` describes a sandbox environment; `.neron` configures its source access; `interfaces.kvx` identifies declarations and associated compatibility contracts. Task assignments retain separate identities. Proposed `hyperfide install` prepares pinned code, dependencies, configs and interface subsets through an explicit existing-source adapter first, then a separately qualified native adapter. The example schemas are proposed, not existing command support.
