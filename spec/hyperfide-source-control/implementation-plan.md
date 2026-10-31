# Native source-control implementation plan

Generated from [spec.kvx](spec.kvx); regenerate with `python3 spec/hyperfide-source-control/tools/validate_spec.py --render`.

All implementation tasks are pending. This catalogue describes future work; the listed verification drivers are deliverables of those tasks, not existing passing gates.

Dependencies determine eligibility. Wave numbers group integration and release obligations. Each package couples its implementation with a direct consumer and positive/negative checks. Component success does not qualify a complete product case or elapsed-time campaign.

The repository-layout prerequisite runs first: **0.3 → 0.4 → 0.5 → 0.6 → 0.7 → 0.8 → 0.9**. Only then do native source-control tasks **0.1 → 0.2** become eligible. Existing task IDs are preserved; the list below follows dependencies.

| Task | Wave | Scope | Requires | Owner |
|---|---:|---|---|---|
| 0.3 | 0 | Freeze the category layout inventory and executable baseline | None | repository-layout |
| 0.4 | 0 | Establish the root workspace and relocation front door | 0.3 | repository-layout |
| 0.5 | 0 | Relocate native engines and core executables with their consumers | 0.4 | repository-layout |
| 0.6 | 0 | Relocate SDKs contracts libraries and packaged tooling | 0.5 | repository-layout |
| 0.7 | 0 | Relocate applications plugins extensions examples and assets | 0.6 | repository-layout |
| 0.8 | 0 | Complete tooling CI preparation and release path migration | 0.7 | repository-layout |
| 0.9 | 0 | Qualify the category layout and release the source-control prerequisite | 0.8 | repository-layout |
| 0.1 | 0 | Version the native source contract and compatibility boundary | 0.9 | contracts |
| 0.2 | 0 | Add native-source qualification profiles and evidence capture | 0.1 | qualification |
| 1.1 | 1 | Build the immutable S3 object and persistent-tree vertical slice | 0.1, 0.2 | source-storage |
| 1.2 | 1 | Durable revision metadata, scoped idempotency and source outbox | 1.1 | source-protocol |
| 1.3 | 1 | Enforce source capabilities across transfer, caches and metadata consumers | 1.1, 1.2 | source-security |
| 2.1 | 2 | Online revision, history and query API vertical slice | 1.2, 1.3 | source-api |
| 2.2 | 2 | Materialize pinned source scopes with immutable host cache and durable capture | 2.1 | workspaces |
| 2.3 | 2 | Connect durable source roots to race-safe incremental collection | 1.1, 1.2, 1.3 | source-retention |
| 3.1 | 3 | Object-level merge, rebase and revert with typed conflicts | 2.1 | source-transformations |
| 3.2 | 3 | Serve demand-driven virtual workspaces with explicit host capabilities | 2.2 | workspaces |
| 3.3 | 3 | Pin graph and context to native revisions with incremental cross-project invalidation | 2.2 | graph |
| 4.1 | 4 | Native candidate qualification and atomic domain acceptance | 3.1, 3.3 | source-integration |
| 4.2 | 4 | Run Hyperfide fleet attempts and qualification through native source custody | 4.1, 3.2 | fleet |
| 4.3 | 4 | Ship source API clients and native workspace-to-publication product journeys | 4.2 | surfaces |
| 5.1 | 5 | Publish accepted native changes through bounded Git remote adapters | 4.1, 4.2 | remote |
| 5.2 | 5 | Version project projections and import external source provenance | 5.1 | remote |
| 5.3 | 5 | Consolidate projects and cut over to one native source authority | 5.2, 4.3 | migration |
| 6.1 | 6 | Qualify source durability, authority failover and complete restore | 4.1, 4.2, 5.1, 5.3, 2.3 | source-recovery |
| 6.2 | 6 | Measure within-monorepo growth, mixed load and real-storage endurance | 6.1, 4.3, 5.3 | source-control-qualification |
| 6.3 | 6 | Qualify integrated native source control and independently close evidence | 6.2 | source-control-qualification |
| 7.1 | 7 | Ship native source documentation and reproducible release artifacts | 6.3 | release |
| 7.2 | 7 | Close the native source release with running-system evidence | 7.1 | release |

## 0.3: Freeze the category layout inventory and executable baseline

Status: **pending**. Owner: `repository-layout`. Dependencies: none.

Proposed implementation scope:

- `spec/hyperfide-source-control/repository-layout.json`
- `spec/hyperfide-source-control/repository-layout.md`
- `tools/repository/layout-inventory.py`
- `tests/hyperfide/cases/source_control/0_3.py`

Future focused gate: `python3 tests/hyperfide/cases/source_control/0_3.py`.

Acceptance clauses: 15.1, 15.2, 15.6, 15.8.
Canonical cases: SCM-025 (UNRUN).

Implementation and qualification obligations:

1. Inventory every tracked input under platform/ and services/, classified app/package/plugin units, root native/KVX/editor sources, hidden configuration, file types/modes, package identities and declared toolchains against the actual implementation baseline. Refresh the versioned mapping with explicit merge/regeneration exceptions and reject unmapped inputs or target/case collisions.
2. Capture existing dependency resolution/integrity, public exports and bins, workspace/test membership, native component discovery, current runtime paths and relevant baseline check outcomes. Preserve absent/failed prerequisite evidence explicitly instead of treating it as a successful baseline.
3. Implement the inventory/dry-run consumer to produce old-to-new path and content/mode manifests, direct-consumer rewrite obligations, installed-artifact versus source-path classifications, historical path exceptions and a reversible move plan. Do not move files in this task.
4. Implement the task driver against actual tracked manifests and source rules; prove detection of missing mapping, duplicate destinations, unexpected identity/dependency changes and source/artifact path confusion. Record approved target layout generation and baseline inputs for subsequent moves.

## 0.4: Establish the root workspace and relocation front door

Status: **pending**. Owner: `repository-layout`. Dependencies: 0.3.

Proposed implementation scope:

- `package.json`
- `pnpm-workspace.yaml`
- `pnpm-lock.yaml`
- `turbo.json`
- `vitest.config.ts`
- `vitest.shared.ts`
- `vitest.global-tmpdir.ts`
- `.oxlintrc.json`
- `.oxfmtrc.json`
- `.env.example`
- `.nvmrc`
- `.gitignore`
- `.gitattributes`
- `.hyperfide-env-setup.sh`
- `platform/package.json`
- `platform/pnpm-workspace.yaml`
- `platform/pnpm-lock.yaml`
- `platform/turbo.json`
- `platform/vitest.config.ts`
- `platform/vitest.shared.ts`
- `platform/vitest.global-tmpdir.ts`
- `platform/.oxlintrc.json`
- `platform/.oxfmtrc.json`
- `platform/.env.example`
- `platform/.nvmrc`
- `platform/.gitignore`
- `platform/.gitattributes`
- `platform/.hyperfide-env-setup.sh`
- `tools/workspace/env-setup.sh`
- `tools/repository/repository-root.py`
- `tests/hyperfide/cases/source_control/0_4.py`

Future focused gate: `python3 tests/hyperfide/cases/source_control/0_4.py`.

Acceptance clauses: 15.3, 15.4, 15.5.
Canonical cases: SCM-025 (UNRUN).

Implementation and qualification obligations:

1. Promote the pnpm workspace configuration and authoritative lockfile to root with explicit staged membership for units not yet moved. Keep the independent control-plane npm package and standalone module boundaries excluded. Preserve pnpm versions, patch integrity and dependency resolutions while regenerating importer/link paths.
2. Rewire root commands, Vitest discovery, Turbo inputs/outputs, lint rules and environment examples to the staged layout; merge ignore/attribute rules while preserving tracked authored assets and exclusions. Transitional launchers must delegate to the single root configuration, not maintain a second lockfile.
3. Provide qualified root discovery for moved tools and a conventional root environment-hook delegator to tools/workspace/env-setup.sh. Preserve package/setup input hashing, installed invocation, nested cwd and explicit path overrides. Record the observed Node22 development/Node24 CI/control profiles without silently upgrading or claiming a unified profile.
4. Implement the gate to compare actual workspace identities and dependency resolutions, run pinned install/frozen validation for the chosen existing profiles, exercise root/transitional commands and hook discovery, and prove a moved build input invalidates its cache. No native source-control modules are introduced.

## 0.5: Relocate native engines and core executables with their consumers

Status: **pending**. Owner: `repository-layout`. Dependencies: 0.4.

