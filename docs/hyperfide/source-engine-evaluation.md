# Storage engine bake-off: plain Git plumbing vs. a Jujutsu-backed integrator

Task hyperfide-v21/5.6 (req 6.5, decision D7). Runs 2026-10-22, UTC. This is a
report only: no engine changes here (do_2). The engine choice is raised as a decision
Ask. Until it is answered, the work proceeds on the recommended option, which is to
keep what exists.

**Both halves are MEASURED.** The permission Ask to install Jujutsu was answered yes
on 2026-10-22, and the Jujutsu half was then run as decision option (c), a measured
shadow integrator. The binary is **jj 0.46.0** (`0.46.0-7d382314f9420b4b8d932245b49c99492c812b9f`),
the newest release at least 14 days old (published 2026-10-07T21:28:17Z). It came
from the prebuilt `jj-v0.46.0-x86_64-unknown-linux-musl.tar.gz`, whose sha256
`fce0271158e665ceb82dc66c5eb95b1728649094e9133074f3b5baece345fc08` matches the
digest GitHub publishes. It is unpacked to `/opt/jj/0.46.0/jj` and called by absolute
path. Nothing in this report is estimated any more.

## What is being compared

- **Git (the 4.8 path).** `runQueue` in `core/control-plane/src/integration/queue.ts`,
  built from this branch and called in-process with a requalifier that always passes,
  so the timings hold no gate time. Snapshots (base commit, result tree) are folded onto
  `refs/hyperfide/trunk/<run>` in touch-disjoint batches. Each fold is one
  `git merge-tree --write-tree --merge-base=<base>` and one `commit-tree` with
  `Hyperfide-Snapshot` trailers. A conflicted snapshot is left out and becomes a
  decision Ask.
- **Jujutsu (jj 0.46.0).** A jj repository (`jj git init --git-repo=`) over the same
  shared Git object store. Each fold is
  `jj --ignore-working-copy duplicate <snapshot> --onto <trunk>`: jj applies the
  snapshot's change onto the trunk with its own three-way tree merge and writes the
  result as a Git commit. jj never stops on a conflict; it records the conflict in the
  new commit. There are two policies:
  - **contract** follows 4.8: a conflicted result is abandoned (`jj abandon`), the
    trunk stays where it is, and the conflict counts.
  - **native** is jj's own model: the trunk advances onto the conflicted commit, and
    later folds carry the conflict until a fold resolves it.

  A merge commit is folded as a single-parent commit of its tree over its first
  parent. That is the same wrapping 4.8's `fold` applies to every snapshot, and it
  keeps the snapshot (base tree to result tree) identical across both engines.
  Duplicating the merge itself would carry only the merge's own change and drop the
  second parent's branch. A first jj week run that did this diverged from history
  with 201 conflicts. It was discarded, and the rows below use the wrapped form.

## The workload (from task 1.11)

The trunk of `Sidiora-Labs/paxeer-monorepo` at `666469ff186892b307694fd2bb4ad5974f2c12bb`
(docs/hyperfide/source-measurement.md): 56,663 tracked files, a 785 MiB pack. It is
replayed from the 1.11 scratch clone through `git clone --bare --shared`, so the
source clone is never written.

| window | first-parent trunk commits | merges | files changed per snapshot p50 / p90 / max (mean) |
|---|---|---|---|
| 24 h (since 2026-10-21T10:57:36Z) | 71 | 0 | 6 / 16 / 35 (7.5) |
| 7 d (since 2026-10-15T10:35:21Z) | 1,111 | 4 | 2 / 8 / 17,053 (67.9) |

These counts match 1.11. Each trunk commit becomes one snapshot: base = its first
parent, result = its tree. One author identity wrote every commit. The 7-day window
holds 14 commits over 1,000 files each, including a 17,053-file one, and a directory
move (`services/platform/...` to `platform/...`).

Arrival orders:

- **strict**: trunk order, one queue call per snapshot. This is the order the monorepo
  produced.
