# Inbox

The Inbox app calls `inboxList` and `inboxAnswer` RPCs. Open Asks are grouped by
repository identity and task, with kind and task filters. Permission answers
require the operator to enter their identity; the answer note and RPC result
record that identity. Secret values and sensitive variables use the
`hyperfide-secrets` plugin's `storeReference` RPC. Only `secret-ref:<name>` reaches
the binary; secret notes are omitted to avoid accidental disclosure.

The store bridge mirrors CLI rows and publishes debounced database/WAL updates.
`src/inbox-adapter.ts`, `src/thread-bridge.ts` and `rpc-client.ts` adapt its
RPC and row shapes for the inbox, thread lifecycle and UI consumers.
The local host adapter reads the graph plugin's repository binary-path setting
and verifies the executable with the daemon's `inspectHyperfide` implementation.
`inbox.repositories` can supply explicit repository paths; otherwise project
source paths are used. These paths must be accessible on the server host.

Named secret files live under `~/.hyperfide/secrets` with mode 0600, in a directory
created with mode 0700. Their randomly generated reference names contain no value.
No read-value RPC is exposed by the Inbox.

Run `bash tests/hyperfide/cases/v22/3_3.sh` from the repository root.
