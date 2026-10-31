# Railway sandbox fleet toolkit

Hand-built fleet (hyperfide-v21 task 4.10, owner order D22) that runs Hyperfide jobs on up to 100 Railway Sandboxes, using
the `railway` TypeScript SDK. It does not use GitHub: source travels as git bundles of local `main`, and results come back
as bundles that land as local `sandbox/<id>` branches. Hyperfide's own sandbox path (4.2/4.3/4.4) replaces it once that lands.

## Credentials
The toolkit reads only these environment variables. It never reads `.env`, never prints a value, and redacts every value
from captured output, ledgers and logs:

| variable | used by |
| --- | --- |
| `HF_RAILWAY_API_TOKEN` | every SDK call (bearer) |
| `HF_RAILWAY_ENV_ID` | the Railway environment holding the sandboxes |
| `HF_GATEWAY_URL` | OpenAI-compatible gateway base URL (Codex provider) |
| `HF_GATEWAY_KEYS` | comma-separated keys; each worker uses key `n % count`, where `n` is its number |
| `HF_GATEWAY_MODEL` | optional, default `cx/gpt-6.1-sol` |

`provision.mjs` needs the first two. `run-job.mjs` and `dispatch.mjs` need all four and will not start if one is missing.
The gateway key is written to a root-only file inside the sandbox, read into the `codex` exec environment, and deleted.

## Layout
`fleet.json` holds the configuration: checkpoint and checkpoint commit (written by `provision.mjs base|use`), pool
(`hf-w`, default 20, max 100), resources (4 CPU / 8 GB), idle timeout, workspace `/work/hyperfide`, `cap` (agents in flight,
20), `staggerMs` (1500), base build steps, probe, per-job prepare, the qualify command and the Codex settings. All state is
gitignored under `state/`: `jobs/`, `packets/`, `ledger/` (`pool/`, `jobs/`, `failed/`, `<id>.txt`), `bundles/`,
`evidence/<id>/`, `logs/`. Every ledger is written atomically with mode 0600.

## Supervisor sequence (from the main checkout, through the credential wrapper)
```
cd deploy/hyperfide/sandbox
npm install --no-audit --no-fund            # railway@3.16.0, ws@8 (owner-approved, D22); node_modules is gitignored
W=/path/to/with-fleet-env.sh                # exports the five HF_* variables; prints nothing

# 1. base checkpoint: clone local main into a sandbox booted from the earlier fleet's image, build cg and the service,
#    index, checkpoint as hf-base-<main10>, record checkpoint + commit in fleet.json
$W node provision.mjs base --from-checkpoint paxeer-base-1bc4285614
#    prints one "[Ns] <step> ok" line per step (clone, cg, service, platform, platform-build, index, tools), then
#    "checkpoint hf-base-<sha10> commit <sha> (recorded in fleet.json)" and "base sandbox destroyed".
#    If the base was built some other way:  node provision.mjs use hf-base-<sha10> <full sha>

# 2. pool: prints {"worker":"hf-w001","state":"ready","bootMs":...} per worker, then "ready N of N"
$W node provision.mjs pool 20               # repeat (or raise n) up to 100 in total
$W node provision.mjs list                  # "<count> {"RUNNING":N}" and one "<id> RUNNING <created> hf-wNNN" line per sandbox

# 3. jobs: each prints one {"job":...} line per job and "<n> job(s) at base <sha12>"
python3 gen-jobs.py --requalify hyperfide 7.1 7.2 7.3 7.4   # qualify jobs, chained by requires
python3 gen-jobs.py --codex hyperfide-v22 0.8               # one Codex job per task, packet in state/packets/

# 4. dispatch: --dry prints the plan as one JSON line; the real run stays in the foreground until every job has settled
$W node dispatch.mjs --dry
nohup $W node dispatch.mjs --watch > state/logs/dispatch.out 2>&1 &
python3 status.py                           # pool: {...} busy: b idle: i / jobs: queued=… running=… done=… review=… failed=…

# 5. collect: one "READY|NOT-QUALIFIED <id> ..." line per job, then {"ready":n,"notQualified":m,"errors":[]}
node collect-all.mjs
#    each job: branch sandbox/<id> in the main repository (never checked out), state/evidence/<id>/ with READY.txt or
#    NOT-QUALIFIED.txt, the log, the spec patch (qualify), and the unpacked receipts. Move the receipts into the gitignored
#    data dirs yourself, then merge the branch the normal way.

# 6. teardown: "destroyed hf-wNNN" per worker, then "teardown N of N" (busy workers refuse without --force)
$W node provision.mjs teardown
```

