# Fleet sandbox source and environment contracts

Status: proposed prerequisite contract. The `.neron` grammar, `package.kvx` grammar and `hyperfide install` behavior below are implementation requirements, not assertions about commands or formats already shipped. Source-control engine implementation remains pending. The examples are structurally illustrative and carry unresolved example digests; they cannot establish a ready environment.

A fleet sandbox carries two distinct inputs before worker execution:

- `.neron` describes how source is accessed: the online endpoint, repository, source backend, immutable revision, workspace identity/generation, read/write scope, cache policy and authentication profile references.
- `package.kvx` describes the sandbox environment: source mounts, dependency installation, toolchains, configuration references, selected interfaces, readiness probes and worker-slot isolation. Its role resembles a package manifest for an environment. It is neither a task assignment nor a replacement for Hyperfide's spec task/package and attempt records.

Task dispatch subsequently binds a ready environment and worker slot to an independently authorized task attempt. Editing either file does not grant source permission, change task ownership or authorize execution.

## 1. Grammar and identity

Both files use the existing simple KVX shape: `[section.name]`, then `key = value`, with one JSON string, integer, Boolean or array of strings per line. Comments begin with `#`; unknown sections/keys, duplicate sections/keys and ambiguous input are rejected under the selected schema version. There is no shell interpolation, implicit include or executable KVX value. Placeholder expansion occurs only in explicitly documented path-template fields and accepts installer-owned values such as `{slot}`.

A versioned schema defines the permitted keys and value constraints. The installer validates the complete bootstrap input before producing an installation plan. It returns exact diagnostics for unsupported versions, missing references and incompatible host capabilities. It does not guess a missing backend, revision, scope or dependency lockfile.

The package digest is computed from its canonical parsed content; `.neron` has its own canonical digest. The package pins `.neron` through `source.config_digest`; `.neron` does not hash the package back, avoiding a circular identity. A ready receipt binds both digests together with environment identity/generation and resolved inputs. Hashes identify content; they do not establish authorization.

`meta.example = true`, an `example.invalid` endpoint, placeholder identifiers or all-zero artifact digests make an example non-runnable. Static example validation may pass while installation readiness must fail. The [package example](examples/fleet/package.kvx) and [source configuration example](examples/fleet/.neron) describe the format without claiming that their prospective source layout or artifact pins exist.

## 2. `.neron`: proposed source configuration v1

Every fleet sandbox has a protected environment-level `.neron` delivered by the coordinator. Each writable worker view receives an effective `.neron` with that view's actual workspace ID and generation. The original descriptor remains unchanged and attributable. A shared file is never repeatedly overwritten to represent different workers.

| Section | Required fields | Contract |
|---|---|---|
| `[meta]` | `format`, `schema_version` | `format = "neron.source-config"`; v1 schema. Optional `example` explicitly prevents readiness. |
| `[source]` | `endpoint`, `repository`, `source_backend`, `revision`, `auth_profile` | Nonsecret online endpoint, stable logical repository identity, configured adapter name, immutable source revision and credential-profile reference. Native revisions use the source protocol's typed identity; the initial Git adapter accepts `git:<full-commit-id>`. Branch names and unqualified `latest` are not immutable pins. |
| `[workspace]` | `workspace_id`, `workspace_generation`, `environment_id`, `environment_generation`, `authority_epoch`, `read_scope`, `write_scope` | Current environment/view association and explicit repository-relative allowed path patterns. Write scope must be contained in read scope and in server-granted capability. Generations are positive integers or explicit opaque authority values where the authority schema requires them. |
| `[cache]` | `directory`, `max_bytes`, `max_entries`, `security_domain` | Absolute host/sandbox cache path, positive clean-cache bounds and authorization domain. Cache data is immutable; dirty files and pending uploads live elsewhere. |
| `[client]` | `mode`, `dirty_directory`, `network_policy` | Mode is `api_only`, `sparse`, `virtual` or explicitly `materialized`; dirty data has a private absolute location. `network_policy = "online-required"` does not grant offline write authority. |

The endpoint and repository namespace are validated against coordinator policy; a source file cannot redirect credentials to an arbitrary host. `auth_profile` resolves through the enrolled sandbox's secret/capability channel. The file contains no token value, access-key secret, private key, unrestricted bucket credential or secret-bearing URL. Reference resolution checks audience, repository/scope, expiry and environment generation. A profile's existence is not itself a permission grant.

