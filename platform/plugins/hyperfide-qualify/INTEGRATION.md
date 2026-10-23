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

# Lane receipts and task detail

`projection-lane-receipts.ts` is the temporary 4.1 completion-event boundary.
Register `registerLaneReceipts(host)` with the lane host. The host delivers the
completed verification's exit code, duration in milliseconds, toolchain versions,
combined log and repository-relative source paths. Failed lanes write no passing
receipt. `recordReceipt` stores the relative receipt path on the task; repeated
passes keep separate immutable bundles in the lane repository.

The spec plugin's `registerReceiptDetail(host)` subscribes to task detail requests.
It discovers receipts, runs the Python closure checker separately for each, and
returns warnings plus `openLog` and `openBundleList` actions backed by the host's
file opener. Drift warns and leaves closure open, without blocking task viewing.
The checker defaults to the repository's `tests/hyperfide/closure_check.py`; a host
may supply an absolute checker path when the lane repository lacks the harness.
