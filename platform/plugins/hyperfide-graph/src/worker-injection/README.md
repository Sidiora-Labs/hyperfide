# Worker injection

`graph-lifecycle-projection.ts` is the local task 1.3 integration surface.
The Claude Code and Codex bridge adapters call `worker-injection.ts` when constructing
sessions. The protocol validates each capability and returns it in
`attachedCapabilities` on the thread identity response.

The task 1.3 plugin lifecycle supplies `GraphWorkerHost` to
`registerGraphWorker`: its thread-info contribution renders the returned
capabilities, and its repository setting calls the registered setter.
The host must resolve each thread's repository and task on the provider host.
No plugin root files are supplied by this task.

Set `enabled` to `false` in `.codegraph/worker-injection.json` to disable
injection for that repository. A missing file enables injection only when
an ancestor repository contains a `.codegraph` directory. Invalid settings
raise an error. Setting changes apply when a provider session is constructed.
No process-level task is inherited: `CG_TASK` comes from the thread request
or its explicitly supplied environment.
