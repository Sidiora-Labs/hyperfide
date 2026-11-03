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

Native source queries can pass `nativeSource: { buildId, revisionId, rootTreeId }` to the existing `run` RPC. The host uses its protected `HF_SOURCE_CONFIG` and the signed source API; the repository field remains the settings namespace. `index-status`, `survey`, `context`, and `why` map to graph coverage, symbols, file context, and file dependencies. Results carry the exact source identity and use `binary: null`. A continuation cursor must be reused with the same source and query.

Native graph extraction is configured on the source service with `HF_SOURCE_GRAPH_BINARY`, `HF_SOURCE_GRAPH_BINARY_DIGEST`, and `HF_SOURCE_GRAPH_SCRATCH`. Builds require explicit selected paths and parser/resolver/configuration identities. Publication advances a channel only from a complete staged build using its expected generation. Incomplete extraction leaves the prior published generation available.
