# Hyperfide spec worker

`src/worker.ts` exposes `createTaskWorker(host).runTask(input)`. The operator
supplies the repository, project and worker provider. The default managed
environment provider is `environment-git-worktree`. The shared packet module
ports the dispatcher packet format and standing rules.

Task reads use the read model's `featureFromKvx`, including reconciliation from
the worker checkout. The host supplies environment-scoped file reads, base
revision, thread creation, stop events and board publication. Stop subscriptions
must replay an already stopped thread and deliver callbacks asynchronously.
Publication failures remain retryable.

The scripted test provider creates a real Git worktree and executes a child
process receiving the packet on stdin and the task ID in `CG_TASK`.
Run `bash tests/hyperfide/cases/v22/2_3.sh` to check server and plugin types,
server worker integration, plugin tests and the canonical identity gate.
