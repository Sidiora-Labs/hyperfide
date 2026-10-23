# Hyperfide platform

The platform runtime is the Node 24, pnpm 9.15 workspace in `platform/`.
The C binary is the public front door. Runtime threads execute work; the spec,
Asks, independent checks and qualification receipts govern task completion.

## Four layers

| Layer | Responsibility | Proof from the repository root |
| --- | --- | --- |
| Surfaces | Web app, desktop, mobile, CLI and editor language client. | `pnpm -C platform exec turbo run typecheck test --filter=./apps/app`; `bash tests/integration/14_vscode.sh` |
| Execution | Server, host daemons, providers, environments and machines run work where the workspace lives. | `pnpm -C platform exec turbo run typecheck test --filter=./apps/server --filter=./apps/host-daemon` |
| Authority | Spec, Asks, qualification and dispatch use the binary and PostgreSQL control plane. | `python3 tests/hyperfide/cases/v22/6_5.py` |
| Proof | Graph, lane receipts, independent checker and wave closure establish results. | `python3 tests/hyperfide/cases/v22/4_5.py` |

These commands are reproducible checks, not a claim of production qualification.
The active feature is `spec/hyperfide-v22/spec.kvx`: implemented records coding
completion; done records qualification. Tests using projection adapters prove
those adapter contracts rather than deployment of every plugin together.

## Front door

```sh
make cg
pnpm -C platform install --frozen-lockfile
pnpm -C platform build
hyperfide platform --help
pnpm -C platform dev
bash tests/integration/99_platform_frontdoor.sh
```

`hyperfide platform <args>` delegates to `hyperfide-platform`, preserving streams
and exit status. Rebuild after source changes to avoid stale CLI output.
Configuration uses `HYPERFIDE_`; runtime data lives in `~/.hyperfide`.
Host binary verification and graph context are checked by
`bash tests/hyperfide/cases/v22/1_2.sh` and
`bash tests/hyperfide/cases/v22/1_3.sh`.

## Plugin inventory

These are the seven `hyperfide-*` source directories at this revision. Directory
presence does not imply every capability is automatically installed or wired.
Inspect the running registry with `hyperfide platform plugin list`.

| Directory under platform/plugins | Capability and boundary | Proof command |
| --- | --- | --- |
| hyperfide-spec | Spec board, task packets, managed workers, binary status transitions and task details. Some host integrations retain projection adapters. | `bash tests/hyperfide/cases/v22/2_4.sh`; `bash tests/hyperfide/cases/v22/2_3.sh` |
| hyperfide-asks | Ask mirroring, blocking pause/resume, inbox and secret references. Secrets stay in the secrets store. | `python3 tests/hyperfide/cases/v22/3_5.py` |
| hyperfide-qualify | Streaming verify lanes, receipts, independent checker, wave closure and permission-bound publication. | `python3 tests/hyperfide/cases/v22/4_5.py` |
| hyperfide-dispatch | Checkpoint builder, dependency scheduling, budgets, collection and fleet dashboard. | `python3 tests/hyperfide/cases/v22/5_7.py` |
| hyperfide-graph | Host-scoped survey, context, index status and why queries; Index panel. | `pnpm -C platform exec turbo run typecheck test --filter=./plugins/hyperfide-graph` |
| hyperfide-guide | Settings-controlled CLI introduction and bundled agent skills. | `pnpm -C platform exec turbo run typecheck test --filter=./plugins/hyperfide-guide` |
| hyperfide-ai | Retained AI service surface; hosted account access is unavailable. Configure a local provider. | `pnpm -C platform exec turbo run typecheck test --filter=./plugins/hyperfide-ai` |

Machine providers live in `machine-railway` and `machine-blaxel`. Their
create/exec/files/checkpoint/destroy contracts and redaction checks run with
`bash tests/hyperfide/cases/v22/5_1.sh` and
`bash tests/hyperfide/cases/v22/5_2.sh`. Fake SDK tests do not measure live capacity.
Provider bridges, secrets, memory and environment plugins remain distinct from
the authority plugins above.

## Fleet