Proposed implementation scope:

- `kvx`
- `platform/apps/ai-gateway`
- `platform/apps/host-daemon`
- `platform/apps/server`
- `platform/packages/agent-runtime`
- `platform/packages/db`
- `platform/packages/environment-provider-host`
- `platform/packages/host-watcher`
- `platform/packages/host-workspace`
- `platform/packages/hyperfide-authority`
- `platform/packages/local-open-targets`
- `platform/packages/provider-bridge-acp`
- `platform/packages/provider-bridge-protocol`
- `platform/packages/secret-storage`
- `platform/packages/server-archive`
- `services/hyperfide`
- `src`
- `core/kvx`
- `core/ai-gateway`
- `core/host-daemon`
- `core/server`
- `core/agent-runtime`
- `core/runtime-db`
- `core/environment-provider-host`
- `core/host-watcher`
- `core/host-workspace`
- `core/authority-client`
- `core/local-open-targets`
- `core/provider-bridge-acp`
- `core/provider-bridge-protocol`
- `core/secret-storage`
- `core/server-archive`
- `core/control-plane`
- `core/native/src`
- `Makefile`
- `pnpm-workspace.yaml`
- `pnpm-lock.yaml`
- `turbo.json`
- `tools/repository/hyperfide-native-components.py`
- `scripts/hyperfide-native-components.py`
- `deploy/hyperfide/dist-stamp.mjs`
- `tests/integration`
- `tests/hyperfide/cases/source_control/0_5.py`

Future focused gate: `python3 tests/hyperfide/cases/source_control/0_5.py`.

Acceptance clauses: 15.1, 15.2, 15.4, 15.6.
Canonical cases: SCM-025 (UNRUN).

Implementation and qualification obligations:

1. Move the current C tree to core/native/src, KVX implementation/spec/fixtures to core/kvx with its editor extension reserved for the extension step, the service to core/control-plane, and classified core packages/apps to their explicit destinations. Keep vendor/ and the KVX Go module/public identity unchanged.
2. Update root native compilation, include/object rules, native component source/header/support manifests and component-registry generation. Adapt every direct runtime caller and package path at the same time, using the manifest to preserve currently unmoved SDK/app dependencies.
3. Preserve service src/dist/migrations/components adjacency, storage schema loading, component discovery, npm lock/toolchain boundaries and source-stamp behavior. Update CLI discovery and core root resolution without changing public command spelling, exit codes or installed artifact layout.
4. Implement the driver to compile and exercise native front-door/component dispatch, control-plane schema/component bootstrap, relocated core package consumers and nested/installed path probes with real code paths. Compare exported identities and content/mode inventory; identify any allowed path rewrites explicitly.

## 0.6: Relocate SDKs contracts libraries and packaged tooling

Status: **pending**. Owner: `repository-layout`. Dependencies: 0.5.

Proposed implementation scope:

- `platform/packages/bundled-plugins`
- `platform/packages/client-core`
- `platform/packages/config`
- `platform/packages/core-ui`
- `platform/packages/desktop-contract`
- `platform/packages/domain`
- `platform/packages/fuzzy-match`
- `platform/packages/hono-typed-routes`
- `platform/packages/host-daemon-contract`
- `platform/packages/logger`
- `platform/packages/mobile-bridge`
- `platform/packages/plugin-build`
- `platform/packages/plugin-registry`
- `platform/packages/plugin-sdk`
- `platform/packages/process-utils`
- `platform/packages/provider-parity`
- `platform/packages/query-tags`
- `platform/packages/scripts`
- `platform/packages/sdk`
- `platform/packages/server-contract`
- `platform/packages/shared-ui`
- `platform/packages/templates`
- `platform/packages/test-helpers`
- `platform/packages/text-utils`
- `platform/packages/thread-view`
- `platform/packages/tsconfig`
- `tools/bundled-plugins`
- `lib/client-core`
- `lib/config`
- `lib/core-ui`
- `contracts/desktop`
- `lib/domain`
- `lib/fuzzy-match`
- `lib/hono-typed-routes`
- `contracts/host-daemon`
- `lib/logger`
- `contracts/mobile-bridge`
- `tools/plugin-build`
- `tools/plugin-registry`
- `sdk/plugins`
- `lib/process-utils`
- `tools/provider-parity`
- `lib/query-tags`
- `tools/scripts`
- `sdk/client`
- `contracts/server`
- `lib/shared-ui`
- `lib/templates`
- `tools/test-helpers`
- `lib/text-utils`
- `lib/thread-view`
- `tools/tsconfig`
- `platform/changelog-parser.ts`
- `platform/changelog-metadata.ts`
- `lib/changelog/parser.ts`
- `lib/changelog/metadata.ts`
- `pnpm-workspace.yaml`
- `pnpm-lock.yaml`
- `turbo.json`
- `vitest.config.ts`
- `tests/hyperfide/cases/source_control/0_6.py`

Future focused gate: `python3 tests/hyperfide/cases/source_control/0_6.py`.

Acceptance clauses: 15.1, 15.2, 15.3, 15.4, 15.6.
Canonical cases: SCM-025 (UNRUN).

Implementation and qualification obligations:

1. Move every SDK, wire contract, shared library and packaged build/test tool according to the explicit package map. Keep mixed-responsibility packages intact and public package identities unchanged; move shared changelog helpers into lib/changelog without changing behavior.
2. Rewrite package-relative imports, project references, generator/scaffold inputs, shared test config references and workspace importer keys. Preserve public export subpaths, package bins, dependency integrity and generated module semantics.
3. Run actual SDK/plugin consumer examples and relevant package checks against the new paths. Compare discovered tests/generators before and after and verify generated outputs and bundle inputs remain part of the build graph.
4. Implement the gate to reject resolution from an old-source duplicate, missing exports, lost test membership, accidental dependency upgrades and warm-cache reuse after changing a moved library or generator input. Report exact runtime/consumer evidence, not just successful TypeScript parsing.

## 0.7: Relocate applications plugins extensions examples and assets

Status: **pending**. Owner: `repository-layout`. Dependencies: 0.6.

Proposed implementation scope:

- `platform/apps/app`
- `platform/apps/cli`
- `platform/apps/desktop`
- `platform/apps/mobile`
- `platform/apps/demo-server`
- `platform/packages/hyperfide-app`
- `platform/plugins`
- `platform/examples`
- `platform/assets`
- `platform/patches`
- `editors/vscode`
- `kvx/editors/vscode`
- `core/kvx/editors/vscode`
- `apps`
- `plugins`
- `extensions`
- `examples`
- `assets`
- `patches`
- `pnpm-workspace.yaml`
- `pnpm-lock.yaml`
- `turbo.json`
- `tests/hyperfide/cases/source_control/0_7.py`

Future focused gate: `python3 tests/hyperfide/cases/source_control/0_7.py`.

Acceptance clauses: 15.1, 15.2, 15.4, 15.6.
Canonical cases: SCM-025 (UNRUN).

Implementation and qualification obligations:

1. Move the remaining user apps, CLI/launcher, runtime plugins, separately distributed editor extensions, demonstrations, shared assets and authored patches into their categories. Preserve installed identities, package names, plugin IDs, extension IDs, licenses and archive member conventions.
2. Update app/plugin manifests, bundled registry inputs, SDK/scaffold imports, asset loading, release package source roots and the C platform front door together. Keep the demo runtime and disabled gateway behavior unchanged rather than using relocation to change product capabilities.
3. Exercise actual web/server/host and CLI startup, affected desktop/mobile build and asset paths on supported executors, plugin discovery and a generated plugin consumer, launcher bins and VSIX packaging. Record missing supported-executor evidence as unqualified rather than substitute source checks.
4. Implement the driver to compare packaged assets, bins and plugin/extension inventories, reject any dependence on old platform/services source facades, and verify relative paths from root and nested working directories. Preserve authored patch bytes and declared dependency targets.

## 0.8: Complete tooling CI preparation and release path migration

Status: **pending**. Owner: `repository-layout`. Dependencies: 0.7.

Proposed implementation scope:

- `scripts`
- `platform/scripts`
- `tools/repository`
- `tools/workspace`
- `platform/tests`
- `tests/runtime-integration`
- `tests/qa`
- `tests/fixtures/plugins/scripted-echo-provider`
- `platform/qa`
- `platform/docs`
- `docs/runtime`
- `docs/verification`
- `docs/history/runtime-port.md`
- `platform/README.md`
- `platform/CHANGELOG.md`
- `platform/AGENTS.md`
- `AGENTS.md`
- `platform/.hyperfide`
- `spec/workflow.kvx`
- `.agents/skills`
- `.github/workflows`
- `deploy/hyperfide`
- `Makefile`
- `.gitignore`
- `.gitattributes`
- `.cgignore`
- `README.md`
- `tests/hyperfide/cases/source_control/0_8.py`

