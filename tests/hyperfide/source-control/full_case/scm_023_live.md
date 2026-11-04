# Deployed SCM-023 product journey

`scm_023_live.py` uses an existing real native fleet candidate on a deployed HTTPS
source service. It does not create a local service, PostgreSQL database, provider,
checker, or acceptance. The product's signed client remains on a localhost bridge;
Chromium never receives the source credential or private key.

Set `HF_SOURCE_LIVE_JOURNEY_INPUT` to a private regular JSON file with:

- `variant`: `api-cli-ui`.
- `source_config`: absolute protected native signed client configuration path.
- `run_id`, `task_id`, `assignment_id`: the actual native worker assignment.
- `candidate_id`, `evidence_ids`: candidate and independent registered checker
  evidence ready for UI qualification. Its integration domain must still permit
  acceptance at the expected generation.
- `destination_id`, `target_ref`, `github_repository`: the configured deployed
  GitHub destination, permitted ref, and `owner/repository` for independent readback.
- `expected_old_oid`: observed namespaced Git identity; defaults to the all-zero
  identity only for a newly created empty remote ref.
- `conflict_path`, `readback_path`: optional bounded text paths; default `main.txt`.

The actor invokes the existing built source CLI and privately bundles the real
SourcePanel. Do not run during shared CLI/web packaging. It drives qualification,
acceptance, a real merge conflict and explicit resolution, and publication. It
captures each stage at desktop, tablet and mobile widths and verifies independent
GitHub head and content against authenticated native source reads.

The receipt is written to `build/source-control/full-case/SCM-023-live/receipt.json`.
This actor's assertions are only the product segment. Complete SCM-023 registration
also needs the actual deployed fleet assignment/checkpoint/recovery/replacement and
native source capture evidence; owned fixture records cannot substitute for it.
