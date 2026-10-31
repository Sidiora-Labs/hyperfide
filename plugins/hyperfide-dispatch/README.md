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

The server starts a background dispatcher after SDK bind. It begins paused with
cap zero; configure gateway keys before raising the cap and resuming. Providers
without checkpoint support remain available to their other consumers; Dispatch
reports that no checkpoint-capable provider is available. Gateway key JSON is a
secret setting containing `{ id, value, concurrency }` records; only counts and
IDs enter the ledger.

The fleet JSON retains the image builder's checkpoint/base fields and adds a
`dispatcher` object with `feature`, `integrationRef`, `prepare`, `runner`
(`codex` or `claude`) and `mcp` configuration. These values are required before
an unpaused tick can launch work. Tasks come from the spec plugin read model;
merged dependencies are checked against the integration ref's commit messages.
Durable claims belong to this server's dispatcher and are released on terminal
results or restart. The concurrency-limit snapshot bounds the key budget and
accounts for running platform threads. Tick interval defaults to 15 seconds;
backoff is persisted and retries wait until it expires. Service disposal stops
scheduling, interrupts owned compute and drains ledger writes.

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