- **batched**: trunk order in one queue call. 4.8's `planBatches` forms touch-disjoint
  batches, so a later snapshot can fold before an earlier one that touches other
  paths.
- **K concurrent, resolved (K=4r, 16r)**: within each window of K consecutive commits,
  the snapshots arrive in reverse order. Before each window, the trunk is reset to the
  history commit that precedes it, as if the previous window's conflict Asks had been
  answered. This counts primary conflicts only.
- **K concurrent, cascading (K=4, 16)**: the same reverse order without the reset, so a
  dropped snapshot stays dropped and later ones can conflict on its change. This is
  deliberately adversarial.
- **merge-tree floor**: one `merge-tree` per snapshot with no queue bookkeeping. It is
  the cost floor of the plumbing.
- **renames off**: the same runs on a second shared clone whose repo-local config sets
  `merge.renames=false` and `merge.directoryRenames=false`.

The host was shared with the fleet: 16 CPUs, and up to three bench runs overlapped.
Each row carries the 1-minute load at its start and end. Throughput is wall time
under that load, not the host's capacity.

## Git half: MEASURED

| run | window | order | snapshots | folded | conflicts (paths) | batches / requalifications | wall s | snapshots/s | ms/snapshot | load 1m start→end | trunk tree = history |
|---|---|---|---|---|---|---|---|---|---|---|---|
| day-serial | 24 h | strict | 71 | 71 | 0 | 71 / 71 | 58.1 | 1.22 | 819 | 31.8→28.4 | yes |
| day-k1 | 24 h | batched | 71 | 71 | 0 | 12 / 12 | 55.1 | 1.29 | 776 | 37.8→37.5 | yes |
| day-k4r | 24 h | K=4 resolved | 71 | 62 | 9 (24) | 27 / 23 | 67.6 | 1.05 | 953 | 34.5→37.4 | n/a |
| day-k16r | 24 h | K=16 resolved | 71 | 50 | 21 (86) | 22 / 16 | 91.9 | 0.77 | 1,295 | 36.9→43.3 | n/a |
| day-k4 | 24 h | K=4 cascading | 71 | 45 | 26 (87) | 11 / 10 | 102.6 | 0.69 | 1,445 | 38.7→49.1 | n/a |
| day-k16 | 24 h | K=16 cascading | 71 | 40 | 31 (117) | 10 / 10 | 76.2 | 0.93 | 1,074 | 46.8→43.1 | n/a |
| day-floor | 24 h | merge-tree only | 71 | — | — | — | 12.4 | 5.71 | 175 | 49.4→47.3 | n/a |
| week-serial | 7 d | strict | 1,111 | 1,111 | 0 | 1,111 / 1,111 | 897.2 | 1.24 | 808 | 20.3→22.5 | **yes** |
| week-k1 | 7 d | batched | 1,111 | 1,042 | **69 (7,113)** | 342 / 332 | 1,820.0 | 0.61 | 1,638 | 34.7→8.2 | **no** |
| nr-week-k1 | 7 d | batched, renames off | 1,111 | 1,111 | **0** | 342 / 342 | 497.4 | 2.23 | 448 | 22.8→35.9 | **yes** |
| week-k4r | 7 d | K=4 resolved | 1,111 | 1,004 | 107 (210) | 504 / 452 | 724.8 | 1.53 | 652 | 8.2→19.2 | n/a |
| nr-week-k4r | 7 d | K=4 resolved, renames off | 1,111 | 1,004 | 107 (210) | 504 / 452 | 914.3 | 1.22 | 823 | 10.4→15.2 | n/a |
| week-k16r | 7 d | K=16 resolved | 1,111 | 885 | 226 (564) | 407 / 328 | 1,048.6 | 1.06 | 944 | 31.0→15.5 | n/a |
| day-serial-b | 24 h | strict (rerun beside jj) | 71 | 71 | 0 | 71 / 71 | 33.9 | 2.10 | 477 | 8.2→8.1 | yes |
| day-k1-b | 24 h | batched (rerun beside jj) | 71 | 71 | 0 | 12 / 12 | 34.5 | 2.06 | 486 | 7.8→7.8 | yes |
| week-serial-b | 7 d | strict (rerun beside jj) | 1,111 | 1,111 | 0 | 1,111 / 1,111 | 661.9 | 1.68 | 596 | 6.4→9.0 | **yes** |
| nr-week-k1-b | 7 d | batched, renames off (rerun beside jj) | 1,111 | 1,111 | 0 | 342 / 342 | 530.0 | 2.10 | 477 | 22.7→24.5 | **yes** |