The installer treats `read_scope` and `write_scope` as requested/configured bounds. Effective access is their intersection with current service authorization and any subsequently assigned task scope. The source server or existing authorized adapter enforces the result. A worker changing local scope strings cannot widen access or revive a revoked generation. A disconnected sandbox cannot renew workspace authority by editing configuration.

The environment-level workspace may be a coordinator-admitted read-only base view. Worker preparation derives private writable views, each with its own workspace identity, generations and effective scope. There is no writable shared default checkout used by every worker.

## 3. `package.kvx`: proposed sandbox environment manifest v1

| Section | Fields | Contract |
|---|---|---|
| `[meta]` | `format`, `schema_version`, `name`, `version`, optional `example` | `format = "hyperfide.sandbox-package"`; human-readable environment package identity. Its version does not replace source or dependency digests. |
| `[environment]` | `environment_id`, `environment_generation`, `platform`, `image_digest`, `root` | Coordinator-selected sandbox generation, OS/architecture, immutable image identity and absolute environment root. A new incompatible input plan creates a new generation. |
| `[bootstrap]` | `installer_path`, `installer_version`, `installer_sha256`, `delivery` | Prebuilt installer location/version/digest and `image` or `coordinator-artifact` delivery. Installer authentication roots are supplied outside fetched source. |
| `[source]` | `config`, `config_digest`, `adapter_contract` | Path to the delivered `.neron`, its expected digest and supported source-manifest adapter version. `config` resolves inside the protected bootstrap input directory. |
| `[mount.<name>]` | `kind`, `source`, `paths`, `target`, `access`, `mode` | Named scoped source mount from the `.neron` repository and revision. `access` is `read_only` or `private_overlay`; it never overrides source capability. Paths must be contained in effective read scope. Targets cannot overlap incompatibly or escape the environment root. |
| `[toolchain.<name>]` | `kind`, `version`, `delivery`, `artifact_digest`, `executable` | Exact tool version plus immutable image/artifact pin and absolute executable identity. Required tools exist before dependency commands that need them. |
| `[dependency.<name>]` | `manager`, `version`, `mount`, `lockfile`, `lockfile_digest`, `include`, `argv`, `script_policy` | Pinned package-manager version, named source mount, committed lockfile and digest, selected package names, argument vector and approved lifecycle-script policy. The source lockfile remains authoritative. |
| `[configuration.<name>]` | `kind`, `reference`, `target`, `mode`, `required` | Typed `config-ref` or `secret-ref` resolved through the enrolled environment channel, installed with declared path permissions. Values are absent from the manifest and logs. |
| `[interfaces]` | `catalogue`, `catalogue_digest`, `source_revision`, `selected_ids`, `output`, `max_blocks`, `max_bytes` | Exact catalogue/generation pin, source pin, explicit interface IDs, bounded derived output and limits. Selection behavior is defined in section 5. |
| `[install]` | `scope`, `stages`, `reuse_policy`, `dirty_policy` | Installation scope `environment_generation`; fixed dependency-ordered stages; exact-input clean reuse and dirty-conflict refusal semantics. |
| `[probe.<name>]` | `argv`, `cwd`, `timeout_seconds`, `expected_exit` | Bounded noninteractive probe against the installed environment. Argument arrays are executed without implicit shell parsing. A probe cannot replace source/dependency verification. |
| `[workers]` | `slots`, `source_template`, `home_template`, `build_template`, `temporary_template`, `dirty_template`, `isolation` | Positive worker-slot capacity and separate writable roots. `isolation = "private-overlay"` requires host-enforced path/process boundaries appropriate to the sandbox profile. |
| `[readiness]` | `require_stages`, `require_probes`, `receipt` | All named completed stages/probes and a durable ready-receipt destination. Missing inputs, stale grants, unsupported modes or failed probes prevent readiness. |

The v1 `source` refers to the one source repository configured by the paired `.neron`; `mount.<name>.source = "primary"` names this singleton source. Multiple mounts select different regions of that same pinned repository. Adding other repositories requires a versioned explicit extension; a dependency command must not silently fetch an unrelated mutable repository.

Paths and glob semantics are versioned and platform-independent. Mount metadata records the resolved selected paths, scope and source-manifest digest. Missing sparse paths are omitted source, not deletions. A package may request `api_only` work with no source mount, or virtual access with lazy hydration. A full materialized mount requires an explicit full selection and recorded cost/reason policy; the installer does not expand a small mount to the whole monorepo implicitly.

