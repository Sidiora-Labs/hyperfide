# Hyperfide fleets

The fleet supervisor runs a Primary and separately authenticated Wave Managers on the supervisory host. Models choose typed actions from observations of accepted programme state. PostgreSQL transactions validate current hierarchy ownership, generations, delegated budgets, reservations and readiness before an action can take effect. Implementation workers run in sandbox slots.

The implementation lives in [fleet orchestration](../../core/control-plane/src/agents/fleet_orchestration.ts), [manager effects](../../core/control-plane/src/scheduler/fleet.ts), [install authority](../../core/control-plane/src/preparation/fleet_authority.ts) and the [supervisor](../../core/control-plane/src/fleet-supervisor.ts). See [operations](operations.md#fleet-supervisor-operations) for configuration and recovery.

## Model-driven lifecycle

1. An authenticated operator establishes the run, accepted specification, registered supervisory identities, hierarchy and provider resources. The Primary has the `LEADER` identity role; each Wave Manager has a distinct `FEATURE_MANAGER` identity and signing key.
2. The supervisor acquires or resumes leadership, binds the host cohort and requests observations. The Primary chooses `CONFIGURE_WAVE` to configure an accepted package through hierarchy authority, then `DELEGATE_WAVE` for a WAVE package and an eligible child manager, including explicit action, provider, profile, task and concurrency budgets. It can record a `REPLAN` proposal, explicitly admit an existing versioned replan through specification authority, or choose a `COORDINATE_DEPENDENCY` notification for an active package. Coordination never releases a dependency milestone or creates tasks.
3. The supervisor enrolls or loads the selected manager's own credential, binds its current package generation and wakes its model session. Managers choose provisioning, reuse, installation, assignment, steering, cancellation, shutdown, coordination or replanning actions inside their delegated authority.
4. Each reasoning operation persists the observed context and selected action. The action router applies that exact decision through the owning API. A missing model or uncertain response leaves a waiting or reconciliation state; the controller does not invent a replacement choice.
5. Provider intents, worker claims, resource reservations and runner execution retain their existing admission and reconciliation boundaries. A model decision alone does not establish successful provisioning, installation, task acceptance or publication.

The supervisor polls state and resumes persisted operations. It does not select the next package, sandbox or task on behalf of the model. Task pages are collected completely within explicit page and byte bounds; oversized or incomplete context is refused. This interface currently bounds whole-programme context, so large programmes require appropriately scoped accepted work rather than assuming unlimited model context.

The control service and provisioner receive the same protected `HF_PROVIDER_BOOTSTRAP_CONFIG_FILE`. Each pool recipe pins the provider configuration, execution role, artifacts, native executable, enrollment actions, OS identities and install inputs. Observations expose the matching recipe's availability and supported purposes. `PROVISION_SANDBOX` validates that capability before reserving capacity or creating a provider intent; a missing or mismatched recipe returns `FLEET_BOOTSTRAP_UNSUPPORTED`. The model still chooses which supported pool and purpose to use.

An acknowledged manager-selected CREATE starts native bootstrap through the provisioner. Bootstrap retains its enrollment grant, manifest and provider process identity across retries. It checks the actual provider ownership labels and delivered bytes before execution, then requires consumed enrollment and observed runner slots before reporting READY. An acknowledged CREATE without a bootstrap record exposes its dispatch status to the model, including an unavailable recipe, so recovery can retain the original resource identity.

## API surface

Requests use authenticated `POST /v1/invoke` with the existing signed operation envelope and an explicit component. The native source-control design has a separate API namespace; it is not the fleet invocation endpoint.

| Component | Operations |
| --- | --- |
| `fleet-orchestration` | `fleet.identity.bootstrap`, `fleet.cohort.bind`, `fleet.session.bind`, `fleet.observe`, `fleet.session.reason`, `fleet.decision.inspect`, `fleet.decision.apply` |
| `fleet-install` | `fleet.install.register`, `fleet.install.admit`, `fleet.install.status`, `fleet.install.complete`, `fleet.install.adopt` |
| `fleet-install-delivery` | `fleet.install.delivery.register`, `fleet.install.delivery.pending`, `fleet.install.delivery.schedule`, `fleet.install.delivery.collect` |
| `fleet-test-executor` | `fleet.test.pending`, `fleet.test.executor.pending`, `fleet.test.executor.retire` |
| `16.1` | `submission.archive.register`, `submission.inspect` |

The authoritative action registrations are the [orchestration component](../../core/control-plane/components/fleet-orchestration.json), [install component](../../core/control-plane/components/fleet-install.json) and [delivery component](../../core/control-plane/components/fleet-install-delivery.json). Manager observations include the effect API's current input contracts; callers should use these contracts rather than infer fields from prose.

`fleet.session.reason` takes `binding`, `operation_id`, `observation_id` and optionally `context_observation_ids`. Complete page sets must agree on actor, cohort, source, specification and plan versions. The server persists an aggregate context before reasoning. Decision `expected_version` starts at `"0"`; leader, manager and other authority generations retain their own validation rules. A Primary with an explicit `spec.amendment.admit` grant can use `REPLAN` with `proposal.kind = "ADMIT_VERSIONED"` and the observed immutable amendment ID/digest, explicit revalidation set, justification and proof policies. Admission uses the existing accepted-plan authority in the same fleet decision transaction; it preserves accepted coverage, proof, active-compute fencing and dependency checks. Other proposal objects remain record-only except the profile-budget revision described below. Typed application refusals are retained as actor-scoped observation feedback with the chosen input and decision references. The model can correct a later choice; replaying the refused operation returns its existing refusal. Unknown effects remain subject to reconciliation.

The Primary can add registered environment profiles to an existing delegation with `REPLAN` and `proposal.kind = "UPDATE_DELEGATION_BUDGET"`. The proposal carries `package_id`, `manager_session_id`, `expected_manager_generation`, the observed `expected_budget_digest`, the complete replacement `budget` and a `reason`. Only `profile_ids` may expand; task, provider, action and numeric budgets stay unchanged. New profiles require active approved pools, current source bindings and unexpired policy. Current compute and unsettled executable effects prevent the revision. Acceptance preserves manager ownership, advances its plan version and records both budget digests; decisions made against the previous plan become stale.

## Sandbox installation contract

Every sandbox carries `.neron` source configuration and a fleet `package.kvx` describing its environment. These are environment inputs, separate from task assignment and from a project's own package-manager manifest. The [contract](../../spec/hyperfide-source-control/sandbox-contracts.md) defines their roles; [examples](../../spec/hyperfide-source-control/examples/fleet/package.kvx) illustrate the format and contain intentionally unresolved pins.

The operator registers parsed package/source configuration and an immutable install plan through `fleet.install.register`. The plan pins source inventory, installer runtime, toolchains, dependency lockfiles, configuration versions, selected interface blocks and probes. Configuration references do not grant permission, and credential values are not model observation fields.

A manager selects `fleet.install.admit` for a registered input digest, environment generation, sandbox boot and explicit physical slot bindings. The authority validates the current decision, package owner, source revision, cohort and compatible slots. The install delivery path stages a pinned bootstrap runtime and inputs before executing a PREPARATION job; fetching the tracked repository is not required to obtain the bootstrap executable.

`hyperfide install` executes the admitted environment preparation. Its stages cover bootstrap, admission, manifest resolution, source, toolchains, dependencies, configuration, interfaces and readiness probes. Dependency installation verifies committed lockfile digests and frozen npm/pnpm commands. Selected interface fragments must match the pinned source and interface selection. Workers receive isolated writable slot directories. Source scopes can compose multiple mounts; API-only environments omit source materialization.

Secret configuration values stay in the native runner's protected credential channel. After preparation exits, the native finalizer writes each slot's private configuration and measures readiness under that worker's UID. Measurements cover source, dependencies, selected interfaces, toolchains, configuration versions and declared probes. Immutable `FLEET_MANIFEST_V1` publications bind those measurements to the physical slot and sandbox boot.

READY is a server-accepted receipt bound to the admission, source, plan, probes, sandbox boot and slot mapping. The retained native execution receipt and captured installer output must reconcile with the committed runner job. Neither a local marker nor a command's zero exit code independently authorizes worker launch. Assignment and runner launch recheck current install authority and slot bindings.

An interrupted preparation can receive a new manager-selected install admission with `recovery_of`. This object names the predecessor's `install_operation_id` and `admission_digest`, its `runner_operation_id` and `runner_plan_digest`, and the `quiescence_operation_id` and `quiescence_receipt_digest`. Recovery requires an actual signed, completed FAILED preparation with confirmed process absence and its retained native receipt. UNKNOWN executions require reconciliation. The source, environment generation, physical boot and worker mapping stay fixed; the new execution has a fresh operation ID and shares its predecessor's `logical_operation_id`. A transactional environment head prevents competing recoveries from advancing the same predecessor.

The installer preserves previous stage evidence and verifies any completed dependency stage against the actual files before reusing it. Changed files are refused and preserved. Recovery currently resumes interrupted staging before its atomic rename into the final environment root; a failure after that rename requires separate finalization reconciliation.

Preparation allocation registers the authenticated native PREPARATION executor under the selected manager and physical boot. This registration creates no coding attempt. The operator delivery pump projects the configured task and slot into allocation and delivery requests; the manager still chooses installation through its admitted decision.

For credential-bearing work, the bootstrap activation path requires a successful install, signed preparation cleanup and released preparation allocation. A separately pinned native helper releases the preparation slot and promotes the existing worker slot to the sole credential-sensitive slot on a dedicated VM. `HF_PROVIDER_ACTIVATION_CONFIG_FILE` supplies the helper artifact and exact source/profile pins. Credential delivery checks the resulting activation receipt and fresh authenticated inventory before resolving secrets.

An accepted START binds the qualified connector profile, private worker paths and initial task packet into an immutable launch plan. The native runner fetches that plan through its authenticated identity and retains the public profile snapshot in a protected per-launch file. A foreground owner keeps the provider execution alive through worker termination and evidence delivery. Durable launch claims prevent automatic replay of `CLAIMED` or `UNKNOWN` executions; stale unstarted commands receive a recorded refusal so later valid work can proceed.

## Independent verification

For a manifest-backed worker workspace, `submission.archive.register` captures the actual result files after confirmed native STOP. The service checks the original launch, task generation, physical boot and revoked execution credentials, seals the workspace, and retains the archive and capture receipt in object storage. Admission transfers the closed attempt into result custody and creates a pending qualification job. Physical reservations remain counted until their cleanup proof is accepted.

TEST reconstructs these captured bytes and independently checks their content, modes and derived Git tree. The Git representation is local to the existing-source adapter; the captured archive remains its source authority. Profile schema 2 explicitly identifies every preparation pin as `SOURCE` or `PROFILE_ARTIFACT`. Source pins come from the captured repository; retained policy and environment artifacts are staged outside it. Profile-artifact digests stay fixed when a result changes source-owned files.

A TEST bootstrap uses a distinct manifest and one native TEST slot on a sandbox separate from the coding attempt. Its pinned root controller obtains a scoped VERIFIER credential for the selected qualification job. The supervisor delivers the job’s existing preparation, allocation and assignment commands; the verifier executes them through authenticated qualification APIs. Accepted source bundles and the submitted result custody bind the inputs.

Pool configuration can declare `execution_role = {"schema_version":1,"kind":"CODING"}` or `"TEST"` for manager observations. Bootstrap checks that declaration against its protected slot template. The declaration describes the pool's purpose; physical readiness still comes from the enrolled slots and accepted measurements.

A terminal verification retains each signed check result and cleanup receipt. The TEST controller releases the native slot and refreshes its authenticated absence observation until retirement completes. Release replay checks the slot UID for live processes again. Retirement validates the current boot, original allocation, complete check inventory and fresh cleanup evidence, releases reservations through the scheduler, stops the verifier session and revokes its child credential. A delayed or disconnected supervisor can use a new observation without rerunning the checks.

## Recovery and adoption

An unchanged supervisor configuration resumes its private journal and pending operation IDs. Ambiguous requests and unknown runner outcomes require reconciliation of those original operations. Reissuing work under a fresh ID can duplicate external effects and is not a recovery mechanism.

Cohort replacement or an acknowledged manager handoff does not mutate an old install admission. A current manager can choose `fleet.install.adopt` using the eight exact fields described by the action contract: `install_operation_id`, `previous_adoption_id`, `admission_digest`, `receipt_digest`, `input_digest`, `handoff_id`, `runner_operation_id` and `runner_result_digest`. Nullable fields must be explicit.

Adoption appends current authority to the existing install. A READY install pins its immutable receipt. An ADMITTED install requires the single retained completed, successful FLEET_INSTALL execution and an unexpired lease. Manager replacement additionally requires the acknowledged hierarchy handoff covering the previous owner generation. Adoption cannot extend a lease, change source or slots, repair an uncertain execution by assertion, or make a stale sandbox boot current.

Observations expose package-scoped recovery candidates, including previous ownership generations, latest adoption pins, acknowledged handoffs and bounded retained execution summaries. The authority remains responsible for validating a chosen candidate.

When an operator destroys a manager-owned sandbox, that manager's original CREATE observation includes the audited administrative disposition and confirmed provider-absence evidence for the same native sandbox and boot. The evidence preserves operator provenance and lets the manager reason about replacement capacity.

## Source adapter boundary

The executable prerequisite uses [Git source manifests](../../core/control-plane/src/preparation/fleet_source.ts): immutable Git revisions, selected paths, file modes, content digests and bounded inventories. The current adapter supports regular files with Git modes `100644` and `100755`; unsupported source kinds are refused. It does not implement the proposed virtual native SCM working copy.

The fleet environment contract keeps source selection and revision pins separate from task assignments. A future native source-control adapter must supply equivalent pinned inventory and installation evidence through that contract while preserving authority, scopes and generation fencing. The [source-control specification](../../spec/hyperfide-source-control/README.md) describes that target; remote Git publication and native source storage remain separate concerns.