Future focused gate: `python3 tests/hyperfide/cases/source_control/0_8.py`.

Acceptance clauses: 15.3, 15.4, 15.5, 15.8.
Canonical cases: SCM-025 (UNRUN).

Implementation and qualification obligations:

1. Move un-packaged tools, runtime test packages, runbooks/docs and history into their mapped categories. Reconcile discovery-specific skill/instruction sources through the owning workflow without changing policy or broadening instruction scope. Preserve historical specs/receipts and maintain explicit old-path exceptions.
2. Rewire CI path filters, cache keys, working directories and their asserting tests; update sandbox prepare/probe/build and changed-input detection with a layout generation that invalidates incompatible prepared images. Retain heartbeat, worker setup and runtime discovery behavior.
3. Adapt release assembly and checkout fallback paths while preserving installed services/dist and other artifact-format contracts. Exercise source-stamp guards, package manifests, licenses, nonpublishing release construction and service startup/preflight on the configured disposable executor.
4. Remove transitional old workspace roots and source facades. Scan executable/current references with typed exceptions for installed artifacts, historical evidence, fixtures and CLI command names; retain exactly one source owner for each unit. Implement the task driver to test CI triggering, cold/warm preparation, ignore/privacy boundaries, packaged startup and qualified exceptions.

## 0.9: Qualify the category layout and release the source-control prerequisite

Status: **pending**. Owner: `repository-layout`. Dependencies: 0.8.

Proposed implementation scope:

- `spec/hyperfide-source-control/repository-layout.json`
- `spec/hyperfide-source-control/repository-layout.md`
- `spec/hyperfide-source-control/spec.kvx`
- `spec/hyperfide-source-control/verification.md`
- `tools/repository/layout-inventory.py`
- `tests/hyperfide/cases/source_control/0_9.py`
- `tests/hyperfide/source-control/layout-receipt.schema.json`

Future focused gate: `python3 tests/hyperfide/cases/source_control/0_9.py`.

Acceptance clauses: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8, 14.4.
Canonical cases: SCM-025 (UNRUN).

Implementation and qualification obligations:

1. Compare the completed repository against the frozen mapping and original tracked content/type/mode inventory, accounting for every permitted path/configuration change. Validate exact package/extension/CLI identities, dependencies and test/workspace membership and require no old platform/ or services/ source container or facade.
2. Execute the combined existing-system layout regression and nonpublishing release/startup checks at the actual final revision, including root/nested/installed CLI discovery, native/core/control runtime, SDK/plugin consumers, app assets/packaging, prepared-image generation, CI routing and build-cache invalidation. Record baseline failures and new regressions distinctly.
3. Emit the SCM-025 layout receipt using existing Git-based evidence and actual assertion/command inventories; this driver is independent of future task 0.2 and the native source service. Bind source revisions, mapping digest, scope, toolchain, artifact/image identities, exclusions and rollback contract, refusing missing or stale mandatory evidence.
4. Update future native task targets and current layout documentation to the qualified mapping while retaining source-baseline history. Gate task 0.1 on this receipt and current layout generation; reject an attempt to start native implementation before closure or to roll back layout after new work without preserving that work.

## 0.1: Version the native source contract and compatibility boundary

Status: **pending**. Owner: `contracts`. Dependencies: 0.9.

Proposed implementation scope:

- `core/control-plane/src/source_control/contracts.ts`
- `sdk/source-control/package.json`
- `sdk/source-control/src/contracts.ts`
- `sdk/source-control/src/index.ts`
- `tests/hyperfide/cases/source_control/0_1.py`
- `spec/hyperfide-source-control/decisions.md`

Future focused gate: `python3 tests/hyperfide/cases/source_control/0_1.py`.

Acceptance clauses: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 14.1, 14.4.
Canonical cases: SCM-001 (UNRUN).

Implementation and qualification obligations:

1. Implement versioned request/response/error envelopes and explicit SourceRevision, TreeId, ChangeId, WorkspaceId, OperationId, authority generation and GitIdentity types; encode their repository/security-domain scopes and canonical bytes without collapsing legacy raw hashes into native identities.
2. Expose the shared contract through the source client package and exercise real server/client codec interoperability, capability/version negotiation and lossless supported path/type/mode fields; reject unknown versions and ambiguous identities.
3. Specify complete consumer-visible lifecycle states, pagination, operation replay, source scope and no-local-repository use. Freeze contract vectors and compatibility policy in the tracked schema and decision record.
4. Create the task driver to execute the actual codecs and consumer imports, with supported round trips and negative version/identity/path/state cases. It must not assert deployment, source durability or fleet scale from schema validity.

## 0.2: Add native-source qualification profiles and evidence capture

Status: **pending**. Owner: `qualification`. Dependencies: 0.1.

Proposed implementation scope:

- `tests/hyperfide/qualify.py`
- `tests/hyperfide/manifest.schema.json`
- `tests/hyperfide/check-evidence.py`
- `tests/hyperfide/source-control/registry.json`
- `tests/hyperfide/source-control/manifests/`
- `tests/hyperfide/source-control/registrations/`
- `tests/hyperfide/cases/source_control/0_2.py`

Future focused gate: `python3 tests/hyperfide/cases/source_control/0_2.py`.

Acceptance clauses: 14.1, 14.3, 14.4.
Canonical cases: SCM-024 (UNRUN).

Implementation and qualification obligations:

1. Version the qualification registry and manifest schema to admit the SCM-NNN namespace alongside legacy V-NNN cases without changing their original meaning or breaking old registrations. Keep feature/task namespaces separate when task numbers overlap.
2. Add native source capture to the evidence path: exact revision/root manifest, authority epoch, source scope, toolchain/environment, test inventory, policy version, object readiness, command exit and complete evidence object references. Preserve legacy Git evidence readers.
3. Register the canonical source-control cases and workload profiles from verification.md as future cases with explicit prerequisites and missing-environment diagnostics; absence of a real backend or required live fleet must remain UNRUN or blocked rather than pass.
4. Implement and run a driver against the actual registry, evidence loader and schema validation for valid legacy/native records, mixed source identity refusal, missing/forged receipts, unsupported versions and case registration collisions. Preserve original assertion inventories and checker boundaries.

## 1.1: Build the immutable S3 object and persistent-tree vertical slice

Status: **pending**. Owner: `source-storage`. Dependencies: 0.1, 0.2.

Proposed implementation scope:

- `core/control-plane/src/source_control/objects.ts`
- `core/control-plane/src/source_control/trees.ts`
- `core/control-plane/src/source_control/s3.ts`
- `core/control-plane/src/source_control/storage_contract.ts`
- `core/control-plane/src/source_control/object_catalog.ts`
- `core/control-plane/src/source_control/registration.ts`
- `core/control-plane/migrations/*-source-control-storage.sql`
- `tests/hyperfide/cases/source_control/1_1.py`
- `tests/hyperfide/cases/source_control/fixtures/objects/**`

Future focused gate: `python3 tests/hyperfide/cases/source_control/1_1.py`.

Acceptance clauses: 1.3, 1.4, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 3.1, 3.2, 3.3, 11.4.
Canonical cases: SCM-001, SCM-002 (UNRUN).

Implementation and qualification obligations:

1. Implement the frozen type-separated canonical codecs and golden vectors for blobs/chunks/file descriptors, bounded radix tree nodes and empty roots. Exercise exact bytes/mode/symlink metadata, deterministic split/merge behaviour, unsupported paths, binary/large-file descriptors and malformed input rejection through the real storage interface.
2. Create the minimal native object catalog, placement incarnation, upload-session, direct-child reservation and routing interfaces needed by the object service; allocate a free migration sequence during preflight. Keep logical object identity separate from physical S3 placement and legacy OIDs, and expose a real registered put/read/inspect consumer used by the case driver.
3. Implement conditional immutable uploads, multipart tracking, streaming digest/length/type verification and idempotent reconciliation against the selected S3 backend. Persist upload/verification outcomes outside long metadata transactions; conflicting bytes, incomplete parts, lost PUT responses and backend UNKNOWN outcomes must prevent false revision readiness.
4. Verify new tree closure inductively using direct-child protection receipts, including cross-owner reservations that remain protective after unknown parent outcomes. Update a fixed small change set inside increasing tree/directory fixtures and assert object/node work is bounded by affected paths rather than full-tree serialization.
5. 1_1.py runs the real service/object catalog and codec paths, records backend identity and separately labels deterministic backend-fault cases and an actual S3 integration result. Assert independent reads reconstruct the exact pinned files without checkout, bucket LIST, Git invocation or native packs; do not represent a skipped live backend as PASS.

