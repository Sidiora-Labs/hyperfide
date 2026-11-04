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

## Full nineteen-assertion registration

`scm_023_live_full.py` runs the product segment, then verifies real durable fleet
state through the supplied deployed PostgreSQL connection and signed APIs. The
same private input additionally names `database_config` (a private JSON file with
`connectionString`) and `fleet_proof_file` (private JSON with the following IDs):

- `run_id`, `original_assignment_id`, `checkpoint_revision_ids` (exactly two),
  `original_custody_id`, `original_acceptance_id`, `original_task_qualification_id`.
- `replacement_assignment_id`, `replacement_custody_id`,
  `replacement_acceptance_id`, `replacement_task_qualification_id`.
- `dependent_custody_id`, `dependent_candidate_id`, `dependent_selection_id`, `queue_batch_id`.
- `product_leg`: `original` or `replacement`; the product assignment, candidate,
  revision, qualification and acceptance must exactly match this leg.
- `reply_loss_file`: the actual worker-produced submission witness described below.

Before the first submission, the current real worker must invoke
`witnessLiveSubmissionReplay` from `support/native_source_live_submission.mjs`.
It intercepts the first real HTTPS response before the SDK receives it, destroys
the request after a valid upstream committed result, requires client-observed
`OUTCOME_UNKNOWN`, and retries the same signed operation. Its output
is checked against the actual committed operation and unique durable submission;
a hand-written assertion or retrospective `true` field is not accepted.

The verifier independently reads assignment/workspace bindings, checkpoint
lineage, prior and replacement custody, task qualifications, queue dependencies
and acceptance receipts. It actively submits a forged dependency candidate and
requires `CANDIDATE_DEPENDENCY_STALE` plus absence of the candidate in PostgreSQL.
It invokes the production native task-qualification reader on the actual SQL
transaction and compares its result with the durable receipt. The database is
only queried, with the transaction always rolled back.

The full registration emits the canonical nineteen IDs only after every check
passes. It retains the live source and published GitHub history; it does not
claim ownership or deletion of deployed services or real worker resources.
