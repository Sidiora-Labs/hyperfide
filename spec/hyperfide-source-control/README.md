# Hyperfide native source control

Status: **category relocation in progress (8,339 mapped paths moved); tasks 0.4–0.8 in progress; task 0.3 graph qualification pending; full product qualification UNRUN**.

This feature specifies an online source-control subsystem inside Hyperfide. It serves one growing monorepo containing many large projects, thousands of concurrent agent workspaces, and high rates of independent changes. Immutable source objects live in S3; thin clients use versioned APIs, bounded caches, and optional sparse, virtual, or explicitly materialized working copies. Git is an import/export protocol at the remote boundary.

The subsystem has its own versioned contracts and independently scalable services. Hyperfide remains the task, attempt, scheduling, and qualification-policy authority. Source control owns source identities, durable revisions, workspace mutations, and atomic source acceptance. Saving source, completing a task, accepting a candidate, and publishing to a remote are separate events.

## First prerequisite

[Repository layout](repository-layout.md) is the first work: move nested codebases into category roots while preserving behavior and public identities. The [explicit mapping](repository-layout.json) covers current source inputs. The category roots now contain 8,339 relocated paths. Tasks 0.4–0.8 are in progress; task 0.9 still owns combined layout qualification before fleet or native source-control implementation.

The [final prerequisite](fleet-orchestration.md), tasks 0.10–0.14, makes the Primary and co-located Wave Managers responsible for adaptive orchestration. Every sandbox carries `.neron` source configuration and a `package.kvx` environment manifest; proposed `hyperfide install` assembles code, dependencies, configs and selected interface contracts before worker readiness. See [sandbox contracts](sandbox-contracts.md) and [interface schema](interface-contracts.md). Native task 0.1 waits for the final fleet qualification receipt. Task 0.3 implements the inventory and baseline, with 22 focused checks passing and graph qualification pending; fleet and native source-control implementation remain pending.

## Read in this order

| Document | Purpose |
|---|---|
| [Native specification](spec.kvx) | Normative requirements, acceptance clauses, proposed implementation tasks, dependencies, and UNRUN qualification cases. |
| [Design](design.body.md) | Product boundary, invariants, operating model, and one task from assignment to publication. |
| [Decisions](decisions.md) | Fixed product constraints, proposed implementation choices, and qualification-dependent decisions. |
| [Repository baseline](repository-baseline.md) | Source-grounded migration seams and conflicts with earlier feature assumptions. |
| [Storage](storage.md) | Object identities, bounded trees, S3 durability, sharding, retention, and reclamation. |
| [Protocol](protocol.md) | API contracts, mutations, queries, integration, idempotency, and events. |
| [Workspaces](workspaces.md) | Materialization, virtualization, caches, file semantics, and source scopes. |
| [Hyperfide integration](hyperfide-integration.md) | Fleet custody, graph identities, CLI/SDK, and native product surfaces. |
| [Identity and security](identity-security.md) | Scoped authorization, source integrity, revocation, and recovery. |
| [Git interoperability](git-interop.md) | GitHub/GitLab projection, transport, contribution import, and remote reconciliation. |
| [Migration](migration.md) | Repository consolidation, provenance, authority cutover, and rollback. |
| [Verification](verification.md) | Correctness cases, fault campaigns, workload definitions, and evidence requirements. |
| [Implementation plan](implementation-plan.md) | Generated task order and ownership from the native specification. |
| [Traceability](traceability.md) | Generated acceptance-clause links to tasks, cases, and contracts. |

## Authority and evidence

`spec.kvx` is the normative requirements and task catalogue. Detailed contracts refine it; a contradiction is a defect to resolve, not an invitation to choose the easier requirement. The task plan and traceability are generated views. Earlier specifications remain historical inputs and their recorded statuses are unchanged.

The owning `spec/workflow.kvx` selects `hyperfide-source-control`. Layout implementation is active; fleet and native source-control implementation remain pending behind their prerequisite gates. New test drivers, packages, migrations, API routes, and commands named in later tasks remain proposed deliverables unless the baseline explicitly identifies them as existing. Feature selection and physical relocation do not establish runtime or capacity qualification.

Run the authoring check from the repository root:

```sh
python3 spec/hyperfide-source-control/tools/validate_spec.py
```

Regenerate the two derived views after changing normative clauses, task mappings, or cases:

```sh
python3 spec/hyperfide-source-control/tools/validate_spec.py --render
```

The check parses KVX, validates references and dependency order, checks clause coverage and local document links, and detects stale derived views. It does not execute future test drivers or qualify source-control behavior. All product cases remain UNRUN.

The capacity profiles are proposed acceptance targets, not measurements. Repository line counts, historical commit imports, newly authored revisions, workspace opens, concurrent agent processes, and downloaded bytes are separate dimensions. A successful API load generator does not prove an equivalent fleet of live engineering agents.

Current execution: layout task 0.3 is implemented, not done; its full qualification command exited 143 with graph refresh unfinished. Tasks 0.4–0.8 record work ahead of open prerequisites, rather than declaring those prerequisites complete. Focused native, SDK/registry, tooling and source-path checks have passed. Pinned root dependency installation and the independent control-plane install/build have passed; integrated workspace build and combined layout qualification remain outstanding. See [current relocation evidence](repository-layout.md#8-current-relocation-progress) and [qualification record](qualification.kvx). Full layout case SCM-025 remains UNRUN until task 0.9.
