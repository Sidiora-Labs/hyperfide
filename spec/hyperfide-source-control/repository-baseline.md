# Repository baseline and implementation seams

Source baseline: `2f7331ef2085f6f374adf2d1e2ee01405fecb72d`. This is a source inspection record, not a runtime or deployment qualification.

## Specification format

The feature follows [hyperfide/spec.kvx](../hyperfide/spec.kvx), [hyperfide-v21/spec.kvx](../hyperfide-v21/spec.kvx), and [hyperfide-v22/spec.kvx](../hyperfide-v22/spec.kvx): metadata; numbered requirements with stories and acceptance clauses; design/decisions; documentation obligations; and tasks with wave, dependencies, touches, verify command, steps, requirement references and owner. The expanded contract pack follows the `spec/hyperfide` document layout.

The owning [workflow](../workflow.kvx) currently selects `hyperfide-v22`. Its selection is unchanged. The explicit feature scope `-f hyperfide-source-control` selects layout task 0.3 without changing the shared workflow default. Its inventory driver is being implemented; later drivers remain future deliverables.

## Current source seams

| Current source | Observed boundary | Required adaptation |
|---|---|---|
| [src/vcs.c](../../src/vcs.c) | Existing local source snapshot implementation | Preserve historical readability; add native API façade and typed native source identities rather than assuming local objects become distributed authority. |
| [Slice provider](../../platform/plugins/environment-slices/provider.ts) | Copies `.codegraph/objects`, checks out a base tree, prunes scope, reconstructs a publication tree; current file walk rejects symlinks | Manifest-driven object reads and explicit mutations, ordinary file-type semantics, bounded cache and native source acceptance. |
| [Slice contract](../../platform/plugins/environment-slices/contract.ts) | Current snapshot/slice IDs use raw 64-hex strings | Versioned identity adapter; native IDs cannot be silently inserted into incompatible existing validators. |
| [Fleet worker](../../platform/apps/host-daemon/src/fleet-worker.ts) | Job/attempt identity, cancellation and completion acknowledgment retry | Source mutations validated server-side against current generation; acknowledged revisions survive worker replacement. |
| [Publication service](../../services/hyperfide/src/integration/publication.ts) | Durable operations, publication fencing, expected-head reconciliation, Git wave operations | Reuse authority/reconciliation semantics with native acceptance and a separate projected Git publication operation. |
| [GitHub integration](../../services/hyperfide/src/integration/github.ts) | Existing remote integration seam | Streaming object exporter plus a separately qualified GitLab adapter; existing GitHub behavior is not proof of GitLab compatibility. |
| [Qualification runner](../../tests/hyperfide/qualify.py) and [manifest schema](../../tests/hyperfide/manifest.schema.json) | Canonical case namespace is restricted to `V-NNN`; source evidence includes Git-oriented assumptions | Versioned SCM case namespace and native-source evidence capture, retaining legacy registrations. |
| [VCS admission design](../../platform/docs/vcs-process-admission.md) | Separate local/network subprocess admission; budgets scoped to a Node runtime | Native service request budgets and per-resource admission; current subprocess budgets do not limit a distributed native API. |

Detailed source adapters and proposed new files are named in the corresponding contract and task. New `source_control/` service files, native client package, host source-control runtime and test drivers are implementation destinations, not claims that these capabilities already exist.

## Current verification limits

No product build, native source-control runtime, S3 campaign, fleet campaign, or migration is established by this baseline. Authoring validation only checks the new specification package. The installed CLI reports `2.0.0-dev`; `hyperfide brief` requires initialized project state in this checkout. Specification validation therefore uses the repository's strict KVX parser without initializing a repository-wide graph.

Statistics from public dashboards are not a capacity baseline. Future inventory records actual repository/object counts, unique bytes, imported history, authoring rate, minute-level bursts, materialization demand and concurrency separately, with snapshot and collection provenance. Production inventory and credentials belong in deployment evidence, not in this public design package.

## Layout successor

The paths above identify the inspected source revision. [repository-layout.json](repository-layout.json) maps them to proposed category destinations; new implementation task scopes already target that layout with layout tasks 0.3–0.9 followed by fleet prerequisite 0.10–0.14 before native implementation. The authoring check validates mapping coverage and collisions against the pinned baseline, not runtime behavior after a move.
