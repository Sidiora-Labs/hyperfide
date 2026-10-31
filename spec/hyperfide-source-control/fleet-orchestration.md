# Prerequisite: adaptive fleet orchestration and reproducible sandbox installation

Status: **proposed, not implemented or qualified**. This prerequisite follows the qualified repository layout in task `0.9` and precedes native source-control task `0.1`. Tasks `0.10` through `0.14` implement and qualify it. Every case remains **UNRUN** until its actual implementation gate executes.

The Primary agent and Wave Managers run on the **same supervisory box**. The Primary delegates waves. Wave Managers decide how to provision provider sandboxes, assign task packages to workers, supervise results and adapt execution as conditions change. Model agents own those planning decisions; the engine enforces accepted contracts, current authority, resource budgets, durable effects and evidence.

The layout prerequisite is defined in [repository-layout.md](repository-layout.md). Native source semantics are defined in [protocol.md](protocol.md), [storage.md](storage.md) and [workspaces.md](workspaces.md). This prerequisite initially uses an explicit legacy source adapter so it can qualify before those native services exist.

## 1. Role and location contract

| Role | Location | Decisions and responsibilities |
|---|---|---|
| Primary agent | Supervisory box | Interpret programme intent, choose waves to dispatch, appoint Wave Managers, delegate budgets/scope, coordinate cross-wave priorities and resolve changes beyond a manager's authority. |
| Wave Manager | The same supervisory box as the Primary | Reason about its wave and current evidence; choose task groupings, eligible workers, provider/environment profiles, sandbox provisioning/reuse, concurrency, intervention and replanning within its delegation. |
| Authority/control engine | Control services for the supervisory cohort | Validate requested decisions and atomically record scope, generations, reservations, leases, commands, results and their receipts. It does not invent a replacement work plan. |
| Provider executor/provisioner | Configured service execution boundary | Perform the manager's admitted create/observe/exec/stop/destroy intent through registered provider adapters, preserving durable request identity and reconciling unknown outcomes. |
| Worker | Provider sandbox | Execute its assigned task package against installed pinned inputs, report progress and checkpoint/submit results under the admitted attempt identities. |
| Independent checker/integrator | Assigned provider execution environment | Apply the declared qualification/review/integration policy to exact inputs. A worker or manager cannot replace required proof with a declaration. |

Co-location is enforced through the supervisor cohort's `host_id`, run epoch and placement receipt. A Wave Manager on another machine cannot be labeled as belonging to the same-box cohort. Administrative registration and package ownership are insufficient proof that the manager's native process is running on that host.

The Primary and managers can inspect source and graph state and invoke fleet tools. Implementation, builds and task execution remain in the admitted provider sandboxes. Requesting provisioning through a control API counts as a manager provisioning decision; it does not require placing provider administration credentials in the manager's prompt or native shell.

## 2. Existing seams and required evolution

The following paths describe the inspected baseline. Their post-layout owners are `core/control-plane/`, `core/host-daemon/` and `plugins/`; historical paths remain useful source references until the moves actually occur.

| Existing source | Existing capability | Required change |
|---|---|---|
| [hierarchy/packages.ts](../../services/hyperfide/src/hierarchy/packages.ts) | `WAVE` allocation, explicit leader assignment, manager/package generations and acknowledged handoff. | Make Primary-to-Wave-Manager dispatch the declared programme contract and persist adaptive decisions within that ownership. |
| [policy/placement.ts](../../services/hyperfide/src/policy/placement.ts) and [agents/supervision.ts](../../services/hyperfide/src/agents/supervision.ts) | Authorized local leader/manager supervision on a configured host with process/profile evidence. | Bind all Primary and Wave Manager processes to one active supervisor cohort and qualify restart/adoption. |
| [scheduler/resources.ts](../../services/hyperfide/src/scheduler/resources.ts) | Eligible task discovery and preparation demand scoped to manager-owned packages. | Expose complete paginated observations to the planning agent; keep budgets and eligibility as enforcement, without treating discovery order as the plan. |
| [scheduler/claim.ts](../../services/hyperfide/src/scheduler/claim.ts) | Deterministic task/sandbox admission with current generations, scope/dependency checks and capacity reservations. | Admit the manager-selected assignments and persist decision lineage. Preserve those safety checks when task grouping becomes adaptive. |
| [dispatcher/dispatcher.ts](../../platform/plugins/hyperfide-dispatch/src/dispatcher/dispatcher.ts) | Sorts pending work by wave/task identity, selects capacity, creates a sandbox and applies a fixed retry loop. | Replace automatic planning choices with manager-authored admitted decisions; retain execution, observation and reconciliation machinery through explicit interfaces. |
| [decisions/ranking.ts](../../services/hyperfide/src/decisions/ranking.ts) | Advisory ranking of a bounded deterministic shortlist, with `authority: NONE`. | Keep advisory behavior explicitly advisory. It does not constitute the Primary/Wave Manager reasoning loop or an autonomous dispatch decision. |
| [hyperfide-spec worker](../../platform/plugins/hyperfide-spec/src/worker.ts) | Spawns a worker for an explicit task, provider and environment selection. | Accept a durable manager assignment and installation receipt, then bind every task's attempt and resulting evidence. |

