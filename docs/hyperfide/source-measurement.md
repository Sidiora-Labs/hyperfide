# Source traffic measurement

One day of source traffic on the real monorepo: where the time and bytes go when
sandboxes clone, integrate and push. The numbers set the targets for the internal
object store (task 2.11), the bytes-per-sandbox metric (5.4) and the storage engine
bake-off (5.6). Requirement: spec/hyperfide-v21 req 6, ac_5; task 1.11.

The tool is `scripts/hyperfide/measure-source-day.sh`. It needs bash, git (2.38 or
later for conflict replay), awk, du and, for GitHub sampling, curl with
`GITHUB_TOKEN` or an authenticated `gh`. It writes one JSON report and never writes
provider env values into it.

## Method

Run it once, on a host with a current clone of the monorepo, at the end of a normal
working day:

```sh
scripts/hyperfide/measure-source-day.sh \
  --repo /path/to/monorepo --trunk origin/main --since "24 hours ago" \
  --provider railway --region <region> --provider-env /path/to/provider.env \
  --remote <the URL sandboxes clone from today> \
  --clone-mode full,partial,sparse --samples 4 --interval 7200 \
  --events /path/to/sandbox-events.jsonl \
  --github <owner>/<repo> --maintenance \
  --out source-day.json
```

It measures four things:

1. **Clone cost per sandbox.** Active: `--samples` rounds of clones from `--remote`,
   with the provider env exported, in each `--clone-mode`. `full` is what a sandbox
   does today. `partial` is `--filter=blob:none`. `sparse` adds `--sparse`, which is
   the lower bound a packet-scoped slice (11.5) starts from. Each sample records wall
   seconds, bytes under `.git/objects`, bytes on disk and files checked out.
   `--interval` spreads the rounds over the day so they catch peak load. Passive: the
   `clone` events sandboxes reported.
2. **Snapshot-to-integrated wait.** For every first-parent merge on the trunk inside
   the window, every commit it brought in counts once, with wait = the merge's
   committer time minus the commit's committer time. A trunk that is rebased or
   squashed leaves no such trace. Those commits are counted under
   `non_merge_commits`, and their wait must come from `snapshot` events.
3. **Conflicts.** Each of those merges is replayed with
   `git merge-tree --write-tree` on its two parents. A textual conflict means that
   integration needed a human or a strategy option. Rebase conflicts that sandboxes
   hit before they merge are only visible as `rebase_conflict` events.
4. **GitHub and maintenance.** One `rate_limit` sample (core and GraphQL) at the time
   of the run. Push refusals and rate-limit hits come from events, because GitHub
   exposes neither per push outside the enterprise audit log. With `--maintenance`,
   the repository's scheduled maintenance tasks (commit-graph, loose-objects,
   incremental-repack) are run one by one and timed. This changes the repository's
   packs.

### Events file

Optional JSONL, one flat object per line, from the provisioner or sandbox logs:

| kind | fields read | meaning |
|---|---|---|
| `clone` | `seconds`, `bytes` | a sandbox materialised source |
| `snapshot` | `wait_seconds` | a snapshot waited this long to reach trunk |
| `rebase_conflict` | — | a rebase or merge stopped on a conflict |
| `push_refused` | — | GitHub refused a push (protected ref, non-fast-forward, size) |
| `rate_limited` | — | a GitHub call got 403/429 for rate limit |
| `maintenance` | `seconds` | a host ran git maintenance |

## Report fields

Every distribution is `{n, p50, p90, max, mean}`, with nearest-rank percentiles. A
field is `null` when its source was not given. That is different from a measured
zero.

| field | meaning |
|---|---|
| `schema` | `hyperfide.source-measurement/1` |
| `window.since`, `window.until` | the git date window measured |
| `repo.tracked_files`, `repo.count_objects` | size of the trunk tree and the object store |
| `provider.name`, `provider.region`, `provider.env_keys` | where samples ran. Env keys are names only |
| `clone.remote_is_github` | whether sandboxes clone from GitHub today (2.11 removes this) |
| `clone.samples[]` | one row per sample clone |
| `clone.sampled.<mode>.seconds`, `.object_bytes` | sampled clone cost per mode |
| `clone.observed.seconds`, `.bytes` | clone cost sandboxes reported |
| `integration.first_parent_merges`, `.non_merge_commits` | trunk shape in the window |
| `integration.history_wait_seconds` | snapshot-to-integrated wait from history |
| `integration.observed_wait_seconds` | the same from `snapshot` events |
| `conflicts.merges_replayed`, `.textual_conflicts` | merges whose parents conflict |
| `conflicts.observed_rebase_conflicts` | conflicts sandboxes hit |
| `github.rate_limit` | `core` and `graphql` limit, used, remaining, reset |
| `github.observed_push_refusals`, `.observed_rate_limited` | from events |
| `maintenance.seconds`, `.tasks[]` | timed maintenance on `--repo` |
| `maintenance.observed_seconds` | maintenance hosts reported |
| `notes[]` | everything skipped or failed, and why |