## 1.2: Durable revision metadata, scoped idempotency and source outbox

Status: **pending**. Owner: `source-protocol`. Dependencies: 1.1.

Proposed implementation scope:

- `core/control-plane/src/source_control/metadata.ts`
- `core/control-plane/src/source_control/revisions.ts`
- `core/control-plane/src/source_control/operations.ts`
- `core/control-plane/src/source_control/events.ts`
- `core/control-plane/migrations/0718-source-control-metadata.sql`
- `core/control-plane/src/storage/schema.ts`
- `tests/hyperfide/cases/source_control/1_2.py`

Future focused gate: `python3 tests/hyperfide/cases/source_control/1_2.py`.

Acceptance clauses: 1.4, 4.1, 4.2, 4.5, 5.3, 5.4, 5.5, 7.1.
Canonical cases: SCM-002, SCM-003, SCM-007 (UNRUN).

Implementation and qualification obligations:

1. Add versioned metadata tables for immutable revisions, change membership/predecessor divergence, operation requests/results, pending source deliveries and explicit retained roots. Register migration 0718 after checking the implementation baseline for number conflicts; all authoritative keys include organization/repository and applicable security domain.
2. Implement source registration from a verified tree root/explicit parents and generation-bound source capability, with scoped idempotency uniqueness and canonical request digest; reference/root pins and available object incarnations must be validated atomically with registration according to storage.md.
3. Separate immutable revision creation from optional preferred-change references and acceptance domain state. Expose concurrent revisions as divergence and preserve earlier objects; revision creation must not acquire an existing run-wide assurance/advisory lock or increment a repository-wide counter.
4. Persist the committed result and source outbox in the same transaction. Implement pending delivery claims, durable acknowledgments and per-aggregate/inbox deduplication without relying on insertion-sequence order; bootstrap binds an authorized immutable source manifest and replay boundary.
5. Implement operation lookup and cancellation dispositions for lost responses, COMMIT_AMBIGUOUS, completed replay after compute-lease release and reassigned incomplete work. Retained read capability can retrieve a previous receipt but cannot revive stale mutation authority.
6. Create the future 1_2.py driver using real metadata transactions and object service: race identical/different idempotent requests, concurrent same-change successors, stale generations, upload/registration/GC interleavings, and event transaction A committing after B. Assert one effect per request and no lost pending delivery.

## 1.3: Enforce source capabilities across transfer, caches and metadata consumers

Status: **pending**. Owner: `source-security`. Dependencies: 1.1, 1.2.

Proposed implementation scope:

- `core/control-plane/src/source_control/capabilities.ts`
- `core/control-plane/src/source_control/transfer_grants.ts`
- `core/control-plane/src/source_control/audit.ts`
- `core/control-plane/src/source_control/storage_contract.ts`
- `core/control-plane/src/source_control/registration.ts`
- `core/control-plane/src/transport/protocol.ts`
- `core/control-plane/migrations/*-source-control-capabilities.sql`
- `tests/hyperfide/cases/source_control/1_3.py`

Future focused gate: `python3 tests/hyperfide/cases/source_control/1_3.py`.

Acceptance clauses: 3.3, 11.1, 11.2, 11.3, 11.4, 11.5, 11.6.
Canonical cases: SCM-004, SCM-013 (UNRUN).

Implementation and qualification obligations:

1. Add explicit source principal/action/scope capabilities carrying security domain, repository, policy version, authority epoch and service-clock expiry, and managed task/workspace generations where applicable. Adapt the existing authenticated invocation seam and provide equivalent scoped entry for human/import/automation operations without inventing tasks.
2. Issue bounded object/incarnation/method transfer grants only after authorized source resolution and readiness/pin acquisition; qualify trusted endpoint handling and expiry/revocation behaviour. Keep durable S3 credentials and signed transfer URLs outside source objects, public metadata, prompts and ordinary audit bodies.
3. Apply a reusable authorization decision to listings/content/history/search/event/cache lookup and dedup results; key caches by permitted security domain, snapshot and scope. Define explicit denied/partial responses and negative fixtures proving object guessing or a warm cache does not reveal another scope's source or existence.
4. Define public provenance/export metadata and private fleet context as separate typed schemas with an explicit public allowlist, and implement bounded audit records carrying request/source/generation/result identities. Check stale attempt, revoked credential, changed request digest and cross-domain receipt attempts against real transaction boundaries.
5. 1_3.py exercises registered service actions, actual authorization/pin decisions and signed-grant validation, including revoked credentials with cached bytes, method/key tampering, malicious paths/symlinks and expired epochs. Record the residual validity of an already issued grant separately from immediate server mutation revocation.

## 2.1: Online revision, history and query API vertical slice

Status: **pending**. Owner: `source-api`. Dependencies: 1.2, 1.3.

Proposed implementation scope:

- `core/control-plane/src/source_control/api.ts`
- `core/control-plane/src/source_control/queries.ts`
- `core/control-plane/src/source_control/cursors.ts`
- `core/control-plane/src/source_control/operations.ts`
- `core/control-plane/src/source_control/events.ts`
- `core/control-plane/src/transport/protocol.ts`
- `core/control-plane/src/components/registry.ts`
- `tests/hyperfide/cases/source_control/2_1.py`

Future focused gate: `python3 tests/hyperfide/cases/source_control/2_1.py`.

Acceptance clauses: 1.1, 1.2, 1.8, 4.2, 4.5, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 7.1.
Canonical cases: SCM-003, SCM-006, SCM-007 (UNRUN).

Implementation and qualification obligations:

1. Expose the proposed /api/v1/source-control contract through authenticated service registration: capability discovery, object/tree access, upload completion, native revision creation/read, changes, operation lookup/cancel and subscriptions. Keep managed task bindings optional for source-only actors while enforcing repository capabilities.
2. Implement pinned ancestry/merge-base/history/diff/blame/line-map queries with deterministic bounded pagination, binary/encoding semantics, redacted or incomplete coverage and cancellation/continuation. Build reusable ancestry/index workers without a mandatory local history clone or checkout.
3. Apply exact schema, payload and result limits, opaque authenticated query cursors, per-action stable errors and typed SDK contracts. Batch object/metadata reads with per-item authorization and expose index freshness rather than treating index omission as absence.
4. Route causal dependent reads using the receipt and metadata/object profile; implement changed-epoch rejection and bounded writer fallback. Apply separate upload/query/event/acceptance admission classes so a broad blame or slow consumer cannot starve mutations.
5. Create future 2_1.py with a real source service and transactional metadata, making source operations from an API-only client without .git or a checkout. Cover altered cursor scope, access denial without existence leaks, stale replica/epoch, cancellation, late event commit and paginated directory/history correctness.

## 2.2: Materialize pinned source scopes with immutable host cache and durable capture

Status: **pending**. Owner: `workspaces`. Dependencies: 2.1.

Proposed implementation scope:

- `core/host-daemon/src/source-control/client.ts`
- `core/host-daemon/src/source-control/materializer.ts`
- `core/host-daemon/src/source-control/cache.ts`
- `core/host-daemon/src/source-control/journal.ts`
- `core/host-daemon/src/source-control/checkpoint.ts`
- `plugins/environment-slices/contract.ts`
- `plugins/environment-slices/provider.ts`
- `plugins/environment-slices/host.ts`
- `tests/hyperfide/cases/source_control/2_2.py`

Future focused gate: `python3 tests/hyperfide/cases/source_control/2_2.py`.

Acceptance clauses: 1.5, 6.1, 6.2, 6.3, 6.4, 6.5.
Canonical cases: SCM-010 (UNRUN).

Implementation and qualification obligations:

