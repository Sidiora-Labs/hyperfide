# Resumable full-case release campaigns

First capture the final reviewed implementation once:

```sh
python3 tests/hyperfide/source-control/full_case/prepare_capture.py --all-full
```

Use the full-case manifest builders with that same `native.json`. Each manifest
may replace only its ordered assertion-inventory hash; scope, revision, root,
authority epoch, policy, source manifest, readiness and toolchain stay shared.
Pin deployment/resource configuration through each case's declared inputs and
policy. Credentials may be renewed; never copy secrets into source evidence.

Prepare an explicit mapping file. All paths are relative to the workspace:

```json
{
  "schema_version": 1,
  "release_id": "00000000-0000-4000-8000-000000000001",
  "registry": {"path":"tests/hyperfide/source-control/registry.json","sha256":"HEX"},
  "claims": {"path":"tests/hyperfide/source-control/claims.json","sha256":"HEX"},
  "native_source": {"path":"build/source-control/full-case/capture/native.json","sha256":"HEX"},
  "entries": [
    {"case_id":"SCM-023","variant":"api-cli-ui","manifest":{"path":"build/source-control/full-case/scm-023.json","sha256":"HEX"}}
  ]
}
```

The list selects already prepared, reviewed full-case manifests. It is not a
command template and does not manufacture a missing backend/provider variant.
Run it in a new output directory:

```sh
python3 tests/hyperfide/source-control/release_campaign.py \
  --plan build/source-control/release-plan.json \
  --output build/source-control/release-run
```

Resume that exact plan and input set with `--resume`. The runner fingerprints
all manifest/registration/source inventories and canonical checker tools,
locks the run, and keeps immutable input copies, state checkpoints, attempt
logs and the canonical qualifier's receipts. Successful entries are checked
again and skipped. Failed completed entries get a new attempt directory only for an empty declared resource inventory whose failed receipt and cleanup observations pass the canonical checker's integrity checks;
previous evidence remains intact. An interrupted entry is recovered only from
an actual independently verified receipt. If it has no such receipt, the run
reports it unresolved and continues other entries; reconcile the recorded
process instead of launching the same unknown operation again.

A missing required variant or failed entry returns `BLOCKED` with its explicit
inventory. The runner never substitutes task-component receipts. When every
claim is satisfied it writes `closure.json` and runs the same strict closure
checker used by task 6.3. Hash-named closure candidates and reports remain for
audit. Completing this campaign does not synthesize operator release approval;
task 7.2 still verifies that separately.

The runner's own test exercises the actual qualifier and independent checker
in temporary owned workspaces:

```sh
python3 tests/hyperfide/source-control/release_campaign_test.py
```
