# Repository baseline and implementation seams

Source baseline: `2f7331ef2085f6f374adf2d1e2ee01405fecb72d`. This is a source inspection record, not a runtime or deployment qualification.

## Specification format

The feature follows [hyperfide/spec.kvx](../hyperfide/spec.kvx), [hyperfide-v21/spec.kvx](../hyperfide-v21/spec.kvx), and [hyperfide-v22/spec.kvx](../hyperfide-v22/spec.kvx): metadata; numbered requirements with stories and acceptance clauses; design/decisions; documentation obligations; and tasks with wave, dependencies, touches, verify command, steps, requirement references and owner. The expanded contract pack follows the `spec/hyperfide` document layout.

The owning [workflow](../workflow.kvx) now selects `hyperfide-source-control`. Layout task 0.3 is implemented with graph qualification outstanding; relocation tasks 0.4–0.8 are in progress ahead of open prerequisites. This current execution state is separate from the pinned source inspection below. Later fleet and native source-control drivers remain future deliverables.

## Current source seams

| Current source | Observed boundary | Required adaptation |
|---|---|---|
| [src/vcs.c](https://github.com/Sidiora-Labs/hyperfide/blob/2f7331ef2085f6f374adf2d1e2ee01405fecb72d/src/vcs.c) | Existing local source snapshot implementation | Preserve historical readability; add native API façade and typed native source identities rather than assuming local objects become distributed authority. |
| [Slice provider](https://github.com/Sidiora-Labs/hyperfide/blob/2f7331ef2085f6f374adf2d1e2ee01405fecb72d/platform/plugins/environment-slices/provider.ts) | Copies `.codegraph/objects`, checks out a base tree, prunes scope, reconstructs a publication tree; current file walk rejects symlinks | Manifest-driven object reads and explicit mutations, ordinary file-type semantics, bounded cache and native source acceptance. |
| [Slice contract](https://github.com/Sidiora-Labs/hyperfide/blob/2f7331ef2085f6f374adf2d1e2ee01405fecb72d/platform/plugins/environment-slices/contract.ts) | Current snapshot/slice IDs use raw 64-hex strings | Versioned identity adapter; native IDs cannot be silently inserted into incompatible existing validators. |
| [Fleet worker](https://github.com/Sidiora-Labs/hyperfide/blob/2f7331ef2085f6f374adf2d1e2ee01405fecb72d/platform/apps/host-daemon/src/fleet-worker.ts) | Job/attempt identity, cancellation and completion acknowledgment retry | Source mutations validated server-side against current generation; acknowledged revisions survive worker replacement. |
| [Publication service](https://github.com/Sidiora-Labs/hyperfide/blob/2f7331ef2085f6f374adf2d1e2ee01405fecb72d/services/hyperfide/src/integration/publication.ts) | Durable operations, publication fencing, expected-head reconciliation, Git wave operations | Reuse authority/reconciliation semantics with native acceptance and a separate projected Git publication operation. |
| [GitHub integration](https://github.com/Sidiora-Labs/hyperfide/blob/2f7331ef2085f6f374adf2d1e2ee01405fecb72d/services/hyperfide/src/integration/github.ts) | Existing remote integration seam | Streaming object exporter plus a separately qualified GitLab adapter; existing GitHub behavior is not proof of GitLab compatibility. |
| [Qualification runner](../../tests/hyperfide/qualify.py) and [manifest schema](../../tests/hyperfide/manifest.schema.json) | Canonical case namespace is restricted to `V-NNN`; source evidence includes Git-oriented assumptions | Versioned SCM case namespace and native-source evidence capture, retaining legacy registrations. |
| [VCS admission design](https://github.com/Sidiora-Labs/hyperfide/blob/2f7331ef2085f6f374adf2d1e2ee01405fecb72d/platform/docs/vcs-process-admission.md) | Separate local/network subprocess admission; budgets scoped to a Node runtime | Native service request budgets and per-resource admission; current subprocess budgets do not limit a distributed native API. |

Detailed source adapters and proposed new files are named in the corresponding contract and task. New `source_control/` service files, native client package, host source-control runtime and test drivers are implementation destinations, not claims that these capabilities already exist.

## Current verification limits

The pinned source inspection below establishes no runtime qualification. Current relocation evidence includes focused native compilation, path/source guards, pinned dependency installation and the independent control-plane build; see [current relocation progress](repository-layout.md#8-current-relocation-progress). Integrated workspace build and full layout qualification remain outstanding. Native source-control runtime, S3/fleet campaigns and repository-consolidation migration remain UNRUN. Authoring validation uses the strict KVX parser without refreshing the repository graph.

Statistics from public dashboards are not a capacity baseline. Future inventory records actual repository/object counts, unique bytes, imported history, authoring rate, minute-level bursts, materialization demand and concurrency separately, with snapshot and collection provenance. Production inventory and credentials belong in deployment evidence, not in this public design package.

## Layout successor

The paths above identify the inspected source revision. [repository-layout.json](repository-layout.json) maps them to category destinations now physically present in the working tree; new implementation task scopes already target that layout with layout tasks 0.3–0.9 followed by fleet prerequisite 0.10–0.14 before native implementation. The authoring check validates mapping coverage and collisions against the pinned baseline, not runtime behavior after a move.

## Task 0.3 inventory baseline

Layout inventory now has an independently pinned `implementation_baseline` in [repository-layout.json](repository-layout.json), preserving the original design revision above. Its focused driver passed 22 checks and recorded actual discovery/toolchain observations; see [layout results](repository-layout.md). Those original observations recorded missing dependencies and checkout-built executables. Subsequent work relocated 8,339 paths and passed scoped native/tooling checks, the pinned root dependency install and the independent control-plane install/build. Original baseline data remains historical; it is not overwritten by the newer setup state. Complete graph, integrated workspace/runtime and full layout qualification remain outstanding.
