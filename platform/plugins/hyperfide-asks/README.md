# Inbox

The Inbox app calls `inboxList` and `inboxAnswer` RPCs. Open Asks are grouped by
repository identity and task, with kind and task filters. Permission answers
require the operator to enter their identity; the answer note and RPC result
record that identity. Secret values and sensitive variables use the
`hyperfide-secrets` plugin's `storeReference` RPC. Only `secret-ref:<name>` reaches
the binary; secret notes are omitted to avoid accidental disclosure.

`src/bridge-projection.ts` is the local interface for the unmerged 3.1 bridge.
Replace it with that bridge at integration. It normalizes the binary's Ask rows
and answers through `hyperfide ask answer <id> <answer> -m <note>` on the server.
The default server adapter discovers project source paths on each refresh;
`inbox.repositories` in plugin storage can supply an explicit list. This local
adapter assumes those paths are accessible on the server. The merged host-aware
3.1 bridge owns repository routing.

Named secret files live under `~/.hyperfide/secrets` with mode 0600, in a directory
created with mode 0700. Their randomly generated reference names contain no value.
No read-value RPC is exposed by the Inbox.

Run `bash tests/hyperfide/cases/v22/3_3.sh` from the repository root.