The `-b` rows were rerun while the jj runs were going, at a similar host load. They
are the Git side of the like-for-like timing comparison below.

week-k4 (7 d, K=4 cascading) was stopped after 55 minutes without a result. Every
cascaded conflict reads both sides of each conflicted path, and the large commits
multiply those paths. The day-window cascading rows stand for that order. The
`merge-tree` floor was run on the day window only.

Storage: folds write loose objects only (the fold commits plus the merged trees).
week-serial added 6,672 loose objects (152 MiB before any repack), and the 7-day runs
added 23 to 216 MiB. 1.11 measured the maintenance that packs them at 0.724 s a run.

### What the Git numbers say

1. **Strict trunk order reproduces the trunk exactly.** All 1,111 snapshots fold with
   no conflict, and the folded trunk tree is byte-identical to `666469ff`'s tree. The
   rate is 1.2 snapshots/s (0.8 s each) at load 20 to 30, which is about 4,400 an hour
   against the 1.11 rate of about 160 trunk commits a day. Throughput is not the
   constraint.
2. **Most of a fold's time is queue bookkeeping, not merging.** The bare `merge-tree`
   floor costs 175 ms per snapshot. The queue spends about 0.45 to 0.8 s around it:
   seven `git` spawns per snapshot plus one `rev-parse` and one `update-ref` per
   batch. That cost is in the plumbing harness, not in the object model.
3. **The 69 conflicts of the batched order are a 4.8 artefact, not workload
   conflicts.** `planBatches` pulled 850 of 1,111 snapshots ahead of at least one
   earlier snapshot (up to 498 ahead). The first one, `dd8979d18e` (history index 907,
   folded at position 249), met a trunk missing 658 earlier snapshots, including the
   one that created `services/platform/perps-data/`. ort's directory-rename detection
   then read that absence as a rename to `platform/perps-data/` and reported `CONFLICT
   (file location)`. The 68 that followed cascade from it (modify/delete and content on
   the files it would have added). With rename detection off, the same batched run
   folds all 1,111 snapshots with no conflict and a tree identical to history, at
   2.2 snapshots/s. See *Finding for 4.8* below.
4. **Primary conflicts under concurrency are textual overlaps and do not depend on
   rename detection.** K=4 resolved gives 107 conflicts over 210 paths, with
   identical counts with renames on and off. K=16 resolved gives 226 over 564. These
   are consecutive commits by one author revising the same lines. In a real fleet the
   `requires` graph and touch-disjoint scheduling would serialise most of them. They
   are the upper bound of what a three-way line merge, Git's or jj's, must surface.
5. **Cascading roughly triples the conflicts on the day window.** K=4: 26 cascading
   against 9 primary. K=16: 31 against 21. A conflicted snapshot dropped from the
   trunk takes down later snapshots whose base held its change.

### Finding for 4.8 (out of this task's scope; no change made)

`planBatches` reorders snapshots across batches on the assumption that touch-disjoint
snapshots commute. They commute only when every snapshot's base is already on the
trunk. When a base holds a not-yet-folded snapshot (stacked work, or any replay like
this one), the three-way merge sees "the trunk removed it". ort's rename and
directory-rename detection can then move or conflict files neither side touched in
that sense. Either fix stays in Git:

- the queue refuses or serialises an entry whose `base_commit` is not an ancestor of
  the trunk head, or
