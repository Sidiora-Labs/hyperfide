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

> **PENDING. Fill from the answer to the Ask for task 1.11.** The run needs the
> monorepo, its sandbox clone URL, provider env and an events export, and the agent
> that wrote this has none of them. Paste the report's numbers below without
> rounding, and keep the JSON next to them as evidence.

| measure | value |
|---|---|
| date of run, window | |
| tracked files, object store size | |
| clone full: p50 / p90 seconds, p50 object bytes | |
| clone partial: p50 / p90 seconds, p50 object bytes | |
| clone sparse: p50 / p90 seconds, p50 object bytes | |
| observed sandbox clones per day, p50 bytes | |
| snapshot-to-integrated wait p50 / p90 (history, observed) | |
| merges per day, textual conflicts | |
| rebase conflicts per day (observed) | |
| GitHub push refusals, rate-limited calls, lowest core remaining | |
| git maintenance seconds per run | |
| report JSON location | |
