# Prerequisite: organize the repository by category

Status: **8,339 mapped paths physically relocated; tasks 0.4–0.8 in progress ahead of open prerequisites; task 0.3 graph qualification pending; full layout qualification UNRUN**. This is the first prerequisite to native source-control implementation. Requirement 15 and tasks 0.3 through 0.9 in [spec.kvx](spec.kvx) own the work. Fleet task 0.10 cannot start until task 0.9 qualifies; native task 0.1 also waits for final fleet gate 0.14. Existing task identities are preserved; dependency order, not numeric sorting, puts this prerequisite first.

## 1. Objective and boundaries

Replace the nested `platform/` and `services/` source containers with category-based top-level directories. A package belongs according to its purpose: SDK, core implementation, application, plugin, protocol contract, shared library or tooling. The layout must not recreate the old containers under another parent.

The move preserves behavior, published package names, imports by package identity, exports, CLI commands, plugin/extension IDs, module identities, licenses and source history. Existing package units remain intact, including units with mixed responsibilities. Splitting those packages, changing their architecture, upgrading dependencies, merging databases or implementing native source control is outside this prerequisite.

The [machine-readable mapping](repository-layout.json) is the complete proposed path contract at baseline `2f7331ef2085f6f374adf2d1e2ee01405fecb72d`. It identifies the original 8 direct application units and 38 direct package units under `platform/`, the control-plane service, plugins and supporting assets/configuration. Task 0.3 separately pinned the implementation baseline before relocation; the original design mapping and both historical revisions remain fixed.

## 2. Target categories

```text
core/                  Engines, servers, host runtimes and implementation packages
  native/src/          Existing C implementation
  kvx/                 KVX module, language specification and fixtures
  control-plane/       Existing control/provision/dispatch service
  server/              Existing platform server
  host-daemon/         Existing host daemon
sdk/                   Public/client and plugin-authoring SDKs
  client/              Existing @hyperfide/sdk
  plugins/             Existing @hyperfide/plugin-sdk
  source-control/      Future native source-control SDK
contracts/             Wire schemas and cross-process contracts
lib/                   Shared internal libraries, including UI helpers
apps/                  Web, desktop, mobile, CLI and distribution launcher
plugins/               Product plugins and provider integrations
extensions/            Separately packaged editor extensions
tools/                 Build, development, maintenance and test-support tools
examples/              Demonstration applications and example plugins
tests/                 Test suites and fixtures
docs/                  Product/runtime documentation and runbooks
assets/                Shared application assets
patches/               Authored dependency patches
runtime/               Supervisory runtime entrypoints
deploy/                Deployment and artifact assembly
vendor/                Pinned third-party native sources
spec/                  Specifications and their authoring tools
licenses/              Attribution
```

Root workspace/configuration files remain at the root. Tool-discovery conventions such as `.github/`, `.agents/`, and the environment setup hook are explicit exceptions, not additional source containers. Package-local tests, migrations, assets and schemas may stay with their owning package where runtime loading or publication relies on that package boundary. Category organization does not mean scattering every individual file by extension.

| Current unit | Destination | Preserved identity or boundary |
|---|---|---|
| `services/hyperfide/` | `core/control-plane/` | `@hyperfide/control-services`, its npm lockfile, migrations and component loader |
| `platform/apps/server/` | `core/server/` | `@hyperfide/server` |
| `platform/apps/host-daemon/` | `core/host-daemon/` | `@hyperfide/host-daemon` |
| `platform/apps/app/` | `apps/web/` | `@hyperfide/app` |
| `platform/apps/desktop/`, `platform/apps/mobile/` | `apps/desktop/`, `apps/mobile/` | Existing desktop/mobile packages and installed identities |
| `platform/apps/cli/` | `apps/cli/` | `@hyperfide/cli`, including the `hyperfide platform` public front door |
| `platform/packages/hyperfide-app/` | `apps/launcher/` | Existing executable distribution and bin names |
| `platform/packages/sdk/` | `sdk/client/` | `@hyperfide/sdk` |
| `platform/packages/plugin-sdk/` | `sdk/plugins/` | `@hyperfide/plugin-sdk` |
| `platform/packages/*-contract/` | Explicit entries under `contracts/` | Existing wire schemas and package identities; not a blind filename rule |
| `platform/packages/db/` | `core/runtime-db/` | Runtime database; it is not merged with control-plane storage |
| `platform/packages/bundled-plugins/` | `tools/bundled-plugins/` | Existing bundling package |
| `platform/packages/scripts/` | `tools/scripts/` | Packaged command/helper unit |
| `platform/scripts/`, `scripts/` | `tools/workspace/`, `tools/repository/` | Distinct un-packaged tooling groups |
| `platform/plugins/` | `plugins/` | Runtime plugin registry and plugin IDs |
| `editors/vscode/`, `kvx/editors/vscode/` | `extensions/vscode/`, `extensions/kvx-vscode/` | Distinct extension IDs, versions and VSIX contents |
| `platform/docs/` | `docs/runtime/` | Current runtime documentation |