- it folds with rename detection off. Git 2.43's `merge-tree` has no flag for this,
  but the repo-local `merge.renames=false` / `merge.directoryRenames=false` that
  `gitEnv()` does not override works, as nr-week-k1 shows.

## Jujutsu half: MEASURED with jj 0.46.0

Same inputs as the Git half: the 1.11 trunk at `666469ff`, the same 24 h and 7 d
windows, and the same arrival orders. The batched order is `planBatches` from the
built `queue.js`. Each run got a fresh jj repository over a fresh `--shared` bare
clone holding only the measured trunk ref.

| run (jj 0.46.0) | window | order | policy | folded | conflicts the fold introduced | folds that left the trunk conflicted | conflicted paths on the final trunk | wall s | snapshots/s | ms/snapshot | load 1m start→end | trunk tree = history |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| jj-day-strict | 24 h | strict | contract | 71 | 0 | 0 | 0 | 17.0 | 4.19 | 239 | 12.0→10.9 | yes |
| jj-day-batched | 24 h | batched | contract | 71 | 0 | 0 | 0 | 31.4 | 2.26 | 443 | 11.4→19.4 | yes |
| jj-day-k4r | 24 h | K=4 resolved | contract | 62 | 9 | 0 | 0 | 64.9 | 1.09 | 914 | 22.3→31.5 | n/a |
| jj-day-k16r | 24 h | K=16 resolved | contract | 50 | 21 | 0 | 0 | 22.6 | 3.14 | 319 | 32.9→25.5 | n/a |
| jj-day-k4 | 24 h | K=4 cascading | contract | 45 | 26 | 0 | 0 | 32.2 | 2.21 | 453 | 24.0→17.7 | n/a |
| jj-day-k16 | 24 h | K=16 cascading | contract | 40 | 31 | 0 | 0 | 27.6 | 2.57 | 389 | 13.5→10.6 | n/a |
| jj-day-k4n | 24 h | K=4 cascading | native | 71 | 5 | 11 of 71 | 0 | 13.7 | 5.19 | 193 | 16.2→14.5 | not measured |
| jj-day-k16n | 24 h | K=16 cascading | native | 71 | 5 | 48 of 71 | 0 | 27.1 | 2.62 | 381 | 10.2→10.2 | not measured |
| jj2-week-strict | 7 d | strict | contract | 1,111 | 0 | 0 | 0 | 526.3 | 2.11 | 474 | 8.5→21.7 | **yes** |
| jj2-week-batched | 7 d | batched | contract | 1,111 | 0 | 0 | 0 | 530.3 | 2.10 | 477 | 8.7→20.6 | **yes** |
| jj2-week-k4r | 7 d | K=4 resolved | contract | 1,004 | 107 | 0 | 0 | 460.7 | 2.41 | 415 | 10.0→8.6 | n/a |
| jj2-week-k16r | 7 d | K=16 resolved | contract | 884 | 227 | 0 | 0 | 538.3 | 2.06 | 485 | 9.5→12.3 | n/a |
| jj2-week-k4n | 7 d | K=4 cascading | native | 1,111 | 31 | 368 of 1,111 | 1 | 845.7 | 1.31 | 761 | 20.3→11.1 | **no** |
| jj2-week-k16n | 7 d | K=16 cascading | native | 1,111 | 35 | 608 of 1,111 | 1 | 1,018.4 | 1.09 | 917 | 17.4→18.3 | **no** |

A fold "introduced" a conflict when the trunk it landed on was clean. Under the
native policy, a fold onto a conflicted trunk stays conflicted until a later fold
resolves it, so the fourth column counts the folds that left the trunk unqualifiable.

**Operating cost, measured.** `jj git init` over this repository took 0.7 to 2.9 s.
The `.jj` store grew to 24.0 MiB after the 1,111-fold strict week (2.3 MiB after the
71-fold day), and it grows with every operation: one operation-log entry per fold,
plus one per abandon under the contract policy (1,338 entries for jj2-week-k16r).
jj also wrote 1,117 `refs/jj/keep/*` refs into the Git repository, one per commit it
created. One `jj` process per fold (1,115 calls for 1,111 snapshots in strict order)
replaces the Git queue's seven `git` processes per fold.

