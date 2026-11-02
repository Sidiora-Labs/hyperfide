# Native source-control service

The source service stores immutable content and persistent trees in S3, with repository, revision, operation and authorization metadata in PostgreSQL. Its online API is `POST /api/v1/source-control`; the SDK works without a checkout or Git history.

Build and start the service from `core/control-plane`:

```sh
npm run build
HF_SOURCE_CONTROL_CONFIG=/run/secrets/source-control.json npm run source-control
```

`HF_SOURCE_CONTROL_CONFIG` names an owner-only regular JSON file. TLS file paths resolve relative to that file. The server accepts Ed25519 **public** verification keys; the credential issuer retains signing keys.

```json
{
  "host": "0.0.0.0",
  "port": 9443,
  "trust": {
    "issuer": "https://identity.example.test",
    "audience": "hyperfide-source",
    "keys": {"source-1": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n"},
    "max_ttl_seconds": 300,
    "clock_skew_seconds": 0
  },
  "tls": {
    "certificate": "source.crt",
    "private_key": "source.key"
  }
}
```

The private key also requires owner-only permissions. Local development can explicitly set `"host":"127.0.0.1"` and `"allowLoopbackHTTP":true` instead of TLS. External listeners require TLS 1.3.

Supply the existing PostgreSQL connection in `DATABASE_URL`. Source-control migrations `0736` through `0740` must already be applied through the migration lifecycle. The server checks schema presence when starting. Repository scope, source authority, capabilities and active principal credentials must be provisioned by the authorized control plane.

The S3 backend reads `HF_SOURCE_S3_ENDPOINT`, `HF_SOURCE_S3_REGION`, `HF_SOURCE_S3_BUCKET`, `HF_SOURCE_S3_ACCESS_KEY_ID` and `HF_SOURCE_S3_SECRET_ACCESS_KEY`; `HF_SOURCE_S3_SESSION_TOKEN` is optional. Existing `HF_ARTIFACT_S3_*` configuration is also supported. Source objects use their own `source/v1/` prefix and physical incarnations. Normal source reads follow pinned tree/object identities rather than bucket listings.

Set `HF_SOURCE_CURSOR_KEY` to the base64url encoding of 32–64 random bytes, and supply explicit positive workspace budgets:

| Variable | Unit |
| --- | --- |
| `HF_SOURCE_CACHE_BYTES` | Immutable cache bytes |
| `HF_SOURCE_CACHE_ENTRIES` | Immutable cache entries |
| `HF_SOURCE_MAX_FILE_BYTES` | Materializable file bytes |
| `HF_SOURCE_MATERIALIZED_BYTES` | Materialized workspace bytes |
| `HF_SOURCE_DIRTY_BYTES` | Retained dirty workspace bytes |

The listener emits a bounded `source-control.ready` event containing its address. SIGTERM and SIGINT stop new requests, drain the listener and close the PostgreSQL pool.

## SDK access

The issuer supplies a short-lived `HF-SOURCE-1` bearer token for the exact organization, repository and security-domain scope. Its current credential and capability records are checked in PostgreSQL.

```ts
import {SourceControlClient} from '@hyperfide/source-control';

const source = new SourceControlClient({
  endpoint: 'https://source.example.test:9443/api/v1/source-control',
  scope: {
    organisation_id: organizationId,
    repository_id: repositoryId,
    security_domain_id: securityDomainId,
  },
  token: () => credentialProvider.currentSourceToken(),
});

const capabilities = await source.capabilities();
const revision = await source.revision(pinnedRevisionId);
const entry = await source.lookup(pinnedTreeId, 'sdk/example/src/index.ts');
```

Mutations carry explicit operation and idempotency identities plus current source authority. Retain those identities across an uncertain response and query the original operation before retrying. Revision creation, qualification, acceptance and remote Git publication have separate receipts.

## Merge, rebase and revert

`source.transforms.merge`, `source.transforms.rebase` and `source.transforms.revert` operate on pinned revision IDs. Their SDK methods are `merge`, `rebase` and `revert`. Supply the operation and idempotency IDs through the SDK call options; the request body contains only transformation inputs. These operations require repository-wide source authorization and the capabilities used to read revisions, create revisions, resume transformations and inspect their results.

Merge uses three-way comparison of immutable tree identities, reuses unchanged subtrees, and merges bounded UTF-8 text edits. Conflicts retain typed references to each side, including binary, add/add, delete/modify, symlink, type and executable-mode conflicts. Rename detection is reported as `NOT_PERFORMED`. Multiple maximal merge bases require an explicit `base_revision_id`.

Rebase accepts an ordered linear `revision_ids` stack and an `onto_revision_id`. It retains each completed step and its original-to-successor mapping under the original change identity. `max_steps` bounds work per call. An unchanged replay maps back to its existing revision with `unchanged: true` and preserves its original history.

Inspect progress with `transformation(operationId)` and continue with `resumeTransformation({operation_id: operationId, max_steps: 1})`. A `CONFLICT` result includes an aggregate `conflict_id`; resolve it by passing `resolution: {conflict_id, resolved_tree_id, provenance}` to `resumeTransformation`. The resolved tree must already be uploaded and verified. Optional `expected_generation` rejects a stale continuation. Reusing a conflict identity with a different resolution is refused.

Revert applies the inverse of a pinned revision onto a pinned target. Reverting a merge requires `mainline_parent_revision_id`; reverting a root revision requires an explicit source patch. Cancellation through `source.operations.cancel` preserves already completed steps and prevents later commits. After a lost response, inspect the original transformation before resuming. New revisions require fresh qualification and acceptance.
