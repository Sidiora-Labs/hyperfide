# Hyperfide-plugin-memory

HYPERFIDE's official plugin for durable, progressively disclosed agent memory. It
provides:

Because this memory store works across providers, we recommend turning off
provider-native memory under Settings → Providers while using it. That avoids
duplicated or conflicting memories split between Codex, Claude Code, and hyperfide platform.

- plugin-private SQLite storage with append-only migrations;
- global and current-project memory scopes;
- an automatically injected, 3,900-character summary catalog through
  `hyperfide platform.agents.contributeInstructions`;
- CLI-only agent access through `hyperfide platform memory` (no native agent tools);
- FTS5 search followed by full-record reads;
- explicit provenance, tags, kinds, importance, pinning, and version history;
- optimistic update/forget operations and soft deletion;
- basic prompt-injection and secret-pattern rejection;
- a bundled `memory` skill that teaches agents retrieval and write policy.
- a Settings → Memory table for reviewing, editing, and deleting every stored
  global or project memory.

## Install

Install Memory from the HYPERFIDE Official catalog:

```bash
hyperfide platform plugin install memory
hyperfide platform plugin list
```

## Try it

```bash
hyperfide platform memory add \
  --scope project \
  --name turbo-validation \
  --summary "Use Turbo for builds and typechecks" \
  --details "Run pnpm exec turbo run typecheck --filter=@hyperfide/<pkg>." \
  --kind procedure \
  --tag build \
  --tag testing \
  --importance 80 \
  --reason "Durable repository validation convention" \
  --json

hyperfide platform memory search "Turbo typecheck" --scope all --json
hyperfide platform memory get <id> --scope all --json
```

Project writes take the invoking CLI's HYPERFIDE project context. Global writes must
explicitly pass `--scope global`. The injected catalog refreshes at every
thread start / turn submission, so a successful CLI write is visible on the
next turn.

## Limitations

- CLI calls require loopback access to the local server. Claude's macOS
  workspace sandbox permits this; Linux and other provider sandboxes may
  still block it.
- Retrieval is FTS5 keyword search in this first version; embeddings and
  background reflection are deliberately deferred.
- The safety scanner is a guardrail, not a substitute for avoiding sensitive
  memory content.

## Develop

```bash
pnpm exec turbo run test typecheck --filter=hyperfide-plugin-memory
hyperfide platform plugin dev ./plugins/memory
```

## Hyperfide task decisions

The durable task bridge lives beside the private memory store. Workers use
`hyperfide platform memory remember "decision" --repository ROOT --task FEATURE/ID`
and `hyperfide platform memory recall --repository ROOT --task FEATURE/ID`.
Never store secrets in either memory store.

`rememberDecision` and `recallDecisions` RPCs expose the same repository/task
scope. The CLI writes through `hyperfide remember`; reads use `hyperfide recall`
and validate the binary's JSON shape. Host failures propagate to the caller.

Pending dependency integration uses these explicit projection seams:

- `graph-memory-projection.ts`: `GraphMemoryHost` resolves the binary from the
  graph/host setting and executes it on that host in the repository root. The
  plugin factory accepts its `GraphMemoryBridge` as the second argument; without
  it, durable commands report a configuration error. Private memories still work.
- `../hyperfide-spec/memory-packet-projection.ts`: the 2.3 packet builder calls
  `TaskMemoryProjection.packet(existingPacket, scope, requires)`; task detail
  calls `detail(scope)`. Only decisions and constraints from that task and its
  direct prerequisites enter the `Recalled decisions` section. IDs without a
  feature use the current task's feature. Recall returns at most 1,000 per type.
- `identity_gate.py`: local identity check until the shared 0.7 gate arrives;
  `7_2.sh` automatically prefers the shared gate when available.

Run `bash tests/hyperfide/cases/v22/7_2.sh` for package typechecking, all memory
plugin tests, real-binary fixture coverage, packet/detail coverage and identity.
