# Hyperfide spec worker

`src/worker.ts` exposes `createTaskWorker(adapter).runTask(input)`. The operator
supplies the repository, project and worker provider. The default managed
environment provider is `environment-git-worktree`. The shared packet module
ports the dispatcher packet format and standing rules without changing the
dispatcher.

Tasks 2.1 and 1.4 are absent from this checkout. Their temporary integration
boundary is `src/worker-projection-adapter.ts`: the spec plugin supplies task
reads and board publication; the host supplies environment-scoped filesystem
reads, base revision, standard thread spawning with a per-thread `CG_TASK`, and
stop events. The stop subscription must replay an already stopped thread and
deliver callbacks asynchronously. Publication failures remain retryable.

The server's `spec-task-worker.ts` is a temporary source loader for this boundary.
Integration can replace it with the plugin registry entry when 2.1 lands. The
scripted provider creates a real Git worktree and executes a child process that
receives the packet on stdin and the task ID in `CG_TASK`; its optional script
edits only that worktree's spec. Server tests check the resulting board update.

`src/test/identity_gate.py` is a projection of the absent wave-0 identity gate.
The verification script selects the canonical gate when available; this local
copy can then be deleted. It scans changed tracked files against encoded rename
patterns and never reads environment files.

Run `bash tests/hyperfide/cases/v22/2_3.sh` from the repository root. It checks
server and plugin types, executes the server tests, and runs the identity gate.
