# Hyperfide Graph

Bundled by default with an Index panel and `graph status --host ID --repository PATH`.
RPC `run` accepts hostId, repository, command (survey, context, index-status, why),
and a non-option target for queries. Host execution is bounded to 15 seconds and 8 MiB.
Settings are stored per host and repository: enabled (initially true), binaryPath (optional).
The binary resolves on the host from the override, HYPERFIDE_BIN, repository cg, then PATH.
Binary verification uses task 1.2's host-daemon `inspectHyperfide` implementation.
`build-runtime.ts` packages that source into the host artifact. The host builder
currently rejects scoped source owners, so staging uses the package basename;
the runtime manifest retains `@hyperfide/hyperfide-graph`.