These source observations identify reuse opportunities. They do not establish a qualified deployed hierarchy, provider fleet or restart campaign.

## 3. Model decisions and deterministic enforcement

A model-owned decision records the observations used, chosen action, affected identities, rationale, expected effect, limits and alternatives or uncertainty relevant to that action. The engine validates the chosen action against current state. Refusal returns concrete changed-state or policy reasons to the manager for a new decision.

The Primary chooses wave delegation and cross-wave priorities. Wave Managers choose execution strategies inside their wave: which eligible tasks to group, whether to provision/reuse a sandbox, which approved provider/profile to request, which worker to assign, whether to reduce concurrency, and when to repair, replace, cancel or escalate. Task graph amendments outside the delegation require a Primary-owned versioned plan change.

The engine retains deterministic validation of authenticated identities, accepted specifications, dependency milestones, scope conflicts, generation fences, available budgets, reservation accounting, environment compatibility, installation integrity, timeouts and evidence requirements. It may perform the admitted command's transport retry or expire a lease according to its contract. Such mechanics cannot silently select a new task, new provider, new worker or replacement strategy.

If a manager is unavailable or its model cannot produce a valid decision, that planning operation becomes `WAITING_FOR_MANAGER` or another explicit recoverable state. The system must not silently switch to wave/id sorting, an advisory ranking, round-robin provider allocation or a fixed replacement loop and describe that as adaptive planning. A separately configured nonadaptive mode, if retained, has its own name, provenance and qualification boundary and does not satisfy this prerequisite's adaptive gate.

Eligibility queries expose their pagination, excluded candidates and observation freshness. A model's decision can consider all relevant permitted pages without being silently restricted to an eight-candidate ranking shortlist. The resulting choice still undergoes current authoritative validation before execution.

## 4. Keep assignment packages distinct from environment manifests

| Artifact | Meaning | Authority |
|---|---|---|
| **Task assignment package** | Durable selection of task IDs, source/spec inputs, acceptance obligations, worker identities and execution limits. | Primary/Wave Manager decision admitted by the control engine. |
| **`package.kvx`** | Sandbox environment manifest, analogous in purpose to a package manifest: describes pinned code, dependencies and configuration needed to prepare that sandbox. | Versioned environment input validated by `hyperfide install`. |
| **`.neron`** | Source-control configuration installed in each sandbox: source provider/endpoint, repository/workspace binding and configuration references. | Versioned SCM configuration plus scoped credentials supplied through the approved secret mechanism. |
| **`interfaces.kvx`** | Interface declaration participating in environment/consumer compatibility according to its separately frozen schema. | Interface schema and the declared producer/consumer contract. |

`package.kvx` is not the manager's task package. `.neron` is not an agent instruction file, a task scheduler or an alternative source of fleet ownership. Agent prompts and task packets remain separate artifacts. `interfaces.kvx` is not an interchangeable filename for any of these; task `0.10` freezes the applicable schema using its designated samples and records its relation to the environment manifest.

An assignment can reference one or several tasks when admitted policy permits grouping. Every task still has its own accepted definition, attempt identity, scope, status and qualification obligations. Grouping cannot turn one worker exit code into completion of all tasks or hide conflicting writes. A worker can execute sequential or independent grouped work only as declared; native child workers require separately admitted identities and accounting.