1. Implement online workspace open/detail and manifest traversal by native repository/revision IDs without copying .codegraph/objects, running Git or enumerating the bucket; return separate admission and filesystem readiness receipts with scope and closure identities.
2. Implement bounded domain-scoped object caching, digest/length verification, atomic cache admission, safe path installation and private writable copies or copy-on-write overlays; pin in-use objects and protect dirty bytes under cache pressure.
3. Implement explicit sparse and selected materialized modes with native file types/modes and safe symlink handling, exact-name compatibility checks, generation-checked scope widening and separately authorized read/write scopes; maintain explicit delete records rather than inferring deletion from absent files.
4. Implement dirty-path journaling, atomic-save handling and watcher-overflow reconciliation limited to installed scope; freeze or stage a stable overlay generation, upload its missing objects and resolve checkpoint acknowledgment by idempotent operation identity.
5. Implement 2_2.py against the real source API and host modules: create two writable workspaces sharing cache, round-trip executable/symlink and mode transitions, prove cached data cannot be mutated through an alias, and prove omitted sparse paths survive checkpoint.
6. The case SHALL interrupt and corrupt downloads, race an edit with checkpoint, overflow the watcher journal, revoke scope and lose a checkpoint response; assert typed failures, retained dirty bytes, safe replay, exact snapshot contents and bounded traversal as unrelated source grows.

## 2.3: Connect durable source roots to race-safe incremental collection

Status: **pending**. Owner: `source-retention`. Dependencies: 1.1, 1.2, 1.3.

Proposed implementation scope:

- `core/control-plane/src/source_control/gc.ts`
- `core/control-plane/src/source_control/pins.ts`
- `core/control-plane/src/source_control/object_catalog.ts`
- `core/control-plane/src/source_control/retention.ts`
- `core/control-plane/src/source_control/registration.ts`
- `core/control-plane/migrations/*-source-control-retention.sql`
- `tests/hyperfide/cases/source_control/2_3.py`

Future focused gate: `python3 tests/hyperfide/cases/source_control/2_3.py`.

Acceptance clauses: 3.4, 3.5, 3.6, 11.3, 11.6.
Canonical cases: SCM-005 (UNRUN).

Implementation and qualification obligations:

1. Implement durable root and direct-child pin ledgers covering native revisions/history, active uploads/workspaces, custody/candidates/evidence, import/export operations, backup horizons and holds. Make root acquisition and object lifecycle transitions share the generation fence; indexed counts may accelerate discovery but cannot alone authorize deletion.
2. Add bounded partition work queues with quarantine/rescue and DELETE_PENDING states, current policy binding and idempotent per-incarnation deletion intents. Perform S3 deletion outside SQL transactions, reconcile lost responses, preserve unknown cleanup as debt and release outgoing child pins only after verified parent absence.
3. Implement cross-owner reservation adoption/release reconciliation using durable parent outcomes, preserving pins on unknown outcomes. Re-upload reclaimed content into a new physical incarnation; stale collector retries must remain bound to the old key even when the native digest is identical.
4. Expose collection inspect/debt/rescue results through the registered service and bind read/export grant lifetime to pin retention. Reject backend lifecycle policies that can independently expire retained source, and preserve object versions needed by the declared backup horizon.
5. 2_3.py runs real catalog/collector/pin paths with controlled scheduling of reference-versus-quarantine, delayed deletion versus re-upload, read-grant expiry, parent crash and partial cross-shard reservation cases. Assert live source remains readable, leaks are explicit debt, cleanup converges after safe release and no bucket-wide scan is required for a bounded pass.

## 3.1: Object-level merge, rebase and revert with typed conflicts

Status: **pending**. Owner: `source-transformations`. Dependencies: 2.1.

Proposed implementation scope:

- `core/control-plane/src/source_control/merge.ts`
- `core/control-plane/src/source_control/rebase.ts`
- `core/control-plane/src/source_control/revert.ts`
- `core/control-plane/src/source_control/conflicts.ts`
- `core/control-plane/src/source_control/api.ts`
- `tests/hyperfide/cases/source_control/3_1.py`

Future focused gate: `python3 tests/hyperfide/cases/source_control/3_1.py`.

Acceptance clauses: 4.3, 4.4, 4.6, 5.1, 5.3, 5.6, 7.4.
Canonical cases: SCM-008 (UNRUN).

Implementation and qualification obligations:

1. Implement server-side tree identity comparison and deterministic three-way merge over retained object reads, reusing identical subtrees and bounded radix/directory paths; record algorithm and multiple-merge-base strategy and never materialize a whole repository to calculate a merge.
2. Return typed immutable conflicts for text/binary add/add, modify/delete, directory/file, symlink and executable-mode cases. Make rename/copy detection explicitly bounded and report unperformed/unknown detection rather than assuming absent renames. Store large sides as authorized content references.
3. Implement rebase of a pinned revision/ordered stack onto a pinned base, persisting operation continuations and original-to-successor mapping under the stable change identity. Retain original descendants/dependencies until explicitly updated and expose partial stacks on conflict.
4. Implement revert onto a pinned target with explicit parent/mainline selection for merge revisions. Conflict resolutions create new revisions and fresh evidence obligations; no transformation marks a source result semantically correct or inherits checks from the old tree.
5. Create future 3_1.py running real object/metadata services and the production transformation engine: deterministic replay, divergent ancestry/multiple bases, all entry/conflict types, large untouched subtrees, cancellation/resume and revert-of-merge input rejection. Assert visited-object metrics for a fixed patch as untouched tree size grows.

## 3.2: Serve demand-driven virtual workspaces with explicit host capabilities

Status: **pending**. Owner: `workspaces`. Dependencies: 2.2.

Proposed implementation scope:

- `core/host-daemon/src/source-control/virtual-filesystem.ts`
- `core/host-daemon/src/source-control/capabilities.ts`
- `core/host-daemon/src/source-control/materializer.ts`
- `core/host-daemon/src/source-control/journal.ts`
- `plugins/environment-slices/contract.ts`
- `plugins/environment-slices/host.ts`
- `tests/hyperfide/cases/source_control/3_2.py`

Future focused gate: `python3 tests/hyperfide/cases/source_control/3_2.py`.

Acceptance clauses: 1.5, 6.1, 6.2, 6.3, 6.4, 6.6.
Canonical cases: SCM-011 (UNRUN).

Implementation and qualification obligations:

1. Select and pin the initial virtual adapter through the implementation profile and register its actual host/kernel requirements; add capability discovery and explicit fallback negotiation rather than reporting an unsupported mount as ready.
2. Implement paginated directory metadata, snapshot/overlay lookup, demand reads, coalesced hydration and bounded prefetch with stable base bytes for open handles; never hydrate unrelated subtrees to satisfy mount admission.
3. Implement declared rename, truncate, atomic-save, symlink, executable, mmap and file-lock semantics or explicit unsupported errors, preserving dirty data across cancellation and network loss; no failed fetch may become a successful empty read.
4. Reconcile mount/daemon restart and journal state against workspace generation before readiness, and refuse writes or checkpoint under an expired attempt while leaving the last acknowledged source intact.
5. Implement 3_2.py using the real selected filesystem adapter and representative compiler/editor operations; measure objects/bytes fetched before and after first read and assert pinned contents while upstream acceptance advances.
6. Exercise unavailable object/network, canceled hydration, permission expiry, case collision, dirty-cache pressure and daemon restart; assert exact I/O diagnostics, no cache corruption and explicit sparse fallback. An adapter mock cannot qualify this case.

## 3.3: Pin graph and context to native revisions with incremental cross-project invalidation

Status: **pending**. Owner: `graph`. Dependencies: 2.2.

Proposed implementation scope:

- `core/control-plane/src/graph/extraction.ts`
- `core/control-plane/src/graph/ingestion.ts`
- `core/control-plane/src/graph/publication.ts`
- `core/control-plane/src/graph/query.ts`
- `core/control-plane/src/source_control/graph-adapter.ts`
- `plugins/hyperfide-graph/contract.ts`
- `plugins/hyperfide-graph/host.ts`
- `plugins/hyperfide-graph/server.ts`
- `tests/hyperfide/cases/source_control/3_3.py`

Future focused gate: `python3 tests/hyperfide/cases/source_control/3_3.py`.

Acceptance clauses: 8.4, 13.3, 13.4.
Canonical cases: SCM-012 (UNRUN).

Implementation and qualification obligations:

1. Version graph source identity to admit native repository/revision/tree IDs and immutable overlay identity without coercing sha256-prefixed IDs into raw Git hashes; retain imported Git provenance as a separate field.
2. Expose source-pinned graph/context queries over the source service with parser/schema/resolver/configuration versions, coverage/freshness and bounded pagination; remove local checkout as a requirement for remote survey/context.
3. Cache extraction by immutable content plus language/build/path context, reuse unchanged facts and invalidate changed interfaces/imports/generated inputs plus affected cross-project consumers; stage new generations without displacing a complete published graph prematurely.
4. Preserve authorization on snippets, references and derived graph artifacts and independent graph admission budgets; return incomplete/degraded coverage explicitly so it cannot silently narrow qualification.
5. Implement 3_3.py using real extraction, ingestion, publication and query paths over a multi-project source snapshot; assert exact source mismatch refusal, stale overlay isolation, cross-project consumer invalidation and unchanged-fact reuse.
6. Interrupt extraction/publication, deny one source region and grow unrelated subtrees; prove the old complete generation survives, private edges do not leak, pagination stays bounded and graph work does not starve source authority traffic.

## 4.1: Native candidate qualification and atomic domain acceptance

Status: **pending**. Owner: `source-integration`. Dependencies: 3.1, 3.3.

Proposed implementation scope:

- `core/control-plane/src/source_control/candidates.ts`
- `core/control-plane/src/source_control/acceptance.ts`
- `core/control-plane/src/source_control/evidence.ts`
- `core/control-plane/src/integration/queue.ts`
- `core/control-plane/src/integration/candidates.ts`
- `core/control-plane/src/assurance/submission.ts`
- `core/control-plane/src/assurance/validity.ts`
- `core/control-plane/migrations/0719-source-control-acceptance.sql`
- `tests/hyperfide/cases/source_control/4_1.py`

Future focused gate: `python3 tests/hyperfide/cases/source_control/4_1.py`.

Acceptance clauses: 4.5, 5.3, 5.4, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6.
Canonical cases: SCM-009 (UNRUN).

Implementation and qualification obligations:

1. Create immutable candidate/contributor/input manifests for native root/revision IDs and versioned source bindings in assurance submission/validity. Preserve existing current custody, spec/policy/checker and disposition semantics while isolating native candidates from Git-backed legacy ones.
2. Implement bounded fair candidate scheduling and optional speculative batches outside metadata transactions, with exact contributor order, explicit dependency versions, transformation version, captured source/config/toolchain/graph coverage and current custody references.
3. Implement the initial same-authority PostgreSQL acceptance transaction with expected-domain CAS, current assurance/revocation verification, object/root retention pins, immutable acceptance receipt, idempotent result and source outbox. Document migration 0719 collision handling; no network upload, merge worker, build/test or Git call may hold the domain transaction open.
4. Return changed-state conflicts when trunk advances, invalidate applicability on source/policy/custody changes and require a new candidate. Evidence reuse requires a qualified completeness/applicability verifier; path disjointness alone never waives checks. Batch isolation generates new candidate receipts and preserves original proposals.
5. Expose separate native-created, candidate-qualified, native-accepted and remote-publication projections and acceptance receipts for Hyperfide. Source-only acceptance cannot mark a task done; define one explicit domain ordering point and no implicit cross-domain latest snapshot.
6. Create future 4_1.py using the real candidate engine, metadata and assurance modules: race two candidates at one generation, policy/custody revocation versus acceptance, lost acknowledgment, changed tree receipt, malformed contributor set, GC race, batch isolation and hot-domain fairness. Verify no accepted tree lacks exact current evidence or retained content.

## 4.2: Run Hyperfide fleet attempts and qualification through native source custody

Status: **pending**. Owner: `fleet`. Dependencies: 4.1, 3.2.

Proposed implementation scope:

- `core/host-daemon/src/fleet-worker.ts`
- `contracts/host-daemon/src/workspace.ts`
- `plugins/environment-slices/server.ts`
- `plugins/environment-slices/contract.ts`
- `plugins/hyperfide-dispatch/src/dispatcher/contracts.ts`
- `plugins/hyperfide-dispatch/src/dispatcher/runners.ts`
- `plugins/hyperfide-dispatch/src/dispatcher/dispatcher.ts`
- `plugins/hyperfide-dispatch/src/integrate/queue.ts`
- `plugins/hyperfide-qualify/adapter.ts`
- `plugins/hyperfide-qualify/receipts.ts`
- `core/control-plane/src/source_control/fleet-adapter.ts`
- `tests/hyperfide/cases/source_control/4_2.py`

Future focused gate: `python3 tests/hyperfide/cases/source_control/4_2.py`.

Acceptance clauses: 1.1, 1.7, 1.8, 6.5, 8.1, 8.2, 8.3, 8.5, 8.6.
Canonical cases: SCM-004, SCM-014 (UNRUN).

Implementation and qualification obligations:

1. Replace native-mode bundle/tip/check-out assumptions with versioned assignment descriptors carrying source/scope/closure/environment identities and current task/attempt/workspace generations; preserve explicit compatibility routing for still-legacy environments.
2. Bind server-enforced source capabilities to current Hyperfide authority, fence stale workers at mutation/submission and support taskless principals; manager and integration operations SHALL request APIs or scoped workspaces without mandatory full source trees.
3. Transfer immutable submitted revisions and retention roots into coordinator-owned custody before releasing worker compute; retain current submission state through worker cleanup or lease expiry and reconcile duplicated/ambiguous result acknowledgment.
4. Run native qualification against exact candidate and closure/toolchain manifests, emit native revision receipts and route native merge/acceptance through the durable candidate service; retain Hyperfide policy as the sole task qualification and dependency-release authority.
5. Implement 4_2.py through the real dispatch, host, source, qualification and integration adapters: execute a dependent task flow, replace a worker and reject its delayed write, lose submission acknowledgment and retain source after cleanup, with no internal Git invocation.
6. Assert that process exit, object upload, checkpoint, source acceptance and remote publication remain distinguishable; exercise source/authority outage and replay without duplicate task completion or acceptance, and demonstrate a manager completing integration without a full checkout.

## 4.3: Ship source API clients and native workspace-to-publication product journeys

Status: **pending**. Owner: `surfaces`. Dependencies: 4.2.

Proposed implementation scope:

- `core/native/src/main.c`
- `sdk/source-control/package.json`
- `sdk/source-control/src/client.ts`
- `sdk/source-control/src/contracts.ts`
- `pnpm-lock.yaml`
- `apps/cli/src/source-control.ts`
- `apps/cli/src/index.ts`
- `tools/bundled-plugins/package.json`
- `tools/bundled-plugins/build.ts`
- `plugins/hyperfide-source-control/package.json`
- `plugins/hyperfide-source-control/contract.ts`
- `plugins/hyperfide-source-control/server.ts`
- `plugins/hyperfide-source-control/app.tsx`
- `plugins/hyperfide-source-control/views/workspace-detail.tsx`
- `plugins/hyperfide-source-control/views/change-detail.tsx`
- `plugins/hyperfide-source-control/views/publication-status.tsx`
- `core/host-daemon/src/source-control/metrics.ts`
- `tests/hyperfide/cases/source_control/4_3.py`

Future focused gate: `python3 tests/hyperfide/cases/source_control/4_3.py`.

Acceptance clauses: 13.1, 13.2, 13.3, 13.4, 13.5, 8.5, 8.6.
Canonical cases: SCM-014 (UNRUN).

Implementation and qualification obligations:

1. Freeze proposed source verb names in the versioned contract and expose one shared TypeScript client with authentication, typed errors, resumable operation lookup, pagination, cancellation and idempotent mutations; route the hyperfide front door and API-only automation through that contract without repository discovery.
2. Register native source product views using existing app headers/forms/navigation and human-readable project/task/revision pickers; implement open/readiness, checkpoint, submit/conflict/qualification/acceptance, transfer and independent remote-publication status with paginated large data.
3. Display durable receipts, exact source identity and freshness in detail controls while preserving dirty/uploading/acknowledged/submitted/accepted/export states; reconnect and repeated UI actions SHALL reconcile operation outcomes rather than manufacture success.
4. Instrument bounded operation/mode/status/partition metrics for logical opens, materialization bytes/files, cache hit/eviction/dirty pressure, transfer queues, graph work, checkpoint latency, integration retries and remote lag; reserve heartbeat/cancellation capacity and return typed limiting-budget diagnostics.
5. Implement 4_3.py through real API/SDK/CLI adapters and browser journeys at desktop, tablet and mobile sizes; record screenshots and receipts for open, checkpoint, conflict, retry, transfer and publication inspection, with a taskless metadata query performed without checkout.
6. Exercise incomplete dependency closure, unavailable virtualization, stale ownership, oversized paginated diff/history and reconnect after an ambiguous action; verify actionable messages, no unauthorized source disclosure, bounded metric label cardinality and no local edit reported as durable history.

