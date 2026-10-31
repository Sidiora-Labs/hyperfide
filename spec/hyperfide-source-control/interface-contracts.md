# Interface catalogue contract

Status: proposed prerequisite contract; implementation and product qualification are pending. Requirement 17 and tasks 0.10–0.14 govern adoption. See [sandbox contracts](sandbox-contracts.md) for environment installation and [fleet orchestration](fleet-orchestration.md) for decision ownership.

## Observed schema and limited inspection

The reference is [LayerX merge interfaces.kvx at acecdb6015412fc9bf23ab0654040f035950cc71](https://github.com/Sidiora-Labs/paxeer-monorepo/blob/acecdb6015412fc9bf23ab0654040f035950cc71/spec/layerx-merge/interfaces.kvx). Inspection used three HTTP byte ranges, each 8,192 bytes, starting at offsets 0, 25,000,000 and 50,000,000. The server reported a 51,440,845-byte file. An earlier 16 KiB header sample used the moving main URL. No complete catalogue review or import was performed.

The header identifies generated interface blocks derived from spec fragments and referenced by task interface IDs. Sampled entries share these fields:

| Field | Observed representation | Intended use |
|---|---|---|
| Section | `[interface.<id>]` | Stable identity referenced by a task or environment |
| `kind` | String | Declaration category; samples include `c_symbol`, `go_exported`, `env_var` |
| `path` | String | Repository-relative declaration location |
| `line` | Integer | Source location hint at the pinned revision |
| `signature` | String | Declaration or configuration contract text |
| `callers` | Array of strings | Known consumer locations |
| `status` | String | Samples include `stable` and `retire` |
| `contract` | String | Supporting document and anchor |
| `notes` | String | Extraction or migration context |

This sampling establishes a compatible block shape, not an exhaustive vocabulary or validator for every entry. A sampled Swift declaration uses the legacy `go_exported` kind; importers must not infer implementation language solely from that value. Empty or sampled caller lists do not prove absence of dependencies. Full schema migration must version observed variants without silently rewriting historical identities.

## Proposed execution contract

The fleet consumes the same flat KVX grammar and stable block identities. The local [example](examples/fleet/interfaces.kvx) illustrates the shape with proposed Hyperfide interfaces; it is not extracted source evidence. New policy/provenance fields belong to a versioned catalogue envelope or explicit schema extension, rather than silently changing the meaning of existing fields.

The authoritative publication includes a catalogue version, immutable source identity, fragment digests, extractor version and a shard/index manifest. Resolve selected interface IDs through that index, verify each returned block and inclusion in the pinned publication, and transfer only the requested bounded closure. Do not require the whole interface file to exist inside a sandbox, in an agent prompt, or in a single service's memory. Missing dependencies return explicit partial coverage or refusal; clients cannot infer completeness from a successful byte-range read. Sampling this reference is author research, not a runtime subset protocol.

`package.kvx` selects the interface IDs needed by the environment. Task assignments separately declare interfaces they provide, consume or are authorized to change. A ready installation records the exact selected block digests and publication provenance. A worker may fetch further authorized blocks explicitly without changing the pinned publication implicitly.

Line numbers support navigation; identity and compatibility depend on the source revision, declaration/contract digests and checker results. Verification combines source extraction, declared producer/consumer constraints, affected-consumer checks and behavioral acceptance evidence. Matching a signature string cannot establish behavioral correctness. Historical `stable` or `retire` labels never grant execution or deletion authority.

An interface change becomes a versioned proposal identifying affected IDs and consumers. The Primary coordinates cross-wave changes; the responsible managers update assignments and environment generations after admission. Required dependency and acceptance constraints remain enforced. Generated catalogue entries are regenerated from their fragments/source; worker edits to a downloaded subset cannot redefine the authoritative contract.

## Qualification

SCM-026 must prove syntax/type rejection, stable-ID lookup, exact publication membership, unknown-version refusal, missing and stale consumers, tampered blocks, bounded selection and declared compatibility checks. SCM-027 binds those selected contracts to the installed environment and real consumer execution. A schema parse alone proves neither complete catalogue coverage nor fleet readiness.