Dependency installation reads the pinned lockfile at the selected source revision, verifies its digest and follows its package-manager/version semantics. Before ready publication, the installer owns a private staging view of the source and dependency output paths. A mount declaring `read_only` describes the completed worker-visible base, not a prohibition on creating dependency outputs in installer-owned staging. Package-manager writes remain confined to that staging view; required dependency output directories are excluded from source mutation capture. The installer revalidates tracked source and lockfile identities after lifecycle scripts and refuses undeclared tracked-source changes before freezing the prepared base. The resolved dependency closure includes required workspace manifests and build configuration, even where those are read-only. Missing closure is a failed plan or an explicit authorized widening, not silent lockfile regeneration. No `--no-frozen-lockfile` fallback is implied. Registry/auth access, lifecycle scripts and network endpoints follow the approved environment plan. An installer cannot claim readiness from a cache entry alone without checking its input identity and completeness.

Toolchains can be present in the image or delivered as immutable coordinator artifacts. An image containing an approximate major version does not satisfy an exact version/digest pin. The installer records its own version separately from the tools it installs.

## 4. Bootstrap delivery and installation order

`hyperfide install` prepares the sandbox environment before task workload execution. The manager/coordinator authorizes one installation per environment generation through a durable operation identity. The sandbox entrypoint or first worker bootstrap can invoke the command; other starting workers wait for that same operation and its ready receipt. Agent process startup does not itself establish workload readiness. Multiple workers do not race to mutate the same dependency installation or base source tree. Additional slots consume the completed immutable/base environment and create private views.

A fresh sandbox does not need to fetch Hyperfide source to obtain the command that fetches source. Provisioning supplies either an image with a verified prebuilt installer or a small verified installer artifact delivered through the provider/coordinator channel. The bootstrap payload includes `package.kvx`, `.neron`, trust/configuration references and the bounded interface selection input. The installer artifact is independently versioned and pinned. It does not build itself from an unavailable repository as a prerequisite.

The fixed installation state machine is:

1. **Bootstrap preflight:** verify installer identity, schema versions, input digests, host capabilities, writable roots and available disk/budgets; obtain the current environment-generation install lease. This is a narrowly scoped installation lease, not a repository commit lock.
2. **Authority resolution:** authenticate the enrolled environment, resolve profile/configuration references and compute effective scope. Secret values are delivered only to their intended consumer. Reject stale generations and unsuitable endpoints.
3. **Plan resolution:** resolve the pinned source revision, selected paths, dependency closure, exact toolchains/configuration and interface selection. Record an immutable install-plan digest and capability expiration/renewal policy before long work.
4. **Source preparation:** fetch the requested code/metadata through the selected adapter, verify source manifests/content and stage generation-owned bases and private overlay templates. Worker-visible read-only permissions are finalized at ready publication; installation has no access to a running worker overlay. No full history clone or full interface catalogue is required in the sandbox.
5. **Toolchain preparation:** verify image tools or fetch pinned artifacts, then expose their paths to the installation environment. Toolchain changes invalidate dependent installed outputs.
6. **Dependency preparation:** install the selected lockfile-defined dependencies into generation-owned paths, using bounded shared immutable download caches where authorized. Stage incomplete outputs; expose only complete installs. Record manager, lockfile, selection, scripts and resulting closure identity.
7. **Configuration preparation:** resolve and install only required configuration references and secret mounts with appropriate permissions. Record reference identities/versions without hashing secret plaintext into publicly visible receipts.
8. **Interface preparation:** verify catalogue/source pins and extract or verify the bounded selected blocks into the declared derived output. Record coverage and omitted references.
9. **Readiness probes:** execute declared probes against the exact installed source/toolchain/configuration plan and record complete exit outcomes. A timeout or skipped required probe cannot count as passed.
10. **Ready publication:** freeze the completed base to its declared access mode and atomically expose the generation and receipt after all prerequisites pass. Only then may the coordinator assign worker workloads to slots. A lost response is reconciled by install operation and generation before another preparation attempt.

The stages are ordered by their declared inputs. A backend may pipeline independent downloads, but cannot publish source/dependency/configuration readiness before verification. No metadata transaction remains open around downloads, package-manager execution or probes.

## 5. Interface subset contract

The supplied catalogue shape uses blocks such as `[interface.<id>]` with `kind`, `path`, `line`, `signature`, `callers`, `status`, `contract` and `notes`. `interfaces.kvx` is generated from source/spec fragments; edits belong in those inputs. This contract does not reinterpret the catalogue as task assignments or assume its `status` proves implementation qualification.