### What the jj numbers say

1. **Conflict handling under the 4.8 contract is the same as Git's.** Strict and
   batched orders: 0 conflicts and a trunk tree identical to history, on both windows.
   Primary conflicts: 9 and 21 on the day, 107 on the week at K=4 (equal to Git), 227
   at K=16 (Git 226; one hunk is split differently). Cascading on the day: 26 and 31,
   equal to Git. jj does no rename detection, so the batched order does not hit the
   69 artefact conflicts that Git hits with ort's rename detection on. It behaves like
   Git with renames off (nr-week-k1: 0).
2. **jj's own conflict model is worse for this contract.** Under the native policy the
   introduced conflicts fall (day K=4: 5 instead of 26). But the trunk stays
   conflicted for 11 to 48 of 71 folds on the day and 368 to 608 of 1,111 on the
   week. Both week runs end on a trunk that still holds a conflicted path and whose
   tree differs from history. That trunk could not be requalified or published for a
   third to more than half of the week, and the final state is wrong without a human
   resolution.
3. **jj folds faster.** Compared at similar load against the `-b` Git reruns:

   | comparison | Git 4.8 queue | jj 0.46.0 | jj speed-up |
   |---|---|---|---|
   | strict, 7 d | 596 ms (load 6.4→9.0) | 474 ms (8.5→21.7) | 1.26× |
   | strict, 24 h | 477 ms (8.2→8.1) | 239 ms (12.0→10.9) | 2.0× |
   | batched, 7 d (Git renames off) | 477 ms (22.7→24.5) | 477 ms (8.7→20.6) | 1.0× |
   | batched, 24 h | 486 ms (7.8→7.8) | 443 ms (11.4→19.4) | 1.1× |
   | K=4 resolved, 7 d | 652 ms (8.2→19.2) | 415 ms (10.0→8.6) | 1.57× |

   The load was not identical; the jj side often ran at the higher load. jj
   is between equal and twice as fast per fold, and never slower. The Git queue's cost is
   mostly its process spawns (the `merge-tree` floor is 175 ms), so the gap is in the
   harness rather than the object model. Both engines run four orders of magnitude
   above the measured demand of about 160 trunk commits a day.

| measure (7 d unless noted) | Git, 4.8 queue (MEASURED) | Jujutsu 0.46.0 (MEASURED) |
|---|---|---|
| conflicts, strict order | 0; trunk tree = history | 0; trunk tree = history |
| conflicts, batched order | 69 with ort rename detection (4.8 artefact); 0 with it off | 0 (no rename detection) |
| primary conflicts, K=4r / K=16r | 107 / 226 | 107 / 227 |
| conflicts, cascading, day K=4 / K=16 (contract) | 26 / 31 | 26 / 31 |
| native first-class conflicts, K=4 / K=16 | n/a (4.8 never puts a conflict on the trunk) | trunk conflicted after 368 / 608 of 1,111 folds; ends with 1 conflicted path and a tree ≠ history |
| fold cost, strict | 596 ms at load 6 to 9 | 474 ms at load 8 to 22 |
| extra store | none (Git objects, 0.7 s maintenance) | `.jj` 24.0 MiB per 1,111 folds plus one op-log entry per operation; 1,117 `refs/jj/keep/*` |
| new binary | none | jj 0.46.0, pre-1.0, monthly releases |
| conflict to a human | decision Ask with both sides (4.8) | a conflicted commit; an Ask still has to be built from it |

## Recommendation

**Keep Git's object model and the 4.8 plain-plumbing queue as the engine. Do not
build a Jujutsu-backed integrator.** This is option (a) of the decision Ask, and D7's
default stands. Fix the batch-reordering finding inside the Git path, in a 4.8
follow-up task.

