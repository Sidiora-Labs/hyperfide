# Source tracking

## Snapshot slice environments

The `hyperfide-environment-slices` provider lets a repository select snapshot
slices alongside its worktree provider. The repository's `environmentProviderId`
selects the provider; an unset value retains the worktree default. The bundled
entry is `platform/packages/bundled-plugins/environment-slices.ts`.

Record the repository baseline with `hyperfide commit -m <message>` and obtain
the task manifest with `hyperfide slice <task> -f <feature> --json` before launching
the environment. The current slice CLI derives paths from Git and requires a
Git repository; this preparation belongs to task-run input resolution, outside
the environment lifecycle. There is no `hyperfide snapshot` command. Do not use
`--git` when recording snapshots.

Creation takes the manifest and an optional full snapshot id (otherwise the
latest snapshot). Each thread receives a private tree and object store under
`<dataDir>/slices/<sliceId>/`; production dataDir is `~/.hyperfide`. Only manifest
paths, build roots and metadata roots remain in a SLICE tree. A glob or missing
touches produces FULL_TREE with its recorded reason. The provider retains that
reason for task detail. Directory paths include their descendants.

Threads edit in the returned environment path. Finishing a thread runs
`hyperfide commit -m ...` there and persists the snapshot chain. A no-change
finish keeps the same head. Out-of-slice additions and symlinks are rejected at
snapshot time. The task-detail binding supplies the slice id, snapshot chain
and full-tree fallback reason. State survives service restart. Discard removes
only the private environment, leaving repository files and history unchanged.

Provider commands use an absolute Hyperfide binary path and an empty child PATH,
so optional Git probes cannot invoke Git. Create, edit, finish and discard do
not depend on Git. Publication materializes the selected snapshot in a separate
private tree and passes it, its paths and deletions to the wave publication
service. That service owns the worktree and task 4.4's closure and push-permission
gates. The provider never pushes or creates Git commits.

### Integration adapters

`platform/plugins/environment-slices/projected-lifecycle.ts` is the local
interface for the pending task-run (2.3) and publication (4.4) integrations.
`registerSlices` supplies a resource provider matching the existing create/remove
contract, including Standard Schema inputs, plus finish, detail and publication
bindings. `installSlicesEnvironment` in the bundled entry attaches those bindings
to the host's task lifecycle. Task-run must resolve the manifest, invoke the
provider selected for the repository, and route only that environment's thread
completion to its finish binding. Detail consumers render `sliceId` and
`snapshotChain`. Publication consumers must enforce their own closure gates
before invoking the registered publication binding. This source registration
avoids introducing metadata in the obsolete plugin manifest format while the
identity sweep is pending.

`projected-identity-gate.py` is a temporary task-0.7 adapter. The qualification
script prefers the shared `tests/hyperfide/cases/v22/identity_gate.py --changed`
when available. Until it lands, the adapter checks changed and new files for
new occurrences of encoded former identifiers against HEAD, without charging
this task for unchanged violations in existing files. It excludes license
attribution and never reads environment files. Remove it when task 0.7 merges.

Run `bash tests/hyperfide/cases/v22/7_1.sh` for TypeScript checking, the real-binary
fixture test (including real Git worktree publication), and the identity gate.
