# Hyperfide Graph

Bundled by default with an Index panel and `graph status --host ID --repository PATH`.
RPC `run` accepts hostId, repository, command (survey, context, index-status, why),
and a non-option target for queries. Host execution is bounded to 15 seconds and 8 MiB.
Settings are stored per host and repository: enabled (initially true), binaryPath (optional).
The binary resolves on the host from the override, HYPERFIDE_BIN, repository cg, then PATH.
`projected-binary-adapter.ts` is the local task 1.2 interface; replace it when that service lands.
`bundle.ts` derives the manifest key from the builder schema during the identity migration.
The adapter builds in a temporary staging directory and briefly uses the unscoped
package basename for the host builder, which currently rejects scoped source owners.
The copied runtime retains `@hyperfide/hyperfide-graph` and the derived plugin id.