### What each consumer reads

- **2.11 (internal object store):** `clone.remote_is_github`, `clone.sampled.full` vs
  `.partial` vs `.sparse`, `github.*`. These justify mirroring and size the mirror.
- **5.4 (three numbers):** `clone.sampled.sparse.object_bytes` and
  `clone.observed.bytes` are the baseline for bytes materialised per sandbox. The
  target is a fall of more than an order of magnitude.
- **5.6 (engine bake-off):** `integration.*` and `conflicts.*` are the workload to
  replay through plain Git plumbing and a Jujutsu-backed integrator.

### Check on this repository (not the monorepo)

Run on the codify repository, 7-day window, no clones: 1,388 tracked files, 423
first-parent merges, 84 non-merge trunk commits, 2,303 integrated commits with
p50 wait 18,096 s and p90 55,267 s, and 16 of 423 merges with textual conflicts.
This only shows that the method works end to end. It is not the monorepo
measurement.

## Results

Measured 2026-10-22 on `Sidiora-Labs/paxeer-monorepo` (public GitHub), trunk
`origin/main` at `666469ff186892b307694fd2bb4ad5974f2c12bb`. Two runs, both from a
fresh clone on the Hyperfide build host, not from a Railway sandbox, so clone
samples measure GitHub to this host and `provider.name` is `local`. No events
export existed, so every `observed_*` field is `null`: nothing inside sandboxes
was measured, only what the trunk history and the clone samples show.

- 7-day window, history only, no clones: `source-measurement/source-7d.json`.
- 24-hour window, two rounds of full, partial and sparse clones, with
  `--maintenance`: `source-measurement/source-day.json`. Command:

```sh
scripts/hyperfide/measure-source-day.sh \
  --repo <scratch clone> --trunk origin/main --since "24 hours ago" \
  --provider local --region scratchpad-host \
  --clone-mode full,partial,sparse --samples 2 --interval 0 \
  --github Sidiora-Labs/paxeer-monorepo --maintenance --out source-day.json
```

| measure | value |
|---|---|
| date of run, window | 2026-10-22T10:57:36Z, `24 hours ago` to `now`; 7-day run at 2026-10-22T10:35:21Z |
| tracked files, object store size | 56,663 files; 169,516 objects in one pack of 803,937 KiB (785 MiB) |
| clone full: p50 / p90 seconds, p50 object bytes | 263.294 / 423.652 s; 819,572,736 bytes (3,018,362,880 on disk) |
| clone partial: p50 / p90 seconds, p50 object bytes | 241.657 / 300.486 s; 574,459,904 bytes (2,773,254,144 on disk) |
| clone sparse: p50 / p90 seconds, p50 object bytes | 14.437 / 16.665 s; 12,378,112 bytes (21,737,472 on disk) |
| observed sandbox clones per day, p50 bytes | null (no events export) |
| snapshot-to-integrated wait p50 / p90 (history, observed) | 24 h: n=0, no merge in the window. 7 d: n=15, p50 4,652 s, p90 13,407 s, max 14,315 s. Observed: null |
| merges per day, textual conflicts | 24 h: 0 first-parent merges, 71 non-merge trunk commits. 7 d: 4 merges, 1,107 non-merge commits; 0 of 4 replayed merges conflict |
| rebase conflicts per day (observed) | null (no events export) |
| GitHub push refusals, rate-limited calls, lowest core remaining | null, null; core 4,968 of 5,000 remaining (32 used), GraphQL 4,995 of 5,000 |
| git maintenance seconds per run | 0.724 s (commit-graph 0.364, loose-objects 0.090, incremental-repack 0.270) |
| report JSON location | `docs/hyperfide/source-measurement/source-day.json`, `docs/hyperfide/source-measurement/source-7d.json` |

Two samples per mode is a floor for the distributions, not a day's spread; the
7-day run carries the integration numbers because the 24-hour window held no
merge. The `checked_out_files` value in the sparse rows counts index entries, not
files on disk; the disk bytes show what the sparse checkout materialised.

