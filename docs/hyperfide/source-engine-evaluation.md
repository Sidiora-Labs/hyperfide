# Storage engine bake-off: plain Git plumbing vs. a Jujutsu-backed integrator

Task hyperfide-v21/5.6 (req 6.5, decision D7). Run 2026-10-22. This is a report only:
no engine changes here (do_2). The engine choice is raised as a decision Ask. Until
it is answered, the work proceeds on the recommended option, which is to keep what
exists.

**Measured vs. estimated.** The Git half was run on the build host, and every Git
number below is MEASURED. The `jj` binary is not installed on this host, and
installing software needs a permission this task does not have, so a permission Ask
was raised to install it. The Jujutsu half is ESTIMATED. It comes from Jujutsu's
documented model applied to the conflict profile measured on the Git half, plus one
measured Git proxy that is labelled as a proxy. No `jj` command was run.

## What is being compared

- **Git (the 4.8 path).** `runQueue` in `services/hyperfide/src/integration/queue.ts`,
  built from this branch and called in-process with a requalifier that always passes,
  so the timings hold no gate time. Snapshots (base commit, result tree) are folded onto
  `refs/hyperfide/trunk/<run>` in touch-disjoint batches. Each fold is one
  `git merge-tree --write-tree --merge-base=<base>` and one `commit-tree` with
  `Hyperfide-Snapshot` trailers. A conflicted snapshot is left out and becomes a
  decision Ask.
- **Jujutsu (ESTIMATED).** An integrator over the same Git object store through jj's
  Git backend. It folds each snapshot with `jj rebase`/`jj new` onto a trunk bookmark,
  using `--ignore-working-copy`, so no checkout exists.

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

## Jujutsu half: ESTIMATED, not run

1. **Merge semantics.** jj merges trees path by path, three-way, with line-based
   content merge. It does not detect renames when merging. Its behaviour on this
   workload is therefore closest to the **renames off** rows, which are a measured Git
   *proxy*, not jj. ESTIMATED: 0 conflicts in strict and batched order, and about the
   same primary conflicts as Git (107 at K=4r, 226 at K=16r). jj's diff can split
   hunks a little differently, so the counts may move by a few.
2. **First-class conflicts.** jj does not stop a rebase on a conflict. It writes a
   commit whose tree records the conflict sides and rebases descendants automatically.
   A later resolution propagates to them. In the cascading orders, that keeps later
   snapshots from conflicting over a dropped one. ESTIMATED: cascading counts fall to
   about the primary counts (day K=4: about 9 instead of 26), **but only by leaving
   conflicted commits on the trunk.** A conflicted trunk cannot be requalified or
   published. 4.8's contract is a trunk that is always a qualified tree and a conflict
   that becomes an Ask, never a picked side. Under that contract the integrator has to
   keep conflicted commits off the trunk bookmark, which brings the cascade back.
3. **Throughput.** The Git backend reads and writes the same objects, and jj's tree
   merge is an in-process merge of the same order as the `merge-tree` floor (175 ms).
   Every jj command also loads the view and the commit index and writes an
   operation-log entry. The first command on this history builds the index. ESTIMATED:
   between the floor and the queue rows, 0.2 to 1 s per snapshot. The constant factor
   is unknown without the binary.
4. **Operating cost.** jj is a second binary, pre-1.0, released about monthly with CLI
   and config changes. It keeps a `.jj/` store (operation log, views, index) beside the
   Git store that grows with every operation, `refs/jj/*` keep refs, `jj git
   import/export` round trips, and change-ids next to the `Hyperfide-Snapshot`
   trailers the queue already uses for idempotent replay. None of this exists on the
   Git path.

| measure | Git (4.8 queue), MEASURED | Jujutsu integrator, ESTIMATED |
|---|---|---|
| conflicts, strict order, 7 d | 0; trunk tree = history | 0 |
| conflicts, batched order, 7 d | 69 with rename detection (4.8 artefact); 0 with it off | 0 (no rename detection) |
| primary conflicts, K=4r / K=16r, 7 d | 107 / 226 | about the same |
| conflicts, cascading, day K=4 | 26 (9 primary) | about 9, only with conflicted commits on the trunk |
| fold cost per snapshot | 0.45 to 0.8 s at load 20 to 36 (strict 0.81 s); `merge-tree` floor 0.175 s | 0.2 to 1 s, unknown constant |
| store | Git objects only; 0.7 s maintenance | Git objects plus `.jj` op log and index |
| new binary | none | jj-cli, pre-1.0 |
| conflict to a human | decision Ask with both sides (4.8) | conflicted commit; an Ask still has to be built |

## Recommendation

**Keep Git's object model and the 4.8 plain-plumbing queue as the engine. Do not
build a Jujutsu-backed integrator.** This is option (a) of the decision Ask, and D7's
default stands. Fix the batch-reordering finding inside the Git path, in a 4.8
follow-up task.

1. In trunk order, the Git queue folds all 1,111 snapshots of the measured week with
   no conflict and reproduces the trunk tree byte for byte (MEASURED). jj has no
   conflict to remove there.
2. The only conflicts that jj's model would avoid on this workload come from 4.8
   reordering stacked snapshots and ort's rename detection reading the gap as a move.
   Turning rename detection off (or not reordering) removes all 69 in Git itself
   (MEASURED: 0 conflicts, identical tree, 2.2 snapshots/s).
3. Primary conflicts under concurrency are textual overlaps that any three-way line
   merge reports, jj's included. jj changes only the cascade, and only by putting
   conflicted trees on the trunk. That breaks the 4.8 contract.
4. Merging is not where the cost is. A fold costs under a second per snapshot at load
   20 to 40. 1.11 measured 4 to 7 minutes and 820 MB per full clone. Slices (2.12,
   5.4) and the internal object store (2.11) attack the expensive part. A new engine
   would attack the cheap part, at the price of a pre-1.0 binary, a second metadata
   store and a second identity scheme.

**Revisit when:** 5.4's `snapshot` and `rebase_conflict` events show real fleet
conflicts above zero in trunk order, or the permission Ask is granted and a measured
jj shadow run (option (c)) beats the Git column on throughput with the same conflict
handling.

### Asks

- **permission** (blocks only the measured jj half): install `jj-cli` from the jj-vcs/jj
  GitHub releases, the prebuilt `x86_64-unknown-linux-musl` tarball pinned to the
  newest release at least 14 days old, unpacked to `/opt/jj/<version>/` and called by
  absolute path. Its sha256 is recorded at install time.
- **decision** (proceed-and-flag): (a) keep Git plumbing [recommended]; (b) a
  Jujutsu-backed integrator; (c) keep (a) and run jj as a measured shadow once the
  permission is granted. The work proceeds on (a).

## Reproduce

The harness is not tracked; it is in the task scratchpad: `bench.mjs` imports
`services/hyperfide/dist/integration/queue.js` and calls `runQueue`, `planBatches` and
`git`. `run.sh` and `norenames.sh` drive it, with one JSON row per run in
`results.jsonl`.

```sh
npm --prefix services/hyperfide ci --ignore-scripts && npm --prefix services/hyperfide run build
git clone --bare --shared <1.11 monorepo clone> bench/repo.git
git -C bench/repo.git rev-list --first-parent --reverse --since=2026-10-15T10:35:21Z 666469ff1868 > bench/c7d.txt
node bench.mjs services/hyperfide/dist/integration/queue.js bench/repo.git bench/c7d.txt week-serial 1 serial
# other modes: <label> 1 (batched), <label> K resolved, <label> K (cascading), <label> 1 floor;
# renames off: the same on a clone with merge.renames=false and merge.directoryRenames=false
```
