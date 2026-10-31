# Railway machines

The server registers `hyperfide-machine-railway` on the machine provider SDK.
`src/machine-ops.ts` exports the operations client for dispatch callers, with an
injected credentials resolver and optional SDK client factory for offline tests.

Configure `HYPERFIDE_RAILWAY_API_TOKEN` and `HYPERFIDE_RAILWAY_ENV_ID` through the
plugin's secret settings. Each create, connect and list resolves settings again.
The runtime never reads credentials from the process environment.

The client supports checkpoint restores, CPU, memory in MiB, idle timeout in
seconds, environment variables and region. Railway has no sandbox naming field;
`name` is an allocation label for host callers. Exec defaults to a 1,800 second
timeout and a 4,000,000 byte cap per stream. All returned strings and errors are
redacted; file reads preserve binary bytes except credential/token sequences.

Host allocation intent is recorded before creation. If creation has an unknown
outcome, reconciliation reports failure until the allocation is inspected rather
than guessing which remote machine belongs to the request. Suspend persists a
disk checkpoint before destroying compute; resume restores that checkpoint.

Run `bash tests/hyperfide/cases/v22/5_1.sh` from the repository. The live smoke
prints SKIP unless `HYPERFIDE_RAILWAY_LIVE=1`; an enabled run additionally needs a
module path argument exporting `resolveCredentials` backed by plugin settings.
No live credentials belong in fixtures, source or process environment variables.
