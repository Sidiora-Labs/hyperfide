# Scale case evidence

`scale.py` verifies completed real campaigns through `6_2.py --verify-completed`.
It does not restart a completed endurance job or accept its PASS label alone.
The verifier reopens durable state and ledgers, checks artifact hashes and
cleanup, reads authored revisions through the real source API, and invokes the
pinned observer again.

Set `HF_SOURCE_SCALE_PLAN` to a private JSON file with `schema_version: 1` and
`runs`. Each run has exactly `id`, `manifest`, `config`, `preparation`, and
`topology` file paths. The immutable topology file must be emitted by the observer as a
`measured-topology` source, with the declared `topology` structure and pinned
`raw_evidence` files. A separate fresh provider snapshot confirms the same
deployment/resource identity. Per-service request-counter windows must cover
the measured ledger times and prove the other endpoint was idle.

SCM-020 requires the ordered runs `baseline`, `unique-content`,
`directory-fanout`, `history-depth`, and `source-tier`. Every run measures the
10k/1M/10M logical sizes with the same ten-file, one-MiB change. The first four
hold endpoint/resources fixed and vary one source dimension at a time. The last
holds source shape and metadata/object tiers fixed while measuring one versus
two actual source replicas. Separate properly fenced endpoints are permitted
for that tier comparison; a changed resource hash alone is insufficient.

SCM-021 requires `mixed-load` and `open-admission` completed runs. Its full
variants each verify the complete case inventory: at least 5,000 active
workspaces, measured 100 submissions per second for five minutes, distinct
revisions, and 20 million logical opens within a day. A useful offered-load
profile exceeds 100/s so final-request latency does not lower measured
throughput below the required rate.

SCM-022 requires one `endurance` run. Both full variants verify the complete
72-hour/daily-new-revision and independent real-worker inventory. They retain
separate canonical receipts while referring to the same immutable long-running
campaign evidence. Load-client work never substitutes for worker revisions.

Use `scale_manifest.py --case SCM-020 --variant growth --native-source ...
--output ...` to bind a shared authenticated implementation capture. Missing
profiles, topology observations, or elapsed runtime remain explicit failures.
The pure matrix tests exercise refusal boundaries only and do not qualify a
product workload.