Not every package with exports is an SDK. The authority client includes storage/migration responsibilities and remains `core/authority-client/`; the provider bridge protocol package includes runtime machinery and remains a core package. Shared formatting and UI helpers belong in `lib/`. The inactive gateway remains inactive after its move; a layout change must not activate or remove a product capability.

## 3. Workspace and toolchain migration

Promote the former platform workspace to root `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, Turbo, Vitest and lint/format configuration. Workspace membership is generated from the explicit package inventory, including the relocated plugin/example/test packages. Do not blindly include every directory under every category: `core/control-plane/` retains its independent npm manager and must be explicitly excluded from pnpm ingestion. Standalone extension and KVX module boundaries remain explicit too.

Use the current pinned package managers. Regenerate pnpm importer, workspace-link and patch paths while retaining resolved dependency versions and integrity records. Compare the dependency graph before and after; an unexpected version change is a relocation defect, not a free upgrade. Preserve the independent control-plane package lock and TypeScript profile.

The baseline has real Node-profile drift: the workspace `.nvmrc` says `22.19.0`, workspace CI/documentation select Node 24, and the control service pins Node `24.22.0` with npm `11.19.1`. The move records and preserves these scoped invocation profiles until an explicit reconciliation is qualified. It must neither silently change the development pin nor describe the existing files as a consistent single version. Package-manager or compiler consolidation is separate work.

Temporary migration launchers may route an old development command to the new root during the move. Their lifetime is bounded by task 0.8. The qualified final checkout must not need a `platform/` or `services/` directory symlink, duplicate source tree, second workspace root, or hidden old lockfile.

## 4. Path-dependent behavior that must move with its producer

| Contract | Required relocation work and verification |
|---|---|
| Native compilation | Root Makefile discovery, include paths, source/object rules, unit tests and native component KVX source/header/support paths must resolve `core/native/src/`. Keep pinned native third-party sources under `vendor/`. |
| CLI discovery | Update the C `platform_cmd`/help resolver and installed/nested-cwd probes to find `apps/cli/bin/hyperfide-platform`. Preserve existing overrides, command spelling, streams and exit status. |
| Package loaders | Preserve package-relative service `src/dist`, migrations and components. Relative module URL loading must work from the relocated and packaged forms. |
| Root calculation | Scripts moved into `tools/` cannot keep an assumed one-level `dirname` root. Use a qualified root resolver with nested-cwd and installed-artifact cases. |
| Workspace membership | Compare discovered package identities before/after; retain intended tests and example plugins without accidentally installing test fixtures as production packages. |
| Generated outputs and Turbo | Remap input globs, output paths, directory filters, registry/template generation and shared changelog inputs. Prove a changed moved file invalidates a warm cache. |
| Environment setup | Move the implementation to `tools/workspace/env-setup.sh` and retain the conventional root `.hyperfide-env-setup.sh` delegator, or explicitly qualify a discovery protocol migration. Preserve install-input hashes against root lock/workspace/package files. |
| Plugins and SDKs | Update scaffold templates, SDK-relative references, bundled-plugin builds, registry sources, example consumers and generated documentation. Preserve runtime plugin IDs and export subpaths. |
| CI | Update path triggers, working directories, cache keys, build commands and tests that assert those interfaces. Edits in every moved category must trigger the appropriate existing checks. |
| Sandbox preparation | Update build/probe/prepare commands and changed-path detection. Prepared images identify the layout generation; old images cannot be presented as ready for the new layout. |
| Release and deployment | Adapt source inputs and checkout fallback paths. Preserve existing installed artifact paths, including packaged `services/dist`, unless a separate versioned artifact-format migration is qualified. |
| Extensions and KVX | Keep extension IDs/archive members and the published Go module path. Source relocation alone does not rename either public interface. |
| Ignore and attributes | Re-anchor nested rules, preserve tracked desktop assets and authored patches, and preserve exclusions for generated/private files. Detect newly exposed files before staging. |
| Documentation and history | Update current executable examples and links. Preserve historical source paths, fixture transcripts, signed receipts and old specs at their original revision. Maintain an explicit exception catalogue. |

These are source-grounded obligations. The referenced baseline files remain readable through [repository-baseline.md](repository-baseline.md) and the mapping; specification authoring itself establishes none of these runtime checks. Current implementation evidence is scoped in section 8.

## 5. Prerequisite sequence

| Task | Deliverable | Gate before continuing |
|---|---|---|
| 0.3 | Refresh complete move/merge/keep manifest, file/mode inventory and runtime baseline | No uncovered inputs or unexplained collisions; baseline check outcomes recorded |
| 0.4 | Establish root workspace front door and relocation tooling | Correct package discovery, pinned installs, path/root discovery and transitional commands |
| 0.5 | Move native/core/control components with their callers | Native build/discovery, control schema/components and core runtime checks |
| 0.6 | Move SDKs, contracts, libraries and packaged tooling | Consumer imports, exports, generation, package tests and cache invalidation |
| 0.7 | Move apps, plugins, extensions, examples and assets | Product launches, plugin discovery, scaffold consumers, extension/package contents |
| 0.8 | Complete CI, preparation, release, docs and configuration migration | No live old-root dependence; packaged/deployment contracts and ignore boundaries preserved |
| 0.9 | Qualify the relocated repository and record the handoff | Current complete layout receipt; then fleet prerequisite task 0.10 becomes eligible |

Each move includes the producer's direct callers and relevant configuration so the task's resulting candidate is runnable. Final cleanup is not permission to leave prior tasks falsely green with broken imports or discovery. The integration branch changes to the new layout only with the qualified revision and compatible prepared-image/build manifests; partial moves stay in isolated candidates.

## 6. Qualification, history and rollback

SCM-025 is the layout case. Its prerequisite task drivers use existing builds/runtime contracts and legacy Git source evidence; they do not depend on the native SCM API, S3 backend, future SDK or task 0.2. Task 0.9 emits its own exact assertion inventory and layout receipt. Task 0.2 later registers the compatible SCM namespace and imports that evidence with its original source identity; it cannot retroactively manufacture a pass.

The layout receipt includes input and resulting Git revisions, mapping digest, file/mode inventory, identity/dependency differences, actual checks and exits, build/artifact identities, CI-trigger checks, prepared-image layout generation, supported runtime profiles and known baseline failures. Existing unrelated failures remain explicit; no required layout proof may be waived by calling a new regression pre-existing.

Validate actual core/server/host/CLI operation, app startup and affected desktop/mobile packaging on supported executors, SDK/plugin consumers, editor artifacts, test-suite discovery, cold/warm cache invalidation, sandbox preparation and nonpublishing release assembly. A path grep, TypeScript pass, or successful file move alone does not qualify the layout.

Old specifications and signed evidence remain attached to their original source revision. The new source-control plan's future paths use the target categories now, but its source-inspection links continue to document the old baseline until the corresponding code moves. Historical paths must not be mass-rewritten to imply past tests ran against the new layout.

Before native implementation begins, rollback can select the retained pre-layout revision and its compatible images/configuration, while preserving any uncommitted work. Once new source work exists, rollback requires a reviewed reverse mapping/cherry-pick or forward repair; it cannot discard later changes. No permanent duplicate source trees are maintained.

## 7. Executable inventory and baseline capture

Task 0.3 provides [layout-inventory.py](../../tools/repository/layout-inventory.py), a read-only consumer of the mapping. `source_baseline` retains the original design inspection; `implementation_baseline` pins the refreshed tracked-source inventory. `category-layout-v1` identifies the target layout. Later tasks must reject unexplained drift before moving files.

```sh
python3 tools/repository/layout-inventory.py --mapping spec/hyperfide-source-control/repository-layout.json --revision HEAD --output build/layout/inventory.json
python3 tests/hyperfide/cases/source_control/0_3.py
```

The inventory records original and target paths, Git object identities, types/modes, package declarations, dependency and configuration inputs, rewrite obligations and an inverse plan. Intentional merges retain every original input and are never declared automatically reversible. Historical references and installed artifact paths are classified separately from checkout references; unresolved references need explicit disposition during their owning move task.

The focused driver writes `build/layout/0.3/inventory.json`, `baseline.json` and `receipt.json`, with command logs and input digests. It exercises rejection of incomplete mappings, collisions including case-folded destinations, path escapes, source/artifact confusion, package identity drift, dependency drift and mode changes. These are inventory/validator checks, not evidence of a relocated runtime.

Baseline probes observe native component discovery and available tool versions without installing dependencies or running full product builds. Missing dependency trees, unavailable tools and absent binaries remain recorded. Workspace package membership, package test scripts and root Vitest project discovery are separate inventories. Installed global tools do not prove this checkout builds. Final layout qualification still belongs to task 0.9.

### Task 0.3 focused result

The inventory driver passed 22 assertions against implementation baseline `5958bcb02cef0e5fa75d7b0239a6cd2191278bd1`. It recorded 9,786 tracked inputs, 117 package manifests, 108 workspace packages, 47 root Vitest projects, 13 native component fragments and one explicit merge target. At that inventory stage, no source files moved. The receipt and complete inventory are local build artifacts identified above; the driver recreates them from the pinned revision.

Observed host tools were Python 3.12.3, Node 22.22.2, npm 10.9.7 and pnpm 12.8.1. These differ from some declared workspace/control/release profiles. Dependency trees and checkout-built executables were absent; product builds and runtime checks remain UNRUN. Task 0.4 must provision/use the existing pinned profiles, not substitute these host defaults or silently upgrade project dependencies.

A full initial Hyperfide graph scan was interrupted; complete graph indexing is not part of this result. The inventory uses pinned Git objects and explicit runtime drift detection. Full relocated behavior remains the obligation of later tasks and SCM-025.

The full `hyperfide spec done 0.3 -f hyperfide-source-control --no-sync` command was terminated with exit 143 after the focused gate passed: its graph refresh remained unfinished. [qualification.kvx](qualification.kvx) records the distinction. Task 0.3 remains **implemented**, not **done**. Later relocation tasks now record in-progress work ahead of their open dependencies; this does not release the missing graph/evidence gate. The passing inventory gate has not been rerun.


## 8. Current relocation progress

The working tree now contains 8,339 mapped file relocations into `core/`, `sdk/`, `contracts/`, `lib/`, `apps/`, `plugins/`, `extensions/`, `tools/`, `examples/` and the supporting category roots. The root pnpm workspace excludes the independent `core/control-plane` npm package, KVX module and separately packaged extensions. Original package/public identities and the pinned source and implementation baselines remain the comparison inputs; the mapping is not rewritten to erase the original paths.

Tasks 0.4–0.8 are **in progress**. Their `execution_mode = "ahead"` annotations record that relocation work has occurred while direct prerequisites remain open. They are progress annotations, not qualification receipts or substitutes for the engine's ownership/lease records. Task 0.3's graph gate remains outstanding. Task 0.9 and full layout case SCM-025 remain pending/UNRUN; fleet and native source-control implementation remain pending.

| Observed check | Result and evidence scope | Recorded log or receipt |
|---|---|---|
| Current file/mode structure | PASS for 9,786 inventoried files, 8,811 unchanged contents, with no missing mapped files or mode errors at that check. This checks paths/modes, not executable behavior. | `build/layout/workspace/structure-receipt.json` |
| Native/core relocation | Native compilation passed; the focused gate reports 1,325 checks covering native/component and control-source closure, module URLs, retained migration bytes and source/installed path distinctions. PostgreSQL bootstrap, platform CLI execution, packaged supervisor and KVX runtime tests are outside that result. | `/tmp/neron-native-relocation-build.log`, `/tmp/neron-native-relocation-gate.log` |
| SDK/registry/extension paths | PASS: registry generation matches 106 items, 22 real SDK runtime source/copy entries resolve, eight changed JavaScript modules parse and two extension manifests validate. No full app/SDK typecheck or packaging campaign is implied. | `/tmp/neron-layout-owned-gate.log` |
| Tools/deployment/CI paths | PASS: syntax of 8 Python, 14 shell, 36 MJS and 17 JSON files; 18 native source/support paths discovered; source-stamp checks over 165 control inputs and temporary fresh/stale states; root-based workspace tooling imports. No release construction, provider operation or service startup was run by this gate. | `/tmp/neron-layout-tools-gate.log` |
| Root workspace dependencies | Frozen install passed using Node 22.19.0 and pnpm 9.15.0, including preparation after the relocated generator fallback was repaired. Dependency setup is not workspace build/test qualification. | `build/layout/workspace/dependencies/workspace-install.log` |
| Independent control-plane dependencies/build | `npm ci --ignore-scripts` and `npm run build` passed using Node 24.22.0/npm 11.19.1. Runtime startup, PostgreSQL integration and source-control qualification are outside this result. | `build/layout/workspace/dependencies/control-install.log`, `build/layout/workspace/dependencies/control-build.log` |

The focused gate logs under `/tmp` are local working evidence and are not release receipts. Combined layout closure must retain the required artifacts under its declared evidence policy and rerun only checks invalidated by subsequent relevant edits. Integrated workspace build passed under Node 22.19.0/pnpm 9.15.0 (65/65 Turbo tasks; `build/layout/workspace/dependencies/workspace-build.log`) after repairing the profile-worker generator directory URL and restoring its input source. Broader runtime, cache invalidation, prepared-image, packaged startup and combined layout evidence remain unestablished. No passing component gate changes SCM-025 from UNRUN.