`deploy/hyperfide/sandbox` ships local Git bundles into execution machines and
collects result bundles as local `sandbox/<id>` branches. Its fleet.json records
checkpoint ancestry, image steps, resource bounds and worker preparation.
Preparation rebuilds the binary and service and reinstalls platform packages
when workspace definitions or the lockfile change. One task runs per sandbox.

The dispatcher releases dependencies after integration, applies concurrency and
per-key budgets, backs off on 429 responses and retries once on another machine.
Collection detects conflicts and duplicate task headers. The dashboard exposes
machines, jobs, budgets, timelines and log tails.

Proof: `python3 tests/hyperfide/cases/v22/5_7.py` exercises image creation and
A -> (B, C) dispatch, bundles and tagged local merges with fake machines and a
scripted provider. The transport toolkit has its own check:
`CG=$PWD/cg bash tests/integration/96_sandbox_toolkit.sh`.
Neither establishes live fleet throughput. See [operations](operations.md) and
[the toolkit guide](../../deploy/hyperfide/sandbox/README.md) for measurements.

## Authority and storage

`services/hyperfide` is the PostgreSQL control plane. The platform runtime
database remains SQLite at this revision: task 6.1 is pending, its
`HYPERFIDE_DATABASE_URL` dialect selection and verification case are absent.
`HYPERFIDE_AUTHORITY_URL` selects the authority endpoint separately.
Operator authentication, receipts and plugin transactions use that authority;
local runtime storage does not grant distributed authority. Plugin state records
are observations, not task claims, leases or permission grants. Plugin migration
and an opt-in embedded PostgreSQL fallback have separate checks.

```sh
npm --prefix services/hyperfide run check
bash tests/hyperfide/cases/v22/6_2.sh
bash tests/hyperfide/cases/v22/6_3.sh
bash tests/hyperfide/cases/v22/6_4.sh
python3 tests/hyperfide/cases/v22/6_5.py
```

The final case boots two platform servers with an isolated authority projection,
enrolls two hosts, dispatches qualification on the second host and reads the
PostgreSQL receipt from both. It also refuses unknown operators and enrollment
credentials. This is a fixture proof, not a deployed multi-host campaign.

## Slices and memory

`platform/plugins/environment-slices` provides repository-selectable snapshot
and slice environments. It invokes `hyperfide snapshot` and `hyperfide slice`,
records the base and subsequent snapshot chain, and exposes slice detail.
Edits stay in the slice; Git is used for publication through the supplied wave
publication interface. Proof: `bash tests/hyperfide/cases/v22/7_1.sh` exercises
create, edit, snapshot, discard and publish with the real binary.

`platform/plugins/memory` retains private versioned memories and adds durable
repository/task decisions through the binary store:

```sh
hyperfide platform memory remember "Use the authority receipt" --repository ROOT --task FEATURE/ID
hyperfide platform memory recall --repository ROOT --task FEATURE/ID
bash tests/hyperfide/cases/v22/7_2.sh
```

The `DurableMemoryBridge` calls `hyperfide remember` and `hyperfide recall` through the
configured host binary adapter. Without that adapter durable commands report a configuration
error. Every call carries a `TaskScope` (the repository root and a `FEATURE/ID` task); `recall`
returns the task's `DurableMemory` decisions and constraints, queried per type so unrelated
facts cannot consume the result limit, and the spec plugin lists them as Recalled decisions in
the task packet. The private catalog and binary
store are separate; this bridge does not synchronize arbitrary private memories.
Never store secrets in memory or task packets.

## Documentation verification

`bash tests/hyperfide/cases/v22/7_3.sh` runs the real documentation checker on
the task documents in an isolated workspace, then runs the canonical
`tests/hyperfide/cases/v22/identity_gate.py` over the whole tracked repository.
The isolated `docs_check_projection.py` supplies a synthetic lifecycle baseline
because feature-wide packet generation waits for all ordinary tasks to qualify.
It copies the actual documents and link targets and indexes the real memory
packet adapter for the claim ledger. It does not qualify this feature or replace
its final documentation closure. The checker validates scope, links and evidence
references; semantic review remains necessary. See [platform testing](../../platform/docs/testing.md) for runtime
checks and capability-dependent suites.
