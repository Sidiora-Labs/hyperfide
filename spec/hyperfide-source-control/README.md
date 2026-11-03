# Hyperfide native source control

Status: **native source-control implementation is present; release integration, fleet deployment and full workload campaigns are in progress**.

This feature specifies an online source-control subsystem inside Hyperfide. It serves one growing monorepo containing many large projects, thousands of concurrent agent workspaces, and high rates of independent changes. Immutable source objects live in S3; thin clients use versioned APIs, bounded caches, and optional sparse, virtual, or explicitly materialized working copies. Git is an import/export protocol at the remote boundary.

The subsystem has its own versioned contracts and independently scalable services. Hyperfide remains the task, attempt, scheduling, and qualification-policy authority. Source control owns source identities, durable revisions, workspace mutations, and atomic source acceptance. Saving source, completing a task, accepting a candidate, and publishing to a remote are separate events.

## First prerequisite

[Repository layout](repository-layout.md) is the first work: move nested codebases into category roots while preserving behavior and public identities. The [explicit mapping](repository-layout.json) covers current source inputs. The category roots contain 8,339 relocated paths. Native, core, SDK and plugin relocation checks pass. Current desktop/Android packaging and the combined layout receipt are being refreshed against the source-control integration.

The [final prerequisite](fleet-orchestration.md), tasks 0.10–0.14, makes the Primary and co-located Wave Managers responsible for adaptive orchestration. Every sandbox carries `.neron` source configuration and a `package.kvx` environment manifest; the `hyperfide install` contract assembles code, dependencies, configs and selected interface contracts before worker readiness. See [sandbox contracts](sandbox-contracts.md) and [interface schema](interface-contracts.md). The source-control implementation includes immutable S3 objects, server-side history and transformations, sparse and virtual workspaces, scoped authority, graph indexing, fleet custody, Git import/export, consolidation, retention and recovery. The protected fleet bootstrap and integrated native workspace paths have executable component evidence; the isolated cloud fleet journey is a separate gate.

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

The owning `spec/workflow.kvx` selects `hyperfide-source-control`. Implementation and focused execution evidence are recorded in [qualification.kvx](qualification.kvx). The public SDK is `sdk/source-control`, the service is `core/control-plane/src/source_control`, the product integration is `plugins/hyperfide-source-control`, and release packaging is `deploy/hyperfide/source-control`. Task statuses distinguish implemented work from qualification. The complete case registry, measured growth/scale/endurance campaigns and operator acceptance govern release closure.

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

Current qualification: category relocation and scoped component work exist, while full layout case SCM-025 remains UNRUN until task 0.9. The historical Node22 workspace build completed 65/65 Turbo tasks, as recorded in [relocation evidence](repository-layout.md#8-current-relocation-progress); this is not a current complete layout or release receipt. Current source-bound workspace, runtime, cache, packaging and prepared-image receipts must satisfy the layout aggregator. Original inventory/graph observations remain in [qualification.kvx](qualification.kvx) with their original scope. Fleet and native-source implementation have their own prerequisite gates; source presence does not release those gates.