### What the numbers say

1. **The trunk is pushed to directly.** 1,107 of 1,111 trunk commits in seven days
   arrived without a merge commit, so the history-based wait (p50 78 min, p90
   3.7 h over 15 merged commits) covers the 4 merges only. The wait of a direct
   push is the time a sandbox spends on fetch, rebase and retry against one ref,
   and that is invisible without `snapshot` events. 2.11 and 5.4 must emit them.
2. **Partial clone does not pay; sparse does.** `--filter=blob:none` saves 30% of
   the bytes and 8% of the time because the tree and commit objects of a 785 MiB
   pack still travel. A sparse partial clone lands in 14 s and 12 MiB: 66 times
   fewer object bytes and 18 times less time than the full clone a sandbox does
   today. That is the floor a packet-scoped slice (11.5) starts from and the
   baseline 5.4 measures its order-of-magnitude fall against.
3. **Merge resolution is not the cost.** 0 textual conflicts in the merges that
   exist. Maintenance is under a second on a repacked clone. The expensive parts are
   the 4 to 7 minutes and 820 MB per full clone, and the queueing on one ref.
4. **GitHub limits are not near.** 32 of 5,000 core calls were used by this run's
   own sampling; refusals and rate-limit hits inside sandboxes stay unmeasured
   until the events export exists.

## Slices by default (task 2.12)

From task 2.12 on, a worker job does not start in a full checkout. The provisioner's
executor checks every admitted job of kind `AGENT`, `CHILD` or an unknown kind before it
claims it. The slot must hold a READY, unreleased slice materialisation for that run. If
the slot holds a `FULL_TREE` manifest, the derivation's `fallback_reason` is the recorded
reason. If no slice exists, the admitted request must declare
`workspace: {mode: "FULL_TREE", fallback_reason: "<CODE>"}`. Anything else is refused
with `WORKER_SLICE_REQUIRED`, `WORKER_SLICE_MISMATCH`, `WORKER_SLICE_AMBIGUOUS` or
`WORKER_WORKSPACE_INVALID`, and the admission settles as UNKNOWN.

Preparation and verification kinds (`BUILD`, `TEST`, `REVIEW`, `INDEX`, `INTEGRATION`,
`EXCLUSIVE_SERVICE`) are exempt. They are the full-tree comparison that a slice result
never claims to be. `runner.executor.describe` reports `workspaces.slice`,
`.full_tree` and `.refused`.

### Against the baseline

The baseline above is the cost of a full clone: 263 s and 820 MB of objects per
sandbox. A sparse partial clone is the floor: 14 s and 12 MB. A worker on a slice pays
that floor plus the blobs of its slice's paths. The cost no longer scales with the
monorepo's 56,663 files. A worker on a recorded full-tree reason still pays the full
baseline, so the share of jobs counted in `workspaces.full_tree` is the number to watch.

Per worker, the numbers come from `preparation.slice.inspect`, under `summary`:

| field | meaning |
|---|---|
| `worktree_bytes`, `disk_bytes` | the latest READY materialisation's evidence metrics |
| `derivation_misses` | out-of-slice reads refused while the job ran: inputs the derivation missed |
| `out_of_slice_writes` | refused writes outside the slice; these are never widened |
| `widen_events`, `widened_children` | explicit widenings and the child manifests they produced |

### Widen rules

`planWidening` turns refused findings into widen requests, grouped by reason:

- a read under a `fixtures/`, `testdata/`, `__fixtures__/` or `__snapshots__/`
  directory widens the whole directory (`FIXTURE_DIRECTORY_READ`);
- a build root, or a path the command declared as required, widens alone
  (`BUILD_ROOT_EXCLUDED`);
- any other read widens the file (`OUT_OF_SLICE_READ`);
- a read the access monitor could only name as a Git object cannot be widened. It
  forces the full tree with `UNMAPPED_OBJECT_READ`;
- more than 256 paths in one plan means the closure was wrong. It falls back with
  `WIDEN_LIMIT_EXCEEDED` instead of widening;
- writes are never widened.

These rules come from the miss classes that the 11.5 fixture produces. The task also
calls for running 11.5's derivation against the real monorepo graph, recording the
worktree bytes, misses and widen events of that run, and tuning the rules from what it
shows. That run needs a control service that has published the monorepo graph, and
access to it is an open variable Ask. Until it is answered, no monorepo slice numbers
exist and this section claims none.