The environment manifest's semantic contract includes schema version, environment/profile identity, exact code inputs, pinned dependency and toolchain inputs, configuration references, interface-contract identities and installation actions. Exact KVX section/key spelling is owned by task `0.10`; illustrative terminology in this document does not create a competing schema.

## 5. `hyperfide install` and environment readiness

`hyperfide install` is the proposed installation command for preparing the sandbox described by `package.kvx`. It fetches the pinned code, installs the declared dependencies and configuration, installs/validates `.neron`, and emits an immutable installation receipt. It does not select tasks, start an unassigned worker or change programme scope.

Installation receives the admitted environment manifest identity, its lock/resolution data, explicit source-provider mode, declared configuration/secret references and a stable installation operation identity. Inputs must be resolvable without consulting a moving branch or silently upgrading a dependency. Missing variables, unavailable pins, unsupported features or digest mismatches are explicit results.

The installation receipt binds the resolved manifest digest, actual code revision/tree, installed path/scope, dependency lock and toolchain identities, materialized configuration digests, interface-contract identities, `.neron` configuration digest, sandbox/provider/boot identity, checks, outcome and retained logs/artifacts. Secret values are excluded from the manifest, receipt and logs; references and nonsecret identity digests remain attributable.

The sandbox becomes worker-ready only after required installation and readiness checks pass at its current boot/generation. Provider `RUNNING`, successful manifest parsing or an old image label is insufficient. Reusing a sandbox requires compatible clean source/environment state and a valid receipt for the new assignment. Dirty output from another assignment is preserved or disposed through an explicit admitted action before reuse.

Installation stages source and dependencies in an isolated destination and exposes the ready workspace atomically where possible. An interrupted install retains a reconciliation record and cannot leave a partial environment labeled ready. Repeating an identical completed request returns its receipt; a changed manifest/configuration requires a new operation identity and readiness decision. Dependency setup executes only actions admitted by the environment policy and records the actual resolved inputs.

## 6. Source-provider transition without a dependency cycle

Tasks `0.10` through `0.14` must qualify using the existing source and provider capabilities after the layout move. They cannot depend on native SCM task `0.1`, the future object store, virtual filesystem, native SDK or later native source acceptance.

The initial install path uses a named **legacy source adapter**. It pins and verifies existing Git-backed revision/tree inputs or their existing admitted bundle/checkpoint transfer. Its `.neron` configuration explicitly identifies that adapter and the actual source authority. The adapter supplies the install contract's code materialization and provenance without pretending to expose already implemented native commits, native history or S3 semantics.

The later native SCM implementation adds a provider behind the same typed installation/source interface. Its cutover updates the approved manifest/configuration generation, prepared images and workers together. Every installation and assignment names the mode actually used. Native-mode failures do not silently fall back to the legacy adapter, and legacy-mode evidence does not establish native source-control behavior.

The dependency chain is therefore `layout 0.9 -> orchestration 0.10–0.14 -> native SCM 0.1`. The later native fleet adapter task replaces the legacy source/result binding while preserving the qualified Primary/manager decision, installation, authority and lifecycle contracts. Neither engine waits for the other to implement its own prerequisite.

## 7. Proposed decision and execution APIs

The following logical operations are proposed control interfaces. Existing hierarchy, scheduler, provider and supervisor components should be adapted rather than duplicated behind competing authorities. Exact transport action names are frozen in task `0.10`.

