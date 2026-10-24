# Multi-host dispatch projection

The Dispatch plugin's Fleet page reads its private ledger and exposes
`fleetImportLedgers` for external workers. Pass `{ source, jobs }`; each job uses
the `JobLedger` fields and may include ISO `started`/`finished` timestamps,
`worker`, a bounded `log`, and `events: [{ stage, at }]`. Reimporting a job ID
updates its record. Imported sources remain visible and are excluded from the
dispatcher's restart cleanup.

Image builder settings are `dispatch_repository` and `dispatch_fleetPath`.
Their labels retain the logical names `dispatch.repository` and
`dispatch.fleetPath`; the host settings API forbids dots in keys. The revision
field resolves branches, tags and short SHAs with Git. Both pages poll every
five seconds.

Task 7.19 remains blocked on permission Ask #1: the registered provider API has
no named checkpoint allocation/result or command execution bridge. The default
server entry still does not run a Dispatcher, and its image execution adapter
still cannot build checkpoints. Ledger/UI checks alone do not prove those paths.

The fleet contracts are exported from `@hyperfide/plugin-sdk/machine-provider`.

Task 6.4 adds `src/host-capacity.ts` while task 5.4 is pending. Its
`scheduleHost` function fills online hosts by utilization, respects their slot
capacity, and excludes every machine that has already lost this job.

The server's `services/machines/fleet-projection.ts` is the removable task 6.2
boundary: `FleetAuthority.transaction` must serialize, persist, and roll back
failed mutations. `FileFleetAuthority` supplies this for one server process;
the authority client can replace it with a remote transaction adapter. Operator
credentials are resolved by an injected allow-list callback, with no permissive
fallback. Tokens and daemon sessions are stored only as SHA-256 digests.

Compose `FleetService(authority, scheduleHost, authorizeOperator)` and pass it
as `createApp(deps, { fleet })`. The API lives at `/api/v1/fleet`, and its
`/view` page shows host utilization and job attempts. The operator callback
receives the request's Authorization header or cookie. Host enrollment, polling,
and completion use separate single-use enrollment tokens and host sessions.
The integration must use its established operator authentication callback.

Run one `FleetWorker` per enrolled sandbox with `createFleetHttpTransport` and
the task runner callback. The runner receives the assigned thread ID, payload,
and cancellation signal. `serve` polls every five seconds; loss is detected after
thirty seconds during polling or status refresh. On loss the server fences the
old attempt and retries on another host once. Call `stop` and await `drain` on
shutdown. `enrollRailwayHost` adapts the machine executor to the enrollment
bootstrap and passes credentials through a private temporary file to stdin.

`test/multi-host.test.mts` uses the real fleet routes, durable store, scheduler,
daemon workers, and Railway provider with fake machine operations. The identity
gate in `tests/hyperfide/cases/v22/identity_gate.py` is a temporary projection for
pending task 0.7: changed mode rejects newly introduced matches relative to the
base commit, while full mode reports all existing matches.
