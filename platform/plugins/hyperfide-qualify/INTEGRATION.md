# Checker integration

`registerChecker(host, config)` subscribes to the spec plugin's implemented-task
event. The host supplies the managed Run task thread factory, task-id listing,
and persistent `recordChecker(task, record)` storage on the reviewed task. Pass
records include an explicit `independent` flag; wave closure must require this
flag when independent review is required. Errors never produce a pass.

Tasks 2.3 and 4.1 are absent on this base. The temporary shared adapter is
`../hyperfide-spec/projection-run-task.ts`: replace its runner and thread-factory
interfaces with the merged spec plugin's exports. `CheckerHost` and
`ImplementedTask` describe the corresponding lifecycle and lane-log boundary.
The checker itself uses that single Run task factory for provider execution;
there is no separate checker thread implementation.

The provider receives a verify tool scoped to the task's managed environment.
The checker accepts only a verdict matching that tool's last completed execution.
Repository checks are serialized to avoid allocating duplicate fix task ids.
Command arguments are passed as an argv array to the shared binary runner.