## 5.1: Publish accepted native changes through bounded Git remote adapters

Status: **pending**. Owner: `remote`. Dependencies: 4.1, 4.2.

Proposed implementation scope:

- `core/control-plane/src/source_control/git/objects.ts`
- `core/control-plane/src/source_control/git/export.ts`
- `core/control-plane/src/source_control/git/transport.ts`
- `core/control-plane/src/source_control/git/github.ts`
- `core/control-plane/src/source_control/git/gitlab.ts`
- `core/control-plane/src/integration/publication.ts`
- `core/control-plane/src/integration/github.ts`
- `plugins/hyperfide-qualify/publication.ts`
- `plugins/github/wave-publication.ts`
- `tests/hyperfide/cases/source_control/5_1.py`

Future focused gate: `python3 tests/hyperfide/cases/source_control/5_1.py`.

Acceptance clauses: 1.6, 9.1, 9.2, 9.3, 9.5, 9.6, 9.7.
Canonical cases: SCM-015 (UNRUN).

Implementation and qualification obligations:

1. Implement a bounded native-to-Git object encoder with explicit Git format namespace, byte/mode/path handling, ordered parent mapping and persisted public metadata. Generate identical Git IDs on retry and reuse unchanged projected trees; never create a full worktree/clone or require native pack storage.
2. Implement durable export intent/checkpoint/mapping and one unresolved mutation per destination/ref, retaining current qualification/authorization bindings and source roots. Replace the platform publisher local-bare/worktree assumption behind a versioned native export interface while keeping historical receipts readable.
3. Implement GitHub and GitLab transport capability boundaries, destination identity/protection observation, exact expected-old ref update, bounded transient pack streaming, restricted credential custody and remote readback. Remote divergence and unsupported capability remain explicit; cancellation after dispatch enters reconciliation.
4. Persist and reconcile response loss, remote acceptance followed by server crash, old-head observations with in-flight transport, stale export generations and credential cleanup debt. Keep native accepted state independent from remote published/PR state; never retry an uncertain effect under a new intent.
5. Create the future focused driver using actual native object conversion, Git parsing/protocol behavior and persistent source-service state. Assert deterministic bytes/parents/modes, denied private metadata/source, large streaming bounds, remote rejection/divergence and injected response loss. Record hosted GitHub/GitLab qualification as UNRUN until actual disposable destinations execute in the later campaign; no mocked transport result proves hosted support.

## 5.2: Version project projections and import external source provenance

Status: **pending**. Owner: `remote`. Dependencies: 5.1.

Proposed implementation scope:

- `core/control-plane/src/source_control/git/projection.ts`
- `core/control-plane/src/source_control/git/import.ts`
- `core/control-plane/src/source_control/git/provenance.ts`
- `core/control-plane/src/source_control/git/export.ts`
- `core/control-plane/src/preparation/object_store.ts`
- `core/control-plane/src/assurance/submission.ts`
- `tests/hyperfide/cases/source_control/5_2.py`

Future focused gate: `python3 tests/hyperfide/cases/source_control/5_2.py`.

Acceptance clauses: 9.2, 9.3, 9.4, 9.7, 9.8, 10.1, 10.2, 10.3.
Canonical cases: SCM-016 (UNRUN).

Implementation and qualification obligations:

1. Implement immutable projection policy versions for project root/path mapping, explicit outside-project dependencies, grouping and public metadata. Map original/native/projected identities separately; use recorded no-visible-change and ordered merge-parent collapse policies rather than deriving public ancestry from excluded native parents.
2. Implement annotated release/tag conversion and replay using exact target mapping, tagger/time/message and explicit signing policy. Report missing or unsupported encodings, entry types, gitlinks, LFS payloads and signatures without silent conversion; preserve original Git object provenance in authorized archives.
3. Implement streaming, resumable import for selected reachable Git history and legacy source maps with quarantined objects, fixed native base, ordered parents and independent import budgets. Preserve exact source identity, target paths and author/signature observations; metrics separate historical ingestion from new authored revisions.
4. Implement optional PR/MR intake that pins provider source identity and commit, creates an idempotent native proposal and routes it through existing scope/qualification/acceptance. Disable hooks, filters and implicit submodule execution; a changed remote contribution becomes a new revision rather than overwriting accepted history.
5. Create the future focused driver with actual Git histories and native source services covering two independent repositories sharing bytes, empty filtered commits, merges collapsing to one/two parents, annotated tags, executable/symlink modes, policy version changes, unsupported names and repeat/resumed imports. Assert source maps and dependency/access failures; no history conversion claims that imported commits were new fleet work.

## 5.3: Consolidate projects and cut over to one native source authority

Status: **pending**. Owner: `migration`. Dependencies: 5.2, 4.3.

Proposed implementation scope:

- `core/control-plane/src/source_control/migration/inventory.ts`
- `core/control-plane/src/source_control/migration/consolidation.ts`
- `core/control-plane/src/source_control/migration/parity.ts`
- `core/control-plane/src/source_control/migration/cutover.ts`
- `core/control-plane/src/migration/cutover.ts`
- `core/control-plane/src/migration/parity.ts`
- `core/control-plane/src/assurance/submission.ts`
- `core/control-plane/src/assurance/validity.ts`
- `core/control-plane/src/preparation/object_store.ts`
- `spec/workflow.kvx`
- `docs/hyperfide/source-control-migration.md`
- `tests/hyperfide/cases/source_control/5_3.py`

Future focused gate: `python3 tests/hyperfide/cases/source_control/5_3.py`.

Acceptance clauses: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 14.4.
Canonical cases: SCM-017 (UNRUN).

Implementation and qualification obligations:

1. Inventory source writers, source/evidence schemas, active dirty work/custody, selected history and external publication effects. Implement a versioned consolidation manifest, bounded project subtree composition and collision diagnostics; retain stable original-to-native provenance without assuming project roots fit a physical shard.
2. Implement read-only shadow parity with complete selected source-content/type/mode checks and ancestry/access/evidence comparisons. Execute a pilot through actual Hyperfide assignment, scoped materialization, checkpoint, qualification, native acceptance and queued remote export under separate ingestion/live-operation budgets.
3. Implement quiesce/drain, independently verified legacy writer isolation, final delta import, parity receipt, idempotent epoch-fenced activation and route switching. Unknown legacy writers or unresolved issued pushes block cutover; permit only one authoritative writer before and after transition.
4. Version source bindings through graph, qualification, findings, publication and retained historical receipts. Prepare explicit workflow/source-mode transition naming only superseded v21 source engine/local-only and v22 Git worktree mechanics; activation is a later authorized operation, never performed by drafting or schema installation.
5. Implement abort-before-writes proof and post-write forward recovery that preserves every acknowledged native revision, checkpoint, source map and remote effect. Restored metadata uses a fresh authority epoch and reconciles external outcomes before admission; prohibit reopening stale legacy writers.
6. Create the future focused driver exercising actual source services and at least two real input histories, interruption/resume, collision rejection, dirty workspace preservation, denied stale writers, complete selected tree parity and crashes before/after each activation boundary. Verify recovery after an acknowledged native write; persist explicit UNRUN for actual deployment migration until separately executed.

## 6.1: Qualify source durability, authority failover and complete restore

Status: **pending**. Owner: `source-recovery`. Dependencies: 4.1, 4.2, 5.1, 5.3, 2.3.

Proposed implementation scope:

- `core/control-plane/src/source_control/recovery.ts`
- `core/control-plane/src/source_control/backup.ts`
- `core/control-plane/src/source_control/routing.ts`
- `core/control-plane/src/source_control/registration.ts`
- `deploy/hyperfide/source-control/recovery-profile.schema.json`
- `tests/hyperfide/cases/source_control/6_1.py`
- `docs/hyperfide/source-control-recovery.md`

Future focused gate: `python3 tests/hyperfide/cases/source_control/6_1.py`.

Acceptance clauses: 2.5, 3.1, 3.2, 3.4, 3.5, 3.6, 11.1, 11.3, 11.6.
Canonical cases: SCM-018, SCM-019 (UNRUN).

Implementation and qualification obligations:

