# Repository operations plugins

These canonical plugins are separate from the source-control panel. Their
recipes were absent from the older catalogue. Record each as not run until its
actual configured repository and provider prerequisites have been exercised;
source discovery and a matching inventory fingerprint are not a live pass.

Use the main skill's isolated store, doctor and cleanup rules. Select one
disposable repository/project and use its configured native identity. Read
current command help/schema before writing; preserve existing project data.

| Feature | Entry and source | Drive and observable result |
| --- | --- | --- |
| Spec tasks and waves | **Spec**; `plugins/hyperfide-spec/src/board/plugin-app.ts` and `src/read-model-server.ts` | Load the fixture specification, inspect an eligible task and its dependencies/wave, and compare with `hyperfide spec next`. Changing a fixture task updates its durable spec state; task execution is a separate action. |
| Repository asks | **Inbox**; `plugins/hyperfide-asks/app.tsx` and `src/server.ts` | Create a synthetic repository Ask, inspect its type and pending state, answer it through the provided control, then re-read it with the Ask interface. Only that Ask changes; sensitive answers remain secret references. |
| Repository graph | **Graph**; `plugins/hyperfide-graph/{app.tsx,server.ts,host.ts}` and `views/index-summary.tsx` | Select the configured repository, read index status and a bounded query, then change one fixture source file and refresh. Show the intended revision/index coverage; stale or unavailable indexes remain explicit. Native and Git source identities must not be mixed. |
| Qualification | **Qualification**; `plugins/hyperfide-qualify/{app.ts,server.ts,native-adapter.ts}` | Run one registered fixture task and inspect its actual receipt/assertions. Invalid source or missing evidence refuses qualification; component evidence never becomes a full-case pass. Re-read the same receipt through the CLI/API. |
| Fleet dispatch | **Dispatch**; `plugins/hyperfide-dispatch/app.tsx` and `server.ts` | With an authorized isolated provider/project, submit a harmless task package and follow primary/wave/worker assignment through completion. Verify source and task identities survive replacement, and cleanup only the owned run. Missing provider readiness stays a prerequisite. |

The native product API/CLI/browser fixtures, full-case registrations and live
provider recipes have different coverage. Link the applicable current receipt
and raw evidence to each row; do not promote a local fixture into a provider
pass. Repo-specific KVX and `.neron` configuration belong to the selected fixture,
not a user's existing checkout.

## Installed release runtime

Release assembly uses the Node version declared by
`core/control-plane/package.json` (`engines.node`), currently **24.22.0**.
Select that runtime on `PATH` for both assembly and the extracted smoke journey;
the development `.nvmrc` selects Node 22 and has a different native-addon ABI.

Run `tools/repository/release.sh --dry-run --skip-tests --output <new-directory>`
with the release runtime, then run `python3 <new-directory>/smoke.py` with the
same `PATH`. This starts the extracted server and host daemon with isolated
state, enrolls the host, and verifies that the packaged application entry exists.
Retain the archive checksums, command logs, and the Node version used.

Inspect `native-runtime.json` inside both platform server and host-daemon
archives. It records the loaded addon names, Node module ABI, header checksum,
and addon file hashes. For Node 24.22.0 the ABI is **137**. The builder compiles
copied runtime dependencies in its temporary stage and runs an actual SQLite
query before archiving. A successful smoke requires the extracted processes to
load those staged addons under the recorded runtime.