| Operation | Decision owner and required inputs | Durable result |
|---|---|---|
| Observe programme/wave | Primary or authorized manager; run, spec revision, scope and pagination. | Freshness-stamped tasks, dependencies, environments, budgets, findings, pending effects and omissions. |
| Delegate wave | Primary; wave/task-set identity, manager session, cohort host, scope, budget envelope and expected owner generation. | Admitted delegation, owner generation, manager startup intent and decision receipt. |
| Record/revise plan | Owning agent; decision ID, observation/version bindings, selected actions, rationale, limits and expected prior plan. | Immutable decision plus current plan generation or explicit stale/refused result. |
| Request sandbox lifecycle | Wave Manager; delegated package/owner generation, provider/profile choice, environment manifest, budget and stable command identity. | Admitted provisioning/reuse/stop/destroy intent and subsequent provider outcome receipt. |
| Install environment | Admitted executor for the manager's request; manifest/pin/configuration references and sandbox boot. | Installation operation and readiness receipt, or explicit failure/unknown state. |
| Assign worker | Wave Manager; selected tasks, exact installed source, per-task attempt identities, worker/profile choice, current budget and expected assignment state. | Fenced assignment and idempotent launch intent tied to installation and decision receipts. |
| Steer/replan/cancel | Current Primary/manager owner; target assignment/generation, decision, explicit new instructions or requested lifecycle effect. | Durable command, acknowledgment and reconciliation status. |
| Offer/acknowledge dependency | Current manager owners; producer/consumer tasks, required milestone, pinned result/evidence and expected edge/plan versions. | Durable coordination record; eligibility changes only when the engine verifies the actual milestone. |
| Submit/review/integrate | Appropriate admitted role; per-task result set, source identities, current custody and exact evidence. | Result custody/qualification/integration receipts under the existing policy. |

A decision record contains no executable arbitrary SQL or shell admitted solely because it came from a model. It selects typed actions within the current contract. Provider executors perform network effects outside metadata transactions after durable intent is committed.

Decision replay is separate from reasoning again. A repeated request with the same identity and canonical inputs returns its original decision/effect record. Changed observations or a new choice require a new decision linked to its predecessor. The system must not call the model again during a transport retry and treat a different answer as the same command.

## 8. Primary and Wave Manager lifecycle

The Primary starts from the accepted programme specification, current persisted state and cohort identity. It chooses an eligible wave or overlapping wave set, appoints the manager and delegates scope/budget. A wave number is an organizational boundary; explicit accepted dependency milestones and barriers determine whether selected work may execute.

The manager acknowledges its delegation and constructs a plan from actual tasks, dependencies, installed environments, resource observations and findings. It requests sandboxes, waits for installation/readiness receipts, chooses worker assignments and submits typed dispatch intents. Worker task execution is authorized only after both assignment and environment readiness are committed; an admitted bootstrap process can run hyperfide install and wait for readiness beforehand.

Each active worker has an owning manager package and generation, individually tracked task attempts, its sandbox/boot, scoped source inputs, resource reservations and a durable launch command. A manager cannot detach a worker and erase responsibility for its cleanup, submissions or budget. A manager replacement adopts valid workers explicitly through the persisted handoff; it does not indiscriminately kill and relaunch them.

Progress, failures, Ask answers, provider conditions, source changes and completed milestones wake the manager to reconsider its plan. Observation events trigger reasoning; they do not themselves choose a new task or provider. A manager may reuse the existing plan when still applicable and records that decision. Resource backpressure remains visible so the manager can reason about concurrency rather than mislabel queued work as stalled.

Result submission transfers work into the declared durable custody. Worker lease expiry or sandbox cleanup cannot remove that custody. Required checks and review govern acceptance. Managers use their results to choose repairs, follow-up work and teardown; they cannot self-certify a missing gate through a plan update.

## 9. Manager-to-manager dependency coordination

Cross-wave or cross-project dependencies are durable typed edges, not private manager conversations alone. Each edge names producer/consumer identities, accepted specification generation, required milestone and pinned artifact/source/evidence references.

Managers can exchange offers, blockers, compatibility constraints, readiness notices and requests for changed sequencing. Their messages have stable identities, sender/recipient owner generations, acknowledgments and causal references. Delivery may be duplicated; applying the same coordination action twice cannot release dependencies twice or create another worker.

The receiving manager evaluates the information and proposes any plan change. The engine verifies producer milestone receipts and accepted dependency policy before allowing a consumer claim. A message saying ready does not replace an integration or qualification receipt. Imported implementation milestones and native source acceptance remain explicitly distinguished during the source transition.

A manager cannot widen another manager's scope, change its budget or rewrite its task definitions. Conflicting priorities, incompatible interface changes or dependency amendments beyond delegation return to the Primary. Accepted plan/spec changes invalidate affected prospective packets and require current version checks on later dispatch. Existing admitted workers receive explicit retain/steer/quiesce/reassign decisions; a live spec edit cannot silently rewrite their assignments.

## 10. Restart, fencing and the same-box failure domain

The supervisory box is a shared failure domain. Losing it can interrupt the Primary and every Wave Manager simultaneously. Durable control state and acknowledged source/evidence must live outside replaceable agent processes; co-location is not an availability guarantee.