1. Define and validate a deployment durability profile naming metadata failure domain, required object placements, backup retention, RPO/RTO and tested backend capabilities. Reject readiness for absent mandatory profile inputs; do not infer cross-region replication or failover fencing from endpoint syntax.
2. Implement consistent metadata/root manifests and object retention barriers for backups, restore into a fresh authority epoch, and verify retained source closure before mutation readiness. Fence prior metadata/routing writers and reconcile persisted upload, pin, collection and Git-export intents without replaying completed external effects.
3. Exercise worker/API death before upload completion, after verification, after metadata commit and before response, verifying acknowledgment/retry identities and preservation of every acknowledged revision under the declared failure model. Rebalance a live object partition while reads and commits continue and test obsolete-owner rejection.
4. Run real metadata failover and restore with live selected object storage, including a deliberately missing referenced object, stale backup credentials, delayed old DELETE and an old writer attempting acceptance. The missing-object restore must fail its completeness gate; fresh content incarnations and successor authority must remain safe.
5. 6_1.py records exact source/profile/backend versions, fault schedule, acknowledged revision inventory, roots/object verification, recovery times and unresolved debt. Distinguish deterministic fault coverage from real infrastructure results; publish a recovery runbook and truthful PASS/FAIL/UNRUN statuses for every declared failure domain.

## 6.2: Measure within-monorepo growth, mixed load and real-storage endurance

Status: **pending**. Owner: `source-control-qualification`. Dependencies: 6.1, 4.3, 5.3.

Proposed implementation scope:

- `tests/hyperfide/cases/source_control/6_2.py`
- `tests/hyperfide/source-control/workloads/**`
- `tests/hyperfide/source-control/manifests/campaigns/**`
- `tests/hyperfide/source-control/registrations/6.2.json`
- `core/control-plane/src/source_control/metrics.ts`

Future focused gate: `python3 tests/hyperfide/cases/source_control/6_2.py`.

Acceptance clauses: 1.3, 1.4, 12.1, 12.2, 12.3, 12.4, 12.5, 12.6.
Canonical cases: SCM-020, SCM-021, SCM-022 (UNRUN).

Implementation and qualification obligations:

1. Implement seeded corpus and arrival-schedule drivers through the actual native API, separating logical files, unique content, hot directories and history depth; pin unchanged hardware and fixed 10-file/1 MiB edits across 10,000, 1,000,000 and 10,000,000-file corpora and register the SCM-020 component and full variants.
2. Implement mixed-load ramps and offered-load measurements for SCM-021: 5,000 active workspace clients, 100 new revision submissions/s for five minutes, the sustained daily target and a separate twenty-million-open admission profile. Record actual persisted revisions, hydrate bytes/cache/storage requests, latency histograms, timeout/refusal samples and independently observed accepted state.
3. Implement an explicit approved-campaign variant for SCM-022 using actual S3 and 72 elapsed hours with at least 100,000 new durable revisions per 24 hours. Inject supported throttling, credential rotation, GC and recovery drills; include a separately counted real Hyperfide worker canary and fail BLOCKED on missing required capacity rather than substituting a replay.
4. Test negative campaign manifests, zero offered work, imported-history inflation, replay counted as new commits, missing samples, missing real-backend capability, a dirty cache mislabeled cold and logical opens mislabeled materialization. Independently compare client operation ledgers and reachable objects to every acknowledged revision.
5. Keep the direct task gate a bounded implemented driver/harness check; full growth, 72-hour and scale variants require the separate registered campaign manifests. Persist exact machine-readable outcomes and cleanup inventory, and do not mark parent SCM-020/021/022 PASS from the bounded gate.

## 6.3: Qualify integrated native source control and independently close evidence

Status: **pending**. Owner: `source-control-qualification`. Dependencies: 6.2.

Proposed implementation scope:

- `tests/hyperfide/cases/source_control/6_3.py`
- `tests/hyperfide/source-control/closure.py`
- `tests/hyperfide/source-control/manifests/full/**`
- `tests/hyperfide/source-control/registrations/6.3.json`
- `tests/hyperfide/source-control/claims.json`

Future focused gate: `python3 tests/hyperfide/cases/source_control/6_3.py`.

Acceptance clauses: 12.1, 12.6, 12.7.
Canonical cases: SCM-023, SCM-024 (UNRUN).

Implementation and qualification obligations:

1. Implement SCM-023 through the actual Hyperfide native environment and CLI/API surfaces: real assignment, sparse edit, source diff, checkpoint, worker replacement, submission custody, conflict repair, exact-candidate qualification, atomic acceptance and external publication observation. Identify source snapshot and provider for every step.
2. Implement SCM-024 evidence closure over the feature-local registry and immutable receipts, checking exact requirement-clause/assertion inventories and required backend/provider variants; independently reconstruct source roots, accepted revisions, custody and remote effects without trusting handler success alone.
3. Reject unknown/empty case selection, missing drivers, zero assertions, fake exits, fabricated/tampered hashes, missing native input identities, stale receipts, duplicate assertions used to fill gaps, omitted live variants and incomplete cleanup with nonzero status and named unmet obligations.
4. Compare all required current SCM cases against the same release-candidate source and policy inputs, recording explicitly justified reuse for unaffected evidence and invalidating affected results. Preserve historical receipts and retain UNRUN/BLOCKED for anything not exercised.
5. Keep the focused task gate bounded to the real integration harness and closure failure probes; run the complete real-fleet/backend acceptance variants through their registered manifests. Produce a release qualification packet for task 7.1 without treating source acceptance, a task status or an authoring validator as full product qualification.

## 7.1: Ship native source documentation and reproducible release artifacts

Status: **pending**. Owner: `release`. Dependencies: 6.3.

Proposed implementation scope:

- `docs/hyperfide/source-control.md`
- `docs/hyperfide/platform.md`
- `docs/hyperfide/operations.md`
- `docs/runtime/source-control.md`
- `README.md`
- `core/control-plane/package.json`
- `sdk/source-control/package.json`
- `tests/hyperfide/cases/source_control/7_1.py`
- `spec/hyperfide-source-control/spec.kvx`

Future focused gate: `python3 tests/hyperfide/cases/source_control/7_1.py`.

Acceptance clauses: 14.1, 14.2, 14.3, 14.4.
Canonical cases: SCM-023 (UNRUN).

Implementation and qualification obligations:

1. Document the actual native CLI/API/SDK and user journeys, source scope/materialization modes, graph freshness, compatibility limits, authorization, retention, operator inputs and restore procedures with current evidence links. Mark unqualified profiles explicitly.
2. Package the service, host integration, CLI façade, SDK and required native filesystem component as reproducible release artifacts with pinned dependencies, manifests, checksums, supported format/protocol versions and upgrade compatibility. Do not require a source build on every agent host.
3. Exercise the packaged artifacts through API-only and materialized client journeys, source acceptance and remote status display. Validate installation and upgrade from the declared legacy profile against the qualified source/evidence adapters.
4. Create the task driver to verify artifact identities and executable documented commands against the packaged runtime, reject stale source/evidence references and incomplete release profiles, and run the specification/claim documentation checks. Prepare the changelog and release manifest without treating packaging as full release qualification.

## 7.2: Close the native source release with running-system evidence

Status: **pending**. Owner: `release`. Dependencies: 7.1.

Proposed implementation scope:

- `tests/hyperfide/cases/source_control/7_2.py`
- `tests/hyperfide/source-control/manifests/release.json`
- `docs/hyperfide/source-control.md`
- `docs/hyperfide/operations.md`
- `spec/hyperfide-source-control/spec.kvx`

Future focused gate: `python3 tests/hyperfide/cases/source_control/7_2.py`.

Acceptance clauses: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 14.1, 14.2, 14.3, 14.4, 14.5.
Canonical cases: SCM-023, SCM-024 (UNRUN).

Implementation and qualification obligations:

1. Run the released source-control system with the qualified deployment profile and current source format; demonstrate assignment, sparse/virtual workspace, native durable checkpoint, worker replacement, qualification, acceptance and Git remote publication through Hyperfide.
2. Verify all required canonical case assertions and campaign variants against exact release inputs. Retain component evidence separately from live S3, actual fleet, GitHub/GitLab, consolidation, growth and disaster-recovery evidence. Required missing cases must fail closure.
3. Exercise a restore or failover and an ambiguous external publication outcome using release artifacts, reconcile source and remote state, and record operator acceptance of the running product journey and supported limitations.
4. Create the release driver to validate current evidence/custody/source applicability and operator acceptance, refuse stale or partial receipts, and emit a complete closure report. Only qualified product evidence may move tasks/cases to done/pass; no generated authoring report can substitute.
