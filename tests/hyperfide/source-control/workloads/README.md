# Native source campaigns

`python3 tests/hyperfide/cases/source_control/6_2.py` runs the bounded real-API component gate against its own PostgreSQL instance and local object backend. It does not qualify the capacity cases.

Full campaigns use an already deployed HTTPS source authority and a dedicated repository/security-domain scope:

```sh
python3 tests/hyperfide/cases/source_control/6_2.py \
  --campaign /private/measured-growth.json \
  --deployment-config /private/deployment.json --live-s3
```

Copy a profile from `../manifests/campaigns/` and replace the hardware digest, backend identity and executable pins with measured values. The growth profile covers 10,000, 1,000,000 and 10,000,000 logical files; fleet covers 5,000 workspaces and 100 submissions/second; admission counts twenty million actual API opens; endurance lasts at least 72 hours with 100,000 distinct revisions in each daily window. Placeholder profiles cannot qualify a campaign. Full-case closure also requires the canonical evidence manifest and checker registration.

The private deployment configuration is mode 0600 and contains:

```json
{
  "schema_version": 1,
  "endpoint": "https://source.example.invalid/source",
  "isolated_scope": true,
  "scope": {"organisation_id": "UUID", "repository_id": "UUID", "security_domain_id": "UUID"},
  "backend_identity": "measured backend identity",
  "deployment_identity": {"provider":"provider","service_id":"service","deployment_id":"immutable deployment","image_digest":"sha256:HEX","resource_profile_digest":"sha256:HEX"},
  "credential_file": "/private/renewable-credential.json",
  "output_directory": "/private/campaign-results",
  "budgets": {"max_checkpoint_p95_ms": 1000, "max_growth_ratio": 2},
  "corpora": [{"logical_files": 10000, "revision_id": "sha256:HEX", "edit_paths": ["ten existing file paths"]}],
  "observer": {"argv": ["/private/measured-observer"], "executable_digest": "sha256:HEX", "timeout_seconds": 60, "env_keys": []}
}
```

Provide one immutable prepared corpus revision for each requested size and exactly ten existing edit paths. The driver independently counts logical files through paginated tree APIs before the measurement interval; subtree sharing is counted with its actual multiplicity. Corpus creation and its storage/history shape belong in the preparation evidence. Measured hot directories, distinct content, history depth, placement and tier configuration must accompany that evidence.

For the signed TLS listener, replace `credential_file` with `signed_config_file`, pointing to the private SDK `SignedSourceConfiguration` JSON (endpoint, scope, credential_id, ca_file, key_file). The driver uses the public `createSignedSourceClient`, reloads the issuer-owned configuration between attempts and keeps original operation IDs when retrying unknown outcomes or declared transient RESUME refusals. Credential versions bind the successfully authenticated credential ID and public signing key; in-place key replacement is detected even when the config JSON is unchanged. Successful envelope byte counts use the canonical source protocol codec; unavailable failed-response byte counts are explicitly recorded. Select exactly one credential transport.

The bearer credential file is mode 0600, with `schema_version: 1`, the exact `endpoint` and `scope`, a bearer `token`, and an `expires_at` timestamp. The client rereads it before every request and refuses credentials with less than 30 seconds remaining. Run the deployment's credential issuer separately and atomically replace this file during renewal. Endurance requires the client to observe at least two credential versions. No fixture capability or fixed 30-minute authority context is used. Network loss, throttling and transient gateway failures retry the exact operation body within a five-minute request deadline, rereading the credential for every attempt. `transport.jsonl` retains every retry outcome; logical revision counts remain separate. Fenced workspaces or an unrecoverable outage fail the run and retain their identities for recovery.

The observer, drills and real-worker canary are pinned executable commands. Their environment contains only PATH, LANG, the explicitly listed `env_keys`, `HF_SOURCE_CAMPAIGN_SCOPE`, and `HF_SOURCE_CAMPAIGN_RESULT`. Each command writes a fresh JSON receipt to that result path:

```json
{"schema_version":1,"status":"PASS","scope":{},"evidence":[{"path":"measured-evidence.json","size":123,"sha256":"sha256:HEX"}]}
```

The scope must match exactly; evidence files must remain inside the output directory and match their measured sizes/hashes. Observer receipts additionally contain `observations` with the exact `backend_identity`, `real_s3: true`, and nonnegative integer counters: `persisted_revisions`, `storage_requests`, `storage_bytes`, `hydrated_bytes`, `cache_hits`, `cache_misses`, `queue_depth`, `lock_wait_ms`, `connection_count`, and `publication_lag_ms`. Capture these from the deployed service and storage instrumentation. The before/after durable revision delta must equal distinct acknowledged client revisions. An observer label alone does not establish real storage: retain its raw provider/service evidence for independent case verification.

Endurance hooks must perform actual throttle, credential rotation, collection and recovery operations and a real Hyperfide worker canary. Canary receipts must list `worker_revision_ids`; the driver retrieves each revision and checks it is absent from the client ledger, then includes this separately counted total in the observer reconciliation. Keep their raw outcomes, fault intervals, accepted revision inventories and provider identities. Hook failure stops qualification. Logical API opens are recorded separately from hydrated files. The SQLite identity ledger and append-only request outcomes persist beside the receipt; workspace cleanup has its own inventory. A failed campaign preserves evidence and reports remaining workspace identities for scoped recovery.

Client hardware pins include available parallelism and bounded cgroup v2/v1 CPU, memory and CPU-set limit observations across exposed ancestors. Missing access remains explicitly unknown. Every corpus has before/after provider observations, and the configured deployment identity and resource-profile digest must match each one. A changed deployment or resized service invalidates the comparison.

Growth payloads use a fresh per-run content namespace and distinct corpus-size,
operation, and file indices. Every measured size therefore uploads equally cold
edit objects; the result records `content_condition.profile` as
`cold-unique-edit-objects`. Initial corpus metadata verification still warms the
read path equally before measurement. This profile does not claim a globally
cold object-store or operating-system cache.