The following records survive process restart: accepted programme/spec revisions; supervisor cohort and leader epoch; wave ownership/generations; decisions and plans; task assignments and compute leases; provider intents and known external identities; installation receipts; worker launches/process identities; commands/acknowledgments; result custody; budget reservations; and pending cleanup/reconciliation obligations.

On process restart, the controller inspects existing supervised process identities before replacement. A lost model session may be reconstructed from the accepted specification, decisions, plan, observations and unresolved operations; native context restoration is claimed only when its connector contract proves it. Recovering a session cannot acquire authority merely because its local transcript says it was the manager.

Leader replacement advances the authoritative epoch/generation. Manager handoff advances the package owner generation and records which active assignments are adopted. Old supervisor or manager processes may physically survive, but their commands fail current-generation checks. A replacement worker likewise receives a new admitted attempt after prior outcome/quiescence reconciliation. Existing committed idempotent receipts remain readable to authorized readers without reviving stale execution authority.

If the entire box is unavailable, remote workers follow the declared lease/checkpoint/quiescence policy. They cannot appoint a new manager or self-extend control authority. Already admitted deterministic executors may finish or reconcile a specific persisted effect within its valid contract; they cannot plan additional work. Moving supervision to a replacement box requires an explicit cohort transition that fences the old host and places the Primary and all new managers together on the replacement host.

Ambiguous provider creation, worker launch, environment install or result submission is reconciled by its durable identity before planning replacement. Reservations remain counted while the physical outcome is unknown. All physical workers are eventually linked to current ownership, adopted, quiesced or quarantined with an accountable cleanup obligation. An agent shutdown, forgotten child or network timeout is not evidence that the provider resource disappeared.

## 11. Prerequisite implementation and qualification

| Task | Deliverable | Required gate |
|---|---|---|
| `0.10` | Freeze Primary/manager decision APIs, delegation/budget/assignment schemas, `package.kvx`, `.neron` and `interfaces.kvx` relations, cohort identities and versioned legacy source adapter. | Contract validation and positive/negative authority cases on the relocated existing control plane; no dependency on native SCM. |
| `0.11` | Implement `hyperfide install`, pinned code/dependency/configuration preparation, per-sandbox `.neron` and installation/readiness receipts. | Fresh and reused sandbox installation, explicit legacy source mode, interrupted install recovery, changed-pin rejection and secret-reference handling. |
| `0.12` | Implement durable Primary reasoning, same-box manager supervision and wave delegation with bounded observation tools. | Actual Primary session chooses and dispatches waves; repeated effects replay; unavailable model exposes a waiting state without hidden deterministic planning. |
| `0.13` | Implement adaptive Wave Manager planning, admitted provider lifecycle, task package/worker assignment, cross-manager coordination and accountable cleanup. | Actual manager sessions choose/revise plans, install and run workers in provider sandboxes, coordinate a real dependency and preserve per-task evidence. |
| `0.14` | Qualify the co-located hierarchy, recovery, fencing and the handoff to native SCM foundations. | Exact-revision end-to-end and failure campaign over Primary, managers, installation, provider workers, result custody and cleanup; explicit receipt unlocks task `0.1`. |

Task `0.14` includes a Primary and at least two managers proven on the same box, with producer/consumer tasks across their packages. The campaign observes manager-authored choices, a changed condition that causes an actual replan, provider sandbox readiness, worker execution, exact result qualification and final resource accounting. It interrupts a manager, then the supervisory cohort, reconciles an ambiguous external operation, and demonstrates refusal of commands from superseded manager/worker generations.

Contract tests can establish validation and deterministic safety behavior. Scripted model responses or fake providers cannot establish adaptive-agent operation, provider behavior or same-box recovery. Live tests record the actual agent/provider profiles, inputs, decisions, API requests, host/process/boot identities, logs, receipts, cleanup and limitations. The qualification report distinguishes any unexecuted connector/provider capability.

The prerequisite's final receipt identifies its actual source revision, layout generation, schemas and adapter versions, installed environment manifests, all required gate outcomes and known baseline defects. Native SCM task `0.1` consumes that receipt without relabeling legacy-source checks as native proof. Later source-control migration requalifies the same user path against the native provider.
