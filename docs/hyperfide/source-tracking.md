# Source tracking

## Snapshot slice environments

The `hyperfide-environment-slices` provider lets a repository select snapshot
slices alongside its worktree provider. The repository's `environmentProviderId`
selects the provider; an unset value retains the worktree default. The bundled
entry is `tools/bundled-plugins/environment-slices.ts`.

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

### Runtime integration

The bundled plugin registers with the SDK environment provider API. Its host
entry runs the binary on the selected machine using the host data directory.
Set `HYPERFIDE_BINARY` on that machine when the binary is not installed at
`/usr/local/bin/hyperfide`. Thread bindings persist in plugin KV storage;
`thread.idle` records the snapshot, and the plugin detail RPC returns `sliceId`,
`snapshotChain` and the fallback reason. Removal clears the binding.

The built-in registry installs the provider alongside the worktree provider;
the bundled package builds its server and host entries. The qualification
script uses the canonical identity gate directly.

The task 2.3 worker currently sends only the environment provider id, without
slice inputs. It must supply a task manifest before selecting this provider.
The task 4.4 publication service accepts Git task commits and has no snapshot
import operation yet. The provider's snapshot export remains available through
`SlicesProvider.publish`, but is not wired into wave publication. The fixture
proves export into a real Git worktree; it does not prove wave publication.

Run `bash tests/hyperfide/cases/v22/7_1.sh` for TypeScript checking, the real-binary
fixture test (including real Git worktree publication), and the identity gate.
