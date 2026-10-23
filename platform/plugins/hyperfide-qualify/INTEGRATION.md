# Checker integration

`registerChecker(host, config)` observes the real `TaskWorkerHost.publish`
lifecycle emitted by `createTaskWorker` in `hyperfide-spec/src/worker.ts`.
Reconciled updates carry the repository, worker environment, provider, project,
and original base commit. The checker reads criteria and task IDs through the
real KVX model, and launches through the same `spawnTaskThread` entry point as
the worker. There is no projection thread factory or synthetic task model.

The shared thread request exposes an optional verification tool. A provider
must expose this tool to the checker and call it before writing the structured
verdict to `.hyperfide/checker-verdict.json` in its managed environment. The
checker waits for the real stopped event and reads that file through the worker
host's file API. A verdict without a completed, matching tool run is an error.
Verification runs inside the checker environment.

Configuration supplies the lane log and persistent `recordChecker(task, record)`
storage. Pass records include the provider and an explicit `independent` flag;
wave closure must require independence when configured. Repository checks are
serialized to avoid allocating duplicate fix task IDs. Findings invoke the CLI
with argv arguments and append tasks requiring the reviewed task.

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