The package selects `interface.fleet.install` and `interface.fleet.source-config` in the [illustrative fleet interface fragment](examples/fleet/interfaces.kvx). The resolved catalogue and source revision are pinned. Selection extracts complete blocks by identity, preserving the declared fields. `path` and `line` are interpreted at that source revision; they are not permission grants. `callers` and referenced contracts may require separate source scope and bounded dependency context.

Catalogue selection happens server-side or from a bounded delivered fragment. A sandbox does not download the entire catalogue just to filter two entries. If transitive interface context is required, the resolver follows explicit references within `max_blocks` and `max_bytes`, reports selected and omitted IDs, and requests an explicit expanded plan when required context exceeds limits. It never truncates a block silently or claims a complete contract from an incomplete selection. Unauthorized symbols/callers are not disclosed by selection metadata.

The derived fragment records its own digest, source revision, catalogue digest, resolver version, selected IDs, coverage/omission manifest and generation in the install receipt. The installer never rewrites the authoritative generated catalogue to mark progress or inject an environment-specific value. Catalogue source drift or a missing selected ID invalidates interface preparation; it does not silently substitute the nearest matching signature.

## 6. Idempotency, dirty safety and multiple workers

Installation is identified by `(environment_id, environment_generation, canonical input-plan digest, installer version)`, with a durable operation ID for retries. An identical completed request verifies the ready receipt and retained inputs, then reuses them. A repeated operation with different inputs is refused. A package/source/toolchain/lockfile/configuration-reference change produces a new plan and, when it changes the prepared environment, a new generation. A new generation cannot overwrite a running generation's source, dependencies or dirty overlays.

An interrupted install resumes verified stages from its persisted ledger or discards private staging directories after reconciling external outcomes. Unknown install or download outcomes are inspected before replacement. The ready marker is created last; the existence of a source directory or package-manager cache does not establish readiness. The coordinator owns install retries and reports preparation failures before worker admission.

Each worker receives an independent workspace ID/generation, source overlay, home, dependency-write view where needed, build output, temporary paths and dirty journal. Shared code bases, compiler inputs and dependency caches are immutable or copy-on-write. Mutable hardlinks, shared writable `node_modules`, shared secrets and a common writable checkout are forbidden. If a tool requires mutation of installed dependencies, the slot gets a private writable layer with its own budget. Ports/process identities are scoped by the execution profile.

Reuse verifies source/plan identity and clean state. If dirty files would be overwritten, the installer refuses with the affected workspace and recovery choices. It may preserve them for an explicit checkpoint/export/adoption operation authorized separately; it cannot auto-stash, delete, reset, rebase or silently move them. Cleanup of abandoned generations observes active workers, source retention and submitted-result custody. Cancelling a workload does not remove its last acknowledged checkpoint.

## 7. Prerequisite source adapter and later engine transition

This environment contract must work before the native source-control engine exists. Its initial adapter may read current Git objects or a coordinator-produced manifest of the selected pinned Git revision. The coordinator may use existing Git facilities to obtain that revision; the sandbox installer consumes a manifest, code objects and configuration references through the same source-preparation interface. The example's `git:` identity denotes that compatibility adapter and does not imply native revision semantics.

The later native adapter supplies native revision/tree identities, scope authorization, content objects and workspace generations through the same manifest contract. `package.kvx`, selected interface blocks, dependency preparation and readiness behavior remain unchanged except for explicitly versioned source identity/backend fields. Native-engine code is therefore a consumer of the prepared environment, not a dependency required to bootstrap its first implementation worker. Source-only installation correctness is qualified independently from native commit/merge/acceptance correctness.

A materialized code tree is not a complete local source-control server. Metadata queries, ancestry, merge and rebase remain online service operations. The Git prerequisite adapter must remain visibly identified during migration and must not appear as an implicit fallback when a native source operation fails.

## 8. Required future evidence

Prerequisite qualification must demonstrate a fresh sandbox receiving bootstrap inputs before worker execution, resolving a pinned scoped source view, installing declared locked dependencies/toolchains/configurations, selecting the bounded interface fragment and emitting a ready receipt. Negative cases include stale environment/workspace generation, mismatched source/config/lockfile/catalogue digest, missing interface block, incompatible toolchain, unavailable configuration reference, interrupted installation, duplicate operation, dirty reuse and two slots attempting to mutate shared cache/dependencies.

The receipt includes environment/generation, installer and input digests, effective source/scope/closure, dependency/toolchain identities, configuration reference versions, interface selection coverage, stage outcomes, probes and timestamps. Sensitive values are absent. Runtime evidence must distinguish a real provider sandbox from a fixture and distinguish successful prerequisite installation from source-control feature qualification. This document and its example files provide no runtime evidence by themselves.
