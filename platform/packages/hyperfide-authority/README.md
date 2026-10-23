# Plugin storage

`openPluginStorage(plugin, repository)` chooses the signed control service when
`HYPERFIDE_AUTHORITY_URL` is set, using the same operator, CA and key configuration
as `createAuthorityClient`. It never falls back after a remote failure. Without a
URL it uses the plugin's private SQLite database under `~/.hyperfide/plugins/`.
Dispatcher databases live beside the old ledger directory. Scope each store with
the repository (or dispatcher directory), never a task's mutable working tree.

The control service stores observations in `hyperfide.plugin_state`, scoped by the
authenticated organisation and run as well as plugin and repository. These records
do not confer claims, leases, permission grants or qualification authority.

## Migration

Apply the trusted service migrations (including `0717-plugin-state.sql`) before
selecting authority storage. From `platform/`, with authority credentials set:

```sh
pnpm exec tsx packages/hyperfide-authority/bin/migrate-plugin-state.ts hyperfide-spec /repository /private/state.sqlite upload
pnpm exec tsx packages/hyperfide-authority/bin/migrate-plugin-state.ts hyperfide-spec /repository /restored/state.sqlite download
```

An optional final argument is an exported legacy plugin KV array of
`{ "key": "...", "value": ... }` entries. Migration verifies the copied values,
keeps its source, accepts replay and rejects differing destination values. Each
batch is atomic and limited to 128 entries and 256 KiB per value; the copier
splits larger stores into bounded batches. Spec read-model registration imports its
previous host cache when absent; asks rebuilds its mirror from the real binary;
publication reads import legacy host records on demand; dispatch imports its
existing JSON jobs and budget once, retaining the original files for rollback.
Run `pnpm exec tsx plugins/hyperfide-qualify/migrate.ts /repository` to import
historical receipt metadata from existing artifact directories.
Lane completion records lane metadata and receipts in the selected store; receipt
evidence files remain in their existing repository artifact paths.

## Embedded single host

From the repository root, explicitly opt in without a configured authority URL:

```sh
HYPERFIDE_AUTHORITY_EMBEDDED=1 python3 platform/packages/hyperfide-authority/bin/embedded.py -- your-command
```

Build `services/hyperfide` first. This repository helper starts an owned PostgreSQL
cluster plus the actual HTTPS control service, provisions a session operator, and
passes its signed-client configuration to the command. A configured URL takes
precedence. No listener or PostgreSQL process starts without opt-in. Plugin state
is restored and checkpointed to `~/.hyperfide/authority/state.sqlite` across clean
session exits. `HYPERFIDE_AUTHORITY_EMBEDDED_DIRECTORY` selects another private
checkpoint directory; a lock prevents overlapping embedded sessions. An unclean
host termination can lose the current session's changes and leave the lock for
operator recovery. Use a configured durable control service for unattended runs.