## Job kinds
- **qualify** (`run-job.mjs`): ships `main ^<checkpointCommit>` as a bundle, checks out the job's base on `job/<id>` (or the
  previous chained job's tip, whose bundle travels too), runs `fleet.json` `prepare` (incremental `make cg`, service build),
  then `cg spec start` (when the task is still pending) and `cg spec done -f <feature> <task>` under
  `tests/hyperfide/support/withpg.py` with `HYPERFIDE_PG_BIN=/usr/lib/postgresql/18/bin`, on a throwaway cluster. It commits
  what changed and returns the bundle, the spec.kvx patch, the log and a tgz of files that changed under `spec/<feature>/evidence`
  and `artifacts/` since the checkout. Done means `cg spec done` exited 0.
- **codex**: writes the packet and `CODEX_HOME/config.toml` (gateway provider, request and stream retries 30, idle 600 s,
  `approval_policy = "never"`, `sandbox_mode` from fleet.json, the `codify` MCP server from `./cg mcp` with `CG_TASK` set
  so the ask tools are scoped to the task), runs `codex exec`, commits what the agent left on `task/<id>` and returns the
  bundle, the evidence tgz and the transcript tail. Done means codex exited 0 and there are commits. A clean exit with
  no commit is `review`.

Dispatch retries a failed job once, on a different worker. A second failure moves the ledger to `state/ledger/failed/`.
A failure that mentions HTTP 429 pauses new starts (1 min, doubling up to 10 min). Runners never share a bundle lock,
because dispatch builds each base bundle once before the first start. A failed or timed-out job stops `codex` by process
name, removes the key file and releases the worker.

## Lessons carried from the Paxeer fleet
Stagger creates and starts by 1.5 s. Keep CAP at 20 until the gateway proves it can take more. Never `pkill -f` a pattern
that also appears in your own command line (stop runners by pid). Redact every token-looking string.

## Test
`CG=$PWD/cg bash tests/integration/96_sandbox_toolkit.sh` runs the whole sequence against a stub SDK and a stub `codex`.

## Platform image and continuous dispatch

The platform step runs between service and index: Corepack activates pnpm 9.15.0,
`pnpm install --frozen-lockfile` must succeed, and `pnpm build` is best effort.
Logs remain in `/work/logs/pnpm-install.log` and `/work/logs/pnpm-build.log`.
The pool probe reports the pnpm version. Job preparation reinstalls platform
packages when `pnpm-lock.yaml` or `pnpm-workspace.yaml` differs
from the checkpoint commit, trying a frozen install before `--no-frozen-lockfile`.
`make platform-install`, `make platform-build`, and `make platform-test` run pnpm
from the repository root.

`--codex <feature> <task...>` generates Codex jobs with ids such as `v22-0.8`.
`--v21 <task...>` remains an alias for `--codex hyperfide-v21 <task...>`.
Set `HF_PACKET_PREAMBLE` to a readable file to append its contents to every Codex
packet. Relative file paths resolve from the generator's working directory.

`dispatch.mjs --watch` rescans jobs every tick, including while runners are busy,
and stays alive when the queue empties or workers are unavailable. Each tick
atomically writes `state/dispatch-loop.json` with queued ids, running ids,
settled outcomes, and backoff timing. Create `state/STOP` to stop admitting jobs
and exit after active runners finish; remove it before restarting dispatch.

## Platform authority integration and measurements

The toolkit remains an executable transport for local bundles. The platform
image-builder and dispatch integration is owned by tasks 5.3 through 5.7; its
qualification entry point is `python3 tests/hyperfide/cases/v22/5_7.py` using the fixture. Toolkit tests use `CG=$PWD/cg bash tests/integration/96_sandbox_toolkit.sh`
from the repository root. These tests use fake external services.

The [operations timing table](../../../docs/hyperfide/operations.md#sandbox-toolkit-image-steps-and-measured-base-build)
records the historical base build: about 457 seconds total, including a
109.3-second index of 1,574 files with eight workers on 4 vCPU / 8 GB. Those
numbers describe that checkpoint, not the final merged platform. There is no
measured end-to-end wave 5 fleet timing in tracked evidence.
The [platform guide](../../../docs/hyperfide/platform.md) names the integration
boundaries and proof commands.