The measured jj half changes one thing, said plainly: **jj measured faster per fold
(1.0 to 2.0×) and matched Git's conflict handling under the 4.8 contract.** Before
the measurement this report (7c4542a1) named exactly that as the condition for revisiting, and
it has been met. The recommendation stays (a) for these reasons, each from a
measurement:

1. Conflicts are equal. Strict order gives 0 on both engines with an identical trunk.
   Primary conflicts are 107 against 107 and 226 against 227. The only conflicts jj
   avoids are the 69 that come from 4.8 reordering stacked snapshots under ort's
   rename detection. Git removes them itself with rename detection off (MEASURED:
   0 conflicts, identical tree).
2. jj's distinctive feature, first-class conflicts on the trunk, measured worse for
   this system. The trunk was unqualifiable for 33% to 55% of the week's folds and
   ended wrong. Under the contract policy, the only one compatible with 4.8, jj is a
   faster `merge-tree`, not a different model.
3. Fold speed is not the bottleneck. Both engines fold over 1.6 snapshots/s against
   demand of about 0.002/s. 1.11 measured 4 to 7 minutes and 820 MB per full clone,
   and slices (2.12, 5.4) and the object store (2.11) target that. The Git queue's
   extra time is its seven process spawns per fold, which can be cut inside Git.
4. jj adds a pre-1.0 binary on a monthly release train, a `.jj` store that grows with
   every operation (24 MiB a week here), a keep ref per commit and a second identity
   scheme beside the `Hyperfide-Snapshot` trailers. It also needs the same
   merge-wrapping 4.8 already does.

If fold throughput ever becomes binding, jj (option (b)) is the measured faster
engine, and this comparison is the baseline to re-measure against. Until then the
speed gain does not pay for the operating cost.

### Asks

- **permission:** answered yes on 2026-10-22. jj 0.46.0 is installed at
  `/opt/jj/0.46.0/jj`, sha256
  `fce0271158e665ceb82dc66c5eb95b1728649094e9133074f3b5baece345fc08`.
- **decision** (proceed-and-flag): (a) keep Git plumbing [recommended]; (b) a
  Jujutsu-backed integrator; (c) keep (a) and run jj as a measured shadow. Option (c)
  is the run recorded above. The work proceeds on (a).

## Reproduce

The harness is not tracked; it is in the task scratchpad: `bench.mjs` imports
`core/control-plane/dist/integration/queue.js` and calls `runQueue`, `planBatches` and
`git`. `run.sh` and `norenames.sh` drive it, with one JSON row per run in
`results.jsonl`.

```sh
npm --prefix core/control-plane ci --ignore-scripts && npm --prefix core/control-plane run build
git clone --bare --shared <1.11 monorepo clone> bench/repo.git
git -C bench/repo.git rev-list --first-parent --reverse --since=2026-10-15T10:35:21Z 666469ff1868 > bench/c7d.txt
node bench.mjs core/control-plane/dist/integration/queue.js bench/repo.git bench/c7d.txt week-serial 1 serial
# other modes: <label> 1 (batched), <label> K resolved, <label> K (cascading), <label> 1 floor;
# renames off: the same on a clone with merge.renames=false and merge.directoryRenames=false
```

The Jujutsu half uses `jjbench.mjs`, driven by `jjrun.sh` with rows in `jj-results.jsonl`.
It runs on the same commit lists and imports `planBatches` from the same `queue.js`.
`jjconfig.toml` sets `immutable_heads()` to `none()` and turns off working-copy
auto-tracking. Every call passes `--ignore-working-copy`.

```sh
# jj 0.46.0, x86_64-unknown-linux-musl release tarball, sha256 fce02711...45fc08, at /opt/jj/0.46.0/jj
JJ_CONFIG=jjconfig.toml node jjbench.mjs core/control-plane/dist/integration/queue.js bench/c7d.txt jj2-week-strict 1 strict contract
# orders: strict | batched | reverse (K-window arrival); policies: contract (abandon a conflicted fold) | native (advance onto it);
# a trailing `resolved` resets the trunk to each window's history base (the primary-conflict count)
```
